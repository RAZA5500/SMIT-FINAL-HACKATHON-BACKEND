import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const NOTIFICATION_TYPES = ['leave', 'attendance', 'payroll', 'announcement', 'account', 'system'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

@Schema({ timestamps: true, collection: 'notifications' })
export class Notification {
  /** Recipient — notifications are always read in "own" scope. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, required: true })
  message: string;

  @Prop({ type: String, enum: NOTIFICATION_TYPES, default: 'system' })
  type: NotificationType;

  @Prop({ type: String, default: null })
  entity: string | null;

  @Prop({ type: String, default: null })
  entityId: string | null;

  @Prop({ type: Boolean, default: false })
  isRead: boolean;

  @Prop({ type: Date, default: null })
  readAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(Notification));

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
