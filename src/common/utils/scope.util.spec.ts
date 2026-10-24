import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../interfaces/auth-user.interface.js';
import { assertCanAccessEmployee, assertManager, resolveEmployeeScope } from './scope.util.js';

const base = { userId: 'u', email: 'x@y.z', fullName: 'X', mustChangePassword: false };
const employee: AuthUser = { ...base, role: 'Employee', employeeId: 'emp-own' };
const hr: AuthUser = { ...base, role: 'HR', employeeId: null };
const admin: AuthUser = { ...base, role: 'Admin', employeeId: null };

describe('Employee data-scope enforcement', () => {
  it('pins an Employee to their own employeeId when no id is requested', () => {
    expect(resolveEmployeeScope(employee)).toBe('emp-own');
    expect(resolveEmployeeScope(employee, 'emp-own')).toBe('emp-own');
  });

  it("refuses an Employee asking for another employee's data", () => {
    expect(() => resolveEmployeeScope(employee, 'emp-other')).toThrow(ForbiddenException);
    expect(() => assertCanAccessEmployee(employee, 'emp-other')).toThrow(ForbiddenException);
  });

  it('lets Admin/HR query any employee or everyone', () => {
    expect(resolveEmployeeScope(hr)).toBeUndefined();
    expect(resolveEmployeeScope(admin, 'emp-other')).toBe('emp-other');
    expect(() => assertCanAccessEmployee(hr, 'emp-other')).not.toThrow();
  });

  it('blocks Employees from manager-only aggregates', () => {
    expect(() => assertManager(employee)).toThrow(ForbiddenException);
    expect(() => assertManager(hr)).not.toThrow();
  });

  it('refuses an Employee login without an employee profile', () => {
    expect(() => resolveEmployeeScope({ ...employee, employeeId: null })).toThrow(ForbiddenException);
  });
});
