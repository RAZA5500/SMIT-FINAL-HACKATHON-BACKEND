import { WorkCalendar } from './calendar.util.js';

describe('WorkCalendar (working days)', () => {
  const calendar = new WorkCalendar(['Saturday', 'Sunday'], new Set(['2026-10-28']), 'Asia/Karachi');

  it('skips configured weekend days and public holidays', () => {
    // Mon 26 Oct → Sun 1 Nov 2026, with a holiday on Wed 28 Oct
    expect(calendar.workingDays('2026-10-26', '2026-11-01')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-29',
      '2026-10-30',
    ]);
  });

  it('a weekend-only range has zero working days', () => {
    expect(calendar.countWorkingDays('2026-10-31', '2026-11-01')).toBe(0);
  });

  it('honours a custom weekend (e.g. Friday only)', () => {
    const fridayWeekend = new WorkCalendar(['Friday'], new Set(), 'Asia/Karachi');
    expect(fridayWeekend.countWorkingDays('2026-10-26', '2026-11-01')).toBe(6);
  });
});
