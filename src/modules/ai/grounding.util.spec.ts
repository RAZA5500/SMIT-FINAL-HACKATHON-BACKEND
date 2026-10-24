import { extractNumbers, ungroundedNumbers } from './grounding.util.js';

describe('AI dashboard-summary number grounding', () => {
  const kpis = { attendance: { attendanceRatePercent: 86.36 }, payroll: { totals: { net: 467250 } }, headcount: { total: 42 } };

  it('extracts plain, decimal and comma-grouped numbers', () => {
    expect(extractNumbers('Net 467,250 and 86.36% of 42')).toEqual([467250, 86.36, 42]);
  });

  it('accepts numbers taken from the KPI JSON (including 1-decimal rounding)', () => {
    expect(ungroundedNumbers(['Attendance is 86.4% across 42 employees; net payroll 467,250.'], kpis)).toEqual([]);
  });

  it('flags invented numbers', () => {
    expect(ungroundedNumbers(['Attendance improved by 37% to 91.2%'], kpis)).toEqual([37, 91.2]);
  });
});
