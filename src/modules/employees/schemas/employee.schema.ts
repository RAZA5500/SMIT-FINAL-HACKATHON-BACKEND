import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const EMPLOYEE_STATUSES = ['active', 'probation', 'exited'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const GENDERS = ['male', 'female', 'other'] as const;
export type Gender = (typeof GENDERS)[number];

@Schema({ timestamps: true, collection: 'employees' })
export class Employee {
  /** Unique employee code, stored upper-case (e.g. `EMP-001`). */
  @Prop({ type: String, required: true, unique: true, uppercase: true, trim: true })
  code: string;

  @Prop({ type: String, required: true, trim: true })
  fullName: string;

  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ type: String, trim: true, default: '' })
  phone: string;

  @Prop({ type: String, trim: true, default: '' })
  address: string;

  @Prop({ type: String, enum: [...GENDERS, null], default: null })
  gender: Gender | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Department', required: true })
  departmentId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Designation', required: true })
  designationId: Types.ObjectId;

  /** `YYYY-MM-DD` */
  @Prop({ type: String, required: true })
  joinDate: string;

  @Prop({ type: String, enum: EMPLOYEE_STATUSES, default: 'active' })
  status: EmployeeStatus;

  /** Last day of employment `YYYY-MM-DD` (required when status is `exited`). */
  @Prop({ type: String, default: null })
  exitDate: string | null;

  /** Monthly basic salary set by HR. HRA (40%), medical (10%) and gross (1.5×) are derived. */
  @Prop({ type: Number, required: true, min: 0 })
  basicSalary: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type EmployeeDocument = HydratedDocument<Employee>;
export const EmployeeSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(Employee));

EmployeeSchema.index({ departmentId: 1, status: 1 });
EmployeeSchema.index({ designationId: 1 });
EmployeeSchema.index({ joinDate: 1, exitDate: 1 });
EmployeeSchema.index({ fullName: 1 });
