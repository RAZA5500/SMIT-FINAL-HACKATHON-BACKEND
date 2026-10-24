import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { todayIn } from '../../common/utils/date.util.js';
import { AuditService } from '../audit/audit.service.js';
import { LATE_PENALTY_RULE, SALARY_COMPONENT_RATES, TAX_SLABS } from '../payroll/payroll.calculator.js';
import { UpdateSettingsDto } from './dto/settings.dto.js';
import { HolidaysService } from './holidays.service.js';
import { LeaveTypesService } from './leave-types.service.js';
import {
  COMPANY_SETTINGS_KEY,
  CompanySettings,
  type CompanySettingsDocument,
} from './schemas/company-settings.schema.js';

@Injectable()
export class SettingsService {
  constructor(
    @InjectModel(CompanySettings.name) private readonly settingsModel: Model<CompanySettingsDocument>,
    private readonly leaveTypes: LeaveTypesService,
    private readonly holidays: HolidaysService,
    private readonly audit: AuditService,
  ) {}

  find(): Promise<CompanySettingsDocument | null> {
    return this.settingsModel.findOne({ key: COMPANY_SETTINGS_KEY }).exec();
  }

  /** Company settings; 503 until first-run setup has been completed. */
  async get(): Promise<CompanySettingsDocument> {
    const settings = await this.find();
    if (!settings) {
      throw new ServiceUnavailableException(
        'System setup has not been completed yet. Call POST /api/setup/init first.',
      );
    }
    return settings;
  }

  async getJson() {
    return (await this.get()).toJSON();
  }

  /**
   * Admin-only policy update. Attendance records and payroll runs store rule snapshots,
   * so changes here only apply to records created afterwards.
   */
  async update(actor: AuthUser, dto: UpdateSettingsDto) {
    const settings = await this.get();
    const before = settings.toObject();

    const { officeLocation, ...fields } = dto;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) settings.set(key, value);
    }
    if (officeLocation) {
      const current = settings.officeLocation ?? { lat: null, lng: null, radiusMeters: 150 };
      settings.officeLocation = {
        lat: officeLocation.lat ?? current.lat ?? null,
        lng: officeLocation.lng ?? current.lng ?? null,
        radiusMeters: officeLocation.radiusMeters ?? current.radiusMeters ?? 150,
      };
    }
    await settings.save();

    await this.audit.record({
      actor,
      action: 'update',
      entity: 'CompanySettings',
      entityId: settings._id,
      before,
      after: settings,
    });
    return settings.toJSON();
  }

  async markClosedThrough(date: string): Promise<void> {
    await this.settingsModel.updateOne({ key: COMPANY_SETTINGS_KEY }, { $set: { lastClosedDate: date } }).exec();
  }

  /** Policies every role may read (Employee: "own relevant policies/holidays"). */
  async policies() {
    const settings = await this.get();
    const today = todayIn(settings.timezone);
    const year = today.slice(0, 4);
    const [leaveTypes, holidays] = await Promise.all([
      this.leaveTypes.findAll(false),
      this.holidays.findAll({ from: `${year}-01-01`, to: `${Number(year) + 1}-12-31` }),
    ]);
    const location = settings.officeLocation;
    return {
      companyName: settings.companyName,
      timezone: settings.timezone,
      currency: settings.currency,
      today,
      attendance: {
        officeStartTime: settings.officeStartTime,
        graceMinutes: settings.graceMinutes,
        halfDayThresholdHours: settings.halfDayThresholdHours,
        weekendDays: settings.weekendDays,
        latePenaltyRuleEnabled: settings.latePenaltyRuleEnabled,
        latePenaltyRule: `${LATE_PENALTY_RULE.latesPerPenalty} lates = ${LATE_PENALTY_RULE.penaltyDaysPerUnit} day deduction`,
        // Coordinates stay Admin/HR-only (GET /settings); the server alone decides the geofence.
        officeLocation: {
          configured: location?.lat != null && location?.lng != null,
          radiusMeters: location?.radiusMeters ?? 150,
        },
        camera: { requireSingleFace: true, maxGpsAccuracyMeters: 100 },
      },
      payroll: {
        hraRate: SALARY_COMPONENT_RATES.hraRate,
        medicalRate: SALARY_COMPONENT_RATES.medicalRate,
        grossMultiplier: 1 + SALARY_COMPONENT_RATES.hraRate + SALARY_COMPONENT_RATES.medicalRate,
        taxSlabs: TAX_SLABS,
      },
      leaveTypes,
      holidays,
    };
  }
}
