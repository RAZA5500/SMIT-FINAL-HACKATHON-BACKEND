import type { Role } from '../constants/roles.js';

/** The authenticated principal attached to `request.user` by the JWT strategy. */
export interface AuthUser {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  /** Linked employee profile. Always set for `Employee`; optional for `HR`/`Admin`. */
  employeeId: string | null;
  mustChangePassword: boolean;
}

export interface JwtPayload {
  sub: string;
  role: Role;
  employeeId: string | null;
  /** Token version — bumped on password change/reset/deactivation to revoke old tokens. */
  tv: number;
}
