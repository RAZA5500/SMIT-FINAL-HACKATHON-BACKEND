import { SetMetadata } from '@nestjs/common';

export const THROTTLE_SCOPE_KEY = 'throttleScope';

/**
 * Makes every route in the decorated controller share ONE rate-limit bucket per user
 * (instead of one bucket per route). Used for the AI endpoints: 20 requests/user/hour in total.
 */
export const ThrottleScope = (scope: string) => SetMetadata(THROTTLE_SCOPE_KEY, scope);
