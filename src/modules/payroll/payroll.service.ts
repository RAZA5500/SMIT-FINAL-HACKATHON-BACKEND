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
import { isDuplicateKeyError } from '../../common/filters/mongo-exception.filter.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { maxDate, minDate, monthBounds, monthLabel, todayIn } from '../../common/utils/date.util.js';
import { KeyedMutex } from '../../common/utils/keyed-mutex.js';
import { round2 } from '../../common/utils/number.util.js';
import { paginate } from '../../common/utils/query.util.js';
import { isEmployee, isManager, resolveEmployeeScope } from '../../common/utils/scope.util.js';
import { Attendance, type AttendanceDocument } from '../attendance/schemas/attendance.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../comms/notifications.service.js';
import { DashboardService, type DashboardQuery } from '../dashboard/dashboard.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { LeaveRequest, type LeaveRequestDocument } from '../leave/schemas/leave-request.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { DesignationsService } from '../setup/designations.service.js';
import { SettingsService } from '../setup/settings.service.js';
import {
  CreatePayrollRunDto,
  PayrollRunQueryDto,
  PayslipQueryDto,
  UpdatePayrollRunDto,
} from './dto/payroll.dto.js';
import {
  calculatePayslip,
  computeAnnualTax,
  computeSalaryStructure,
  LATE_PENALTY_RULE,
  SALARY_COMPONENT_RATES,
  TAX_SLABS,
} from './payroll.calculator.js';
import {
  PayrollRun,
  type PayrollRuleSnapshot,
  type PayrollRunDocument,
  type PayrollTotals,
} from './schemas/payroll-run.schema.js';
import { Payslip, type PayslipDocument } from './schemas/payslip.schema.js';

interface BuiltPayroll {
  workingDaysInMonth: number;
  ruleSnapshot: PayrollRuleSnapshot;
  totals: PayrollTotals;
  payslips: Omit<Payslip, 'payrollRunId' | 'status'>[];
}

@Injectable()
export class PayrollService {
  private readonly runLock = new KeyedMutex();

  constructor(
    @InjectModel(PayrollRun.name) private readonly runModel: Model<PayrollRunDocument>,
    @InjectModel(Payslip.name) private readonly payslipModel: Model<PayslipDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<AttendanceDocument>,
    @InjectModel(LeaveRequest.name) private readonly leaveModel: Model<LeaveRequestDocument>,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly departments: DepartmentsService,
    private readonly designations: DesignationsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly dashboard: DashboardService,
  ) {}

  // ── Runs ──────────────────────────────────────────────────

  /** HR/Admin creates the monthly draft and its payslips. */
  async createRun(user: AuthUser, dto: CreatePayrollRunDto) {
    return this.runLock.run(`month:${dto.month}`, async () => {
      const settings = await this.settings.get();
      const currentMonth = todayIn(settings.timezone).slice(0, 7);
      if (dto.month > currentMonth) {
        throw new UnprocessableEntityException(`Cannot run payroll for a future month (${dto.month}).`);
      }
      if (await this.runModel.exists({ month: dto.month }).exec()) {
        throw new ConflictException(`A payroll run for ${dto.month} already exists. Recalculate it instead.`);
      }

      const built = await this.buildPayroll(dto.month);
      let run: PayrollRunDocument;
      try {
        run = await this.runModel.create({
          month: dto.month,
          status: 'draft',
          workingDaysInMonth: built.workingDaysInMonth,
          ruleSnapshot: built.ruleSnapshot,
          totals: built.totals,
          notes: dto.notes ?? '',
          createdBy: user.userId,
          updatedBy: user.userId,
          lastCalculatedAt: new Date(),
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new ConflictException(`A payroll run for ${dto.month} already exists.`);
        throw error;
      }
      try {
        await this.insertPayslips(run, built);
      } catch (error) {
        await this.payslipModel.deleteMany({ payrollRunId: run._id }).exec();
        await this.runModel.deleteOne({ _id: run._id }).exec();
        throw error;
      }

      await this.audit.record({ actor: user, action: 'create', entity: 'PayrollRun', entityId: run._id, after: run });
      return this.getRun(String(run._id));
    });
  }

  /** Re-computes a draft from current attendance/leave data (403 once finalized). */
  async recalculate(user: AuthUser, id: string) {
    return this.runLock.run(id, async () => {
      const run = await this.getDraftRun(id);
      const before = run.toObject();
      const built = await this.buildPayroll(run.month);
      await this.payslipModel.deleteMany({ payrollRunId: run._id }).exec();
      await this.insertPayslips(run, built);
      run.workingDaysInMonth = built.workingDaysInMonth;
      run.ruleSnapshot = built.ruleSnapshot;
      run.totals = built.totals;
      run.updatedBy = new Types.ObjectId(user.userId);
      run.lastCalculatedAt = new Date();
      await run.save();
      await this.audit.record({ actor: user, action: 'update', entity: 'PayrollRun', entityId: run._id, before, after: run });
      return this.getRun(id);
    });
  }

  async update(user: AuthUser, id: string, dto: UpdatePayrollRunDto) {
    return this.runLock.run(id, async () => {
      const run = await this.getDraftRun(id);
      const before = run.toObject();
      run.notes = dto.notes;
      run.updatedBy = new Types.ObjectId(user.userId);
      await run.save();
      await this.audit.record({ actor: user, action: 'update', entity: 'PayrollRun', entityId: run._id, before, after: run });
      return run.toJSON();
    });
  }

  async remove(user: AuthUser, id: string): Promise<{ deleted: true }> {
    return this.runLock.run(id, async () => {
      const run = await this.getDraftRun(id);
      await this.payslipModel.deleteMany({ payrollRunId: run._id }).exec();
      await run.deleteOne();
      await this.audit.record({ actor: user, action: 'delete', entity: 'PayrollRun', entityId: run._id, before: run });
      return { deleted: true };
    });
  }

  /** Admin-only lock. Afterwards every edit attempt on the run returns 403. */
  async finalize(user: AuthUser, id: string) {
    if (user.role !== Role.Admin) throw new ForbiddenException('Only Admin can finalize payroll.');
    return this.runLock.run(id, async () => {
      const run = await this.getRunDocument(id);
      if (run.status === 'finalized') {
        throw new ForbiddenException(`Payroll for ${run.month} is already finalized and locked.`);
      }
      const before = run.toObject();
      const finalized = await this.runModel
        .findOneAndUpdate(
          { _id: run._id, status: 'draft' },
          { $set: { status: 'finalized', finalizedBy: user.userId, finalizedAt: new Date(), updatedBy: user.userId } },
          { new: true },
        )
        .exec();
      if (!finalized) throw new ForbiddenException(`Payroll for ${run.month} is already finalized and locked.`);
      await this.payslipModel.updateMany({ payrollRunId: run._id }, { $set: { status: 'finalized' } }).exec();

      await this.audit.record({ actor: user, action: 'finalize', entity: 'PayrollRun', entityId: run._id, before, after: finalized });
      const employeeIds = await this.payslipModel.distinct('employeeId', { payrollRunId: run._id }).exec();
      await this.notifications.notifyEmployees(employeeIds as Types.ObjectId[], {
        title: 'Payslip available',
        message: `Your payslip for ${monthLabel(run.month)} is ready to view and download.`,
        type: 'payroll',
        entity: 'PayrollRun',
        entityId: run._id,
      });
      return finalized.toJSON();
    });
  }

  async listRuns(query: PayrollRunQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.year) filter.month = { $gte: `${query.year}-01`, $lte: `${query.year}-12` };
    return paginate(this.runModel, filter, { page: query.page, limit: query.limit, sort: { month: -1 } });
  }

  async getRun(id: string) {
    const run = await this.getRunDocument(id);
    const payslips = await this.payslipModel.find({ payrollRunId: run._id }).sort({ 'employee.code': 1 }).exec();
    return { ...run.toJSON(), payslips: payslips.map((p) => p.toJSON()) };
  }

  // ── Payslips ──────────────────────────────────────────────

  /** Employees see only their own finalized payslips; Admin/HR see all (including drafts). */
  async listPayslips(user: AuthUser, query: PayslipQueryDto) {
    const employeeId = resolveEmployeeScope(user, query.employeeId);
    const filter: Record<string, unknown> = {};
    if (employeeId) filter.employeeId = new Types.ObjectId(employeeId);
    if (isEmployee(user)) filter.status = 'finalized';
    if (query.month) filter.month = query.month;
    if (query.payrollRunId) filter.payrollRunId = new Types.ObjectId(query.payrollRunId);
    if (query.departmentId && isManager(user)) filter['employee.departmentId'] = new Types.ObjectId(query.departmentId);
    return paginate(this.payslipModel, filter, {
      page: query.page,
      limit: query.limit,
      sort: { month: -1, 'employee.code': 1 },
    });
  }

  async getPayslipDocument(user: AuthUser, id: string): Promise<PayslipDocument> {
    const payslip = await this.payslipModel.findById(id).exec();
    if (!payslip) throw new NotFoundException('Payslip not found');
    resolveEmployeeScope(user, String(payslip.employeeId));
    if (isEmployee(user) && payslip.status !== 'finalized') {
      throw new NotFoundException('Payslip not found');
    }
    return payslip;
  }

  async getPayslip(user: AuthUser, id: string) {
    return (await this.getPayslipDocument(user, id)).toJSON();
  }

  /** Recent payslips for one employee (360 profile); drafts hidden from Employees. */
  async payslipsForEmployee(user: AuthUser, employeeId: string, limit = 6) {
    const filter: Record<string, unknown> = { employeeId: new Types.ObjectId(employeeId) };
    if (isEmployee(user)) filter.status = 'finalized';
    const payslips = await this.payslipModel.find(filter).sort({ month: -1 }).limit(limit).exec();
    return payslips.map((p) => p.toJSON());
  }

  /**
   * Payroll summary for the AI assistant. An Employee gets only their own FINALIZED payslips;
   * Admin/HR get the dashboard's payroll-cost and average-salary aggregations (same numbers).
   */
  async getPayrollSummary(user: AuthUser, query: DashboardQuery) {
    const filters = await this.dashboard.resolveFilters(user, query);
    const startMonth = filters.startDate.slice(0, 7);
    const endMonth = filters.endDate.slice(0, 7);
    if (isEmployee(user)) {
      const payslips = await this.payslipModel
        .find({
          employeeId: new Types.ObjectId(filters.employeeId!),
          status: 'finalized',
          month: { $gte: startMonth, $lte: endMonth },
        })
        .sort({ month: -1 })
        .exec();
      return {
        scope: 'own',
        startMonth,
        endMonth,
        payslips: payslips.map((p) => ({
          payslipId: String(p._id),
          month: p.month,
          gross: p.gross,
          proratedGross: p.proratedGross,
          attendanceDeduction: p.attendanceDeduction,
          monthlyTax: p.monthlyTax,
          netPay: p.netPay,
          currency: p.currency,
        })),
      };
    }
    const [cost, averageSalary] = await Promise.all([
      this.dashboard.getPayrollCost(user, query),
      this.dashboard.getAverageSalary(user, query),
    ]);
    return { scope: filters.employeeId ? 'employee' : 'organization', ...cost, averageSalary };
  }

  /** Salary structure + tax for a basic salary (what-if helper for the UI). */
  calculator(basic: number) {
    const salary = computeSalaryStructure(basic);
    const annualGross = round2(salary.gross * 12);
    const annualTax = computeAnnualTax(annualGross);
    const monthlyTax = round2(annualTax / 12);
    return {
      ...salary,
      annualGross,
      annualTax,
      monthlyTax,
      netPayFullMonth: round2(salary.gross - monthlyTax),
      taxSlabs: TAX_SLABS,
    };
  }

  // ── Internals ─────────────────────────────────────────────

  private async getRunDocument(id: string): Promise<PayrollRunDocument> {
    const run = await this.runModel.findById(id).exec();
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  private async getDraftRun(id: string): Promise<PayrollRunDocument> {
    const run = await this.getRunDocument(id);
    if (run.status === 'finalized') {
      throw new ForbiddenException(`Payroll for ${run.month} is finalized and locked — it can no longer be edited.`);
    }
    return run;
  }

  private async insertPayslips(run: PayrollRunDocument, built: BuiltPayroll): Promise<void> {
    if (built.payslips.length === 0) return;
    await this.payslipModel.insertMany(
      built.payslips.map((p) => ({ ...p, payrollRunId: run._id, status: run.status })),
    );
  }

  /**
   * Computes every payslip of a month from DB aggregations over attendance (absent,
   * half_day, late) and approved unpaid leave, prorating joiners/leavers.
   */
  private async buildPayroll(month: string): Promise<BuiltPayroll> {
    const settings = await this.settings.get();
    const { start, end } = monthBounds(month);
    const calendar = await this.calendar.forRange(start, end);
    const workingDates = calendar.workingDays(start, end);
    if (workingDates.length === 0) {
      throw new UnprocessableEntityException(`${month} has no working days with the current calendar.`);
    }
    const workingSet = new Set(workingDates);

    const employees = await this.employeeModel
      .find({ joinDate: { $lte: end }, $or: [{ exitDate: null }, { exitDate: { $gte: start } }] })
      .sort({ code: 1 })
      .exec();
    const ids = employees.map((e) => e._id);

    const [attendanceRows, unpaidRows, departmentNames, designationNames] = await Promise.all([
      this.attendanceModel
        .aggregate<{ _id: Types.ObjectId; absent: number; halfDays: number; lates: number }>([
          { $match: { employeeId: { $in: ids }, date: { $gte: start, $lte: end }, isWorkingDay: true } },
          {
            $group: {
              _id: '$employeeId',
              absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
              halfDays: { $sum: { $cond: [{ $eq: ['$status', 'half_day'] }, 1, 0] } },
              // Late arrivals: `late`, or `missing_checkout` after a late check-in.
              lates: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $in: ['$status', ['late', 'missing_checkout']] },
                        { $gt: ['$lateMinutes', 0] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .exec(),
      this.leaveModel
        .aggregate<{ _id: Types.ObjectId; dates: string[] }>([
          {
            $match: {
              employeeId: { $in: ids },
              status: 'approved',
              isPaid: false,
              dates: { $elemMatch: { $gte: start, $lte: end } },
            },
          },
          { $unwind: '$dates' },
          { $match: { dates: { $gte: start, $lte: end } } },
          { $group: { _id: '$employeeId', dates: { $addToSet: '$dates' } } },
        ])
        .exec(),
      this.departments.nameMap(),
      this.designations.nameMap(),
    ]);
    const attendanceBy = new Map(attendanceRows.map((r) => [String(r._id), r]));
    const unpaidBy = new Map(unpaidRows.map((r) => [String(r._id), r.dates]));

    const totals: PayrollTotals = { employees: 0, gross: 0, proratedGross: 0, attendanceDeduction: 0, tax: 0, net: 0 };
    const payslips: BuiltPayroll['payslips'] = [];

    for (const employee of employees) {
      const windowStart = maxDate(start, employee.joinDate);
      const windowEnd = employee.exitDate ? minDate(end, employee.exitDate) : end;
      const eligibleWorkingDays =
        windowStart > windowEnd ? 0 : workingDates.filter((d) => d >= windowStart && d <= windowEnd).length;
      if (eligibleWorkingDays === 0) continue;

      const key = String(employee._id);
      const counts = attendanceBy.get(key);
      const unpaidLeaveDays = (unpaidBy.get(key) ?? []).filter(
        (d) => workingSet.has(d) && d >= windowStart && d <= windowEnd,
      ).length;

      const figures = calculatePayslip({
        basic: employee.basicSalary,
        workingDaysInMonth: workingDates.length,
        eligibleWorkingDays,
        absentDays: counts?.absent ?? 0,
        unpaidLeaveDays,
        halfDays: counts?.halfDays ?? 0,
        lateCount: counts?.lates ?? 0,
        latePenaltyRuleEnabled: settings.latePenaltyRuleEnabled,
      });

      payslips.push({
        month,
        employeeId: employee._id,
        employee: {
          code: employee.code,
          fullName: employee.fullName,
          email: employee.email,
          departmentId: employee.departmentId ?? null,
          departmentName: departmentNames.get(String(employee.departmentId)) ?? '',
          designationId: employee.designationId ?? null,
          designationName: designationNames.get(String(employee.designationId)) ?? '',
          joinDate: employee.joinDate,
          exitDate: employee.exitDate ?? null,
        },
        ...figures,
        currency: settings.currency,
      });

      totals.employees += 1;
      totals.gross = round2(totals.gross + figures.gross);
      totals.proratedGross = round2(totals.proratedGross + figures.proratedGross);
      totals.attendanceDeduction = round2(totals.attendanceDeduction + figures.attendanceDeduction);
      totals.tax = round2(totals.tax + figures.monthlyTax);
      totals.net = round2(totals.net + figures.netPay);
    }

    return {
      workingDaysInMonth: workingDates.length,
      ruleSnapshot: {
        hraRate: SALARY_COMPONENT_RATES.hraRate,
        medicalRate: SALARY_COMPONENT_RATES.medicalRate,
        taxSlabs: TAX_SLABS,
        latePenaltyRuleEnabled: settings.latePenaltyRuleEnabled,
        latesPerPenalty: LATE_PENALTY_RULE.latesPerPenalty,
        penaltyDaysPerUnit: LATE_PENALTY_RULE.penaltyDaysPerUnit,
        weekendDays: settings.weekendDays,
        holidays: calendar.holidayDates,
        currency: settings.currency,
      },
      totals,
      payslips,
    };
  }
}
