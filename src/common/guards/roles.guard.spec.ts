import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../constants/roles.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { RolesGuard } from './roles.guard.js';

function contextFor(role: Role, requiredRoles?: Role[]): { context: ExecutionContext; reflector: Reflector } {
  const handler = () => undefined;
  class TestController {}
  const reflector = new Reflector();
  if (requiredRoles) Reflect.defineMetadata(ROLES_KEY, requiredRoles, handler);
  const context = {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('RolesGuard', () => {
  it('allows any authenticated role when the route has no @Roles', () => {
    const { context, reflector } = contextFor('Employee');
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  it('allows a matching role', () => {
    const { context, reflector } = contextFor('HR', ['Admin', 'HR']);
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  it('rejects an Employee on an Admin/HR route with 403', () => {
    const { context, reflector } = contextFor('Employee', ['Admin', 'HR']);
    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects HR on an Admin-only route (e.g. payroll finalize, audit logs)', () => {
    const { context, reflector } = contextFor('HR', ['Admin']);
    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException);
  });
});
