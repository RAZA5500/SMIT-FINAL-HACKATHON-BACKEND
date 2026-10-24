import Anthropic from '@anthropic-ai/sdk';
import { jest } from '@jest/globals';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { PayrollService } from '../payroll/payroll.service.js';
import { CalendarService } from '../setup/calendar.service.js';
import { WorkCalendar } from '../setup/calendar.util.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { LeaveTypesService } from '../setup/leave-types.service.js';
import { SettingsService } from '../setup/settings.service.js';
import { AiLogService } from './ai-log.service.js';
import { AiToolsService } from './ai-tools.service.js';
import { AiService } from './ai.service.js';
import { LlmService } from './llm.service.js';

/**
 * Exercises the real Anthropic SDK code paths (tool runner + structured parse) offline:
 * the client is given a fake `fetch` that replays canned Messages API responses.
 */

type FakeRequest = { url: string; headers: Headers; body: Record<string, any> };

const message = (content: unknown[], stop_reason = 'end_turn') => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 },
});
const json = (value: unknown) => message([{ type: 'text', text: JSON.stringify(value) }]);

const hr: AuthUser = {
  userId: String(new Types.ObjectId()),
  email: 'hr@company.com',
  fullName: 'Hina',
  role: 'HR',
  employeeId: null,
  mustChangePassword: false,
};
const employee: AuthUser = { ...hr, fullName: 'Sara', role: 'Employee', employeeId: String(new Types.ObjectId()) };

const kpiSummary = {
  filters: { startDate: '2026-10-01', endDate: '2026-10-24', departmentId: null },
  headcount: { total: 42, active: 40, probation: 2, byDepartment: [{ department: 'Engineering', headcount: 20 }] },
  attrition: { exits: 1, averageHeadcount: 41.5, attritionRate: 2.41 },
  attendance: {
    attendanceRate: 91.25,
    latePercent: 12.5,
    absenteeismRate: 4.1,
    counts: { present: 300, late: 40, half_day: 6, missing_checkout: 4, absent: 15, on_leave: 10 },
  },
  absenteeism: { byDepartment: [{ department: 'Sales', absenteeismRate: 6.2, absentDays: 9 }] },
  leaveUtilization: { byLeaveType: [{ leaveType: 'Annual', approvedDays: 25, quota: 588, utilization: 4.25 }] },
  payrollCost: { byMonth: [{ month: '2026-09', runStatus: 'finalized', gross: 4_500_000, net: 4_100_000, tax: 300_000, employees: 41 }], totals: { gross: 4_500_000, net: 4_100_000, tax: 300_000 } },
  averageSalary: { byDepartment: [{ department: 'Engineering', averageGross: 180_000 }] },
  lateComers: { data: [{ fullName: 'Ali Raza', lateCount: 6 }] },
  attritionRisk: { summary: { high: 2, medium: 5, low: 35 }, data: [{ fullName: 'Ali Raza', score: 64, level: 'high' }] },
  absenceAnomalies: { flaggedEmployees: 3, data: [{ fullName: 'Bilal', flags: [{ code: 'CONSECUTIVE_ABSENCES' }] }] },
};

describe('AiService (Claude SDK, offline)', () => {
  let ai: AiService;
  let requests: FakeRequest[];
  let queue: unknown[];
  const dashboard = {
    getHeadcount: jest.fn<AnyFn>().mockResolvedValue({ date: '2026-10-24', total: 42, active: 40, probation: 2 }),
    getSummary: jest.fn<AnyFn>().mockResolvedValue(kpiSummary),
  };
  const employees = { searchForAssistant: jest.fn<AnyFn>() };
  const leave = { previewForUser: jest.fn<AnyFn>(), getBalances: jest.fn<AnyFn>() };
  const logs = { log: jest.fn<AnyFn>().mockResolvedValue('log-1') };

  beforeEach(async () => {
    requests = [];
    queue = [];
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        AiToolsService,
        LlmService,
        { provide: ConfigService, useValue: { get: (key: string) => ({ AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' })[key] } },
        { provide: AiLogService, useValue: logs },
        { provide: DashboardService, useValue: dashboard },
        { provide: EmployeesService, useValue: employees },
        { provide: LeaveService, useValue: leave },
        { provide: PayrollService, useValue: { getPayrollSummary: jest.fn<AnyFn>() } },
        { provide: DepartmentsService, useValue: { resolve: jest.fn<AnyFn>(), findAll: jest.fn<AnyFn>().mockResolvedValue([]) } },
        {
          provide: SettingsService,
          useValue: {
            get: jest.fn<AnyFn>().mockResolvedValue({
              companyName: 'Acme',
              timezone: 'Asia/Karachi',
              currency: 'PKR',
              officeStartTime: '09:00',
              graceMinutes: 15,
              halfDayThresholdHours: 5,
              weekendDays: ['Saturday', 'Sunday'],
              officeLocation: { lat: 24.86, lng: 67, radiusMeters: 150 },
              latePenaltyRuleEnabled: false,
            }),
          },
        },
        {
          provide: LeaveTypesService,
          useValue: {
            findActiveDocuments: jest.fn<AnyFn>().mockResolvedValue([
              { _id: new Types.ObjectId(), name: 'Annual', annualQuota: 14, isPaid: true },
              { _id: new Types.ObjectId(), name: 'Sick', annualQuota: 8, isPaid: true },
              { _id: new Types.ObjectId(), name: 'Unpaid', annualQuota: null, isPaid: false },
            ]),
          },
        },
        {
          provide: CalendarService,
          useValue: { forRange: jest.fn<AnyFn>().mockResolvedValue(new WorkCalendar(['Saturday', 'Sunday'], new Set(), 'Asia/Karachi')) },
        },
      ],
    }).compile();

    // Route the real SDK client through a fake fetch that replays `queue`.
    const llm = moduleRef.get(LlmService);
    (llm as unknown as { client: Anthropic }).client = new Anthropic({
      apiKey: 'test-key',
      maxRetries: 0,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
        const next = queue.shift();
        if (!next) throw new Error('No fake response queued');
        return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
      }) as typeof fetch,
    });
    ai = moduleRef.get(AiService);
  });

  it('chat: runs the tool loop through the domain services and returns aiGenerated output', async () => {
    queue.push(
      message([{ type: 'tool_use', id: 'toolu_1', name: 'get_headcount', input: {} }], 'tool_use'),
      message([{ type: 'text', text: 'Abhi company mein 42 employees hain.' }]),
    );

    const result = await ai.chat(hr, { message: 'Company mein kitne log hain?' });

    expect(result).toMatchObject({ aiGenerated: true, status: 'success', reply: 'Abhi company mein 42 employees hain.' });
    expect(result.toolsCalled).toEqual([{ name: 'get_headcount', status: 'ok' }]);
    expect(dashboard.getHeadcount).toHaveBeenCalledWith(hr, expect.any(Object)); // same service, same user scope

    const [first, second] = requests;
    expect(first.url).toContain('/v1/messages');
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'low' } });
    expect(first.body).not.toHaveProperty('temperature');
    expect(first.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(first.body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'get_attendance_summary',
      'get_headcount',
      'get_late_comers',
      'get_leave_summary',
      'get_my_leave_balance',
      'get_payroll_summary',
      'search_employees',
    ]);
    expect(first.body.system[0].text).toContain('Roman Urdu');
    expect(first.body.system[0].text).toContain('600,000 = 0');
    const toolResult = second.body.messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(JSON.stringify(toolResult.content)).toContain('42');

    expect(logs.log).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'chat', status: 'success', toolsCalled: [expect.objectContaining({ name: 'get_headcount', status: 'ok' })] }),
    );
  });

  it("chat: an Employee asking about someone else's data gets ACCESS_DENIED from the tool", async () => {
    employees.searchForAssistant.mockRejectedValue(new ForbiddenException('Access denied: employees can only access their own records.'));
    queue.push(
      message([{ type: 'tool_use', id: 'toolu_2', name: 'search_employees', input: { query: 'Ali Raza' } }], 'tool_use'),
      message([{ type: 'text', text: 'Maazrat, main sirf aap ka apna record dikha sakta hoon.' }]),
    );

    const result = await ai.chat(employee, { message: 'Ali ki salary kitni hai?' });

    expect(result.toolsCalled).toEqual([{ name: 'search_employees', status: 'denied' }]);
    expect(JSON.stringify(requests[1].body.messages.at(-1).content[0].content)).toContain('ACCESS_DENIED');
    expect(result.reply).toContain('Maazrat');
  });

  it('chat: a model refusal becomes a friendly fallback', async () => {
    queue.push(message([], 'refusal'));
    const result = await ai.chat(hr, { message: 'something unsafe' });
    expect(result).toMatchObject({ aiGenerated: true, status: 'refused', fallback: true });
  });

  it('dashboard summary: retries once when a bullet uses numbers not in the KPI JSON', async () => {
    queue.push(
      json({ bullets: ['Attendance jumped by 37%.', 'Headcount is 42.', 'Attrition is 2.41%.'] }),
      json({ bullets: ['Headcount is 42 with 2 on probation.', 'Attendance rate is 91.25%.', 'Attrition is 2.41% with 1 exit.'] }),
    );

    const result = await ai.dashboardSummary(hr, {});

    expect(result).toMatchObject({ aiGenerated: true, status: 'success', attempts: 2, grounded: true });
    expect(result.bullets).toHaveLength(3);
    expect(requests[1].headers.get('anthropic-beta')).toContain('structured-outputs');
    expect(requests[1].body.messages.at(-1).content).toContain('37');
  });

  it('dashboard summary: falls back to rule-based bullets when the model keeps failing validation', async () => {
    queue.push(json({ bullets: ['Only one bullet'] }), json({ bullets: ['Still just 1'] }));
    const result = await ai.dashboardSummary(hr, {});
    expect(result).toMatchObject({ aiGenerated: true, status: 'fallback', fallback: true });
    expect(result.bullets.length).toBeGreaterThanOrEqual(3);
    expect(result.bullets[0]).toContain('42');
  });

  it('smart leave: returns a validated draft (never submits it)', async () => {
    leave.previewForUser.mockResolvedValue({ leaveTypeId: 'sick-id', workingDays: 2, canSubmit: true, issues: [] });
    queue.push(json({ understood: true, type: 'sick', startDate: '2026-11-02', endDate: '2026-11-03', reason: 'Fever' }));

    const result = await ai.smartLeave(employee, { text: 'Kal aur parson bukhar ki wajah se chutti chahiye' });

    expect(result).toMatchObject({
      aiGenerated: true,
      status: 'success',
      fallbackToManualForm: false,
      draft: { type: 'Sick', startDate: '2026-11-02', endDate: '2026-11-03', reason: 'Fever' },
      leaveTypeId: 'sick-id',
      attempts: 1,
    });
    expect(requests[0].body.system).toContain('working');
  });

  it('smart leave: retries once on invalid output, then falls back to the manual form', async () => {
    queue.push(
      json({ understood: true, type: 'Vacation', startDate: '2026-11-02', endDate: '2026-11-03', reason: 'Trip' }),
      json({ understood: true, type: 'Annual', startDate: '2026-02-30', endDate: '2026-03-01', reason: 'Trip' }),
    );

    const result = await ai.smartLeave(employee, { text: 'trip next week' });

    expect(result).toMatchObject({ aiGenerated: true, status: 'fallback', fallbackToManualForm: true, attempts: 2 });
    expect(requests).toHaveLength(2);
  });
});
