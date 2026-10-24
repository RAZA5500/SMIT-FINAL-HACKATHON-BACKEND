import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../../common/constants/roles.js';
import { isDuplicateKeyError } from '../../common/filters/mongo-exception.filter.js';
import { todayIn } from '../../common/utils/date.util.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { UsersService } from '../auth/users.service.js';
import { InitSetupDto } from './dto/settings.dto.js';
import { LeaveTypesService } from './leave-types.service.js';
import {
  COMPANY_SETTINGS_KEY,
  CompanySettings,
  type CompanySettingsDocument,
} from './schemas/company-settings.schema.js';

export const DEFAULT_TIMEZONE = 'Asia/Karachi';

/**
 * First-run flow. The database starts empty; the first visitor (or the startup bootstrap
 * from ADMIN_EMAIL/ADMIN_PASSWORD) creates the CompanySettings and the first Admin.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    @InjectModel(CompanySettings.name) private readonly settingsModel: Model<CompanySettingsDocument>,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly leaveTypes: LeaveTypesService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** `initialized` is true as soon as an Admin user or the CompanySettings record exists. */
  async status(): Promise<{ initialized: boolean }> {
    const [settings, admins] = await Promise.all([
      this.settingsModel.exists({ key: COMPANY_SETTINGS_KEY }).exec(),
      this.users.countAdmins(),
    ]);
    return { initialized: settings !== null || admins > 0 };
  }

  async initialize(dto: InitSetupDto, source: 'api' | 'env' = 'api') {
    if ((await this.status()).initialized) {
      throw new ConflictException('The system has already been initialized');
    }

    const timezone = dto.timezone ?? this.config.get<string>('APP_TIMEZONE') ?? DEFAULT_TIMEZONE;

    // The unique singleton key makes concurrent init attempts race-safe: only one insert wins.
    let settings: CompanySettingsDocument;
    try {
      settings = await this.settingsModel.create({
        key: COMPANY_SETTINGS_KEY,
        companyName: dto.companyName,
        timezone,
        currency: dto.currency ?? 'PKR',
        officeStartTime: dto.officeStartTime ?? '09:00',
        graceMinutes: dto.graceMinutes ?? 15,
        halfDayThresholdHours: dto.halfDayThresholdHours ?? 5,
        weekendDays: dto.weekendDays ?? ['Saturday', 'Sunday'],
        officeLocation: {
          lat: dto.officeLocation?.lat ?? null,
          lng: dto.officeLocation?.lng ?? null,
          radiusMeters: dto.officeLocation?.radiusMeters ?? 150,
        },
        latePenaltyRuleEnabled: dto.latePenaltyRuleEnabled ?? false,
        trackingStartDate: todayIn(timezone),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new ConflictException('The system has already been initialized');
      throw error;
    }

    let admin;
    try {
      ({ user: admin } = await this.users.createAccount({
        email: dto.admin.email,
        fullName: dto.admin.fullName,
        role: Role.Admin,
        password: dto.admin.password,
        mustChangePassword: false,
      }));
    } catch (error) {
      // Roll back the settings so setup can be retried.
      await this.settingsModel.deleteOne({ _id: settings._id }).exec();
      throw error;
    }

    settings.initializedBy = admin._id;
    await settings.save();
    await this.leaveTypes.ensureDefaults();

    const adminActor = this.users.toAuthUser(admin);
    await this.audit.record({
      actor: source === 'env' ? null : adminActor,
      action: 'initialize',
      entity: 'CompanySettings',
      entityId: settings._id,
      after: settings,
    });
    await this.audit.record({
      actor: source === 'env' ? null : adminActor,
      action: 'create',
      entity: 'User',
      entityId: admin._id,
      after: admin,
    });
    this.logger.log(`System initialized for "${settings.companyName}" (admin: ${admin.email}, via ${source})`);

    return {
      initialized: true,
      settings: settings.toJSON(),
      ...this.auth.issueToken(admin),
    };
  }
}
