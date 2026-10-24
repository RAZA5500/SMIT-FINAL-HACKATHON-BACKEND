import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

@Schema({ timestamps: true, collection: 'leave_types' })
export class LeaveType {
  @Prop({ type: String, required: true, trim: true })
  name: string;

  /** Working days allowed per calendar year. `null` = unlimited (e.g. Unpaid). */
  @Prop({ type: Number, default: null })
  annualQuota: number | null;

  /** Unpaid leave days are deducted in payroll. */
  @Prop({ type: Boolean, default: true })
  isPaid: boolean;

  @Prop({ type: String, trim: true, default: '' })
  description: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type LeaveTypeDocument = HydratedDocument<LeaveType>;
export const LeaveTypeSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(LeaveType));

LeaveTypeSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

/** Policy defaults created during first-run setup. */
export const DEFAULT_LEAVE_TYPES: Pick<LeaveType, 'name' | 'annualQuota' | 'isPaid' | 'description'>[] = [
  { name: 'Annual', annualQuota: 14, isPaid: true, description: 'Planned annual leave' },
  { name: 'Sick', annualQuota: 8, isPaid: true, description: 'Illness or medical appointments' },
  { name: 'Casual', annualQuota: 10, isPaid: true, description: 'Short personal errands' },
  { name: 'Unpaid', annualQuota: null, isPaid: false, description: 'Unlimited, deducted from salary' },
];
