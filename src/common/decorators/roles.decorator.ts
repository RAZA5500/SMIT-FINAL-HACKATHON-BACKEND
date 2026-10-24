import { SetMetadata } from '@nestjs/common';
import type { Role } from '../constants/roles.js';

export const ROLES_KEY = 'roles';

/** Restricts a route (or controller) to the given roles, e.g. `@Roles('Admin', 'HR')`. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
