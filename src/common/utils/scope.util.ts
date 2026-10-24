import { ForbiddenException } from '@nestjs/common';
import { Role } from '../constants/roles.js';
import type { AuthUser } from '../interfaces/auth-user.interface.js';

/**
 * Data-scope enforcement helpers. Every service method that reads people data runs the
 * caller through these: an `Employee` is always pinned to `employeeId: user.employeeId`
 * and can never widen the scope by passing another employee's id.
 */

export const OWN_DATA_ONLY_MESSAGE =
  'Access denied: employees can only access their own records.';

export function isEmployee(user: AuthUser): boolean {
  return user.role === Role.Employee;
}

export function isManager(user: AuthUser): boolean {
  return user.role === Role.Admin || user.role === Role.HR;
}

/** Returns the caller's employee id or throws if the account has no employee profile. */
export function requireEmployeeId(user: AuthUser): string {
  if (!user.employeeId) {
    throw new ForbiddenException('No employee profile is linked to this account.');
  }
  return user.employeeId;
}

/**
 * Resolves which employee a query may target.
 * - Employee: always their own id; asking for anyone else → 403.
 * - Admin/HR: the requested id (or undefined = everyone).
 */
export function resolveEmployeeScope(user: AuthUser, requestedEmployeeId?: string | null): string | undefined {
  if (isEmployee(user)) {
    const own = requireEmployeeId(user);
    if (requestedEmployeeId && requestedEmployeeId !== own) {
      throw new ForbiddenException(OWN_DATA_ONLY_MESSAGE);
    }
    return own;
  }
  return requestedEmployeeId ?? undefined;
}

/** Throws 403 when an Employee touches a record that belongs to someone else. */
export function assertCanAccessEmployee(user: AuthUser, ownerEmployeeId: unknown): void {
  if (!isEmployee(user)) return;
  const own = requireEmployeeId(user);
  if (String(ownerEmployeeId) !== own) {
    throw new ForbiddenException(OWN_DATA_ONLY_MESSAGE);
  }
}

/** Throws 403 unless the caller is Admin or HR. */
export function assertManager(user: AuthUser, message = 'Only Admin or HR can access this data.'): void {
  if (!isManager(user)) throw new ForbiddenException(message);
}
