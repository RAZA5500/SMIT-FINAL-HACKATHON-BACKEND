import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ALLOW_PENDING_PASSWORD_KEY } from '../decorators/allow-pending-password.decorator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import type { AuthUser } from '../interfaces/auth-user.interface.js';

/**
 * Global authentication guard. Every route requires a valid Bearer JWT unless marked
 * `@Public()`. Users holding a temporary password are blocked (403 PASSWORD_CHANGE_REQUIRED)
 * from everything except routes marked `@AllowPendingPasswordChange()`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;

    const user = context.switchToHttp().getRequest<{ user: AuthUser }>().user;
    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_KEY, targets);
    if (user.mustChangePassword && !allowPending) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Please change your temporary password before continuing (POST /api/auth/change-password).',
      });
    }
    return true;
  }

  override handleRequest<TUser = AuthUser>(err: unknown, user: TUser | false, info: unknown): TUser {
    if (err) throw err;
    if (!user) {
      const reason = info instanceof Error ? info.message : 'Authentication required';
      throw new UnauthorizedException(reason);
    }
    return user;
  }
}
