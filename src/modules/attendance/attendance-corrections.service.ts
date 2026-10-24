import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role } from '../../common/constants/roles.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { todayIn, zonedDateTimeToDate } from '../../common/utils/date.util.js';
import { paginate } from '../../common/utils/query.util.js';
import { requireEmployeeId, resolveEmployeeScope } from '../../common/utils/scope.util.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../comms/notifications.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { SettingsService } from '../setup/settings.service.js';
import { deriveAttendanceStatus } from './attendance.rules.js';
import { rulesFromSettings } from './attendance.service.js';
import {
  CorrectionQueryDto,
  CreateCorrectionDto,
  RejectCorrectionDto,
  ReviewCorrectionDto,
} from './dto/attendance.dto.js';
import {
  AttendanceCorrection,
  type AttendanceCorrectionDocument,
} from './schemas/attendance-correction.schema.js';
import { Attendance, type AttendanceDocument } from './schemas/attendance.schema.js';

/**
 * Attendance corrections: the Employee requests a fix with a reason; HR/Admin approves
 * (record updated + audit log) or rejects. Reviewers cannot approve their own request.
 */
@Injectable()
export class AttendanceCorrectionsService {
  constructor(
    @InjectModel(AttendanceCorrection.name)
    private readonly correctionModel: Model<AttendanceCorrectionDocument>,
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<AttendanceDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, dto: CreateCorrectionDto) {
    const employeeId = requireEmployeeId(user);
    const employee = await this.employeeModel.findById(employeeId).exec();
    if (!employee) throw new NotFoundException('Employee profile not found');

    const settings = await this.settings.get();
    const today = todayIn(settings.timezone);
    if (dto.date > today) throw new UnprocessableEntityException('Corrections can only be requested for past days or today.');
    if (dto.date < employee.joinDate) {
      throw new UnprocessableEntityException(`The date is before your join date (${employee.joinDate}).`);
    }
    if (!dto.requestedCheckIn && !dto.requestedCheckOut) {
      throw new UnprocessableEntityException('Provide requestedCheckIn and/or requestedCheckOut.');
    }
    if (dto.requestedCheckIn && dto.requestedCheckOut && dto.requestedCheckOut <= dto.requestedCheckIn) {
      throw new UnprocessableEntityException('requestedCheckOut must be after requestedCheckIn.');
    }

    const attendance = await this.attendanceModel.findOne({ employeeId: employee._id, date: dto.date }).exec();
    if (!dto.requestedCheckIn && !attendance?.checkInAt) {
      throw new UnprocessableEntityException('There is no check-in for that day — include requestedCheckIn.');
    }
    const pending = await this.correctionModel
      .exists({ employeeId: employee._id, date: dto.date, status: 'pending' })
      .exec();
    if (pending) throw new ConflictException('A correction for this day is already pending review.');

    const correction = await this.correctionModel.create({
      employeeId: employee._id,
      attendanceId: attendance?._id ?? null,
      date: dto.date,
      requestedCheckIn: dto.requestedCheckIn ?? null,
      requestedCheckOut: dto.requestedCheckOut ?? null,
      reason: dto.reason,
      requestedBy: user.userId,
    });

    await this.audit.record({ actor: user, action: 'create', entity: 'AttendanceCorrection', entityId: correction._id, after: correction });
    await this.notifications.notifyRoles(
      [Role.HR, Role.Admin],
      {
        title: 'Attendance correction request',
        message: `${employee.fullName} (${employee.code}) requested a correction for ${dto.date}.`,
        type: 'attendance',
        entity: 'AttendanceCorrection',
        entityId: correction._id,
      },
      user.userId,
    );
    return correction.toJSON();
  }

  async findAll(user: AuthUser, query: CorrectionQueryDto) {
    const employeeId = resolveEmployeeScope(user, query.employeeId);
    const filter: Record<string, unknown> = {};
    if (employeeId) filter.employeeId = new Types.ObjectId(employeeId);
    if (query.status) filter.status = query.status;
    return paginate(this.correctionModel, filter, {
      page: query.page,
      limit: query.limit,
      sort: { createdAt: -1 },
      populate: { path: 'employeeId', select: 'code fullName departmentId' },
    });
  }

  async approve(user: AuthUser, id: string, dto: ReviewCorrectionDto) {
    const correction = await this.getPendingForReview(user, id);
    const settings = await this.settings.get();
    const today = todayIn(settings.timezone);
    const timezone = settings.timezone;

    let record = await this.attendanceModel
      .findOne({ employeeId: correction.employeeId, date: correction.date })
      .exec();
    const before = record?.toObject() ?? null;

    const rules = record?.ruleSnapshot ?? rulesFromSettings(settings);
    const checkInAt = correction.requestedCheckIn
      ? zonedDateTimeToDate(correction.date, correction.requestedCheckIn, rules.timezone ?? timezone)
      : record?.checkInAt ?? null;
    const checkOutAt = correction.requestedCheckOut
      ? zonedDateTimeToDate(correction.date, correction.requestedCheckOut, rules.timezone ?? timezone)
      : record?.checkOutAt ?? null;
    if (!checkInAt) throw new UnprocessableEntityException('Correction has no check-in time to apply.');
    if (checkOutAt && checkOutAt <= checkInAt) {
      throw new UnprocessableEntityException('Corrected check-out would be before check-in.');
    }

    const derived = deriveAttendanceStatus({ date: correction.date, today, checkInAt, checkOutAt, rules });

    if (record) {
      record.checkInAt = checkInAt;
      record.checkOutAt = checkOutAt;
      record.status = derived.status;
      record.lateMinutes = derived.lateMinutes;
      record.workedMinutes = derived.workedMinutes;
      record.leaveRequestId = null;
      record.leaveTypeName = null;
      record.corrected = true;
      record.correctionIds = [...(record.correctionIds ?? []), correction._id];
      await record.save();
    } else {
      const employee = await this.employeeModel.findById(correction.employeeId, { departmentId: 1 }).exec();
      const calendar = await this.calendar.forRange(correction.date, correction.date);
      record = await this.attendanceModel.create({
        employeeId: correction.employeeId,
        departmentId: employee?.departmentId ?? null,
        date: correction.date,
        checkInAt,
        checkOutAt,
        status: derived.status,
        lateMinutes: derived.lateMinutes,
        workedMinutes: derived.workedMinutes,
        isWorkingDay: calendar.isWorkingDay(correction.date),
        source: 'correction',
        ruleSnapshot: rules,
        corrected: true,
        correctionIds: [correction._id],
      });
    }

    const correctionBefore = correction.toObject();
    correction.status = 'approved';
    correction.attendanceId = record._id;
    correction.reviewedBy = new Types.ObjectId(user.userId);
    correction.reviewComment = dto.comment ?? null;
    correction.reviewedAt = new Date();
    await correction.save();

    await this.audit.record({
      actor: user,
      action: 'approve',
      entity: 'AttendanceCorrection',
      entityId: correction._id,
      before: correctionBefore,
      after: correction,
    });
    await this.audit.record({
      actor: user,
      action: before ? 'update' : 'create',
      entity: 'Attendance',
      entityId: record._id,
      before,
      after: record,
    });
    await this.notifications.notifyEmployee(correction.employeeId, {
      title: 'Attendance correction approved',
      message: `Your correction for ${correction.date} was approved${dto.comment ? `: ${dto.comment}` : '.'}`,
      type: 'attendance',
      entity: 'AttendanceCorrection',
      entityId: correction._id,
    });
    return { correction: correction.toJSON(), attendance: record.toJSON() };
  }

  async reject(user: AuthUser, id: string, dto: RejectCorrectionDto) {
    const correction = await this.getPendingForReview(user, id);
    const before = correction.toObject();
    correction.status = 'rejected';
    correction.reviewedBy = new Types.ObjectId(user.userId);
    correction.reviewComment = dto.comment;
    correction.reviewedAt = new Date();
    await correction.save();

    await this.audit.record({
      actor: user,
      action: 'reject',
      entity: 'AttendanceCorrection',
      entityId: correction._id,
      before,
      after: correction,
    });
    await this.notifications.notifyEmployee(correction.employeeId, {
      title: 'Attendance correction rejected',
      message: `Your correction for ${correction.date} was rejected: ${dto.comment}`,
      type: 'attendance',
      entity: 'AttendanceCorrection',
      entityId: correction._id,
    });
    return correction.toJSON();
  }

  private async getPendingForReview(user: AuthUser, id: string): Promise<AttendanceCorrectionDocument> {
    const correction = await this.correctionModel.findById(id).exec();
    if (!correction) throw new NotFoundException('Correction request not found');
    if (correction.status !== 'pending') {
      throw new ConflictException(`This correction has already been ${correction.status}.`);
    }
    if (user.employeeId && String(correction.employeeId) === user.employeeId) {
      throw new ForbiddenException('You cannot review your own correction request.');
    }
    return correction;
  }
}
