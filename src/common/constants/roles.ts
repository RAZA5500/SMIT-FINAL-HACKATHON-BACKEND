export const ROLES = ['Admin', 'HR', 'Employee'] as const;

export type Role = (typeof ROLES)[number];

export const Role = {
  Admin: 'Admin',
  HR: 'HR',
  Employee: 'Employee',
} as const satisfies Record<string, Role>;

/** Roles that manage people data (org-wide scope). */
export const MANAGER_ROLES: Role[] = [Role.Admin, Role.HR];
