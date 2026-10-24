import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DateTime } from 'luxon';
import { Model, Types, type PipelineStage } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { addDays, diffInDays, startOfMonth, todayIn } from '../../common/utils/date.util.js';
import { percent, round2 } from '../../common/utils/number.util.js';
import { assertManager, isEmployee, isManager, resolveEmployeeScope } from '../../common/utils/scope.util.js';
import {
  AttendanceCorrection,
  type AttendanceCorrectionDocument,
} from '../attendance/schemas/attendance-correction.schema.js';
import { ATTENDANCE_STATUSES, Attendance, type AttendanceDocument } from '../attendance/schemas/attendance.schema.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { LeaveRequest, type LeaveRequestDocument } from '../leave/schemas/leave-request.schema.js';
import { SALARY_COMPONENT_RATES } from '../payroll/payroll.calculator.js';
import { PayrollRun, type PayrollRunDocument } from '../payroll/schemas/payroll-run.schema.js';
import { Payslip, type PayslipDocument } from '../payroll/schemas/payslip.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { DesignationsService } from '../setup/designations.service.js';
import { LeaveType, type LeaveTypeDocument } from '../setup/schemas/leave-type.schema.js';
import { SettingsService } from '../setup/settings.service.js';
import {
  attendanceKpis,
  attritionRate,
  attritionRiskScore,
  detectAbsenceFlags,
  EMPTY_STATUS_COUNTS,
  toStatusCounts,
  type StatusCounts,
} from './kpi.util.js';

export interface DashboardQuery {
  startDate?: string;
  endDate?: string;
  departmentId?: string;
  /** Drill-down to one employee (Admin/HR). Employees are always pinned to themselves. */
  employeeId?: string;
  limit?: number;
}

export interface DashboardFilters {
  startDate: string;
  endDate: string;
  departmentId?: string;
  employeeId?: string;
}

interface EmployeeAttendanceStats extends StatusCounts {
  _id: Types.ObjectId;
  departmentId: Types.ObjectId | null;
  absentDates: (string | null)[];
}

const MAX_RANGE_DAYS = 731;
const GROSS_MULTIPLIER = 1 + SALARY_COMPONENT_RATES.hraRate + SALARY_COMPONENT_RATES.medicalRate;

const oid = (id: string) => new Types.ObjectId(id);

/** One `$sum` per attendance status → `{ present: n, late: n, ... }` in a single `$group`. */
const STATUS_SUMS = Object.fromEntries(
  ATTENDANCE_STATUSES.map((status) => [status, { $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } }]),
);

/**
 * Server-side KPI aggregations, filtered by startDate / endDate / departmentId.
 * Every method takes the caller so data scope is enforced here (not only in the
 * controller): the AI tools call these exact methods, so assistant answers match the
 * dashboards and an Employee only ever sees their own numbers.
 */
@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<AttendanceDocument>,
    @InjectModel(LeaveRequest.name) private readonly leaveModel: Model<LeaveRequestDocument>,
    @InjectModel(LeaveType.name) private readonly leaveTypeModel: Model<LeaveTypeDocument>,
    @InjectModel(Payslip.name) private readonly payslipModel: Model<PayslipDocument>,
    @InjectModel(PayrollRun.name) private readonly runModel: Model<PayrollRunDocument>,
    @InjectModel(AttendanceCorrection.name) private readonly correctionModel: Model<AttendanceCorrectionDocument>,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly departments: DepartmentsService,
    private readonly designations: DesignationsService,
  ) {}

  async resolveFilters(user: AuthUser, query: DashboardQuery): Promise<DashboardFilters> {
    const settings = await this.settings.get();
    const endDate = query.endDate ?? todayIn(settings.timezone);
    const startDate = query.startDate ?? startOfMonth(endDate);
    if (startDate > endDate) throw new BadRequestException('startDate must be on or before endDate');
    if (diffInDays(startDate, endDate) > MAX_RANGE_DAYS) {
      throw new BadRequestException(`The date range cannot exceed ${MAX_RANGE_DAYS} days`);
    }
    return {
      startDate,
      endDate,
      departmentId: query.departmentId,
      employeeId: resolveEmployeeScope(user, query.employeeId),
    };
  }

  // ── Headcount & attrition ───────────────────────────────

  /** Headcount = active + probation employees employed on the end date. */
  async getHeadcount(user: AuthUser, query: DashboardQuery) {
    assertManager(user, 'Headcount is available to Admin and HR only.');
    const filters = await this.resolveFilters(user, query);
    return { date: filters.endDate, departmentId: filters.departmentId ?? null, ...(await this.headcountAt(filters.endDate, filters)) };
  }

  /** Attrition % = exits in period / average headcount × 100. */
  async getAttrition(user: AuthUser, query: DashboardQuery) {
    assertManager(user, 'Attrition is available to Admin and HR only.');
    const f = await this.resolveFilters(user, query);
    const exitMatch: Record<string, unknown> = { exitDate: { $gte: f.startDate, $lte: f.endDate } };
    if (f.departmentId) exitMatch.departmentId = oid(f.departmentId);

    const [start, end, exitRows, names] = await Promise.all([
      this.headcountAt(f.startDate, f),
      this.headcountAt(f.endDate, f),
      this.employeeModel
        .aggregate<{ _id: Types.ObjectId | null; count: number }>([
          { $match: exitMatch },
          { $group: { _id: '$departmentId', count: { $sum: 1 } } },
        ])
        .exec(),
      this.departments.nameMap(),
    ]);
    const exits = exitRows.reduce((sum, r) => sum + r.count, 0);
    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      exits,
      headcountStart: start.total,
      headcountEnd: end.total,
      ...attritionRate(exits, start.total, end.total),
      exitsByDepartment: exitRows.map((r) => ({
        departmentId: r._id ? String(r._id) : null,
        department: names.get(String(r._id)) ?? 'Unassigned',
        exits: r.count,
      })),
    };
  }

  // ── Attendance ──────────────────────────────────────────

  /**
   * Attendance rate = (present + late + missing_checkout + 0.5 × half_day) / (working_day_records − on_leave)
   * Late %          = late / (present + late)
   */
  async getAttendanceSummary(user: AuthUser, query: DashboardQuery) {
    const f = await this.resolveFilters(user, query);
    const rows = await this.attendanceModel
      .aggregate<{ _id: string; count: number }>([
        { $match: this.attendanceMatch(f) },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();
    const counts = toStatusCounts(rows);
    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      employeeId: f.employeeId ?? null,
      scope: f.employeeId ? 'employee' : 'organization',
      counts,
      ...attendanceKpis(counts),
      byDepartment: isManager(user) && !f.employeeId ? await this.attendanceByDepartment(f) : undefined,
    };
  }

  async getLateComers(user: AuthUser, query: DashboardQuery) {
    const f = await this.resolveFilters(user, query);
    const limit = Math.min(query.limit ?? 10, 100);
    const [result] = await this.attendanceModel
      .aggregate<{
        top: { _id: Types.ObjectId; lateCount: number; avgLateMinutes: number; maxLateMinutes: number; lastLateDate: string }[];
        totals: { lateArrivals: number; employees: number }[];
      }>([
        { $match: this.attendanceMatch(f, { status: 'late' }) },
        {
          $facet: {
            top: [
              {
                $group: {
                  _id: '$employeeId',
                  lateCount: { $sum: 1 },
                  avgLateMinutes: { $avg: '$lateMinutes' },
                  maxLateMinutes: { $max: '$lateMinutes' },
                  lastLateDate: { $max: '$date' },
                },
              },
              { $sort: { lateCount: -1, avgLateMinutes: -1 } },
              { $limit: limit },
            ],
            totals: [
              { $group: { _id: null, lateArrivals: { $sum: 1 }, employees: { $addToSet: '$employeeId' } } },
              { $project: { _id: 0, lateArrivals: 1, employees: { $size: '$employees' } } },
            ],
          },
        },
      ])
      .exec();
    const info = await this.employeeInfo(result.top.map((r) => r._id));
    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      totalLateArrivals: result.totals[0]?.lateArrivals ?? 0,
      employeesWithLates: result.totals[0]?.employees ?? 0,
      data: result.top.map((r) => ({
        ...info.get(String(r._id)),
        employeeId: String(r._id),
        lateCount: r.lateCount,
        avgLateMinutes: round2(r.avgLateMinutes ?? 0),
        maxLateMinutes: r.maxLateMinutes ?? 0,
        lastLateDate: r.lastLateDate,
      })),
    };
  }

  /** Absenteeism = absent_days / expected_working_days, per department. */
  async getAbsenteeism(user: AuthUser, query: DashboardQuery) {
    const f = await this.resolveFilters(user, query);
    const [rows, names] = await Promise.all([
      this.attendanceModel
        .aggregate<{ _id: Types.ObjectId | null; absent: number; onLeave: number; total: number }>([
          { $match: this.attendanceMatch(f) },
          {
            $group: {
              _id: '$departmentId',
              absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
              onLeave: { $sum: { $cond: [{ $eq: ['$status', 'on_leave'] }, 1, 0] } },
              total: { $sum: 1 },
            },
          },
        ])
        .exec(),
      this.departments.nameMap(),
    ]);
    const byDepartment = rows
      .map((r) => {
        const expectedWorkingDays = r.total - r.onLeave;
        return {
          departmentId: r._id ? String(r._id) : null,
          department: names.get(String(r._id)) ?? 'Unassigned',
          absentDays: r.absent,
          expectedWorkingDays,
          absenteeismRate: percent(r.absent, expectedWorkingDays),
        };
      })
      .sort((a, b) => b.absenteeismRate - a.absenteeismRate);
    const absentDays = byDepartment.reduce((s, d) => s + d.absentDays, 0);
    const expectedWorkingDays = byDepartment.reduce((s, d) => s + d.expectedWorkingDays, 0);
    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      overall: { absentDays, expectedWorkingDays, absenteeismRate: percent(absentDays, expectedWorkingDays) },
      byDepartment,
    };
  }

  // ── Leave ───────────────────────────────────────────────

  /** Leave utilization = approved_days / quota, per leave type and department. */
  async getLeaveUtilization(user: AuthUser, query: DashboardQuery) {
    const f = await this.resolveFilters(user, query);
    const match: Record<string, unknown> = {
      status: 'approved',
      dates: { $elemMatch: { $gte: f.startDate, $lte: f.endDate } },
    };
    if (f.departmentId) match.departmentId = oid(f.departmentId);
    if (f.employeeId) match.employeeId = oid(f.employeeId);

    const [rows, leaveTypes, names] = await Promise.all([
      this.leaveModel
        .aggregate<{ _id: { leaveTypeId: Types.ObjectId; departmentId: Types.ObjectId | null }; days: number }>([
          { $match: match },
          { $unwind: '$dates' },
          { $match: { dates: { $gte: f.startDate, $lte: f.endDate } } },
          { $group: { _id: { leaveTypeId: '$leaveTypeId', departmentId: '$departmentId' }, days: { $sum: 1 } } },
        ])
        .exec(),
      this.leaveTypeModel.find().sort({ name: 1 }).lean().exec(),
      this.departments.nameMap(),
    ]);

    // Quota pool = annual quota × headcount (1 when scoped to a single employee).
    let headcountByDept: Map<string, number>;
    let headcountTotal: number;
    if (f.employeeId) {
      const employee = await this.employeeModel.findById(f.employeeId, { departmentId: 1 }).lean().exec();
      headcountByDept = new Map([[String(employee?.departmentId), 1]]);
      headcountTotal = 1;
    } else {
      const headcount = await this.headcountAt(f.endDate, f);
      headcountByDept = new Map(headcount.byDepartment.map((d) => [String(d.departmentId), d.headcount]));
      headcountTotal = headcount.total;
    }

    const daysFor = (typeId: string, deptId?: string) =>
      rows
        .filter((r) => String(r._id.leaveTypeId) === typeId && (deptId === undefined || String(r._id.departmentId) === deptId))
        .reduce((s, r) => s + r.days, 0);

    const used = (type: (typeof leaveTypes)[number]) => type.isActive || rows.some((r) => String(r._id.leaveTypeId) === String(type._id));
    const relevantTypes = leaveTypes.filter(used);

    const byLeaveType = relevantTypes.map((type) => {
      const approvedDays = daysFor(String(type._id));
      const quota = type.annualQuota === null || type.annualQuota === undefined ? null : type.annualQuota * headcountTotal;
      return {
        leaveTypeId: String(type._id),
        leaveType: type.name,
        approvedDays,
        quota,
        utilization: quota ? percent(approvedDays, quota) : null,
      };
    });

    const departmentIds = new Set([...headcountByDept.keys(), ...rows.map((r) => String(r._id.departmentId))]);
    const byLeaveTypeAndDepartment = relevantTypes.flatMap((type) =>
      [...departmentIds].map((deptId) => {
        const approvedDays = daysFor(String(type._id), deptId);
        const headcount = headcountByDept.get(deptId) ?? 0;
        const quota = type.annualQuota === null || type.annualQuota === undefined ? null : type.annualQuota * headcount;
        return {
          leaveTypeId: String(type._id),
          leaveType: type.name,
          departmentId: deptId === 'null' ? null : deptId,
          department: names.get(deptId) ?? 'Unassigned',
          headcount,
          approvedDays,
          quota,
          utilization: quota ? percent(approvedDays, quota) : null,
        };
      }),
    );

    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      employeeId: f.employeeId ?? null,
      headcount: headcountTotal,
      byLeaveType,
      byLeaveTypeAndDepartment,
    };
  }

  /** Request counts by status (overlapping the period) + utilization. */
  async getLeaveSummary(user: AuthUser, query: DashboardQuery) {
    const f = await this.resolveFilters(user, query);
    const match: Record<string, unknown> = { startDate: { $lte: f.endDate }, endDate: { $gte: f.startDate } };
    if (f.departmentId) match.departmentId = oid(f.departmentId);
    if (f.employeeId) match.employeeId = oid(f.employeeId);
    const onLeaveMatch: Record<string, unknown> = {
      status: 'approved',
      dates: { $elemMatch: { $gte: f.startDate, $lte: f.endDate } },
    };
    if (f.departmentId) onLeaveMatch.departmentId = oid(f.departmentId);
    if (f.employeeId) onLeaveMatch.employeeId = oid(f.employeeId);

    const [statusRows, utilization, onLeaveRows] = await Promise.all([
      this.leaveModel
        .aggregate<{ _id: string; requests: number; workingDays: number }>([
          { $match: match },
          { $group: { _id: '$status', requests: { $sum: 1 }, workingDays: { $sum: '$workingDays' } } },
        ])
        .exec(),
      this.getLeaveUtilization(user, { ...query, employeeId: f.employeeId }),
      // Who is (or was) on approved leave inside the period — e.g. startDate = endDate = today.
      this.leaveModel
        .aggregate<{ employeeId: Types.ObjectId; leaveTypeName: string; startDate: string; endDate: string; daysInRange: number }>([
          { $match: onLeaveMatch },
          {
            $project: {
              employeeId: 1,
              leaveTypeName: 1,
              startDate: 1,
              endDate: 1,
              daysInRange: {
                $size: {
                  $filter: {
                    input: '$dates',
                    as: 'd',
                    cond: { $and: [{ $gte: ['$$d', f.startDate] }, { $lte: ['$$d', f.endDate] }] },
                  },
                },
              },
            },
          },
          { $sort: { startDate: 1 } },
          { $limit: 100 },
        ])
        .exec(),
    ]);
    const requestsByStatus = Object.fromEntries(
      ['pending', 'approved', 'rejected', 'cancelled'].map((status) => {
        const row = statusRows.find((r) => r._id === status);
        return [status, { requests: row?.requests ?? 0, workingDays: row?.workingDays ?? 0 }];
      }),
    );
    const info = await this.employeeInfo(onLeaveRows.map((r) => r.employeeId));
    const onLeave = onLeaveRows.map((r) => ({
      employeeId: String(r.employeeId),
      fullName: info.get(String(r.employeeId))?.fullName ?? 'Unknown',
      code: info.get(String(r.employeeId))?.code ?? '',
      department: info.get(String(r.employeeId))?.department ?? 'Unassigned',
      leaveType: r.leaveTypeName,
      startDate: r.startDate,
      endDate: r.endDate,
      daysInRange: r.daysInRange,
    }));
    const onLeaveByType: Record<string, number> = {};
    for (const leaveType of new Set(onLeave.map((l) => l.leaveType))) {
      onLeaveByType[leaveType] = new Set(onLeave.filter((l) => l.leaveType === leaveType).map((l) => l.employeeId)).size;
    }
    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      employeeId: f.employeeId ?? null,
      requestsByStatus,
      employeesOnLeave: new Set(onLeave.map((l) => l.employeeId)).size,
      onLeaveByType,
      onLeave,
      byLeaveType: utilization.byLeaveType,
      byLeaveTypeAndDepartment: f.employeeId ? undefined : utilization.byLeaveTypeAndDepartment,
    };
  }

  // ── Today / trend / demographics (role dashboards) ──────

  /** HR "today" KPIs: headcount, present, late, on leave, not checked in, pending approvals. */
  async getToday(user: AuthUser, query: Pick<DashboardQuery, 'departmentId'>) {
    assertManager(user, "Today's board is available to Admin and HR only.");
    const settings = await this.settings.get();
    const today = todayIn(settings.timezone);
    const f: DashboardFilters = { startDate: today, endDate: today, departmentId: query.departmentId };
    const attendanceMatch: Record<string, unknown> = { date: today };
    if (f.departmentId) attendanceMatch.departmentId = oid(f.departmentId);
    const pendingLeaveMatch: Record<string, unknown> = { status: 'pending' };
    if (f.departmentId) pendingLeaveMatch.departmentId = oid(f.departmentId);

    const [calendar, headcount, rows, leaveSummary, pendingLeave, pendingCorrections] = await Promise.all([
      this.calendar.forRange(today, today),
      this.headcountAt(today, f),
      this.attendanceModel
        .aggregate<{ _id: string; count: number }>([{ $match: attendanceMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }])
        .exec(),
      this.getLeaveSummary(user, { startDate: today, endDate: today, departmentId: f.departmentId }),
      this.leaveModel.countDocuments(pendingLeaveMatch).exec(),
      this.correctionModel.countDocuments({ status: 'pending' }).exec(),
    ]);
    const counts = toStatusCounts(rows);
    const present = counts.present + counts.late + counts.half_day + counts.missing_checkout;
    const isWorkingDay = calendar.isWorkingDay(today);
    return {
      date: today,
      isWorkingDay,
      headcount: headcount.total,
      present,
      onTime: counts.present,
      late: counts.late,
      halfDay: counts.half_day,
      onLeave: leaveSummary.employeesOnLeave,
      onLeaveByType: leaveSummary.onLeaveByType,
      notCheckedIn: isWorkingDay ? Math.max(0, headcount.total - present - leaveSummary.employeesOnLeave) : 0,
      pendingApprovals: { leave: pendingLeave, corrections: pendingCorrections, total: pendingLeave + pendingCorrections },
    };
  }

  /** Daily attendance series for trend charts (Employee: own days only). */
  async getAttendanceTrend(user: AuthUser, query: DashboardQuery) {
    const f = await this.resolveFilters(user, query);
    const rows = await this.attendanceModel
      .aggregate<StatusCounts & { _id: string }>([
        { $match: this.attendanceMatch(f) },
        { $group: { _id: '$date', ...STATUS_SUMS } },
        { $sort: { _id: 1 } },
      ])
      .exec();
    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      data: rows.map(({ _id, ...raw }) => {
        const counts = { ...EMPTY_STATUS_COUNTS, ...raw };
        const kpis = attendanceKpis(counts);
        return { date: _id, counts, attendanceRate: kpis.attendanceRate, latePercent: kpis.latePercent };
      }),
    };
  }

  /** Gender mix and tenure bands of the headcount on the end date. */
  async getDemographics(user: AuthUser, query: DashboardQuery) {
    assertManager(user, 'Workforce demographics are available to Admin and HR only.');
    const f = await this.resolveFilters(user, query);
    const end = DateTime.fromISO(f.endDate, { zone: 'utc' });
    const cutoff = (years: number, months = 0) => end.minus({ years, months }).toISODate()!;
    // `then` is MongoDB $switch syntax, not a Promise-like object.
    /* oxlint-disable unicorn/no-thenable */
    const tenureBand = {
      $switch: {
        branches: [
          { case: { $lte: ['$joinDate', cutoff(5)] }, then: '5y+' },
          { case: { $lte: ['$joinDate', cutoff(3)] }, then: '3-5y' },
          { case: { $lte: ['$joinDate', cutoff(1)] }, then: '1-3y' },
          { case: { $lte: ['$joinDate', cutoff(0, 6)] }, then: '6-12m' },
        ],
        default: '<6m',
      },
    };
    /* oxlint-enable unicorn/no-thenable */
    const [result] = await this.employeeModel
      .aggregate<{ gender: { _id: string | null; count: number }[]; tenure: { _id: string; count: number }[] }>([
        { $match: this.employedOnMatch(f.endDate, f) },
        {
          $facet: {
            gender: [{ $group: { _id: '$gender', count: { $sum: 1 } } }],
            tenure: [{ $group: { _id: tenureBand, count: { $sum: 1 } } }],
          },
        },
      ])
      .exec();
    const bands = ['<6m', '6-12m', '1-3y', '3-5y', '5y+'];
    return {
      date: f.endDate,
      departmentId: f.departmentId ?? null,
      gender: ['male', 'female', 'other', 'unspecified'].map((g) => ({
        gender: g,
        count: (result?.gender ?? []).filter((r) => (r._id ?? 'unspecified') === g).reduce((s, r) => s + r.count, 0),
      })),
      tenure: bands.map((band) => ({ band, count: result?.tenure.find((t) => t._id === band)?.count ?? 0 })),
    };
  }

  // ── Payroll ─────────────────────────────────────────────

  /** Sum of gross and net by month and department (payslips of runs in the period). */
  async getPayrollCost(user: AuthUser, query: DashboardQuery) {
    const f = await this.resolveFilters(user, query);
    const startMonth = f.startDate.slice(0, 7);
    const endMonth = f.endDate.slice(0, 7);
    const match: Record<string, unknown> = { month: { $gte: startMonth, $lte: endMonth } };
    if (f.departmentId) match['employee.departmentId'] = oid(f.departmentId);
    if (f.employeeId) match.employeeId = oid(f.employeeId);
    if (isEmployee(user)) match.status = 'finalized';

    const [rows, runs, names] = await Promise.all([
      this.payslipModel
        .aggregate<{
          _id: { month: string; departmentId: Types.ObjectId | null };
          gross: number;
          proratedGross: number;
          attendanceDeduction: number;
          tax: number;
          net: number;
          employees: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: { month: '$month', departmentId: '$employee.departmentId' },
              gross: { $sum: '$gross' },
              proratedGross: { $sum: '$proratedGross' },
              attendanceDeduction: { $sum: '$attendanceDeduction' },
              tax: { $sum: '$monthlyTax' },
              net: { $sum: '$netPay' },
              employees: { $sum: 1 },
            },
          },
          { $sort: { '_id.month': 1 } },
        ])
        .exec(),
      this.runModel.find({ month: { $gte: startMonth, $lte: endMonth } }, { month: 1, status: 1 }).lean().exec(),
      this.departments.nameMap(),
    ]);

    const zero = { gross: 0, proratedGross: 0, attendanceDeduction: 0, tax: 0, net: 0, employees: 0 };
    const add = (a: typeof zero, b: typeof zero) => ({
      gross: round2(a.gross + b.gross),
      proratedGross: round2(a.proratedGross + b.proratedGross),
      attendanceDeduction: round2(a.attendanceDeduction + b.attendanceDeduction),
      tax: round2(a.tax + b.tax),
      net: round2(a.net + b.net),
      employees: a.employees + b.employees,
    });

    const byMonthMap = new Map<string, typeof zero>();
    for (const r of rows) byMonthMap.set(r._id.month, add(byMonthMap.get(r._id.month) ?? zero, r));
    const runStatus = new Map(runs.map((r) => [r.month, r.status]));

    return {
      startMonth,
      endMonth,
      departmentId: f.departmentId ?? null,
      byMonth: [...byMonthMap.entries()].map(([month, totals]) => ({
        month,
        runStatus: runStatus.get(month) ?? null,
        ...totals,
      })),
      byMonthAndDepartment: rows.map((r) => ({
        month: r._id.month,
        departmentId: r._id.departmentId ? String(r._id.departmentId) : null,
        department: names.get(String(r._id.departmentId)) ?? 'Unassigned',
        ...add(zero, r),
      })),
      totals: [...byMonthMap.values()].reduce(add, zero),
    };
  }

  /** Mean gross by department and designation (payslips in the period; employee master as fallback). */
  async getAverageSalary(user: AuthUser, query: DashboardQuery) {
    assertManager(user, 'Salary averages are available to Admin and HR only.');
    const f = await this.resolveFilters(user, query);
    const startMonth = f.startDate.slice(0, 7);
    const endMonth = f.endDate.slice(0, 7);
    const [deptNames, desigNames] = await Promise.all([this.departments.nameMap(), this.designations.nameMap()]);

    const payslipMatch: Record<string, unknown> = { month: { $gte: startMonth, $lte: endMonth } };
    if (f.departmentId) payslipMatch['employee.departmentId'] = oid(f.departmentId);
    if (f.employeeId) payslipMatch.employeeId = oid(f.employeeId);

    const groupBy = (field: string): PipelineStage.FacetPipelineStage[] => [
      { $group: { _id: field, averageGross: { $avg: '$gross' }, employees: { $addToSet: '$employeeId' } } },
      { $project: { averageGross: 1, employees: { $size: '$employees' } } },
      { $sort: { averageGross: -1 } },
    ];
    let source: 'payslips' | 'employee_master' = 'payslips';
    let [result] = await this.payslipModel
      .aggregate<{ byDepartment: AvgRow[]; byDesignation: AvgRow[] }>([
        { $match: payslipMatch },
        { $facet: { byDepartment: groupBy('$employee.departmentId'), byDesignation: groupBy('$employee.designationId') } },
      ])
      .exec();

    if (!result || result.byDepartment.length === 0) {
      source = 'employee_master';
      const withGross: PipelineStage[] = [
        { $match: this.employedOnMatch(f.endDate, f) },
        { $addFields: { gross: { $multiply: ['$basicSalary', GROSS_MULTIPLIER] }, employeeId: '$_id' } },
      ];
      [result] = await this.employeeModel
        .aggregate<{ byDepartment: AvgRow[]; byDesignation: AvgRow[] }>([
          ...withGross,
          { $facet: { byDepartment: groupBy('$departmentId'), byDesignation: groupBy('$designationId') } },
        ])
        .exec();
    }

    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      source,
      byDepartment: (result?.byDepartment ?? []).map((r) => ({
        departmentId: r._id ? String(r._id) : null,
        department: deptNames.get(String(r._id)) ?? 'Unassigned',
        averageGross: round2(r.averageGross),
        employees: r.employees,
      })),
      byDesignation: (result?.byDesignation ?? []).map((r) => ({
        designationId: r._id ? String(r._id) : null,
        designation: desigNames.get(String(r._id)) ?? 'Unassigned',
        averageGross: round2(r.averageGross),
        employees: r.employees,
      })),
    };
  }

  // ── Bonus: attrition risk & absence anomalies ───────────

  async getAttritionRisk(user: AuthUser, query: DashboardQuery) {
    assertManager(user, 'Attrition risk is available to Admin and HR only.');
    const f = await this.resolveFilters(user, query);
    const limit = Math.min(query.limit ?? 10, 100);

    const employees = (
      await this.employeeModel
        .find(this.employedOnMatch(f.endDate, f), {
          code: 1,
          fullName: 1,
          departmentId: 1,
          designationId: 1,
          joinDate: 1,
          status: 1,
          basicSalary: 1,
        })
        .lean()
        .exec()
    ).filter((e) => e.status !== 'exited');

    const unplannedMatch: Record<string, unknown> = {
      status: 'approved',
      $or: [{ isPaid: false }, { leaveTypeName: { $regex: /^sick$/i } }],
      dates: { $elemMatch: { $gte: f.startDate, $lte: f.endDate } },
    };
    if (f.departmentId) unplannedMatch.departmentId = oid(f.departmentId);

    const [attendance, unplannedRows, deptNames] = await Promise.all([
      this.perEmployeeAttendance(f),
      this.leaveModel
        .aggregate<{ _id: Types.ObjectId; days: number }>([
          { $match: unplannedMatch },
          { $unwind: '$dates' },
          { $match: { dates: { $gte: f.startDate, $lte: f.endDate } } },
          { $group: { _id: '$employeeId', days: { $sum: 1 } } },
        ])
        .exec(),
      this.departments.nameMap(),
    ]);
    const unplanned = new Map(unplannedRows.map((r) => [String(r._id), r.days]));

    const deptBasic = new Map<string, { sum: number; count: number }>();
    for (const e of employees) {
      const key = String(e.departmentId);
      const agg = deptBasic.get(key) ?? { sum: 0, count: 0 };
      deptBasic.set(key, { sum: agg.sum + e.basicSalary, count: agg.count + 1 });
    }

    const scored = employees.map((e) => {
      const stats = attendance.get(String(e._id));
      const counts = stats ?? { ...EMPTY_STATUS_COUNTS };
      const dept = deptBasic.get(String(e.departmentId));
      const risk = attritionRiskScore({
        absent: counts.absent,
        expectedWorkingDays: attendanceKpis(counts).expectedWorkingDays,
        late: counts.late,
        onTime: counts.present,
        missingCheckouts: counts.missing_checkout,
        unplannedLeaveDays: unplanned.get(String(e._id)) ?? 0,
        tenureMonths: Math.max(0, Math.floor(diffInDays(e.joinDate, f.endDate) / 30.44)),
        onProbation: e.status === 'probation',
        salaryRatio: dept && dept.count >= 2 ? e.basicSalary / (dept.sum / dept.count) : null,
      });
      return {
        employeeId: String(e._id),
        code: e.code,
        fullName: e.fullName,
        department: deptNames.get(String(e.departmentId)) ?? 'Unassigned',
        status: e.status,
        ...risk,
        reasons: risk.factors.filter((x) => x.contribution > 0).map((x) => x.detail),
      };
    });
    scored.sort((a, b) => b.score - a.score);

    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      methodology:
        'Explainable 0-100 score: absence (30), lateness (15), sick/unpaid leave (15), tenure < 12 months (15), ' +
        'probation (10), pay below department average (10), missing check-outs (5). High ≥ 60, medium ≥ 35.',
      summary: {
        evaluated: scored.length,
        high: scored.filter((s) => s.level === 'high').length,
        medium: scored.filter((s) => s.level === 'medium').length,
        low: scored.filter((s) => s.level === 'low').length,
      },
      data: scored.slice(0, limit),
    };
  }

  async getAbsenceAnomalies(user: AuthUser, query: DashboardQuery) {
    assertManager(user, 'Absence anomalies are available to Admin and HR only.');
    const f = await this.resolveFilters(user, query);
    const limit = Math.min(query.limit ?? 20, 100);

    const [attendance, calendar] = await Promise.all([
      this.perEmployeeAttendance(f),
      this.calendar.forRange(addDays(f.startDate, -1), addDays(f.endDate, 1)),
    ]);
    const workingDays = calendar.workingDays(f.startDate, f.endDate);

    const deptTotals = new Map<string, { absent: number; expected: number }>();
    for (const stats of attendance.values()) {
      const key = String(stats.departmentId);
      const agg = deptTotals.get(key) ?? { absent: 0, expected: 0 };
      deptTotals.set(key, {
        absent: agg.absent + stats.absent,
        expected: agg.expected + attendanceKpis(stats).expectedWorkingDays,
      });
    }

    const flagged: { employeeId: string; absentDays: number; flags: ReturnType<typeof detectAbsenceFlags>; absenceRate: number; departmentAverageRate: number }[] = [];
    for (const [employeeId, stats] of attendance) {
      const dept = deptTotals.get(String(stats.departmentId));
      const departmentAverageRate = dept && dept.expected > 0 ? dept.absent / dept.expected : 0;
      const expected = attendanceKpis(stats).expectedWorkingDays;
      const flags = detectAbsenceFlags({
        absentDates: stats.absentDates.filter((d): d is string => !!d),
        expectedWorkingDays: expected,
        departmentAverageRate,
        missingCheckouts: stats.missing_checkout,
        calendar,
        workingDays,
        addDays,
      });
      if (flags.length) {
        flagged.push({
          employeeId,
          absentDays: stats.absent,
          absenceRate: percent(stats.absent, expected),
          departmentAverageRate: round2(departmentAverageRate * 100),
          flags,
        });
      }
    }
    flagged.sort((a, b) => b.flags.length - a.flags.length || b.absentDays - a.absentDays);
    const top = flagged.slice(0, limit);
    const info = await this.employeeInfo(top.map((t) => oid(t.employeeId)));

    return {
      startDate: f.startDate,
      endDate: f.endDate,
      departmentId: f.departmentId ?? null,
      flaggedEmployees: flagged.length,
      data: top.map((t) => ({ ...info.get(t.employeeId), ...t })),
    };
  }

  /** Every KPI in one response (dashboard landing page & AI dashboard summary). */
  async getSummary(user: AuthUser, query: DashboardQuery) {
    assertManager(user, 'The dashboard is available to Admin and HR only.');
    const f = await this.resolveFilters(user, query);
    const q: DashboardQuery = { startDate: f.startDate, endDate: f.endDate, departmentId: f.departmentId };
    const ytd: DashboardQuery = { startDate: `${f.endDate.slice(0, 4)}-01-01`, endDate: f.endDate, departmentId: f.departmentId };
    const [
      headcount,
      attrition,
      attritionYtd,
      attendance,
      attendanceTrend,
      absenteeism,
      leaveUtilization,
      payrollCost,
      averageSalary,
      demographics,
      lateComers,
      attritionRisk,
      absenceAnomalies,
      today,
    ] = await Promise.all([
      this.getHeadcount(user, q),
      this.getAttrition(user, q),
      this.getAttrition(user, ytd),
      this.getAttendanceSummary(user, q),
      this.getAttendanceTrend(user, q),
      this.getAbsenteeism(user, q),
      this.getLeaveUtilization(user, q),
      this.getPayrollCost(user, q),
      this.getAverageSalary(user, q),
      this.getDemographics(user, q),
      this.getLateComers(user, { ...q, limit: 5 }),
      this.getAttritionRisk(user, { ...q, limit: 5 }),
      this.getAbsenceAnomalies(user, { ...q, limit: 10 }),
      this.getToday(user, { departmentId: f.departmentId }),
    ]);
    return {
      filters: { startDate: f.startDate, endDate: f.endDate, departmentId: f.departmentId ?? null },
      today,
      headcount,
      attrition,
      attritionYtd,
      attendance,
      attendanceTrend,
      absenteeism,
      leaveUtilization,
      payrollCost,
      averageSalary,
      demographics,
      lateComers,
      attritionRisk,
      absenceAnomalies,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Internals ───────────────────────────────────────────

  private attendanceMatch(f: DashboardFilters, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const match: Record<string, unknown> = { date: { $gte: f.startDate, $lte: f.endDate }, isWorkingDay: true, ...extra };
    if (f.departmentId) match.departmentId = oid(f.departmentId);
    if (f.employeeId) match.employeeId = oid(f.employeeId);
    return match;
  }

  /** Employees employed on `date` (joined on/before it and not exited before it). */
  private employedOnMatch(date: string, f: DashboardFilters): Record<string, unknown> {
    const match: Record<string, unknown> = {
      joinDate: { $lte: date },
      $or: [{ exitDate: null }, { exitDate: { $gte: date } }],
    };
    if (f.departmentId) match.departmentId = oid(f.departmentId);
    if (f.employeeId) match._id = oid(f.employeeId);
    return match;
  }

  private async headcountAt(date: string, f: DashboardFilters) {
    const [rows, names] = await Promise.all([
      this.employeeModel
        .aggregate<{ _id: { departmentId: Types.ObjectId | null; status: string }; count: number }>([
          { $match: this.employedOnMatch(date, f) },
          { $group: { _id: { departmentId: '$departmentId', status: '$status' }, count: { $sum: 1 } } },
        ])
        .exec(),
      this.departments.nameMap(),
    ]);
    let active = 0;
    let probation = 0;
    const byDept = new Map<string, number>();
    for (const r of rows) {
      // Someone marked `exited` later was still employed (active) on this date.
      if (r._id.status === 'probation') probation += r.count;
      else active += r.count;
      const key = String(r._id.departmentId);
      byDept.set(key, (byDept.get(key) ?? 0) + r.count);
    }
    return {
      total: active + probation,
      active,
      probation,
      byDepartment: [...byDept.entries()]
        .map(([departmentId, headcount]) => ({
          departmentId: departmentId === 'null' ? null : departmentId,
          department: names.get(departmentId) ?? 'Unassigned',
          headcount,
        }))
        .sort((a, b) => b.headcount - a.headcount),
    };
  }

  private async attendanceByDepartment(f: DashboardFilters) {
    const [rows, names] = await Promise.all([
      this.attendanceModel
        .aggregate<StatusCounts & { _id: Types.ObjectId | null }>([
          { $match: this.attendanceMatch(f) },
          { $group: { _id: '$departmentId', ...STATUS_SUMS } },
        ])
        .exec(),
      this.departments.nameMap(),
    ]);
    return rows.map(({ _id, ...counts }) => ({
      departmentId: _id ? String(_id) : null,
      department: names.get(String(_id)) ?? 'Unassigned',
      counts: { ...EMPTY_STATUS_COUNTS, ...counts },
      ...attendanceKpis({ ...EMPTY_STATUS_COUNTS, ...counts }),
    }));
  }

  private async perEmployeeAttendance(f: DashboardFilters): Promise<Map<string, EmployeeAttendanceStats>> {
    const rows = await this.attendanceModel
      .aggregate<EmployeeAttendanceStats>([
        { $match: this.attendanceMatch(f) },
        {
          $group: {
            _id: '$employeeId',
            departmentId: { $last: '$departmentId' },
            ...STATUS_SUMS,
            absentDates: { $push: { $cond: [{ $eq: ['$status', 'absent'] }, '$date', null] } },
          },
        },
      ])
      .exec();
    return new Map(rows.map((r) => [String(r._id), r]));
  }

  private async employeeInfo(ids: Types.ObjectId[]): Promise<Map<string, EmployeeInfo>> {
    if (ids.length === 0) return new Map<string, EmployeeInfo>();
    const [employees, deptNames, desigNames] = await Promise.all([
      this.employeeModel
        .find({ _id: { $in: ids } }, { code: 1, fullName: 1, departmentId: 1, designationId: 1, status: 1 })
        .lean()
        .exec(),
      this.departments.nameMap(),
      this.designations.nameMap(),
    ]);
    return new Map<string, EmployeeInfo>(
      employees.map((e) => [
        String(e._id),
        {
          employeeId: String(e._id),
          code: e.code,
          fullName: e.fullName,
          department: deptNames.get(String(e.departmentId)) ?? 'Unassigned',
          designation: desigNames.get(String(e.designationId)) ?? 'Unassigned',
          status: e.status,
        },
      ]),
    );
  }
}

interface AvgRow {
  _id: Types.ObjectId | null;
  averageGross: number;
  employees: number;
}

interface EmployeeInfo {
  employeeId: string;
  code: string;
  fullName: string;
  department: string;
  designation: string;
  status: string;
}
