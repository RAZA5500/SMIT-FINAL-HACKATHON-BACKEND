import { DateTime, IANAZone } from 'luxon';

/**
 * Calendar dates (join dates, attendance days, leave ranges, holidays) are stored as
 * ISO strings `YYYY-MM-DD` in the company's timezone. Plain strings compare correctly
 * with `<`/`>` and never shift when the server runs in a different timezone.
 */
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
export const TIME_HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const WEEK_DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

const MAX_RANGE_DAYS = 3700;

function fromIsoDate(value: string): DateTime {
  return DateTime.fromISO(value, { zone: 'utc' });
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;
  const dt = fromIsoDate(value);
  return dt.isValid && dt.toISODate() === value;
}

export function isValidMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_REGEX.test(value);
}

export function isValidTimeZone(value: unknown): value is string {
  return typeof value === 'string' && IANAZone.isValidZone(value);
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function toLocalDate(instant: Date, timeZone: string): string {
  return DateTime.fromJSDate(instant, { zone: timeZone }).toISODate()!;
}

/** Today's local date in the given timezone. */
export function todayIn(timeZone: string): string {
  return DateTime.now().setZone(timeZone).toISODate()!;
}

/** Local time-of-day `HH:mm` of an instant in the given timezone. */
export function toLocalTime(instant: Date, timeZone: string): string {
  return DateTime.fromJSDate(instant, { zone: timeZone }).toFormat('HH:mm');
}

/** Converts a local date + `HH:mm` in a timezone to the UTC instant. */
export function zonedDateTimeToDate(date: string, time: string, timeZone: string): Date {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: timeZone });
  if (!dt.isValid) {
    throw new Error(`Invalid date/time: ${date} ${time} (${timeZone})`);
  }
  return dt.toJSDate();
}

export function addDays(date: string, days: number): string {
  return fromIsoDate(date).plus({ days }).toISODate()!;
}

/** Inclusive list of dates from `start` to `end`. */
export function eachDate(start: string, end: string): string[] {
  if (start > end) return [];
  const dates: string[] = [];
  let cursor = fromIsoDate(start);
  const last = fromIsoDate(end);
  while (cursor <= last) {
    dates.push(cursor.toISODate()!);
    if (dates.length > MAX_RANGE_DAYS) {
      throw new Error('Date range is too large');
    }
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

export function weekdayOf(date: string): WeekDay {
  return WEEK_DAYS[fromIsoDate(date).weekday - 1];
}

/** Number of calendar days between two dates (`b - a`). */
export function diffInDays(a: string, b: string): number {
  return Math.round(fromIsoDate(b).diff(fromIsoDate(a), 'days').days);
}

/** First and last date of a `YYYY-MM` month. */
export function monthBounds(month: string): { start: string; end: string } {
  const first = fromIsoDate(`${month}-01`);
  return { start: first.toISODate()!, end: first.endOf('month').toISODate()! };
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Human label for a month, e.g. `2026-10` → `October 2026`. */
export function monthLabel(month: string): string {
  return fromIsoDate(`${month}-01`).toFormat('LLLL yyyy');
}

/** Whole months between two dates' months, inclusive (`2026-01-15`..`2026-03-02` → 3). */
export function monthsBetween(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  let cursor = fromIsoDate(startOfMonth(startDate));
  const last = fromIsoDate(startOfMonth(endDate));
  while (cursor <= last) {
    months.push(cursor.toFormat('yyyy-MM'));
    cursor = cursor.plus({ months: 1 });
  }
  return months;
}
