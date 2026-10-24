import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { catchError, of, throwError, timeout, TimeoutError, type Observable } from 'rxjs';
import { AI_FALLBACK_MESSAGES, AI_TIMEOUT_MS } from './ai.constants.js';

/**
 * Safety net around every AI route: the services already abort the model call after
 * 15 s (AbortSignal.timeout); if anything else stalls, the client still gets a friendly
 * fallback in the shape that endpoint normally returns, instead of a hanging request.
 */
@Injectable()
export class AiTimeoutInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler().name;
    return next.handle().pipe(
      timeout(AI_TIMEOUT_MS + 1_500),
      catchError((error: unknown) =>
        error instanceof TimeoutError ? of(this.fallbackFor(handler)) : throwError(() => error),
      ),
    );
  }

  private fallbackFor(handler: string): Record<string, unknown> {
    const base = { aiGenerated: true, status: 'timeout', fallback: true };
    switch (handler) {
      case 'smartLeave':
        return {
          ...base,
          feature: 'smart-leave',
          fallbackToManualForm: true,
          draft: null,
          message: 'The AI took too long — please use the manual leave form.',
        };
      case 'dashboardSummary':
        return { ...base, feature: 'dashboard-summary', bullets: [], message: AI_FALLBACK_MESSAGES.timeout };
      default:
        return { ...base, feature: 'chat', reply: AI_FALLBACK_MESSAGES.timeout, toolsCalled: [] };
    }
  }
}
