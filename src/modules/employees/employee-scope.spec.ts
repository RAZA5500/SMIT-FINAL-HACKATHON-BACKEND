import { jest } from '@jest/globals';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { AttendanceCorrection } from '../attendance/schemas/attendance-correction.schema.js';
import { Attendance } from '../attendance/schemas/attendance.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { User } from '../auth/schemas/user.schema.js';
import { UsersService } from '../auth/users.service.js';
import { NotificationsService } from '../comms/notifications.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { LeaveRequest } from '../leave/schemas/leave-request.schema.js';
import { PayrollService } from '../payroll/payroll.service.js';
import { PayrollRun } from '../payroll/schemas/payroll-run.schema.js';
import { Payslip } from '../payroll/schemas/payslip.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { DesignationsService } from '../setup/designations.service.js';
import { LeaveType } from '../setup/schemas/leave-type.schema.js';
import { SettingsService } from '../setup/settings.service.js';
import { EmployeesService } from './employees.service.js';
import { Employee } from './schemas/employee.schema.js';

/**
 * Employee RBAC scope isolation at the SERVICE layer (defence in depth — the same
 * methods are called by the AI tools, so the controller guards are not the only line).
 */
const OWN = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const employee: AuthUser = {
  userId: String(new Types.ObjectId()),
  email: 'own@company.com',
  fullName: 'Own Person',
  role: 'Employee',
  employeeId: String(OWN),
  mustChangePassword: false,
};
const query = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('Employee data-scope isolation (services)', () => {
  let employees: EmployeesService;
  let payroll: PayrollService;
  let dashboard: DashboardService;
  let employeeModel: Record<string, jest.Mock<AnyFn>>;
  let payslipModel: Record<string, jest.Mock<AnyFn>>;

  beforeEach(async () => {
    const chain = (value: unknown) => {
      const q: Record<string, unknown> = {};
      for (const m of ['sort', 'skip', 'limit', 'populate', 'lean']) q[m] = jest.fn<AnyFn>().mockReturnValue(q);
      q.exec = () => Promise.resolve(value);
      return q;
    };
    employeeModel = {
      findById: jest.fn<AnyFn>(),
      find: jest.fn<AnyFn>().mockImplementation(() => chain([])),
      countDocuments: jest.fn<AnyFn>().mockReturnValue(query(0)),
      aggregate: jest.fn<AnyFn>().mockReturnValue(query([])),
    };
    payslipModel = {
      findById: jest.fn<AnyFn>(),
      find: jest.fn<AnyFn>().mockImplementation(() => chain([])),
      countDocuments: jest.fn<AnyFn>().mockReturnValue(query(0)),
    };
    const stub = () => ({ useValue: {} });

    const moduleRef = await Test.createTestingModule({
      providers: [
        EmployeesService,
        PayrollService,
        DashboardService,
        { provide: getModelToken(Employee.name), useValue: employeeModel },
        { provide: getModelToken(Payslip.name), useValue: payslipModel },
        { provide: getModelToken(User.name), ...stub() },
        { provide: getModelToken(PayrollRun.name), ...stub() },
        { provide: getModelToken(Attendance.name), ...stub() },
        { provide: getModelToken(LeaveRequest.name), ...stub() },
        { provide: getModelToken(LeaveType.name), ...stub() },
        { provide: getModelToken(AttendanceCorrection.name), ...stub() },
        { provide: UsersService, ...stub() },
        { provide: AttendanceService, ...stub() },
        { provide: LeaveService, ...stub() },
        { provide: CalendarService, ...stub() },
        { provide: NotificationsService, ...stub() },
        { provide: AuditService, ...stub() },
        {
          provide: DepartmentsService,
          useValue: { nameMap: jest.fn<AnyFn>().mockResolvedValue(new Map()) },
        },
        {
          provide: DesignationsService,
          useValue: { nameMap: jest.fn<AnyFn>().mockResolvedValue(new Map()) },
        },
        {
          provide: SettingsService,
          useValue: { get: jest.fn<AnyFn>().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
        },
      ],
    }).compile();

    employees = moduleRef.get(EmployeesService);
    payroll = moduleRef.get(PayrollService);
    dashboard = moduleRef.get(DashboardService);
  });

  it("GET /employees/:id — an Employee cannot open another employee's 360 profile (403, no DB read)", async () => {
    await expect(employees.profile(employee, String(OTHER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(employeeModel.findById).not.toHaveBeenCalled();
  });

  it('employee list/search is pinned to the caller’s own record', async () => {
    await employees.findAll(employee, { page: 1, limit: 20, q: 'someone' });
    const filter = employeeModel.find.mock.calls[0][0] as Record<string, unknown>;
    expect(String(filter._id)).toBe(String(OWN));
  });

  it("the AI search tool refuses an Employee asking about someone else", async () => {
    employeeModel.findById.mockReturnValue(
      query({ _id: OWN, fullName: 'Own Person', code: 'EMP-1', email: 'own@company.com' }),
    );
    await expect(employees.searchForAssistant(employee, { query: 'Ali Raza' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an Employee cannot read another employee's payslip (403)", async () => {
    payslipModel.findById.mockReturnValue(query({ _id: 'slip', employeeId: OTHER, status: 'finalized' }));
    await expect(payroll.getPayslipDocument(employee, 'slip')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an Employee never sees their own DRAFT payslip (404 until finalized)', async () => {
    payslipModel.findById.mockReturnValue(query({ _id: 'slip', employeeId: OWN, status: 'draft' }));
    await expect(payroll.getPayslipDocument(employee, 'slip')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('payslip lists are pinned to own employeeId + finalized; asking for another id is 403', async () => {
    await payroll.listPayslips(employee, { page: 1, limit: 20 });
    const filter = payslipModel.find.mock.calls[0][0] as Record<string, unknown>;
    expect(String(filter.employeeId)).toBe(String(OWN));
    expect(filter.status).toBe('finalized');

    await expect(payroll.listPayslips(employee, { page: 1, limit: 20, employeeId: String(OTHER) })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('dashboard aggregates: org KPIs are 403 for Employees; personal KPIs are pinned to themselves', async () => {
    await expect(dashboard.getHeadcount(employee, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dashboard.getAttritionRisk(employee, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dashboard.resolveFilters(employee, { employeeId: String(OTHER) })).rejects.toBeInstanceOf(ForbiddenException);
    const filters = await dashboard.resolveFilters(employee, {});
    expect(filters.employeeId).toBe(String(OWN));
  });
});
