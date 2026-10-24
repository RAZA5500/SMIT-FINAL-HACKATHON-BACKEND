import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { Model, type AnyBulkWriteOperation } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { addDays, eachDate, minDate, todayIn } from '../../common/utils/date.util.js';
import { AuditService } from '../audit/audit.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { LeaveRequest, type LeaveRequestDocument } from '../leave/schemas/leave-request.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import type { WorkCalendar } from '../setup/calendar.util.js';
import type { CompanySettingsDocument } from '../setup/schemas/company-settings.schema.js';
import { SettingsService } from '../setup/settings.service.js';
import { rulesFromSettings } from './attendance.service.js';
import { Attendance, type AttendanceDocument } from './schemas/attendance.schema.js';

export interface CloseSummary {
  closedDates: string[];
  missingCheckouts: number;
  absentsCreated: number;
  onLeaveCreated: number;
}

const MAX_DAYS_PER_RUN = 370;
const AUTO_CLOSE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * End-of-day attendance close. For every finished local day since the last run:
 *  - check-ins without a check-out become `missing_checkout`
 *  - on working days, employees with no record get `on_leave` (approved leave) or `absent`
 * Idempotent (upserts on the unique employee/day index) and runs every 30 minutes,
 * on startup, and on demand via POST /api/attendance/close-days.
 */
@Injectable()
export class AttendanceCloserService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AttendanceCloserService.name);
  private running: Promise<CloseSummary> | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<AttendanceDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    @InjectModel(LeaveRequest.name) private readonly leaveModel: Model<LeaveRequestDocument>,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get autoCloseEnabled(): boolean {
    return this.config.get<string>('NODE_ENV') !== 'test';
  }

  onApplicationBootstrap(): void {
    if (!this.autoCloseEnabled) return;
    this.startupTimer = setTimeout(() => void this.runSafely(), 5_000);
  }

  onApplicationShutdown(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  @Interval('attendance-auto-close', AUTO_CLOSE_INTERVAL_MS)
  async scheduledClose(): Promise<void> {
    if (this.autoCloseEnabled) await this.runSafely();
  }

  private async runSafely(): Promise<void> {
    try {
      const summary = await this.closePendingDays(null);
      if (summary.closedDates.length) {
        this.logger.log(
          `Closed ${summary.closedDates.length} day(s): ${summary.absentsCreated} absent, ` +
            `${summary.onLeaveCreated} on leave, ${summary.missingCheckouts} missing check-out`,
        );
      }
    } catch (error) {
      this.logger.error(`Attendance auto-close failed: ${(error as Error).message}`);
    }
  }

  /** Closes every pending day up to `upTo` (never later than yesterday). Single-flight. */
  async closePendingDays(actor: AuthUser | null, upTo?: string): Promise<CloseSummary> {
    if (this.running) return this.running;
    this.running = this.doClose(actor, upTo).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doClose(actor: AuthUser | null, upTo?: string): Promise<CloseSummary> {
    const summary: CloseSummary = { closedDates: [], missingCheckouts: 0, absentsCreated: 0, onLeaveCreated: 0 };
    const settings = await this.settings.find();
    if (!settings) return summary;

    const yesterday = addDays(todayIn(settings.timezone), -1);
    const target = upTo ? minDate(upTo, yesterday) : yesterday;
    const start = settings.lastClosedDate ? addDays(settings.lastClosedDate, 1) : settings.trackingStartDate;
    if (start > target) return summary;

    const dates = eachDate(start, target).slice(0, MAX_DAYS_PER_RUN);
    const calendar = await this.calendar.forRange(dates[0], dates[dates.length - 1]);

    for (const date of dates) {
      const day = await this.closeDay(date, calendar, settings);
      summary.closedDates.push(date);
      summary.missingCheckouts += day.missingCheckouts;
      summary.absentsCreated += day.absentsCreated;
      summary.onLeaveCreated += day.onLeaveCreated;
      await this.settings.markClosedThrough(date);
      if (day.missingCheckouts || day.absentsCreated || day.onLeaveCreated) {
        await this.audit.record({
          actor,
          action: 'update',
          entity: 'AttendanceDay',
          entityId: date,
          after: { date, ...day },
        });
      }
    }
    return summary;
  }

  private async closeDay(
    date: string,
    calendar: WorkCalendar,
    settings: CompanySettingsDocument,
  ): Promise<Omit<CloseSummary, 'closedDates'>> {
    const missing = await this.attendanceModel
      .updateMany(
        { date, checkInAt: { $ne: null }, checkOutAt: null, status: { $in: ['present', 'late'] } },
        { $set: { status: 'missing_checkout' } },
      )
      .exec();
    const result = { missingCheckouts: missing.modifiedCount, absentsCreated: 0, onLeaveCreated: 0 };
    if (!calendar.isWorkingDay(date)) return result;

    // Employees employed on that day who already existed in the system by its end.
    const endOfDay = DateTime.fromISO(date, { zone: settings.timezone }).endOf('day').toJSDate();
    const employees = await this.employeeModel
      .find(
        {
          joinDate: { $lte: date },
          $or: [{ exitDate: null }, { exitDate: { $gte: date } }],
          createdAt: { $lte: endOfDay },
        },
        { _id: 1, departmentId: 1 },
      )
      .lean()
      .exec();
    if (employees.length === 0) return result;

    const existing = await this.attendanceModel
      .find({ date, employeeId: { $in: employees.map((e) => e._id) } }, { employeeId: 1 })
      .lean()
      .exec();
    const hasRecord = new Set(existing.map((r) => String(r.employeeId)));
    const withoutRecord = employees.filter((e) => !hasRecord.has(String(e._id)));
    if (withoutRecord.length === 0) return result;

    const leaves = await this.leaveModel
      .find(
        { employeeId: { $in: withoutRecord.map((e) => e._id) }, status: 'approved', dates: date },
        { employeeId: 1, leaveTypeName: 1 },
      )
      .lean()
      .exec();
    const leaveByEmployee = new Map(leaves.map((l) => [String(l.employeeId), l]));
    const rules = rulesFromSettings(settings);

    const operations: AnyBulkWriteOperation<AttendanceDocument>[] = withoutRecord.map((employee) => {
      const leave = leaveByEmployee.get(String(employee._id));
      if (leave) result.onLeaveCreated += 1;
      else result.absentsCreated += 1;
      return {
        updateOne: {
          filter: { employeeId: employee._id, date },
          update: {
            $setOnInsert: {
              employeeId: employee._id,
              departmentId: employee.departmentId ?? null,
              date,
              status: leave ? 'on_leave' : 'absent',
              isWorkingDay: true,
              source: 'system',
              checkInAt: null,
              checkOutAt: null,
              lateMinutes: 0,
              workedMinutes: null,
              ruleSnapshot: rules,
              leaveRequestId: leave?._id ?? null,
              leaveTypeName: leave?.leaveTypeName ?? null,
            },
          },
          upsert: true,
        },
      } as AnyBulkWriteOperation<AttendanceDocument>;
    });
    await this.attendanceModel.bulkWrite(operations, { ordered: false });
    return result;
  }
}
