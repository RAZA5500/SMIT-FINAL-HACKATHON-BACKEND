import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as z from 'zod/v4';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { addDays, eachDate, todayIn, weekdayOf } from '../../common/utils/date.util.js';
import { assertManager, requireEmployeeId } from '../../common/utils/scope.util.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { CalendarService } from '../setup/calendar.service.js';
import { LeaveTypesService } from '../setup/leave-types.service.js';
import { SettingsService } from '../setup/settings.service.js';
import { AiLogService } from './ai-log.service.js';
import {
  buildAssistantSystemPrompt,
  buildContextBlock,
  buildDashboardSummaryPrompt,
  buildSmartLeavePrompt,
} from './ai-prompts.js';
import { AiToolsService } from './ai-tools.service.js';
import { AI_FALLBACK_MESSAGES, AI_TIMEOUT_MS } from './ai.constants.js';
import { AiChatDto, AiDashboardSummaryDto, AiSmartLeaveDto, SmartLeaveDraftDto } from './dto/ai.dto.js';
import { ungroundedNumbers } from './grounding.util.js';
import { LlmService, type LlmUsage } from './llm.service.js';
import type { AiCallStatus, AiFeature, AiToolCall } from './schemas/ai-log.schema.js';

const DashboardSummarySchema = z.object({
  bullets: z.array(z.string()).describe('3 to 5 insight bullets'),
});

const SmartLeaveSchema = z.object({
  understood: z.boolean(),
  type: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  reason: z.string().nullable(),
});

type SmartLeaveParse = z.infer<typeof SmartLeaveSchema>;

interface Outcome {
  status: AiCallStatus;
  usage?: LlmUsage | null;
  errorMessage?: string | null;
}

/**
 * AI features with guardrails: server-side key, 20 req/user/hour (controller), 15 s
 * timeout with friendly fallbacks, `ai_logs` for every call, `aiGenerated: true` on every
 * response, and no direct DB access or mutations — tools go through the domain services.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly tools: AiToolsService,
    private readonly logs: AiLogService,
    private readonly dashboard: DashboardService,
    private readonly leave: LeaveService,
    private readonly leaveTypes: LeaveTypesService,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
  ) {}

  // ── 1. Chat with tool calling ─────────────────────────────

  async chat(user: AuthUser, dto: AiChatDto) {
    const started = Date.now();
    const toolsCalled: AiToolCall[] = [];
    const respond = async (reply: string, outcome: Outcome) => {
      const latencyMs = Date.now() - started;
      const logId = await this.log(user, 'chat', dto.message, toolsCalled, reply, outcome, latencyMs);
      return {
        aiGenerated: true as const,
        feature: 'chat' as const,
        status: outcome.status,
        fallback: outcome.status !== 'success',
        reply,
        toolsCalled: toolsCalled.map(({ name, status }) => ({ name, status })),
        model: this.llm.enabled ? this.llm.model : null,
        latencyMs,
        logId,
      };
    };

    if (!this.llm.enabled) return respond(AI_FALLBACK_MESSAGES.disabled, { status: 'disabled' });

    const signal = AbortSignal.timeout(AI_TIMEOUT_MS);
    let final: BetaMessage | null = null;
    try {
      const settings = await this.settings.get();
      const leaveTypes = await this.leaveTypes.findActiveDocuments();
      final = await this.llm.runTools({
        system: [
          { type: 'text', text: buildAssistantSystemPrompt(settings, leaveTypes), cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildContextBlock(user, todayIn(settings.timezone), settings.timezone) },
        ],
        messages: this.toMessages(dto),
        tools: this.tools.build(user, toolsCalled),
        signal,
      });

      if (final.stop_reason === 'refusal') {
        return respond(AI_FALLBACK_MESSAGES.refused, { status: 'refused', usage: LlmService.usageOf(final) });
      }
      const text = LlmService.textOf(final);
      if (!text) return respond(AI_FALLBACK_MESSAGES.empty, { status: 'fallback', usage: LlmService.usageOf(final) });
      return respond(text, { status: 'success', usage: LlmService.usageOf(final) });
    } catch (error) {
      if (LlmService.isAbort(error, signal)) {
        return respond(AI_FALLBACK_MESSAGES.timeout, { status: 'timeout', errorMessage: 'Timed out after 15s' });
      }
      this.logger.error(`AI chat failed: ${LlmService.describeError(error)}`);
      return respond(AI_FALLBACK_MESSAGES.error, { status: 'error', errorMessage: LlmService.describeError(error) });
    }
  }

  // ── 2. Dashboard summary (Admin/HR) ───────────────────────

  async dashboardSummary(user: AuthUser, dto: AiDashboardSummaryDto) {
    assertManager(user, 'The AI dashboard summary is available to Admin and HR only.');
    const started = Date.now();
    const summary = await this.dashboard.getSummary(user, dto);
    const kpis = compactKpis(summary);
    const fallbackBullets = deterministicBullets(kpis);
    const prompt = JSON.stringify(kpis);

    const respond = async (bullets: string[], outcome: Outcome, attempts: number, grounded: boolean) => {
      const latencyMs = Date.now() - started;
      const logId = await this.log(user, 'dashboard-summary', prompt, [], { bullets, attempts, grounded }, outcome, latencyMs);
      return {
        aiGenerated: true as const,
        feature: 'dashboard-summary' as const,
        status: outcome.status,
        fallback: outcome.status !== 'success',
        bullets,
        grounded,
        attempts,
        filters: summary.filters,
        kpis,
        model: this.llm.enabled ? this.llm.model : null,
        latencyMs,
        logId,
      };
    };

    if (!this.llm.enabled) return respond(fallbackBullets, { status: 'disabled' }, 0, true);

    const signal = AbortSignal.timeout(AI_TIMEOUT_MS);
    const messages: BetaMessageParam[] = [
      { role: 'user', content: `KPI JSON (the only allowed source of numbers):\n${prompt}` },
    ];
    let lastUsage: LlmUsage | null = null;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { parsed, message } = await this.llm.parse({
          system: buildDashboardSummaryPrompt(),
          messages,
          schema: DashboardSummarySchema,
          signal,
        });
        lastUsage = LlmService.usageOf(message);
        if (message.stop_reason === 'refusal') break;
        const bullets = (parsed?.bullets ?? []).map((b) => b.trim()).filter(Boolean);
        const problems: string[] = [];
        if (bullets.length < 3 || bullets.length > 5) problems.push(`Return between 3 and 5 bullets (got ${bullets.length}).`);
        const ungrounded = ungroundedNumbers(bullets, kpis);
        if (ungrounded.length) {
          problems.push(`These numbers are not in the KPI JSON: ${[...new Set(ungrounded)].join(', ')}. Use only numbers from the JSON.`);
        }
        if (problems.length === 0) return respond(bullets, { status: 'success', usage: lastUsage }, attempt, true);
        messages.push(
          { role: 'assistant', content: JSON.stringify(parsed ?? {}) },
          { role: 'user', content: `Please fix and answer again: ${problems.join(' ')}` },
        );
      }
      return respond(fallbackBullets, { status: 'fallback', usage: lastUsage, errorMessage: 'Model output failed validation' }, 2, true);
    } catch (error) {
      if (LlmService.isAbort(error, signal)) {
        return respond(fallbackBullets, { status: 'timeout', errorMessage: 'Timed out after 15s' }, 1, true);
      }
      this.logger.error(`AI dashboard summary failed: ${LlmService.describeError(error)}`);
      return respond(fallbackBullets, { status: 'error', errorMessage: LlmService.describeError(error) }, 1, true);
    }
  }

  // ── 3. Smart leave (Employee / HR own) ────────────────────

  /**
   * Parses a natural-language leave request into { type, startDate, endDate, reason },
   * validates it with a DTO, retries once on failure, and otherwise asks the client to
   * fall back to the manual form. Nothing is submitted — the user reviews and submits.
   */
  async smartLeave(user: AuthUser, dto: AiSmartLeaveDto) {
    requireEmployeeId(user);
    const started = Date.now();
    const respond = async (body: Record<string, unknown>, outcome: Outcome) => {
      const latencyMs = Date.now() - started;
      const logId = await this.log(user, 'smart-leave', dto.text, [], body, outcome, latencyMs);
      return {
        aiGenerated: true as const,
        feature: 'smart-leave' as const,
        status: outcome.status,
        ...body,
        model: this.llm.enabled ? this.llm.model : null,
        latencyMs,
        logId,
      };
    };
    const manualForm = (message: string, attempts: number, errors: string[] = []) => ({
      fallbackToManualForm: true,
      draft: null,
      attempts,
      errors,
      message,
    });

    if (!this.llm.enabled) {
      return respond(manualForm('AI is not configured — please fill in the leave form manually.', 0), { status: 'disabled' });
    }

    const settings = await this.settings.get();
    const today = todayIn(settings.timezone);
    const activeTypes = await this.leaveTypes.findActiveDocuments();
    const typeNames = activeTypes.map((t) => t.name);
    const horizonEnd = addDays(today, 60);
    const calendar = await this.calendar.forRange(today, horizonEnd);
    const calendarLines = eachDate(today, horizonEnd).map(
      (d) => `${d} ${weekdayOf(d).slice(0, 3)} ${calendar.isHoliday(d) ? 'holiday' : calendar.isWeekend(d) ? 'weekend' : 'working'}`,
    );
    const system = buildSmartLeavePrompt({ today, weekday: weekdayOf(today), leaveTypes: typeNames, calendarLines });

    const signal = AbortSignal.timeout(AI_TIMEOUT_MS);
    const messages: BetaMessageParam[] = [{ role: 'user', content: dto.text }];
    let lastErrors: string[] = [];
    let lastUsage: LlmUsage | null = null;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { parsed, message } = await this.llm.parse({ system, messages, schema: SmartLeaveSchema, signal, maxTokens: 1024 });
        lastUsage = LlmService.usageOf(message);
        if (message.stop_reason === 'refusal') {
          return respond(manualForm('Please fill in the leave form manually.', attempt, ['Request declined']), {
            status: 'refused',
            usage: lastUsage,
          });
        }

        lastErrors = await this.validateDraft(parsed, typeNames);
        if (lastErrors.length === 0 && parsed) {
          const type = typeNames.find((t) => t.toLowerCase() === parsed.type!.toLowerCase())!;
          const draft = { type, startDate: parsed.startDate!, endDate: parsed.endDate!, reason: parsed.reason!.trim() };
          const preview = await this.leave
            .previewForUser(user, { leaveType: type, startDate: draft.startDate, endDate: draft.endDate })
            .catch(() => null);
          return respond(
            {
              fallbackToManualForm: false,
              draft,
              leaveTypeId: preview?.leaveTypeId ?? String(activeTypes.find((t) => t.name === type)?._id ?? ''),
              workingDays: preview?.workingDays ?? null,
              preview,
              attempts: attempt,
              message:
                'Please review these details and submit them with the leave form (POST /api/leave/requests). Nothing has been submitted yet.',
            },
            { status: 'success', usage: lastUsage },
          );
        }
        messages.push(
          { role: 'assistant', content: JSON.stringify(parsed ?? {}) },
          { role: 'user', content: `That result is invalid: ${lastErrors.join('; ')}. Correct it and answer again.` },
        );
      }
      return respond(
        manualForm('I could not understand the request reliably — please use the manual leave form.', 2, lastErrors),
        { status: 'fallback', usage: lastUsage, errorMessage: lastErrors.join('; ') },
      );
    } catch (error) {
      const timedOut = LlmService.isAbort(error, signal);
      if (!timedOut) this.logger.error(`AI smart leave failed: ${LlmService.describeError(error)}`);
      return respond(
        manualForm(
          timedOut ? 'The AI took too long — please use the manual leave form.' : 'AI is unavailable — please use the manual leave form.',
          1,
        ),
        { status: timedOut ? 'timeout' : 'error', errorMessage: timedOut ? 'Timed out after 15s' : LlmService.describeError(error) },
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private async validateDraft(parsed: SmartLeaveParse | null, typeNames: string[]): Promise<string[]> {
    if (!parsed) return ['No structured output was returned'];
    if (!parsed.understood) return ['The message was not understood as a leave request'];
    const draft = plainToInstance(SmartLeaveDraftDto, {
      type: parsed.type ?? '',
      startDate: parsed.startDate ?? '',
      endDate: parsed.endDate ?? '',
      reason: parsed.reason ?? '',
    });
    const errors = (await validate(draft)).flatMap((e) => Object.values(e.constraints ?? {}));
    if (parsed.type && !typeNames.some((t) => t.toLowerCase() === parsed.type!.toLowerCase())) {
      errors.push(`type must be one of: ${typeNames.join(', ')}`);
    }
    if (errors.length === 0 && parsed.endDate! < parsed.startDate!) errors.push('endDate must be on or after startDate');
    return errors;
  }

  private toMessages(dto: AiChatDto): BetaMessageParam[] {
    const history = (dto.history ?? []).map((m) => ({ role: m.role, content: m.content }) as BetaMessageParam);
    while (history.length && history[0].role !== 'user') history.shift();
    return [...history, { role: 'user', content: dto.message }];
  }

  private log(
    user: AuthUser,
    feature: AiFeature,
    prompt: string,
    toolsCalled: AiToolCall[],
    response: unknown,
    outcome: Outcome,
    latencyMs: number,
  ) {
    return this.logs.log({
      user,
      feature,
      prompt,
      toolsCalled,
      response,
      status: outcome.status,
      latencyMs,
      model: this.llm.enabled ? this.llm.model : null,
      errorMessage: outcome.errorMessage ?? null,
      usage: outcome.usage ?? null,
    });
  }
}

// ── KPI shaping for the dashboard summary ─────────────────────

type DashboardSummary = Awaited<ReturnType<DashboardService['getSummary']>>;

/** The subset of KPIs sent to the model (and the only numbers the bullets may use). */
export function compactKpis(s: DashboardSummary) {
  return {
    period: { startDate: s.filters.startDate, endDate: s.filters.endDate },
    today: s.today
      ? {
          date: s.today.date,
          present: s.today.present,
          late: s.today.late,
          onLeave: s.today.onLeave,
          notCheckedIn: s.today.notCheckedIn,
          pendingApprovals: s.today.pendingApprovals.total,
        }
      : null,
    headcount: { total: s.headcount.total, active: s.headcount.active, probation: s.headcount.probation },
    headcountByDepartment: s.headcount.byDepartment.slice(0, 8).map((d) => ({ department: d.department, headcount: d.headcount })),
    attrition: {
      exits: s.attrition.exits,
      averageHeadcount: s.attrition.averageHeadcount,
      attritionRatePercent: s.attrition.attritionRate,
      yearToDatePercent: s.attritionYtd?.attritionRate ?? null,
    },
    attendance: {
      attendanceRatePercent: s.attendance.attendanceRate,
      latePercent: s.attendance.latePercent,
      absenteeismRatePercent: s.attendance.absenteeismRate,
      counts: s.attendance.counts,
    },
    absenteeismByDepartment: s.absenteeism.byDepartment.slice(0, 5).map((d) => ({
      department: d.department,
      absenteeismRatePercent: d.absenteeismRate,
      absentDays: d.absentDays,
    })),
    leaveUtilization: s.leaveUtilization.byLeaveType.map((t) => ({
      leaveType: t.leaveType,
      approvedDays: t.approvedDays,
      quota: t.quota,
      utilizationPercent: t.utilization,
    })),
    payroll: {
      byMonth: s.payrollCost.byMonth.map((m) => ({
        month: m.month,
        runStatus: m.runStatus,
        gross: m.gross,
        net: m.net,
        tax: m.tax,
        employees: m.employees,
      })),
      totals: { gross: s.payrollCost.totals.gross, net: s.payrollCost.totals.net, tax: s.payrollCost.totals.tax },
    },
    averageGrossByDepartment: s.averageSalary.byDepartment.slice(0, 5).map((d) => ({
      department: d.department,
      averageGross: d.averageGross,
    })),
    topLateComers: s.lateComers.data.slice(0, 3).map((l) => ({ name: l.fullName, lateCount: l.lateCount })),
    attritionRisk: {
      high: s.attritionRisk.summary.high,
      medium: s.attritionRisk.summary.medium,
      low: s.attritionRisk.summary.low,
      top: s.attritionRisk.data.slice(0, 3).map((r) => ({ name: r.fullName, score: r.score, level: r.level })),
    },
    absenceAnomalies: {
      flaggedEmployees: s.absenceAnomalies.flaggedEmployees,
      examples: s.absenceAnomalies.data.slice(0, 3).map((a) => ({
        name: (a as { fullName?: string }).fullName ?? 'Unknown',
        flags: a.flags.map((f) => f.code),
      })),
    },
  };
}

/** Rule-based bullets used when the model is unavailable, slow, or fails validation. */
export function deterministicBullets(k: ReturnType<typeof compactKpis>): string[] {
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const bullets = [
    `Headcount is ${k.headcount.total} (${k.headcount.active} active, ${k.headcount.probation} on probation) as of ${k.period.endDate}.`,
    `Attendance rate is ${k.attendance.attendanceRatePercent}% with late arrivals at ${k.attendance.latePercent}% of attended days and absenteeism at ${k.attendance.absenteeismRatePercent}%.`,
    `Attrition for the period is ${k.attrition.attritionRatePercent}% (${k.attrition.exits} exit(s) against an average headcount of ${k.attrition.averageHeadcount}).`,
  ];
  if (k.payroll.byMonth.length) {
    bullets.push(`Payroll in the period totals ${fmt.format(k.payroll.totals.gross)} gross and ${fmt.format(k.payroll.totals.net)} net.`);
  } else {
    bullets.push('No payroll run exists for this period yet.');
  }
  const worstAbsenteeism = k.absenteeismByDepartment.find((d) => d.absentDays > 0);
  const busiestLeave = [...k.leaveUtilization]
    .filter((t) => t.approvedDays > 0)
    .sort((a, b) => b.approvedDays - a.approvedDays)[0];
  if (k.attritionRisk.high > 0 || k.absenceAnomalies.flaggedEmployees > 0) {
    bullets.push(
      `${k.attritionRisk.high} employee(s) show high attrition risk and ${k.absenceAnomalies.flaggedEmployees} have absence anomaly flags.`,
    );
  } else if (worstAbsenteeism) {
    bullets.push(
      `${worstAbsenteeism.department} has the highest absenteeism at ${worstAbsenteeism.absenteeismRatePercent}% (${worstAbsenteeism.absentDays} absent day(s)).`,
    );
  } else if (busiestLeave) {
    bullets.push(`${busiestLeave.leaveType} leave is the most used with ${busiestLeave.approvedDays} approved day(s) in the period.`);
  }
  return bullets.slice(0, 5);
}
