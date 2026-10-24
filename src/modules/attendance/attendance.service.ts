import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/filters/mongo-exception.filter.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { KeyedMutex } from '../../common/utils/keyed-mutex.js';
import { addDays, toLocalDate, toLocalTime, todayIn } from '../../common/utils/date.util.js';
import { paginate } from '../../common/utils/query.util.js';
import { assertManager, isManager, requireEmployeeId, resolveEmployeeScope } from '../../common/utils/scope.util.js';
import { AuditService } from '../audit/audit.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { LeaveRequest, type LeaveRequestDocument } from '../leave/schemas/leave-request.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { DesignationsService } from '../setup/designations.service.js';
import type { CompanySettingsDocument } from '../setup/schemas/company-settings.schema.js';
import { SettingsService } from '../setup/settings.service.js';
import {
  evaluateCheckIn,
  evaluateCheckOut,
  verifyCameraCheckIn,
  type AttendanceRules,
  type CameraPayload,
} from './attendance.rules.js';
import {
  AttendanceBoardQueryDto,
  AttendancePunchDto,
  AttendanceQueryDto,
  AttendanceRangeQueryDto,
} from './dto/attendance.dto.js';
import { Attendance, type AttendanceDocument } from './schemas/attendance.schema.js';

export function rulesFromSettings(settings: CompanySettingsDocument): AttendanceRules {
  return {
    timezone: settings.timezone,
    officeStartTime: settings.officeStartTime,
    graceMinutes: settings.graceMinutes,
    halfDayThresholdHours: settings.halfDayThresholdHours,
  };
}

function cameraPayload(dto: AttendancePunchDto): CameraPayload {
  return {
    faceDetected: dto.faceDetected,
    faceCount: dto.faceCount,
    latitude: dto.latitude ?? dto.lat,
    longitude: dto.longitude ?? dto.lng,
    accuracy: dto.accuracy ?? dto.gpsAccuracy,
  };
}

@Injectable()
export class AttendanceService {
  private readonly punchLock = new KeyedMutex();

  constructor(
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<AttendanceDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    @InjectModel(LeaveRequest.name) private readonly leaveModel: Model<LeaveRequestDocument>,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly departments: DepartmentsService,
    private readonly designations: DesignationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Server-stamped check-in. One record per employee per day: a second check-in on the
   * same local day throws 409 (checked up-front and enforced by a unique index).
   */
  async checkIn(user: AuthUser, dto: AttendancePunchDto) {
    const employeeId = requireEmployeeId(user);
    return this.punchLock.run(employeeId, async () => {
      const employee = await this.loadWorkingEmployee(employeeId);
      const settings = await this.settings.get();
      const now = new Date();
      const date = toLocalDate(now, settings.timezone);

      if (employee.joinDate > date) {
        throw new UnprocessableEntityException(`Your employment starts on ${employee.joinDate}.`);
      }
      if (await this.attendanceModel.exists({ employeeId: employee._id, date }).exec()) {
        throw new ConflictException(`You have already checked in today (${date}). Only one check-in per day is allowed.`);
      }

      const source = dto.source ?? 'manual';
      const verification =
        source === 'camera' ? verifyCameraCheckIn(cameraPayload(dto), settings.officeLocation, now) : null;

      const rules = rulesFromSettings(settings);
      const { status, lateMinutes } = evaluateCheckIn(now, date, rules);
      const calendar = await this.calendar.forRange(date, date);

      let record: AttendanceDocument;
      try {
        record = await this.attendanceModel.create({
          employeeId: employee._id,
          departmentId: employee.departmentId,
          date,
          checkInAt: now,
          status,
          lateMinutes,
          isWorkingDay: calendar.isWorkingDay(date),
          source,
          checkInVerification: verification,
          ruleSnapshot: rules,
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new ConflictException(`You have already checked in today (${date}). Only one check-in per day is allowed.`);
        }
        throw error;
      }

      await this.audit.record({ actor: user, action: 'create', entity: 'Attendance', entityId: record._id, after: record });
      return record.toJSON();
    });
  }

  /** Server-stamped check-out for today's record; < half-day threshold hours → `half_day`. */
  async checkOut(user: AuthUser, dto: AttendancePunchDto) {
    const employeeId = requireEmployeeId(user);
    return this.punchLock.run(employeeId, async () => {
      const settings = await this.settings.get();
      const now = new Date();
      const date = toLocalDate(now, settings.timezone);

      const record = await this.attendanceModel
        .findOne({ employeeId: new Types.ObjectId(employeeId), date })
        .exec();
      if (!record || !record.checkInAt) {
        throw new NotFoundException('No check-in found for today. Please check in first.');
      }
      if (record.checkOutAt) {
        throw new ConflictException('You have already checked out today.');
      }

      const verification =
        dto.source === 'camera' ? verifyCameraCheckIn(cameraPayload(dto), settings.officeLocation, now) : null;
      const checkInStatus = record.status === 'late' ? 'late' : 'present';
      // Uses the rules snapshotted at check-in time.
      const { status, workedMinutes } = evaluateCheckOut(record.checkInAt, now, checkInStatus, record.ruleSnapshot);

      const before = record.toObject();
      const updated = await this.attendanceModel
        .findOneAndUpdate(
          { _id: record._id, checkOutAt: null },
          { $set: { checkOutAt: now, workedMinutes, status, checkOutVerification: verification } },
          { new: true },
        )
        .exec();
      if (!updated) throw new ConflictException('You have already checked out today.');

      await this.audit.record({ actor: user, action: 'update', entity: 'Attendance', entityId: updated._id, before, after: updated });
      return updated.toJSON();
    });
  }

  /** Today's status for the caller (drives the check-in/check-out buttons). */
  async today(user: AuthUser) {
    const employeeId = requireEmployeeId(user);
    const settings = await this.settings.get();
    const date = todayIn(settings.timezone);
    const [record, calendar] = await Promise.all([
      this.attendanceModel.findOne({ employeeId: new Types.ObjectId(employeeId), date }).exec(),
      this.calendar.forRange(date, date),
    ]);
    return {
      date,
      timezone: settings.timezone,
      isWorkingDay: calendar.isWorkingDay(date),
      record: record?.toJSON() ?? null,
      canCheckIn: !record,
      canCheckOut: !!record?.checkInAt && !record.checkOutAt,
    };
  }

  /** Attendance list — Employees are always pinned to their own records. */
  async findAll(user: AuthUser, query: AttendanceQueryDto) {
    const employeeId = resolveEmployeeScope(user, query.employeeId);
    const filter: Record<string, unknown> = {};
    if (employeeId) filter.employeeId = new Types.ObjectId(employeeId);
    if (query.departmentId && isManager(user)) filter.departmentId = new Types.ObjectId(query.departmentId);
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      const date: Record<string, string> = {};
      if (query.from) date.$gte = query.from;
      if (query.to) date.$lte = query.to;
      filter.date = date;
    }
    return paginate(this.attendanceModel, filter, {
      page: query.page,
      limit: query.limit,
      sort: { date: -1, createdAt: -1 },
      populate: { path: 'employeeId', select: 'code fullName departmentId designationId' },
    });
  }

  /** Caller's own records in a date range (default: last 30 days). */
  async findMine(user: AuthUser, query: AttendanceRangeQueryDto) {
    const employeeId = requireEmployeeId(user);
    const settings = await this.settings.get();
    const to = query.to ?? todayIn(settings.timezone);
    const from = query.from ?? addDays(to, -30);
    const records = await this.attendanceModel
      .find({ employeeId: new Types.ObjectId(employeeId), date: { $gte: from, $lte: to } })
      .sort({ date: -1 })
      .limit(query.limit ?? 366)
      .exec();
    return { from, to, data: records.map((r) => r.toJSON()) };
  }

  async findOne(user: AuthUser, id: string) {
    const record = await this.attendanceModel.findById(id).exec();
    if (!record) throw new NotFoundException('Attendance record not found');
    resolveEmployeeScope(user, String(record.employeeId));
    return record.toJSON();
  }

  /**
   * Daily attendance board (Admin/HR): every employee employed on the day with their
   * status — including people who have not checked in yet or are on approved leave.
   */
  async board(user: AuthUser, query: AttendanceBoardQueryDto) {
    assertManager(user, 'The attendance board is available to Admin and HR only.');
    const settings = await this.settings.get();
    const today = todayIn(settings.timezone);
    const date = query.date ?? today;

    const employeeFilter: Record<string, unknown> = {
      joinDate: { $lte: date },
      $or: [{ exitDate: null }, { exitDate: { $gte: date } }],
    };
    if (query.departmentId) employeeFilter.departmentId = new Types.ObjectId(query.departmentId);

    const [calendar, employees, departmentNames, designationNames] = await Promise.all([
      this.calendar.forRange(date, date),
      this.employeeModel.find(employeeFilter).sort({ fullName: 1 }).lean().exec(),
      this.departments.nameMap(),
      this.designations.nameMap(),
    ]);
    const ids = employees.map((e) => e._id);
    const [records, leaves] = await Promise.all([
      this.attendanceModel.find({ date, employeeId: { $in: ids } }).lean().exec(),
      this.leaveModel
        .find({ status: 'approved', employeeId: { $in: ids }, dates: date }, { employeeId: 1, leaveTypeName: 1 })
        .lean()
        .exec(),
    ]);
    const recordBy = new Map(records.map((r) => [String(r.employeeId), r]));
    const leaveBy = new Map(leaves.map((l) => [String(l.employeeId), l]));
    const isWorkingDay = calendar.isWorkingDay(date);
    const localTime = (instant: Date | null | undefined) => (instant ? toLocalTime(instant, settings.timezone) : null);

    const data = employees.map((employee) => {
      const id = String(employee._id);
      const record = recordBy.get(id);
      const leave = leaveBy.get(id);
      const status = record
        ? record.status
        : leave
          ? 'on_leave'
          : !isWorkingDay
            ? calendar.isHoliday(date)
              ? 'holiday'
              : 'weekend'
            : date < today
              ? 'absent'
              : 'not_checked_in';
      return {
        employeeId: id,
        code: employee.code,
        fullName: employee.fullName,
        department: departmentNames.get(String(employee.departmentId)) ?? null,
        designation: designationNames.get(String(employee.designationId)) ?? null,
        status,
        checkIn: localTime(record?.checkInAt),
        checkOut: localTime(record?.checkOutAt),
        lateMinutes: record?.lateMinutes ?? 0,
        workedMinutes: record?.workedMinutes ?? null,
        source: record?.source ?? null,
        leaveType: record?.leaveTypeName ?? leave?.leaveTypeName ?? null,
        attendanceId: record ? String(record._id) : null,
      };
    });

    const summary: Record<string, number> = {};
    for (const row of data) summary[row.status] = (summary[row.status] ?? 0) + 1;
    return { date, timezone: settings.timezone, isWorkingDay, total: data.length, summary, data };
  }

  /** Most recent records for an employee (360 profile). */
  async recentForEmployee(employeeId: string, limit = 10) {
    const records = await this.attendanceModel
      .find({ employeeId: new Types.ObjectId(employeeId) })
      .sort({ date: -1 })
      .limit(limit)
      .exec();
    return records.map((r) => r.toJSON());
  }

  /**
   * When leave is approved (possibly retroactively), days already closed as `absent`
   * become `on_leave` so attendance KPIs and payroll stay consistent.
   */
  async applyApprovedLeave(leave: LeaveRequestDocument): Promise<number> {
    const result = await this.attendanceModel
      .updateMany(
        { employeeId: leave.employeeId, date: { $in: leave.dates }, status: 'absent' },
        {
          $set: {
            status: 'on_leave',
            leaveRequestId: leave._id,
            leaveTypeName: leave.leaveTypeName,
            source: 'system',
          },
        },
      )
      .exec();
    return result.modifiedCount;
  }

  private async loadWorkingEmployee(employeeId: string): Promise<EmployeeDocument> {
    const employee = await this.employeeModel.findById(employeeId).exec();
    if (!employee) throw new NotFoundException('Employee profile not found');
    if (employee.status === 'exited') {
      throw new ForbiddenException('Exited employees cannot mark attendance.');
    }
    return employee;
  }
}
