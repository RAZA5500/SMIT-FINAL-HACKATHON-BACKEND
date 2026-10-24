import { Injectable } from '@nestjs/common';
import { todayIn } from '../../common/utils/date.util.js';
import { WorkCalendar } from './calendar.util.js';
import { HolidaysService } from './holidays.service.js';
import { SettingsService } from './settings.service.js';

/** Builds working-day calendars from the configured weekend days and public holidays. */
@Injectable()
export class CalendarService {
  constructor(
    private readonly settings: SettingsService,
    private readonly holidays: HolidaysService,
  ) {}

  /** Calendar covering `[from, to]` (holidays outside the range are not loaded). */
  async forRange(from: string, to: string): Promise<WorkCalendar> {
    const settings = await this.settings.get();
    const holidays = await this.holidays.datesBetween(from, to);
    return new WorkCalendar(settings.weekendDays, holidays, settings.timezone);
  }

  async workingDays(from: string, to: string): Promise<string[]> {
    return (await this.forRange(from, to)).workingDays(from, to);
  }

  async today(): Promise<string> {
    const settings = await this.settings.get();
    return todayIn(settings.timezone);
  }
}
