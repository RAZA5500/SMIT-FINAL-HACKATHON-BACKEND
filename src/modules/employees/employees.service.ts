import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Parser } from '@json2csv/plainjs';
import { Model, Types, type SortOrder } from 'mongoose';
import { Role } from '../../common/constants/roles.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { startOfMonth, todayIn, yearOf } from '../../common/utils/date.util.js';
import { escapeRegex } from '../../common/utils/query.util.js';
import {
  assertCanAccessEmployee,
  isEmployee,
  OWN_DATA_ONLY_MESSAGE,
  requireEmployeeId,
} from '../../common/utils/scope.util.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { AuditService } from '../audit/audit.service.js';
import { User, type UserDocument } from '../auth/schemas/user.schema.js';
import { UsersService } from '../auth/users.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { computeMonthlyTax, computeSalaryStructure } from '../payroll/payroll.calculator.js';
import { PayrollService } from '../payroll/payroll.service.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { DesignationsService } from '../setup/designations.service.js';
import { SettingsService } from '../setup/settings.service.js';
import {
  CreateEmployeeDto,
  ExportEmployeesQueryDto,
  ListEmployeesQueryDto,
  UpdateEmployeeDto,
  UpdateMyProfileDto,
} from './dto/employee.dto.js';
import { Employee, type EmployeeDocument } from './schemas/employee.schema.js';

export const EXPORT_FIELDS = [
  'code',
  'fullName',
  'email',
  'phone',
  'address',
  'gender',
  'department',
  'designation',
  'joinDate',
  'status',
  'exitDate',
  'basicSalary',
  'hra',
  'medical',
  'gross',
] as const;

type NameMaps = { departments: Map<string, string>; designations: Map<string, string> };

@Injectable()
export class EmployeesService {
  constructor(
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly users: UsersService,
    private readonly departments: DepartmentsService,
    private readonly designations: DesignationsService,
    private readonly settings: SettingsService,
    private readonly attendance: AttendanceService,
    private readonly leave: LeaveService,
    private readonly payroll: PayrollService,
    private readonly dashboard: DashboardService,
    private readonly audit: AuditService,
  ) {}

  // ── Create / update ───────────────────────────────────────

  /** HR registers an employee; a login is auto-created with a temporary password (must change). */
  async create(actor: AuthUser, dto: CreateEmployeeDto) {
    const code = dto.code.toUpperCase();
    const email = dto.email.toLowerCase();
    await this.assertReferences(dto.departmentId, dto.designationId);
    this.assertEmploymentDates(dto.status ?? 'active', dto.joinDate, dto.exitDate ?? null);
    if (await this.employeeModel.exists({ code }).exec()) throw new ConflictException(`Employee code ${code} already exists`);
    if (await this.employeeModel.exists({ email }).exec()) throw new ConflictException(`Email ${email} is already used by an employee`);
    if (await this.users.emailExists(email)) throw new ConflictException(`Email ${email} is already used by a login`);

    const employee = await this.employeeModel.create({
      code,
      fullName: dto.fullName,
      email,
      phone: dto.phone ?? '',
      address: dto.address ?? '',
      gender: dto.gender ?? null,
      departmentId: dto.departmentId,
      designationId: dto.designationId,
      joinDate: dto.joinDate,
      status: dto.status ?? 'active',
      exitDate: dto.exitDate ?? null,
      basicSalary: dto.basicSalary,
      createdBy: actor.userId,
    });

    let login: Awaited<ReturnType<UsersService['createAccount']>>;
    try {
      login = await this.users.createAccount({
        email,
        fullName: dto.fullName,
        role: Role.Employee,
        employeeId: employee._id,
        mustChangePassword: true,
        createdBy: actor.userId,
      });
    } catch (error) {
      await this.employeeModel.deleteOne({ _id: employee._id }).exec();
      throw error;
    }
    employee.userId = login.user._id;
    await employee.save();
    if (employee.status === 'exited') await this.users.deactivateForEmployee(employee._id);

    await this.audit.record({ actor, action: 'create', entity: 'Employee', entityId: employee._id, after: employee });
    await this.audit.record({ actor, action: 'create', entity: 'User', entityId: login.user._id, after: login.user });

    return {
      employee: await this.toView(employee),
      login: {
        userId: String(login.user._id),
        email,
        temporaryPassword: login.tempPassword,
        mustChangePassword: true,
      },
    };
  }

  /** HR/Admin edit of job details, status and salary. Exiting deactivates the login. */
  async update(actor: AuthUser, id: string, dto: UpdateEmployeeDto) {
    const employee = await this.getDocument(id);
    const before = employee.toObject();
    const previousStatus = employee.status;

    if (dto.code !== undefined) {
      const code = dto.code.toUpperCase();
      if (code !== employee.code && (await this.employeeModel.exists({ code, _id: { $ne: employee._id } }).exec())) {
        throw new ConflictException(`Employee code ${code} already exists`);
      }
      employee.code = code;
    }
    if (dto.email !== undefined) {
      const email = dto.email.toLowerCase();
      if (email !== employee.email) {
        if (await this.employeeModel.exists({ email, _id: { $ne: employee._id } }).exec()) {
          throw new ConflictException(`Email ${email} is already used by an employee`);
        }
        if (await this.userModel.exists({ email, employeeId: { $ne: employee._id } }).exec()) {
          throw new ConflictException(`Email ${email} is already used by a login`);
        }
      }
      employee.email = email;
    }
    if (dto.departmentId !== undefined || dto.designationId !== undefined) {
      await this.assertReferences(
        dto.departmentId ?? String(employee.departmentId),
        dto.designationId ?? String(employee.designationId),
      );
    }

    const assignable = [
      'fullName',
      'phone',
      'address',
      'gender',
      'departmentId',
      'designationId',
      'joinDate',
      'status',
      'exitDate',
      'basicSalary',
    ] as const;
    for (const key of assignable) {
      if (dto[key] !== undefined) employee.set(key, dto[key]);
    }
    this.assertEmploymentDates(employee.status, employee.joinDate, employee.exitDate);
    await employee.save();

    if (dto.fullName !== undefined || dto.email !== undefined) {
      await this.users.syncEmployeeIdentity(employee._id, { fullName: employee.fullName, email: employee.email });
    }
    if (employee.status === 'exited' && previousStatus !== 'exited') {
      await this.users.deactivateForEmployee(employee._id);
    }

    await this.audit.record({ actor, action: 'update', entity: 'Employee', entityId: employee._id, before, after: employee });
    return this.toView(employee);
  }

  /** `PATCH /employees/me` — an Employee may change only their own phone and address. */
  async updateMyProfile(user: AuthUser, dto: UpdateMyProfileDto) {
    const employee = await this.getDocument(requireEmployeeId(user));
    const before = employee.toObject();
    if (dto.phone !== undefined) employee.phone = dto.phone;
    if (dto.address !== undefined) employee.address = dto.address;
    await employee.save();
    await this.audit.record({ actor: user, action: 'update', entity: 'Employee', entityId: employee._id, before, after: employee });
    return this.toView(employee);
  }

  // ── Read ──────────────────────────────────────────────────

  /** Server-side search, filters and pagination. An Employee only ever gets their own record. */
  async findAll(user: AuthUser, query: ListEmployeesQueryDto) {
    const filter = this.buildFilter(user, query);
    const sort: Record<string, SortOrder> = { [query.sortBy ?? 'createdAt']: query.sortOrder === 'asc' ? 1 : -1 };
    const [docs, total, names] = await Promise.all([
      this.employeeModel
        .find(filter)
        .sort(sort)
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.employeeModel.countDocuments(filter).exec(),
      this.nameMaps(),
    ]);
    return {
      data: docs.map((doc) => this.view(doc, names)),
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /** Employee 360 profile — Admin/HR: anyone; Employee: own `employeeId` only (403 otherwise). */
  async profile(user: AuthUser, id: string) {
    assertCanAccessEmployee(user, id);
    const employee = await this.getDocument(id);
    const settings = await this.settings.get();
    const today = todayIn(settings.timezone);
    const year = yearOf(today);

    const [view, account, monthSummary, recentAttendance, balances, recentLeave, payslips] = await Promise.all([
      this.toView(employee),
      employee.userId ? this.userModel.findById(employee.userId).exec() : Promise.resolve(null),
      this.dashboard.getAttendanceSummary(user, { startDate: startOfMonth(today), endDate: today, employeeId: id }),
      this.attendance.recentForEmployee(id, 10),
      this.leave.balancesFor(id, year),
      this.leave.recentForEmployee(id, 5),
      this.payroll.payslipsForEmployee(user, id, 6),
    ]);

    const salary = computeSalaryStructure(employee.basicSalary);
    return {
      employee: view,
      account: account
        ? {
            userId: String(account._id),
            email: account.email,
            role: account.role,
            isActive: account.isActive,
            mustChangePassword: account.mustChangePassword,
            lastLoginAt: account.lastLoginAt,
          }
        : null,
      attendance: { currentMonth: { ...monthSummary, byDepartment: undefined }, recent: recentAttendance },
      leave: { year, balances, recent: recentLeave },
      payroll: {
        salaryStructure: { ...salary, monthlyTax: computeMonthlyTax(salary.gross) },
        recentPayslips: payslips,
      },
    };
  }

  async getDocument(id: string): Promise<EmployeeDocument> {
    const employee = await this.employeeModel.findById(id).exec();
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /**
   * Directory search used by the AI `search_employees` tool. Admin/HR search everyone;
   * an Employee may only look up themselves — asking about anyone else is refused.
   */
  async searchForAssistant(user: AuthUser, params: { query?: string; department?: string; status?: string; limit?: number }) {
    if (isEmployee(user)) {
      const own = await this.getDocument(requireEmployeeId(user));
      const q = params.query?.trim().toLowerCase();
      const matchesSelf =
        !q || [own.fullName, own.code, own.email].some((value) => value.toLowerCase().includes(q));
      if (!matchesSelf || params.department) throw new ForbiddenException(OWN_DATA_ONLY_MESSAGE);
      return { scope: 'own', total: 1, data: [await this.toView(own)] };
    }

    const filter: Record<string, unknown> = {};
    if (params.query) {
      const regex = new RegExp(escapeRegex(params.query.trim()), 'i');
      filter.$or = [{ fullName: regex }, { code: regex }, { email: regex }, { phone: regex }];
    }
    if (params.department) {
      const department = await this.departments.resolve(params.department);
      if (!department) return { scope: 'organization', total: 0, data: [], note: `Unknown department "${params.department}"` };
      filter.departmentId = department._id;
    }
    if (params.status) filter.status = params.status;
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 25);
    const [docs, total, names] = await Promise.all([
      this.employeeModel.find(filter).sort({ fullName: 1 }).limit(limit).exec(),
      this.employeeModel.countDocuments(filter).exec(),
      this.nameMaps(),
    ]);
    return { scope: 'organization', total, data: docs.map((d) => this.view(d, names)) };
  }

  /** Finds one employee by id, code, email or exact name (for AI tool parameters). */
  async resolveReference(ref: string): Promise<EmployeeDocument | null> {
    const value = ref.trim();
    if (!value) return null;
    if (Types.ObjectId.isValid(value) && /^[a-f\d]{24}$/i.test(value)) {
      const byId = await this.employeeModel.findById(value).exec();
      if (byId) return byId;
    }
    const exact = await this.employeeModel
      .findOne({ $or: [{ code: value.toUpperCase() }, { email: value.toLowerCase() }] })
      .exec();
    if (exact) return exact;
    const byName = await this.employeeModel
      .find({ fullName: new RegExp(`^${escapeRegex(value)}$`, 'i') })
      .limit(2)
      .exec();
    return byName.length === 1 ? byName[0] : null;
  }

  // ── CSV export ────────────────────────────────────────────

  async exportCsv(user: AuthUser, query: ExportEmployeesQueryDto): Promise<string> {
    const filter = this.buildFilter(user, query);
    const [docs, names] = await Promise.all([
      this.employeeModel.find(filter).sort({ code: 1 }).limit(10_000).exec(),
      this.nameMaps(),
    ]);
    const rows = docs.map((doc) => {
      const salary = computeSalaryStructure(doc.basicSalary);
      return {
        code: doc.code,
        fullName: doc.fullName,
        email: doc.email,
        phone: doc.phone,
        address: doc.address,
        gender: doc.gender ?? '',
        department: names.departments.get(String(doc.departmentId)) ?? '',
        designation: names.designations.get(String(doc.designationId)) ?? '',
        joinDate: doc.joinDate,
        status: doc.status,
        exitDate: doc.exitDate ?? '',
        basicSalary: salary.basic,
        hra: salary.hra,
        medical: salary.medical,
        gross: salary.gross,
      };
    });
    return new Parser({ fields: [...EXPORT_FIELDS] }).parse(rows);
  }

  // ── Helpers ───────────────────────────────────────────────

  private buildFilter(user: AuthUser, query: Omit<ListEmployeesQueryDto, 'page' | 'limit'>): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (isEmployee(user)) filter._id = new Types.ObjectId(requireEmployeeId(user));
    if (query.q) {
      const regex = new RegExp(escapeRegex(query.q.trim()), 'i');
      filter.$or = [{ fullName: regex }, { code: regex }, { email: regex }, { phone: regex }];
    }
    if (query.departmentId) filter.departmentId = new Types.ObjectId(query.departmentId);
    if (query.designationId) filter.designationId = new Types.ObjectId(query.designationId);
    if (query.status) filter.status = query.status;
    return filter;
  }

  private async assertReferences(departmentId: string, designationId: string): Promise<void> {
    const [department, designation] = await Promise.all([
      this.departments.resolve(departmentId),
      this.designations.resolve(designationId),
    ]);
    if (!department) throw new UnprocessableEntityException('Unknown department');
    if (!department.isActive) throw new UnprocessableEntityException(`Department "${department.name}" is inactive`);
    if (!designation) throw new UnprocessableEntityException('Unknown designation');
    if (!designation.isActive) throw new UnprocessableEntityException(`Designation "${designation.name}" is inactive`);
  }

  private assertEmploymentDates(status: string, joinDate: string, exitDate: string | null): void {
    if (status === 'exited' && !exitDate) {
      throw new UnprocessableEntityException('exitDate is required when status is "exited"');
    }
    if (exitDate && exitDate < joinDate) {
      throw new UnprocessableEntityException('exitDate cannot be before joinDate');
    }
  }

  private async nameMaps(): Promise<NameMaps> {
    const [departments, designations] = await Promise.all([this.departments.nameMap(), this.designations.nameMap()]);
    return { departments, designations };
  }

  async toView(employee: EmployeeDocument) {
    return this.view(employee, await this.nameMaps());
  }

  private view(employee: EmployeeDocument, names: NameMaps) {
    const json = employee.toJSON() as unknown as Record<string, unknown>;
    const departmentId = String(employee.departmentId);
    const designationId = String(employee.designationId);
    return {
      ...json,
      departmentId,
      designationId,
      userId: employee.userId ? String(employee.userId) : null,
      department: { id: departmentId, name: names.departments.get(departmentId) ?? null },
      designation: { id: designationId, name: names.designations.get(designationId) ?? null },
      salary: computeSalaryStructure(employee.basicSalary),
    };
  }
}
