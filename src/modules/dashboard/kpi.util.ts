import { clamp, percent, round2 } from '../../common/utils/number.util.js';
import type { WorkCalendar } from '../setup/calendar.util.js';

/**
 * Pure KPI formulas shared by the dashboard endpoints and the AI tools — so the numbers
 * the assistant quotes always match the dashboard.
 */

export interface StatusCounts {
  present: number;
  late: number;
  half_day: number;
  missing_checkout: number;
  absent: number;
  on_leave: number;
}

export const EMPTY_STATUS_COUNTS: StatusCounts = {
  present: 0,
  late: 0,
  half_day: 0,
  missing_checkout: 0,
  absent: 0,
  on_leave: 0,
};

export function toStatusCounts(rows: { _id: string; count: number }[]): StatusCounts {
  const counts = { ...EMPTY_STATUS_COUNTS };
  for (const row of rows) {
    if (row._id in counts) counts[row._id as keyof StatusCounts] += row.count;
  }
  return counts;
}

export interface AttendanceKpis {
  workingDayRecords: number;
  expectedWorkingDays: number;
  /** (present + late + missing_checkout + 0.5 × half_day) / (working_day_records − on_leave) */
  attendanceRate: number;
  /** late / (present + late) */
  latePercent: number;
  /** absent / expected_working_days */
  absenteeismRate: number;
}

export function attendanceKpis(c: StatusCounts): AttendanceKpis {
  const workingDayRecords = c.present + c.late + c.half_day + c.missing_checkout + c.absent + c.on_leave;
  const expectedWorkingDays = workingDayRecords - c.on_leave;
  return {
    workingDayRecords,
    expectedWorkingDays,
    attendanceRate: percent(c.present + c.late + c.missing_checkout + 0.5 * c.half_day, expectedWorkingDays),
    latePercent: percent(c.late, c.present + c.late),
    absenteeismRate: percent(c.absent, expectedWorkingDays),
  };
}

/** (exits in period / average headcount) × 100 */
export function attritionRate(exits: number, headcountStart: number, headcountEnd: number) {
  const averageHeadcount = round2((headcountStart + headcountEnd) / 2);
  return { averageHeadcount, attritionRate: percent(exits, averageHeadcount) };
}

// ── Attrition risk (bonus) ─────────────────────────────────

export interface RiskInput {
  absent: number;
  expectedWorkingDays: number;
  late: number;
  onTime: number;
  missingCheckouts: number;
  unplannedLeaveDays: number;
  tenureMonths: number;
  onProbation: boolean;
  /** basic / department average basic (null when the department has < 2 people). */
  salaryRatio: number | null;
}

export interface RiskFactor {
  factor: string;
  weight: number;
  contribution: number;
  detail: string;
}

export const RISK_WEIGHTS = {
  absence: 30,
  lateness: 15,
  unplannedLeave: 15,
  tenure: 15,
  probation: 10,
  payGap: 10,
  missingCheckouts: 5,
} as const;

/** Explainable 0–100 attrition-risk score built from attendance, leave, tenure and pay signals. */
export function attritionRiskScore(input: RiskInput): { score: number; level: 'low' | 'medium' | 'high'; factors: RiskFactor[] } {
  const absenceRate = input.expectedWorkingDays > 0 ? input.absent / input.expectedWorkingDays : 0;
  const lateRate = input.late + input.onTime > 0 ? input.late / (input.late + input.onTime) : 0;

  const factors: RiskFactor[] = [
    {
      factor: 'absence',
      weight: RISK_WEIGHTS.absence,
      contribution: round2(clamp(absenceRate / 0.15, 0, 1) * RISK_WEIGHTS.absence),
      detail: `${input.absent} absent of ${input.expectedWorkingDays} expected days (${percent(input.absent, input.expectedWorkingDays)}%)`,
    },
    {
      factor: 'lateness',
      weight: RISK_WEIGHTS.lateness,
      contribution: round2(clamp(lateRate / 0.4, 0, 1) * RISK_WEIGHTS.lateness),
      detail: `${input.late} late arrivals (${round2(lateRate * 100)}% of attended days)`,
    },
    {
      factor: 'unplannedLeave',
      weight: RISK_WEIGHTS.unplannedLeave,
      contribution: round2(clamp(input.unplannedLeaveDays / 5, 0, 1) * RISK_WEIGHTS.unplannedLeave),
      detail: `${input.unplannedLeaveDays} sick/unpaid leave day(s)`,
    },
    {
      factor: 'tenure',
      weight: RISK_WEIGHTS.tenure,
      contribution: input.tenureMonths < 6 ? RISK_WEIGHTS.tenure : input.tenureMonths < 12 ? 8 : 0,
      detail: `${input.tenureMonths} month(s) of tenure`,
    },
    {
      factor: 'probation',
      weight: RISK_WEIGHTS.probation,
      contribution: input.onProbation ? RISK_WEIGHTS.probation : 0,
      detail: input.onProbation ? 'On probation' : 'Confirmed',
    },
    {
      factor: 'payGap',
      weight: RISK_WEIGHTS.payGap,
      contribution:
        input.salaryRatio === null ? 0 : input.salaryRatio < 0.8 ? RISK_WEIGHTS.payGap : input.salaryRatio < 0.9 ? 5 : 0,
      detail:
        input.salaryRatio === null
          ? 'Not enough peers to compare pay'
          : `Basic is ${round2(input.salaryRatio * 100)}% of the department average`,
    },
    {
      factor: 'missingCheckouts',
      weight: RISK_WEIGHTS.missingCheckouts,
      contribution: round2(clamp(input.missingCheckouts / 4, 0, 1) * RISK_WEIGHTS.missingCheckouts),
      detail: `${input.missingCheckouts} missing check-out(s)`,
    },
  ];

  const score = Math.round(factors.reduce((sum, f) => sum + f.contribution, 0));
  const level = score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low';
  return { score, level, factors };
}

// ── Absence anomalies (bonus) ──────────────────────────────

export interface AbsenceFlag {
  code: 'HIGH_ABSENCE_RATE' | 'CONSECUTIVE_ABSENCES' | 'WEEKEND_ADJACENT_PATTERN' | 'FREQUENT_MISSING_CHECKOUT';
  message: string;
}

export function detectAbsenceFlags(params: {
  absentDates: string[];
  expectedWorkingDays: number;
  departmentAverageRate: number;
  missingCheckouts: number;
  calendar: WorkCalendar;
  /** Every working day in the analysed range, in order. */
  workingDays: string[];
  addDays: (date: string, days: number) => string;
}): AbsenceFlag[] {
  const flags: AbsenceFlag[] = [];
  const absent = [...new Set(params.absentDates)].sort();
  const rate = params.expectedWorkingDays > 0 ? absent.length / params.expectedWorkingDays : 0;

  const threshold = Math.max(2 * params.departmentAverageRate, 0.1);
  if (absent.length >= 2 && rate >= threshold) {
    flags.push({
      code: 'HIGH_ABSENCE_RATE',
      message: `Absence rate ${round2(rate * 100)}% vs department average ${round2(params.departmentAverageRate * 100)}%`,
    });
  }

  const index = new Map(params.workingDays.map((d, i) => [d, i]));
  let longest = 0;
  let streak = 0;
  let previous = -2;
  for (const date of absent) {
    const i = index.get(date);
    if (i === undefined) continue;
    streak = i === previous + 1 ? streak + 1 : 1;
    longest = Math.max(longest, streak);
    previous = i;
  }
  if (longest >= 3) {
    flags.push({ code: 'CONSECUTIVE_ABSENCES', message: `${longest} consecutive working days absent without approved leave` });
  }

  if (absent.length >= 3) {
    const adjacent = absent.filter((d) =>
      params.calendar.isAdjacentToWeekend(d, params.addDays(d, -1), params.addDays(d, 1)),
    ).length;
    if (adjacent / absent.length >= 0.6) {
      flags.push({
        code: 'WEEKEND_ADJACENT_PATTERN',
        message: `${adjacent} of ${absent.length} absences fall right before/after a weekend`,
      });
    }
  }

  if (params.missingCheckouts >= 3) {
    flags.push({ code: 'FREQUENT_MISSING_CHECKOUT', message: `${params.missingCheckouts} missing check-outs` });
  }
  return flags;
}
