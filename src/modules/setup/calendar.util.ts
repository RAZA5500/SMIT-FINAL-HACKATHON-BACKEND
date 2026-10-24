import { eachDate, weekdayOf } from '../../common/utils/date.util.js';

/**
 * Working-day calendar for a date range: a day is a working day unless it falls on one
 * of the configured weekend days or on a public holiday. Pure & synchronous so it can be
 * reused in loops (payroll, attendance close, leave validation) and unit-tested.
 */
export class WorkCalendar {
  private readonly weekend: Set<string>;

  constructor(
    weekendDays: string[],
    private readonly holidays: Set<string>,
    readonly timezone: string,
  ) {
    this.weekend = new Set(weekendDays);
  }

  /** Holiday dates loaded for this calendar, sorted. */
  get holidayDates(): string[] {
    return [...this.holidays].sort();
  }

  isWeekend(date: string): boolean {
    return this.weekend.has(weekdayOf(date));
  }

  isHoliday(date: string): boolean {
    return this.holidays.has(date);
  }

  isWorkingDay(date: string): boolean {
    return !this.isWeekend(date) && !this.isHoliday(date);
  }

  workingDays(from: string, to: string): string[] {
    return eachDate(from, to).filter((date) => this.isWorkingDay(date));
  }

  countWorkingDays(from: string, to: string): number {
    return this.workingDays(from, to).length;
  }

  /** True when the previous or next calendar day is a weekend day (Friday/Monday pattern). */
  isAdjacentToWeekend(date: string, previousDay: string, nextDay: string): boolean {
    return this.isWorkingDay(date) && (this.isWeekend(previousDay) || this.isWeekend(nextDay));
  }
}
