import { jest } from '@jest/globals';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
import { UnprocessableEntityException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../comms/notifications.service.js';
import { Employee } from '../employees/schemas/employee.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { LeaveTypesService } from '../setup/leave-types.service.js';
import { SettingsService } from '../setup/settings.service.js';
import { LeaveService } from './leave.service.js';
import { LeaveRequest } from './schemas/leave-request.schema.js';

const EMPLOYEE_ID = new Types.ObjectId();
const user: AuthUser = {
  userId: String(new Types.ObjectId()),
  email: 'sara@company.com',
  fullName: 'Sara',
  role: 'Employee',
  employeeId: String(EMPLOYEE_ID),
  mustChangePassword: false,
};
const annual = { _id: new Types.ObjectId(), name: 'Annual', annualQuota: 14, isPaid: true, isActive: true };
const unpaid = { _id: new Types.ObjectId(), name: 'Unpaid', annualQuota: null, isPaid: false, isActive: true };
const query = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('LeaveService — strict 422 validation', () => {
  let service: LeaveService;
  let leaveModel: { findOne: jest.Mock<AnyFn>; aggregate: jest.Mock<AnyFn>; create: jest.Mock<AnyFn> };
  let leaveTypes: { resolveActive: jest.Mock<AnyFn>; findActiveDocuments: jest.Mock<AnyFn> };
  let calendar: { workingDays: jest.Mock<AnyFn> };

  beforeEach(async () => {
    leaveModel = {
      findOne: jest.fn<AnyFn>().mockReturnValue(query(null)),
      aggregate: jest.fn<AnyFn>().mockReturnValue(query([])),
      create: jest.fn<AnyFn>().mockImplementation(async (doc: any) => ({ ...doc, _id: new Types.ObjectId(), toJSON: () => doc })),
    };
    leaveTypes = { resolveActive: jest.fn<AnyFn>().mockResolvedValue(annual), findActiveDocuments: jest.fn<AnyFn>() };
    calendar = { workingDays: jest.fn<AnyFn>().mockResolvedValue(['2026-11-02', '2026-11-03', '2026-11-04']) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LeaveService,
        { provide: getModelToken(LeaveRequest.name), useValue: leaveModel },
        {
          provide: getModelToken(Employee.name),
          useValue: {
            findById: jest.fn<AnyFn>().mockReturnValue(
              query({ _id: EMPLOYEE_ID, status: 'active', joinDate: '2024-01-01', exitDate: null, departmentId: null, fullName: 'Sara', code: 'EMP-2' }),
            ),
          },
        },
        { provide: LeaveTypesService, useValue: leaveTypes },
        { provide: CalendarService, useValue: calendar },
        { provide: SettingsService, useValue: { get: jest.fn<AnyFn>().mockResolvedValue({ timezone: 'Asia/Karachi' }) } },
        { provide: AttendanceService, useValue: { applyApprovedLeave: jest.fn<AnyFn>() } },
        { provide: NotificationsService, useValue: { notifyRoles: jest.fn<AnyFn>(), notifyEmployee: jest.fn<AnyFn>() } },
        { provide: AuditService, useValue: { record: jest.fn<AnyFn>() } },
      ],
    }).compile();
    service = moduleRef.get(LeaveService);
  });

  const request = { leaveTypeId: String(annual._id), startDate: '2026-11-02', endDate: '2026-11-04', reason: 'Family trip' };
  const codeOf = (error: unknown) => ((error as UnprocessableEntityException).getResponse() as { code: string }).code;

  it('creates a pending request counting only working days', async () => {
    const leave: any = await service.create(user, request);
    expect(leave.workingDays).toBe(3);
    expect(leaveModel.create).toHaveBeenCalledWith(expect.objectContaining({ dates: ['2026-11-02', '2026-11-03', '2026-11-04'] }));
  });

  it('throws 422 when the dates overlap an existing pending/approved leave', async () => {
    leaveModel.findOne.mockReturnValue(
      query({ status: 'approved', leaveTypeName: 'Casual', startDate: '2026-11-03', endDate: '2026-11-03' }),
    );

    const error = await service.create(user, request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect(codeOf(error)).toBe('LEAVE_OVERLAP');
    expect(leaveModel.create).not.toHaveBeenCalled();
    // the overlap query covers pending + approved requests that intersect the range
    expect(leaveModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ['pending', 'approved'] }, startDate: { $lte: '2026-11-04' }, endDate: { $gte: '2026-11-02' } }),
    );
  });

  it('throws 422 when requested working days exceed the remaining quota', async () => {
    // 10 approved + 2 pending of 14 → 2 remaining, 3 requested
    leaveModel.aggregate.mockReturnValue(
      query([
        { _id: { leaveTypeId: annual._id, status: 'approved' }, days: 10 },
        { _id: { leaveTypeId: annual._id, status: 'pending' }, days: 2 },
      ]),
    );

    const error = await service.create(user, request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(codeOf(error)).toBe('INSUFFICIENT_BALANCE');
    expect(leaveModel.create).not.toHaveBeenCalled();
  });

  it('allows a request that uses exactly the remaining balance', async () => {
    leaveModel.aggregate.mockReturnValue(query([{ _id: { leaveTypeId: annual._id, status: 'approved' }, days: 11 }]));
    await expect(service.create(user, request)).resolves.toBeDefined();
  });

  it('treats Unpaid leave as unlimited', async () => {
    leaveTypes.resolveActive.mockResolvedValue(unpaid);
    leaveModel.aggregate.mockReturnValue(query([{ _id: { leaveTypeId: unpaid._id, status: 'approved' }, days: 300 }]));
    await expect(service.create(user, { ...request, leaveTypeId: String(unpaid._id) })).resolves.toBeDefined();
  });

  it('throws 422 when the range contains only weekends/holidays', async () => {
    calendar.workingDays.mockResolvedValue([]);
    const error = await service.create(user, request).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('NO_WORKING_DAYS');
  });
});
