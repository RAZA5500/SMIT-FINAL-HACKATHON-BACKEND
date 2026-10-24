import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const PAYROLL_STATUSES = ['draft', 'finalized'] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

/** Payroll rules in force when the run was (re)calculated — later rule changes never touch it. */
@Schema({ _id: false })
export class PayrollRuleSnapshot {
  @Prop({ type: Number, required: true })
  hraRate: number;

  @Prop({ type: Number, required: true })
  medicalRate: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  taxSlabs: { upTo: number | null; base: number; rate: number; threshold: number }[];

  @Prop({ type: Boolean, required: true })
  latePenaltyRuleEnabled: boolean;

  @Prop({ type: Number, required: true })
  latesPerPenalty: number;

  @Prop({ type: Number, required: true })
  penaltyDaysPerUnit: number;

  @Prop({ type: [String], required: true })
  weekendDays: string[];

  @Prop({ type: [String], default: [] })
  holidays: string[];

  @Prop({ type: String, required: true })
  currency: string;
}
export const PayrollRuleSnapshotSchema = SchemaFactory.createForClass(PayrollRuleSnapshot);

@Schema({ _id: false })
export class PayrollTotals {
  @Prop({ type: Number, default: 0 }) employees: number;
  @Prop({ type: Number, default: 0 }) gross: number;
  @Prop({ type: Number, default: 0 }) proratedGross: number;
  @Prop({ type: Number, default: 0 }) attendanceDeduction: number;
  @Prop({ type: Number, default: 0 }) tax: number;
  @Prop({ type: Number, default: 0 }) net: number;
}
export const PayrollTotalsSchema = SchemaFactory.createForClass(PayrollTotals);

@Schema({ timestamps: true, collection: 'payroll_runs' })
export class PayrollRun {
  /** `YYYY-MM` — one run per month. */
  @Prop({ type: String, required: true, unique: true })
  month: string;

  @Prop({ type: String, enum: PAYROLL_STATUSES, default: 'draft' })
  status: PayrollStatus;

  @Prop({ type: Number, required: true })
  workingDaysInMonth: number;

  @Prop({ type: PayrollRuleSnapshotSchema, required: true })
  ruleSnapshot: PayrollRuleSnapshot;

  @Prop({ type: PayrollTotalsSchema, default: () => ({}) })
  totals: PayrollTotals;

  @Prop({ type: String, trim: true, default: '' })
  notes: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  updatedBy: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  finalizedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  finalizedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastCalculatedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type PayrollRunDocument = HydratedDocument<PayrollRun>;
export const PayrollRunSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(PayrollRun));
