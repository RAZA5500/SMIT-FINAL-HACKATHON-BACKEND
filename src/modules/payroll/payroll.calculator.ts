import { clamp, round2 } from '../../common/utils/number.util.js';

/**
 * Pure payroll math (no I/O) — shared by payroll runs, the employee 360 profile and tests.
 *
 *   basic   = set by HR
 *   hra     = 40% of basic
 *   medical = 10% of basic
 *   gross   = basic + hra + medical = 1.5 × basic
 *
 *   perDay              = gross / workingDaysInMonth
 *   proratedGross       = perDay × eligibleWorkingDays          (joiners / leavers)
 *   deductionDays       = absent + unpaidLeave + 0.5 × halfDays (+ floor(lates / 3) × 0.5 if enabled)
 *   attendanceDeduction = deductionDays × perDay
 *   annualTax           = slab(gross × 12),  monthlyTax = annualTax / 12
 *   netPay              = proratedGross − attendanceDeduction − monthlyTax
 */

export const SALARY_COMPONENT_RATES = { hraRate: 0.4, medicalRate: 0.1 } as const;

export const LATE_PENALTY_RULE = { latesPerPenalty: 3, penaltyDaysPerUnit: 0.5 } as const;

export interface TaxSlab {
  /** Income above this amount is taxed at `rate`. */
  threshold: number;
  /** Inclusive upper bound of the slab (`null` = no limit). */
  upTo: number | null;
  /** Fixed tax for all income up to `threshold`. */
  base: number;
  rate: number;
}

/** Annualized income tax slabs (on `annualGross = gross × 12`). */
export const TAX_SLABS: TaxSlab[] = [
  { threshold: 0, upTo: 600_000, base: 0, rate: 0 },
  { threshold: 600_000, upTo: 1_200_000, base: 0, rate: 0.05 },
  { threshold: 1_200_000, upTo: 2_400_000, base: 30_000, rate: 0.15 },
  { threshold: 2_400_000, upTo: 3_600_000, base: 210_000, rate: 0.25 },
  { threshold: 3_600_000, upTo: null, base: 510_000, rate: 0.35 },
];

export interface SalaryStructure {
  basic: number;
  hra: number;
  medical: number;
  gross: number;
}

export function computeSalaryStructure(
  basic: number,
  rates: { hraRate: number; medicalRate: number } = SALARY_COMPONENT_RATES,
): SalaryStructure {
  const hra = round2(basic * rates.hraRate);
  const medical = round2(basic * rates.medicalRate);
  return { basic: round2(basic), hra, medical, gross: round2(basic + hra + medical) };
}

/** Annual income tax for an annual gross income using the progressive slabs. */
export function computeAnnualTax(annualGross: number, slabs: TaxSlab[] = TAX_SLABS): number {
  if (!(annualGross > 0)) return 0;
  const slab = slabs.find((s) => s.upTo === null || annualGross <= s.upTo) ?? slabs[slabs.length - 1];
  return round2(slab.base + (annualGross - slab.threshold) * slab.rate);
}

export function computeMonthlyTax(gross: number, slabs: TaxSlab[] = TAX_SLABS): number {
  return round2(computeAnnualTax(gross * 12, slabs) / 12);
}

export interface PayslipInput {
  basic: number;
  workingDaysInMonth: number;
  /** Working days in the month inside the employment window (joiners/leavers are prorated). */
  eligibleWorkingDays: number;
  absentDays: number;
  unpaidLeaveDays: number;
  halfDays: number;
  lateCount: number;
  latePenaltyRuleEnabled: boolean;
}

export interface PayslipRules {
  hraRate: number;
  medicalRate: number;
  taxSlabs: TaxSlab[];
  latesPerPenalty: number;
  penaltyDaysPerUnit: number;
}

export const DEFAULT_PAYSLIP_RULES: PayslipRules = {
  ...SALARY_COMPONENT_RATES,
  taxSlabs: TAX_SLABS,
  ...LATE_PENALTY_RULE,
};

export interface PayslipFigures extends SalaryStructure {
  workingDaysInMonth: number;
  eligibleWorkingDays: number;
  perDay: number;
  proratedGross: number;
  absentDays: number;
  unpaidLeaveDays: number;
  halfDays: number;
  lateCount: number;
  latePenaltyDays: number;
  deductionDays: number;
  attendanceDeduction: number;
  annualGross: number;
  annualTax: number;
  monthlyTax: number;
  netPay: number;
}

export function calculatePayslip(input: PayslipInput, rules: PayslipRules = DEFAULT_PAYSLIP_RULES): PayslipFigures {
  if (!(input.workingDaysInMonth > 0)) {
    throw new Error('workingDaysInMonth must be greater than 0');
  }
  const salary = computeSalaryStructure(input.basic, rules);
  const workingDays = input.workingDaysInMonth;
  const eligible = clamp(input.eligibleWorkingDays, 0, workingDays);

  const perDay = salary.gross / workingDays;
  const proratedGross = eligible === workingDays ? salary.gross : round2(perDay * eligible);

  const latePenaltyDays = input.latePenaltyRuleEnabled
    ? Math.floor(input.lateCount / rules.latesPerPenalty) * rules.penaltyDaysPerUnit
    : 0;
  const deductionDays = input.absentDays + input.unpaidLeaveDays + 0.5 * input.halfDays + latePenaltyDays;
  // A deduction can never exceed what was earned for the month.
  const attendanceDeduction = Math.min(round2(deductionDays * perDay), proratedGross);

  const annualGross = round2(salary.gross * 12);
  const annualTax = computeAnnualTax(annualGross, rules.taxSlabs);
  const monthlyTax = round2(annualTax / 12);
  // Net pay is floored at 0 (e.g. a joiner with 1 working day and a full month's tax).
  const netPay = Math.max(0, round2(proratedGross - attendanceDeduction - monthlyTax));

  return {
    ...salary,
    workingDaysInMonth: workingDays,
    eligibleWorkingDays: eligible,
    perDay: round2(perDay),
    proratedGross,
    absentDays: input.absentDays,
    unpaidLeaveDays: input.unpaidLeaveDays,
    halfDays: input.halfDays,
    lateCount: input.lateCount,
    latePenaltyDays,
    deductionDays,
    attendanceDeduction,
    annualGross,
    annualTax,
    monthlyTax,
    netPay,
  };
}
