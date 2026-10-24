import {
  calculatePayslip,
  computeAnnualTax,
  computeMonthlyTax,
  computeSalaryStructure,
  type PayslipInput,
} from './payroll.calculator.js';

const fullMonth = (overrides: Partial<PayslipInput> = {}): PayslipInput => ({
  basic: 100_000,
  workingDaysInMonth: 22,
  eligibleWorkingDays: 22,
  absentDays: 0,
  unpaidLeaveDays: 0,
  halfDays: 0,
  lateCount: 0,
  latePenaltyRuleEnabled: false,
  ...overrides,
});

describe('Payroll calculator', () => {
  describe('salary structure', () => {
    it('derives HRA 40%, medical 10% and gross = 1.5 × basic', () => {
      expect(computeSalaryStructure(100_000)).toEqual({ basic: 100_000, hra: 40_000, medical: 10_000, gross: 150_000 });
      expect(computeSalaryStructure(33_333)).toEqual({ basic: 33_333, hra: 13_333.2, medical: 3_333.3, gross: 49_999.5 });
    });
  });

  describe('annualized tax slabs', () => {
    it.each([
      [0, 0],
      [500_000, 0],
      [600_000, 0], // top of the 0% slab
      [600_001, 0.05], // 5% of the amount above 600,000
      [900_000, 15_000],
      [1_200_000, 30_000], // top of the 5% slab
      [1_200_001, 30_000.15], // 30,000 + 15% above 1,200,000
      [1_800_000, 120_000],
      [2_400_000, 210_000], // top of the 15% slab
      [3_000_000, 360_000], // 210,000 + 25% above 2,400,000
      [3_600_000, 510_000], // top of the 25% slab
      [4_000_000, 650_000], // 510,000 + 35% above 3,600,000
      [5_400_000, 1_140_000],
    ])('annual gross %d → annual tax %d', (annualGross, expectedTax) => {
      expect(computeAnnualTax(annualGross)).toBeCloseTo(expectedTax, 2);
    });

    it('is continuous at every slab boundary', () => {
      for (const boundary of [600_000, 1_200_000, 2_400_000, 3_600_000]) {
        expect(computeAnnualTax(boundary + 1) - computeAnnualTax(boundary)).toBeLessThan(1);
      }
    });

    it('monthly tax = annual tax on (gross × 12) / 12', () => {
      expect(computeMonthlyTax(150_000)).toBe(10_000); // 1.8M → 120,000 / 12
      expect(computeMonthlyTax(75_000)).toBe(1_250); // 900k → 15,000 / 12
      expect(computeMonthlyTax(40_000)).toBe(0); // 480k → 0
    });
  });

  describe('monthly payslip', () => {
    it('full month, no deductions: net = gross − monthly tax', () => {
      const slip = calculatePayslip(fullMonth());
      expect(slip.gross).toBe(150_000);
      expect(slip.proratedGross).toBe(150_000);
      expect(slip.annualGross).toBe(1_800_000);
      expect(slip.annualTax).toBe(120_000);
      expect(slip.monthlyTax).toBe(10_000);
      expect(slip.attendanceDeduction).toBe(0);
      expect(slip.netPay).toBe(140_000);
    });

    it('deductionDays = absent + unpaid leave + 0.5 × half days; deduction = days × perDay', () => {
      const slip = calculatePayslip(fullMonth({ absentDays: 2, unpaidLeaveDays: 1, halfDays: 2 }));
      expect(slip.deductionDays).toBe(4);
      expect(slip.perDay).toBeCloseTo(150_000 / 22, 2);
      expect(slip.attendanceDeduction).toBeCloseTo((150_000 / 22) * 4, 2);
      expect(slip.netPay).toBeCloseTo(150_000 - (150_000 / 22) * 4 - 10_000, 2);
    });

    it('applies the bonus late rule (floor(lates / 3) × 0.5) only when enabled', () => {
      expect(calculatePayslip(fullMonth({ lateCount: 7 })).latePenaltyDays).toBe(0);
      const slip = calculatePayslip(fullMonth({ lateCount: 7, latePenaltyRuleEnabled: true }));
      expect(slip.latePenaltyDays).toBe(1); // floor(7/3)=2 → 2 × 0.5
      expect(slip.deductionDays).toBe(1);
    });

    it('prorates joiners/leavers by eligible working days (tax stays on full gross)', () => {
      const slip = calculatePayslip(fullMonth({ eligibleWorkingDays: 11 }));
      expect(slip.proratedGross).toBe(75_000);
      expect(slip.monthlyTax).toBe(10_000);
      expect(slip.netPay).toBe(65_000);
    });

    it('never produces a negative net pay', () => {
      const slip = calculatePayslip(fullMonth({ eligibleWorkingDays: 1, absentDays: 1 }));
      expect(slip.attendanceDeduction).toBeLessThanOrEqual(slip.proratedGross);
      expect(slip.netPay).toBe(0);
    });

    it('rejects a month without working days', () => {
      expect(() => calculatePayslip(fullMonth({ workingDaysInMonth: 0 }))).toThrow();
    });
  });
});
