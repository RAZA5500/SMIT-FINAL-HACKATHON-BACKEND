import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Statuses that reserve days and block overlapping requests. */
export const ACTIVE_LEAVE_STATUSES: LeaveStatus[] = ['pending', 'approved'];

@Schema({ timestamps: true, collection: 'leave_requests' })
export class LeaveRequest {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Employee', required: true })
  employeeId: Types.ObjectId;

  /** Department at request time (department-level leave utilization). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Department', default: null })
  departmentId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'LeaveType', required: true })
  leaveTypeId: Types.ObjectId;

  @Prop({ type: String, required: true })
  leaveTypeName: string;

  @Prop({ type: Boolean, required: true })
  isPaid: boolean;

  @Prop({ type: String, required: true })
  startDate: string;

  @Prop({ type: String, required: true })
  endDate: string;

  /** The working days covered (weekends & public holidays skipped). */
  @Prop({ type: [String], default: [] })
  dates: string[];

  @Prop({ type: Number, required: true })
  workingDays: number;

  @Prop({ type: String, trim: true, default: '' })
  reason: string;

  @Prop({ type: String, enum: LEAVE_STATUSES, default: 'pending' })
  status: LeaveStatus;

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

export type LeaveRequestDocument = HydratedDocument<LeaveRequest>;
export const LeaveRequestSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(LeaveRequest));

LeaveRequestSchema.index({ employeeId: 1, status: 1, startDate: 1, endDate: 1 });
LeaveRequestSchema.index({ status: 1, dates: 1 });
LeaveRequestSchema.index({ departmentId: 1, status: 1 });
