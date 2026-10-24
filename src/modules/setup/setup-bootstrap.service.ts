import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import { PASSWORD_REGEX, PASSWORD_RULE_MESSAGE } from '../../common/utils/password.util.js';
import { isValidTimeZone } from '../../common/utils/date.util.js';
import { SetupService } from './setup.service.js';

/**
 * Optional startup hook: when ADMIN_EMAIL and ADMIN_PASSWORD are present in the
 * environment and the system has not been initialized yet, create the CompanySettings
 * and the first Admin automatically. No other data is ever seeded.
 */
@Injectable()
export class SetupBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupBootstrapService.name);

  constructor(
    private readonly setup: SetupService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = this.config.get<string>('ADMIN_EMAIL')?.trim().toLowerCase();
    const password = this.config.get<string>('ADMIN_PASSWORD');
    if (!email || !password) return;

    try {
      if ((await this.setup.status()).initialized) {
        this.logger.log('System already initialized — ADMIN_EMAIL/ADMIN_PASSWORD bootstrap skipped');
        return;
      }
      if (!isEmail(email)) {
        this.logger.error('ADMIN_EMAIL is not a valid email address — bootstrap skipped');
        return;
      }
      if (!PASSWORD_REGEX.test(password)) {
        this.logger.error(`ADMIN_PASSWORD rejected: ${PASSWORD_RULE_MESSAGE} — bootstrap skipped`);
        return;
      }
      const timezone = this.config.get<string>('APP_TIMEZONE');
      await this.setup.initialize(
        {
          companyName: this.config.get<string>('COMPANY_NAME')?.trim() || 'My Company',
          timezone: timezone && isValidTimeZone(timezone) ? timezone : undefined,
          admin: {
            email,
            password,
            fullName: this.config.get<string>('ADMIN_FULL_NAME')?.trim() || 'System Administrator',
          },
        },
        'env',
      );
    } catch (error) {
      this.logger.warn(`Startup bootstrap did not complete: ${(error as Error).message}`);
    }
  }
}
