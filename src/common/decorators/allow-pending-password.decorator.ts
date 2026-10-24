import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_KEY = 'allowPendingPasswordChange';

/**
 * Lets users whose temporary password must still be changed (`mustChangePassword: true`)
 * reach this route. Every other route is blocked for them until they change it.
 */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);
