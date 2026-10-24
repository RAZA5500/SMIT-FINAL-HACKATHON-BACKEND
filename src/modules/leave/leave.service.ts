import {
  BadRequestException,
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
import { diffInDays, todayIn, yearOf } from '../../common/utils/date.util.js';
import { KeyedMutex } from '../../common/utils/keyed-mutex.js';
import { paginate } from '../../common/utils/query.util.js';
import { isManager, requireEmployeeId, resolveEmployeeScope } from '../../common/utils/scope.util.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../comms/notifications.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { LeaveTypesService } from '../setup/leave-types.service.js';
import type { LeaveTypeDocument } from '../setup/schemas/leave-type.schema.js';
import { SettingsService } from '../setup/settings.service.js';
import {
  CreateLeaveDto,
  LeaveBalanceQueryDto,
  LeaveQueryDto,
  RejectLeaveDto,
  ReviewLeaveDto,
  WorkingDaysQueryDto,
} from './dto/leave.dto.js';
import {
  ACTIVE_LEAVE_STATUSES,
  LeaveRequest,
  type LeaveRequestDocument,
} from './schemas/leave-request.schema.js';

const MAX_LEAVE_SPAN_DAYS = 366;

export interface LeaveBalance {
  leaveTypeId: string;
  leaveType: string;
  isPaid: boolean;
  unlimited: boolean;
  /** Annual quota in working days (`null` = unlimited). */
  quota: number | null;
  /** Approved working days in the year. */
  used: number;
  /** Pending working days (reserved until reviewed). */
  pending: number;
  /** Balance after approved leaves: `quota - used` (`null` = unlimited). */
  remaining: number | null;
  /** What can still be requested: `quota - used - pending` (`null` = unlimited). */
  available: number | null;
}

export interface LeaveIssue {
  code:
    | 'INVALID_RANGE'
    | 'RANGE_TOO_LONG'
    | 'BEFORE_JOIN_DATE'
    | 'AFTER_EXIT_DATE'
    | 'NO_WORKING_DAYS'
    | 'LEAVE_OVERLAP'
    | 'INSUFFICIENT_BALANCE';
  message: string;
}

export interface LeaveAssessment {
  leaveType: LeaveTypeDocument;
  startDate: string;
  endDate: string;
  dates: string[];
  workingDays: number;
  issues: LeaveIssue[];
  balances: LeaveBalance[];
}

@Injectable()
export class LeaveService {
  private readonly submitLock = new KeyedMutex();

  constructor(
    @InjectModel(LeaveRequest.name) private readonly leaveModel: Model<LeaveRequestDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    private readonly leaveTypes: LeaveTypesService,
    private readonly calendar: CalendarService,
    private readonly settings: SettingsService,
    private readonly attendance: AttendanceService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Submit a leave request (own). Validation failures are 422:
   * overlap with a pending/approved leave, or more working days than the remaining quota.
   */
  async create(user: AuthUser, dto: CreateLeaveDto) {
    const employeeId = requireEmployeeId(user);
    return this.submitLock.run(employeeId, async () => {
      const employee = await this.loadEmployee(employeeId);
      const assessment = await this.assess(employee, {
        leaveType: dto.leaveTypeId ?? dto.leaveType ?? '',
        startDate: dto.startDate,
        endDate: dto.endDate,
      });
      if (assessment.issues.length > 0) {
        const [first] = assessment.issues;
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: first.code,
          message: first.message,
          issues: assessment.issues,
        });
      }

      const leave = await this.leaveModel.create({
        employeeId: employee._id,
        departmentId: employee.departmentId,
        leaveTypeId: assessment.leaveType._id,
        leaveTypeName: assessment.leaveType.name,
        isPaid: assessment.leaveType.isPaid,
        startDate: assessment.startDate,
        endDate: assessment.endDate,
        dates: assessment.dates,
        workingDays: assessment.workingDays,
        reason: dto.reason ?? '',
        requestedBy: user.userId,
      });

      await this.audit.record({ actor: user, action: 'create', entity: 'LeaveRequest', entityId: leave._id, after: leave });
      await this.notifications.notifyRoles(
        [Role.HR, Role.Admin],
        {
          title: 'New leave request',
          message: `${employee.fullName} (${employee.code}) requested ${leave.workingDays} day(s) of ${leave.leaveTypeName} leave (${leave.startDate} → ${leave.endDate}).`,
          type: 'leave',
          entity: 'LeaveRequest',
          entityId: leave._id,
        },
        user.userId,
      );
      return leave.toJSON();
    });
  }

  /**
   * Validates a prospective request without saving it (also used by the AI smart-leave
   * preview). Working days skip configured weekend days and public holidays.
   */
  async assess(
    employee: EmployeeDocument,
    input: { leaveType: string; startDate: string; endDate: string },
  ): Promise<LeaveAssessment> {
    const leaveType = await this.leaveTypes.resolveActive(input.leaveType);
    const { startDate, endDate } = input;
    const issues: LeaveIssue[] = [];
    const base = { leaveType, startDate, endDate, dates: [] as string[], workingDays: 0, balances: [] as LeaveBalance[] };

    if (endDate < startDate) {
      issues.push({ code: 'INVALID_RANGE', message: 'endDate must be on or after startDate.' });
      return { ...base, issues };
    }
    if (diffInDays(startDate, endDate) >= MAX_LEAVE_SPAN_DAYS) {
      issues.push({ code: 'RANGE_TOO_LONG', message: `A single request cannot span more than ${MAX_LEAVE_SPAN_DAYS} days.` });
      return { ...base, issues };
    }
    if (startDate < employee.joinDate) {
      issues.push({ code: 'BEFORE_JOIN_DATE', message: `Leave cannot start before your join date (${employee.joinDate}).` });
    }
    if (employee.exitDate && endDate > employee.exitDate) {
      issues.push({ code: 'AFTER_EXIT_DATE', message: `Leave cannot end after your exit date (${employee.exitDate}).` });
    }

    const dates = await this.calendar.workingDays(startDate, endDate);
    if (dates.length === 0) {
      issues.push({
        code: 'NO_WORKING_DAYS',
        message: 'The selected dates contain no working days (only weekends/public holidays).',
      });
    }

    const overlap = await this.leaveModel
      .findOne({
        employeeId: employee._id,
        status: { $in: ACTIVE_LEAVE_STATUSES },
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
      })
      .exec();
    if (overlap) {
      issues.push({
        code: 'LEAVE_OVERLAP',
        message: `These dates overlap your ${overlap.status} ${overlap.leaveTypeName} leave (${overlap.startDate} → ${overlap.endDate}).`,
      });
    }

    // Quota is per calendar year — a request spanning New Year is checked against both years.
    const balances: LeaveBalance[] = [];
    const datesByYear = new Map<number, string[]>();
    for (const date of dates) {
      const year = yearOf(date);
      datesByYear.set(year, [...(datesByYear.get(year) ?? []), date]);
    }
    for (const [year, yearDates] of datesByYear) {
      const [balance] = await this.balancesFor(String(employee._id), year, [leaveType]);
      balances.push(balance);
      if (balance.available !== null && yearDates.length > balance.available) {
        issues.push({
          code: 'INSUFFICIENT_BALANCE',
          message:
            `Requested ${yearDates.length} working day(s) of ${leaveType.name} leave in ${year}, ` +
            `but only ${balance.available} are available (quota ${balance.quota}, approved ${balance.used}, pending ${balance.pending}).`,
        });
      }
    }

    return { leaveType, startDate, endDate, dates, workingDays: dates.length, issues, balances };
  }

  /** Smart-leave preview for the caller: validates a parsed draft without creating anything. */
  async previewForUser(user: AuthUser, input: { leaveType: string; startDate: string; endDate: string }) {
    const employee = await this.loadEmployee(requireEmployeeId(user));
    const assessment = await this.assess(employee, input);
    return {
      leaveTypeId: String(assessment.leaveType._id),
      leaveType: assessment.leaveType.name,
      startDate: assessment.startDate,
      endDate: assessment.endDate,
      workingDays: assessment.workingDays,
      dates: assessment.dates,
      canSubmit: assessment.issues.length === 0,
      issues: assessment.issues,
      balances: assessment.balances,
    };
  }

  async findAll(user: AuthUser, query: LeaveQueryDto) {
    const employeeId = resolveEmployeeScope(user, query.employeeId);
    const filter: Record<string, unknown> = {};
    if (employeeId) filter.employeeId = new Types.ObjectId(employeeId);
    if (query.status) filter.status = query.status;
    if (query.leaveTypeId) filter.leaveTypeId = new Types.ObjectId(query.leaveTypeId);
    if (query.departmentId && isManager(user)) filter.departmentId = new Types.ObjectId(query.departmentId);
    if (query.from) filter.endDate = { $gte: query.from };
    if (query.to) filter.startDate = { $lte: query.to };
    return paginate(this.leaveModel, filter, {
      page: query.page,
      limit: query.limit,
      sort: { createdAt: -1 },
      populate: { path: 'employeeId', select: 'code fullName departmentId designationId' },
    });
  }

  async findOne(user: AuthUser, id: string) {
    const leave = await this.leaveModel
      .findById(id)
      .populate('employeeId', 'code fullName departmentId designationId')
      .exec();
    if (!leave) throw new NotFoundException('Leave request not found');
    const ownerId = (leave.employeeId as unknown as { _id: Types.ObjectId })?._id ?? leave.employeeId;
    resolveEmployeeScope(user, String(ownerId));
    return leave.toJSON();
  }

  async approve(user: AuthUser, id: string, dto: ReviewLeaveDto) {
    const leave = await this.getPendingForReview(user, id);
    await this.assertQuotaOnApproval(leave);
    const before = leave.toObject();
    leave.status = 'approved';
    leave.reviewedBy = new Types.ObjectId(user.userId);
    leave.reviewComment = dto.comment ?? null;
    leave.reviewedAt = new Date();
    await leave.save();

    // Days already closed as `absent` become `on_leave`.
    const convertedDays = await this.attendance.applyApprovedLeave(leave);

    await this.audit.record({ actor: user, action: 'approve', entity: 'LeaveRequest', entityId: leave._id, before, after: leave });
    await this.notifications.notifyEmployee(leave.employeeId, {
      title: 'Leave approved',
      message: `Your ${leave.leaveTypeName} leave (${leave.startDate} → ${leave.endDate}) was approved${dto.comment ? `: ${dto.comment}` : '.'}`,
      type: 'leave',
      entity: 'LeaveRequest',
      entityId: leave._id,
    });
    return { ...leave.toJSON(), attendanceDaysUpdated: convertedDays };
  }

  async reject(user: AuthUser, id: string, dto: RejectLeaveDto) {
    const leave = await this.getPendingForReview(user, id);
    const before = leave.toObject();
    leave.status = 'rejected';
    leave.reviewedBy = new Types.ObjectId(user.userId);
    leave.reviewComment = dto.comment;
    leave.reviewedAt = new Date();
    await leave.save();

    await this.audit.record({ actor: user, action: 'reject', entity: 'LeaveRequest', entityId: leave._id, before, after: leave });
    await this.notifications.notifyEmployee(leave.employeeId, {
      title: 'Leave rejected',
      message: `Your ${leave.leaveTypeName} leave (${leave.startDate} → ${leave.endDate}) was rejected: ${dto.comment}`,
      type: 'leave',
      entity: 'LeaveRequest',
      entityId: leave._id,
    });
    return leave.toJSON();
  }

  /**
   * The requester may cancel their own leave while it is pending, or an approved leave that
   * has not started yet (the days return to their balance and HR is notified).
   */
  async cancel(user: AuthUser, id: string) {
    const leave = await this.leaveModel.findById(id).exec();
    if (!leave) throw new NotFoundException('Leave request not found');
    if (String(leave.employeeId) !== user.employeeId) {
      throw new ForbiddenException('You can only cancel your own leave requests.');
    }
    const settings = await this.settings.get();
    const today = todayIn(settings.timezone);
    const cancellable = leave.status === 'pending' || (leave.status === 'approved' && leave.startDate > today);
    if (!cancellable) {
      throw new ConflictException(
        leave.status === 'approved'
          ? 'Approved leave can only be cancelled before it starts.'
          : `This request is already ${leave.status}.`,
      );
    }
    const wasApproved = leave.status === 'approved';
    const before = leave.toObject();
    leave.status = 'cancelled';
    await leave.save();
    await this.audit.record({ actor: user, action: 'update', entity: 'LeaveRequest', entityId: leave._id, before, after: leave });
    if (wasApproved) {
      await this.notifications.notifyRoles(
        [Role.HR],
        {
          title: 'Approved leave cancelled',
          message: `${user.fullName} cancelled their approved ${leave.leaveTypeName} leave (${leave.startDate} → ${leave.endDate}).`,
          type: 'leave',
          entity: 'LeaveRequest',
          entityId: leave._id,
        },
        user.userId,
      );
    }
    return leave.toJSON();
  }

  /** Approval re-checks the quota so approved days can never exceed it (e.g. after a quota change). */
  private async assertQuotaOnApproval(leave: LeaveRequestDocument): Promise<void> {
    const leaveType = await this.leaveTypes.findOne(String(leave.leaveTypeId));
    if (leaveType.annualQuota === null || leaveType.annualQuota === undefined) return;
    const datesByYear = new Map<number, number>();
    for (const date of leave.dates) datesByYear.set(yearOf(date), (datesByYear.get(yearOf(date)) ?? 0) + 1);
    for (const [year, days] of datesByYear) {
      const [balance] = await this.balancesFor(String(leave.employeeId), year, [leaveType]);
      if (balance.used + days > leaveType.annualQuota) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'INSUFFICIENT_BALANCE',
          message: `Approving would exceed the ${leaveType.name} quota for ${year} (approved ${balance.used} + ${days} > ${leaveType.annualQuota}).`,
        });
      }
    }
  }

  /** Leave balances per type for a year (Employee: own only). */
  async getBalances(user: AuthUser, query: LeaveBalanceQueryDto) {
    const employeeId = resolveEmployeeScope(user, query.employeeId) ?? requireEmployeeId(user);
    const employee = await this.employeeModel.findById(employeeId, { code: 1, fullName: 1 }).exec();
    if (!employee) throw new NotFoundException('Employee not found');
    const settings = await this.settings.get();
    const year = query.year ?? yearOf(todayIn(settings.timezone));
    return {
      employeeId,
      employeeCode: employee.code,
      employeeName: employee.fullName,
      year,
      balances: await this.balancesFor(employeeId, year),
    };
  }

  async balancesFor(employeeId: string, year: number, types?: LeaveTypeDocument[]): Promise<LeaveBalance[]> {
    const leaveTypes = types ?? (await this.leaveTypes.findActiveDocuments());
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const rows = await this.leaveModel
      .aggregate<{ _id: { leaveTypeId: Types.ObjectId; status: string }; days: number }>([
        {
          $match: {
            employeeId: new Types.ObjectId(employeeId),
            status: { $in: ACTIVE_LEAVE_STATUSES },
            dates: { $elemMatch: { $gte: from, $lte: to } },
          },
        },
        { $unwind: '$dates' },
        { $match: { dates: { $gte: from, $lte: to } } },
        { $group: { _id: { leaveTypeId: '$leaveTypeId', status: '$status' }, days: { $sum: 1 } } },
      ])
      .exec();
    const daysFor = (leaveTypeId: unknown, status: string) =>
      rows.find((r) => String(r._id.leaveTypeId) === String(leaveTypeId) && r._id.status === status)?.days ?? 0;

    return leaveTypes.map((type) => {
      const used = daysFor(type._id, 'approved');
      const pending = daysFor(type._id, 'pending');
      const quota = type.annualQuota ?? null;
      return {
        leaveTypeId: String(type._id),
        leaveType: type.name,
        isPaid: type.isPaid,
        unlimited: quota === null,
        quota,
        used,
        pending,
        remaining: quota === null ? null : Math.max(0, quota - used),
        available: quota === null ? null : Math.max(0, quota - used - pending),
      };
    });
  }

  /** Working-day preview for a date range (weekends & public holidays excluded). */
  async workingDays(query: WorkingDaysQueryDto) {
    if (query.endDate < query.startDate) throw new BadRequestException('endDate must be on or after startDate');
    if (diffInDays(query.startDate, query.endDate) >= MAX_LEAVE_SPAN_DAYS) {
      throw new BadRequestException(`Range cannot exceed ${MAX_LEAVE_SPAN_DAYS} days`);
    }
    const calendar = await this.calendar.forRange(query.startDate, query.endDate);
    const dates = calendar.workingDays(query.startDate, query.endDate);
    return { startDate: query.startDate, endDate: query.endDate, workingDays: dates.length, dates };
  }

  async recentForEmployee(employeeId: string, limit = 5) {
    const leaves = await this.leaveModel
      .find({ employeeId: new Types.ObjectId(employeeId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
    return leaves.map((l) => l.toJSON());
  }

  private async loadEmployee(employeeId: string): Promise<EmployeeDocument> {
    const employee = await this.employeeModel.findById(employeeId).exec();
    if (!employee) throw new NotFoundException('Employee profile not found');
    if (employee.status === 'exited') throw new ForbiddenException('Exited employees cannot apply for leave.');
    return employee;
  }

  private async getPendingForReview(user: AuthUser, id: string): Promise<LeaveRequestDocument> {
    const leave = await this.leaveModel.findById(id).exec();
    if (!leave) throw new NotFoundException('Leave request not found');
    if (leave.status !== 'pending') {
      throw new ConflictException(`This leave request has already been ${leave.status}.`);
    }
    if (user.employeeId && String(leave.employeeId) === user.employeeId) {
      throw new ForbiddenException('You cannot review your own leave request.');
    }
    return leave;
  }
}
