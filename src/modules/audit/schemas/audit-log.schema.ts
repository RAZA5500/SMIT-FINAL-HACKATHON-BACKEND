import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'approve',
  'reject',
  'finalize',
  'import',
  'activate',
  'deactivate',
  'reset_password',
  'change_password',
  'initialize',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Append-only audit trail. Documents can be inserted and read — every update/delete
 * path is blocked at the schema level (see hooks below), and the service exposes no
 * mutation methods.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' })
export class AuditLog {
  /** `null` for system actions (startup bootstrap, scheduled jobs). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  actorId: Types.ObjectId | null;

  /** `Admin` | `HR` | `Employee` | `System` */
  @Prop({ type: String, required: true })
  actorRole: string;

  @Prop({ type: String, default: null })
  actorEmail: string | null;

  @Prop({ type: String, enum: AUDIT_ACTIONS, required: true })
  action: AuditAction;

  @Prop({ type: String, required: true })
  entity: string;

  @Prop({ type: String, default: null })
  entityId: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  before: unknown;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  after: unknown;

  createdAt?: Date;
}

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(AuditLog));

AuditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
AuditLogSchema.index({ actorId: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: -1 });

const IMMUTABLE_ERROR = 'Audit logs are immutable and cannot be modified or deleted';

const blockedQueryOps = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

for (const op of blockedQueryOps) {
  AuditLogSchema.pre(op, function () {
    throw new Error(IMMUTABLE_ERROR);
  });
}

AuditLogSchema.pre('save', function () {
  if (!this.isNew) throw new Error(IMMUTABLE_ERROR);
});
