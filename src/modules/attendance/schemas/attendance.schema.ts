import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const ATTENDANCE_STATUSES = [
  'present',
  'late',
  'half_day',
  'missing_checkout',
  'absent',
  'on_leave',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_SOURCES = ['manual', 'camera', 'system', 'correction'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

/** Result of the camera + GPS geofence verification. Raw photos/coordinates are never stored. */
@Schema({ _id: false })
export class LocationVerification {
  @Prop({ type: String, default: 'camera' })
  source: string;

  @Prop({ type: Boolean, required: true })
  faceDetected: boolean;

  @Prop({ type: Number, required: true })
  faceCount: number;

  @Prop({ type: Number, required: true })
  distanceMeters: number;

  @Prop({ type: Number, required: true })
  gpsAccuracy: number;

  @Prop({ type: Number, required: true })
  radiusMeters: number;

  @Prop({ type: Boolean, required: true })
  withinRadius: boolean;

  @Prop({ type: Date, required: true })
  verifiedAt: Date;
}
export const LocationVerificationSchema = SchemaFactory.createForClass(LocationVerification);

/** Attendance rules in force when the record was created (rule changes only affect new records). */
@Schema({ _id: false })
export class AttendanceRuleSnapshot {
  @Prop({ type: String, required: true })
  timezone: string;

  @Prop({ type: String, required: true })
  officeStartTime: string;

  @Prop({ type: Number, required: true })
  graceMinutes: number;

  @Prop({ type: Number, required: true })
  halfDayThresholdHours: number;
}
export const AttendanceRuleSnapshotSchema = SchemaFactory.createForClass(AttendanceRuleSnapshot);

@Schema({ timestamps: true, collection: 'attendance' })
export class Attendance {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Employee', required: true })
  employeeId: Types.ObjectId;

  /** Department at the time of the record (for historical department-level KPIs). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Department', default: null })
  departmentId: Types.ObjectId | null;

  /** Local calendar day `YYYY-MM-DD` in the company timezone. */
  @Prop({ type: String, required: true })
  date: string;

  /** Server-stamped check-in instant (client clocks are never trusted). */
  @Prop({ type: Date, default: null })
  checkInAt: Date | null;

  @Prop({ type: Date, default: null })
  checkOutAt: Date | null;

  @Prop({ type: String, enum: ATTENDANCE_STATUSES, required: true })
  status: AttendanceStatus;

  @Prop({ type: Number, default: 0 })
  lateMinutes: number;

  @Prop({ type: Number, default: null })
  workedMinutes: number | null;

  /** False for weekends/holidays — such records are excluded from working-day KPIs. */
  @Prop({ type: Boolean, required: true })
  isWorkingDay: boolean;

  @Prop({ type: String, enum: ATTENDANCE_SOURCES, default: 'manual' })
  source: AttendanceSource;

  @Prop({ type: LocationVerificationSchema, default: null })
  checkInVerification: LocationVerification | null;

  @Prop({ type: LocationVerificationSchema, default: null })
  checkOutVerification: LocationVerification | null;

  @Prop({ type: AttendanceRuleSnapshotSchema, required: true })
  ruleSnapshot: AttendanceRuleSnapshot;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'LeaveRequest', default: null })
  leaveRequestId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  leaveTypeName: string | null;

  @Prop({ type: Boolean, default: false })
  corrected: boolean;

  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'AttendanceCorrection', default: [] })
  correctionIds: Types.ObjectId[];

  createdAt?: Date;
  updatedAt?: Date;
}

export type AttendanceDocument = HydratedDocument<Attendance>;
export const AttendanceSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(Attendance));

// One record per employee per day — enforced by the database as well as the service.
AttendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });
AttendanceSchema.index({ date: 1, status: 1 });
AttendanceSchema.index({ departmentId: 1, date: 1 });
