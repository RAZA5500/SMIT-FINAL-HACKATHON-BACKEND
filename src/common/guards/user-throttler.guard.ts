import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { THROTTLE_SCOPE_KEY } from '../decorators/throttle-scope.decorator.js';
import type { AuthUser } from '../interfaces/auth-user.interface.js';

/**
 * Rate limiting keyed by the authenticated user (falls back to the client IP for public
 * routes such as login). Routes in a `@ThrottleScope()` share a single bucket per user.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const user = req.user as AuthUser | undefined;
    if (user?.userId) return `user:${user.userId}`;
    const ip = Array.isArray(req.ips) && req.ips.length ? req.ips[0] : req.ip;
    return `ip:${ip ?? 'unknown'}`;
  }

  protected override generateKey(context: ExecutionContext, suffix: string, name: string): string {
    const scope = this.scopeOf(context);
    if (scope) return `${scope}:${name}:${suffix}`;
    return super.generateKey(context, suffix, name);
  }

  protected override async getErrorMessage(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<string> {
    if (this.scopeOf(context) === 'ai') {
      const minutes = Math.max(1, Math.ceil(detail.timeToExpire / 60));
      return `AI request limit reached (${detail.limit} per hour). Please try again in about ${minutes} minute(s).`;
    }
    return 'Too many requests — please slow down and try again shortly.';
  }

  private scopeOf(context: ExecutionContext): string | undefined {
    return this.reflector.getAllAndOverride<string | undefined>(THROTTLE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }
}
