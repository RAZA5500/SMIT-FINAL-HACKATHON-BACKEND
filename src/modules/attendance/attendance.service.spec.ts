import { jest } from '@jest/globals';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { AuditService } from '../audit/audit.service.js';
import { Employee } from '../employees/schemas/employee.schema.js';
import { LeaveRequest } from '../leave/schemas/leave-request.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { DesignationsService } from '../setup/designations.service.js';
import { WorkCalendar } from '../setup/calendar.util.js';
import { SettingsService } from '../setup/settings.service.js';
import { AttendanceService } from './attendance.service.js';
import { Attendance } from './schemas/attendance.schema.js';

const EMPLOYEE_ID = '64b7f0c2a1b2c3d4e5f60718';
const employeeUser: AuthUser = {
  userId: '64b7f0c2a1b2c3d4e5f60001',
  email: 'ali@company.com',
  fullName: 'Ali',
  role: 'Employee',
  employeeId: EMPLOYEE_ID,
  mustChangePassword: false,
};

/** Mongoose-style query stub: `.exec()` resolves to the value. */
const query = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('AttendanceService — check-in', () => {
  let service: AttendanceService;
  let attendanceModel: { exists: jest.Mock<AnyFn>; create: jest.Mock<AnyFn> };
  const auditRecord = jest.fn<AnyFn>();

  beforeEach(async () => {
    attendanceModel = { exists: jest.fn<AnyFn>(), create: jest.fn<AnyFn>() };
    const employeeModel = {
      findById: jest.fn<AnyFn>().mockReturnValue(
        query({ _id: EMPLOYEE_ID, status: 'active', joinDate: '2020-01-01', departmentId: 'dept' }),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: getModelToken(Attendance.name), useValue: attendanceModel },
        { provide: getModelToken(Employee.name), useValue: employeeModel },
        { provide: getModelToken(LeaveRequest.name), useValue: {} },
        { provide: DepartmentsService, useValue: {} },
        { provide: DesignationsService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            get: jest.fn<AnyFn>().mockResolvedValue({
              timezone: 'Asia/Karachi',
              officeStartTime: '09:00',
              graceMinutes: 15,
              halfDayThresholdHours: 5,
              officeLocation: { lat: 24.86, lng: 67.0, radiusMeters: 150 },
            }),
          },
        },
        {
          provide: CalendarService,
          useValue: { forRange: jest.fn<AnyFn>().mockResolvedValue(new WorkCalendar(['Saturday', 'Sunday'], new Set(), 'Asia/Karachi')) },
        },
        { provide: AuditService, useValue: { record: auditRecord } },
      ],
    }).compile();
    service = moduleRef.get(AttendanceService);
  });

  it('creates one server-stamped record for the day', async () => {
    attendanceModel.exists.mockReturnValue(query(null));
    attendanceModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'rec1', toJSON: () => doc }));

    const before = Date.now();
    const record: any = await service.checkIn(employeeUser, { source: 'manual' });

    expect(attendanceModel.create).toHaveBeenCalledTimes(1);
    expect(['present', 'late']).toContain(record.status);
    expect(record.checkInAt.getTime()).toBeGreaterThanOrEqual(before); // server time, not client time
    expect(record.ruleSnapshot).toMatchObject({ officeStartTime: '09:00', graceMinutes: 15 });
  });

  it('throws 409 ConflictException on a second check-in the same day', async () => {
    attendanceModel.exists.mockReturnValue(query({ _id: 'existing' }));

    const error = await service.checkIn(employeeUser, { source: 'manual' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect(attendanceModel.create).not.toHaveBeenCalled();
  });

  it('maps a concurrent duplicate (unique index E11000) to 409 as well', async () => {
    attendanceModel.exists.mockReturnValue(query(null));
    attendanceModel.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

    await expect(service.checkIn(employeeUser, { source: 'manual' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('serializes simultaneous check-ins of the same employee (only one record)', async () => {
    let stored: unknown = null;
    attendanceModel.exists.mockImplementation(() => query(stored));
    attendanceModel.create.mockImplementation(async (doc: any) => {
      stored = doc;
      return { ...doc, toJSON: () => doc };
    });

    const results = await Promise.allSettled([
      service.checkIn(employeeUser, { source: 'manual' }),
      service.checkIn(employeeUser, { source: 'manual' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(attendanceModel.create).toHaveBeenCalledTimes(1);
  });

  it('refuses accounts without an employee profile', async () => {
    await expect(service.checkIn({ ...employeeUser, role: 'Admin', employeeId: null }, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
