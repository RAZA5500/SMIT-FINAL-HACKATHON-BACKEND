import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { ROLES, type Role } from '../../../common/constants/roles.js';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ type: String, required: true })
  passwordHash: string;

  @Prop({ type: String, required: true, trim: true })
  fullName: string;

  @Prop({ type: String, required: true, enum: ROLES })
  role: Role;

  /** Linked employee profile (required for Employee, optional for HR/Admin). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Employee', default: null })
  employeeId: Types.ObjectId | null;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  mustChangePassword: boolean;

  /** Incremented to revoke every JWT issued before (password change/reset, deactivation). */
  @Prop({ type: Number, default: 0 })
  tokenVersion: number;

  @Prop({ type: Date, default: null })
  lastLoginAt: Date | null;

  @Prop({ type: Date, default: null })
  passwordChangedAt: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type UserDocument = HydratedDocument<User>;

export const UserSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(User), [
  'passwordHash',
  'tokenVersion',
]);

// One login per employee profile.
UserSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'objectId' } } },
);
UserSchema.index({ role: 1, isActive: 1 });
