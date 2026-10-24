import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CorrectionStatus = (typeof REQUEST_STATUSES)[number];

@Schema({ timestamps: true, collection: 'attendance_corrections' })
export class AttendanceCorrection {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Employee', required: true })
  employeeId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Attendance', default: null })
  attendanceId: Types.ObjectId | null;

  /** Day being corrected `YYYY-MM-DD`. */
  @Prop({ type: String, required: true })
  date: string;

  /** Requested local check-in time `HH:mm` (null = keep current). */
  @Prop({ type: String, default: null })
  requestedCheckIn: string | null;

  /** Requested local check-out time `HH:mm` (null = keep current). */
  @Prop({ type: String, default: null })
  requestedCheckOut: string | null;

  @Prop({ type: String, required: true, trim: true })
  reason: string;

  @Prop({ type: String, enum: REQUEST_STATUSES, default: 'pending' })
  status: CorrectionStatus;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  requestedBy: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  reviewedBy: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  reviewComment: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type AttendanceCorrectionDocument = HydratedDocument<AttendanceCorrection>;
export const AttendanceCorrectionSchema = applyBaseSchemaOptions(
  SchemaFactory.createForClass(AttendanceCorrection),
);

AttendanceCorrectionSchema.index({ employeeId: 1, date: 1, status: 1 });
AttendanceCorrectionSchema.index({ status: 1, createdAt: -1 });
