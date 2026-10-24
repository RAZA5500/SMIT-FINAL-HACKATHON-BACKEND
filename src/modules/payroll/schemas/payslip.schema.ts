import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';
import { PAYROLL_STATUSES, type PayrollStatus } from './payroll-run.schema.js';

/** Employee details frozen at calculation time (the payslip never changes after finalize). */
@Schema({ _id: false })
export class PayslipEmployeeSnapshot {
  @Prop({ type: String, required: true }) code: string;
  @Prop({ type: String, required: true }) fullName: string;
  @Prop({ type: String, default: '' }) email: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Department', default: null })
  departmentId: Types.ObjectId | null;
  @Prop({ type: String, default: '' }) departmentName: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Designation', default: null })
  designationId: Types.ObjectId | null;
  @Prop({ type: String, default: '' }) designationName: string;
  @Prop({ type: String, required: true }) joinDate: string;
  @Prop({ type: String, default: null }) exitDate: string | null;
}
export const PayslipEmployeeSnapshotSchema = SchemaFactory.createForClass(PayslipEmployeeSnapshot);

@Schema({ timestamps: true, collection: 'payslips' })
export class Payslip {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'PayrollRun', required: true })
  payrollRunId: Types.ObjectId;

  @Prop({ type: String, required: true })
  month: string;

  /** Mirrors the run status (Employees only see finalized payslips). */
  @Prop({ type: String, enum: PAYROLL_STATUSES, default: 'draft' })
  status: PayrollStatus;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Employee', required: true })
  employeeId: Types.ObjectId;

  @Prop({ type: PayslipEmployeeSnapshotSchema, required: true })
  employee: PayslipEmployeeSnapshot;

  // ── Salary structure ────────────────────────────────
  @Prop({ type: Number, required: true }) basic: number;
  @Prop({ type: Number, required: true }) hra: number;
  @Prop({ type: Number, required: true }) medical: number;
  @Prop({ type: Number, required: true }) gross: number;

  // ── Attendance & proration ──────────────────────────
  @Prop({ type: Number, required: true }) workingDaysInMonth: number;
  @Prop({ type: Number, required: true }) eligibleWorkingDays: number;
  @Prop({ type: Number, required: true }) perDay: number;
  @Prop({ type: Number, required: true }) proratedGross: number;
  @Prop({ type: Number, required: true }) absentDays: number;
  @Prop({ type: Number, required: true }) unpaidLeaveDays: number;
  @Prop({ type: Number, required: true }) halfDays: number;
  @Prop({ type: Number, required: true }) lateCount: number;
  @Prop({ type: Number, required: true }) latePenaltyDays: number;
  @Prop({ type: Number, required: true }) deductionDays: number;
  @Prop({ type: Number, required: true }) attendanceDeduction: number;

  // ── Tax & net ───────────────────────────────────────
  @Prop({ type: Number, required: true }) annualGross: number;
  @Prop({ type: Number, required: true }) annualTax: number;
  @Prop({ type: Number, required: true }) monthlyTax: number;
  @Prop({ type: Number, required: true }) netPay: number;

  @Prop({ type: String, required: true }) currency: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type PayslipDocument = HydratedDocument<Payslip>;
export const PayslipSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(Payslip));

PayslipSchema.index({ payrollRunId: 1, employeeId: 1 }, { unique: true });
PayslipSchema.index({ employeeId: 1, month: -1 });
PayslipSchema.index({ month: 1, 'employee.departmentId': 1 });
