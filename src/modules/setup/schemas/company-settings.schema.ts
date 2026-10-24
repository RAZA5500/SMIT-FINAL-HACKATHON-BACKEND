import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const COMPANY_SETTINGS_KEY = 'company';

@Schema({ _id: false })
export class OfficeLocation {
  @Prop({ type: Number, default: null })
  lat: number | null;

  @Prop({ type: Number, default: null })
  lng: number | null;

  @Prop({ type: Number, default: 150 })
  radiusMeters: number;
}
export const OfficeLocationSchema = SchemaFactory.createForClass(OfficeLocation);

/** Singleton organization policy document (one per deployment). */
@Schema({ timestamps: true, collection: 'company_settings' })
export class CompanySettings {
  /** Fixed singleton key with a unique index — makes concurrent first-run init race-safe. */
  @Prop({ type: String, required: true, unique: true, default: COMPANY_SETTINGS_KEY })
  key: string;

  @Prop({ type: String, required: true, trim: true })
  companyName: string;

  /** IANA timezone used to stamp attendance days and evaluate office hours. */
  @Prop({ type: String, default: 'Asia/Karachi' })
  timezone: string;

  @Prop({ type: String, default: 'PKR' })
  currency: string;

  @Prop({ type: String, default: '09:00' })
  officeStartTime: string;

  @Prop({ type: Number, default: 15 })
  graceMinutes: number;

  @Prop({ type: Number, default: 5 })
  halfDayThresholdHours: number;

  @Prop({ type: [String], default: ['Saturday', 'Sunday'] })
  weekendDays: string[];

  @Prop({ type: OfficeLocationSchema, default: () => ({}) })
  officeLocation: OfficeLocation;

  /** Bonus rule: every 3 lates in a month deduct 0.5 day of pay. */
  @Prop({ type: Boolean, default: false })
  latePenaltyRuleEnabled: boolean;

  /** First local date the system tracks attendance (set at init; absences are never back-filled before it). */
  @Prop({ type: String, required: true })
  trackingStartDate: string;

  /** Last local date whose attendance was closed (absent / missing_checkout / on_leave finalized). */
  @Prop({ type: String, default: null })
  lastClosedDate: string | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  initializedBy: Types.ObjectId | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type CompanySettingsDocument = HydratedDocument<CompanySettings>;
export const CompanySettingsSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(CompanySettings));
