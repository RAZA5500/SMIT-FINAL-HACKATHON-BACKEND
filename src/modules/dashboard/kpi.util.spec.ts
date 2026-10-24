import { WorkCalendar } from '../setup/calendar.util.js';
import { addDays } from '../../common/utils/date.util.js';
import { attendanceKpis, attritionRate, attritionRiskScore, detectAbsenceFlags } from './kpi.util.js';

describe('Dashboard KPI formulas', () => {
  it('attendance rate = (present + late + missing_checkout + 0.5 × half_day) / (working_day_records − on_leave)', () => {
    const kpis = attendanceKpis({ present: 10, late: 4, half_day: 2, missing_checkout: 1, absent: 3, on_leave: 2 });
    expect(kpis.workingDayRecords).toBe(22);
    expect(kpis.expectedWorkingDays).toBe(20);
    expect(kpis.attendanceRate).toBe(80); // (10 + 4 + 1 + 1) / 20
    expect(kpis.latePercent).toBe(28.57); // 4 / 14
    expect(kpis.absenteeismRate).toBe(15); // 3 / 20
  });

  it('returns 0 instead of dividing by zero', () => {
    expect(attendanceKpis({ present: 0, late: 0, half_day: 0, missing_checkout: 0, absent: 0, on_leave: 0 }).attendanceRate).toBe(0);
  });

  it('attrition = exits / average headcount × 100', () => {
    expect(attritionRate(2, 38, 42)).toEqual({ averageHeadcount: 40, attritionRate: 5 });
  });

  it('attrition risk score is explainable and bounded 0-100', () => {
    const risky = attritionRiskScore({
      absent: 5,
      expectedWorkingDays: 20,
      late: 8,
      onTime: 7,
      missingCheckouts: 4,
      unplannedLeaveDays: 6,
      tenureMonths: 3,
      onProbation: true,
      salaryRatio: 0.7,
    });
    expect(risky.score).toBe(100);
    expect(risky.level).toBe('high');
    expect(risky.factors.every((f) => f.contribution <= f.weight)).toBe(true);

    const steady = attritionRiskScore({
      absent: 0,
      expectedWorkingDays: 20,
      late: 0,
      onTime: 20,
      missingCheckouts: 0,
      unplannedLeaveDays: 0,
      tenureMonths: 30,
      onProbation: false,
      salaryRatio: 1.1,
    });
    expect(steady).toMatchObject({ score: 0, level: 'low' });
  });

  it('flags consecutive and weekend-adjacent absences', () => {
    const calendar = new WorkCalendar(['Saturday', 'Sunday'], new Set(), 'Asia/Karachi');
    const workingDays = calendar.workingDays('2026-10-01', '2026-10-31');
    const flags = detectAbsenceFlags({
      absentDates: ['2026-10-05', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16'],
      expectedWorkingDays: 22,
      departmentAverageRate: 0.02,
      missingCheckouts: 0,
      calendar,
      workingDays,
      addDays,
    });
    const codes = flags.map((f) => f.code);
    expect(codes).toContain('HIGH_ABSENCE_RATE');
    expect(codes).toContain('CONSECUTIVE_ABSENCES');
    expect(codes).toContain('WEEKEND_ADJACENT_PATTERN');
  });
});
