import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

export const AI_FEATURES = ['chat', 'dashboard-summary', 'smart-leave'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_CALL_STATUSES = ['success', 'fallback', 'timeout', 'error', 'refused', 'disabled'] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

export interface AiToolCall {
  name: string;
  input: unknown;
  status: 'ok' | 'denied' | 'error';
  error?: string;
}

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'ai_logs' })
export class AiLog {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true })
  role: string;

  @Prop({ type: String, enum: AI_FEATURES, required: true })
  feature: AiFeature;

  @Prop({ type: String, default: '' })
  prompt: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  toolsCalled: AiToolCall[];

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  response: unknown;

  @Prop({ type: String, enum: AI_CALL_STATUSES, required: true })
  status: AiCallStatus;

  @Prop({ type: Number, required: true })
  latencyMs: number;

  /** Claude model id used for the call (`model` is reserved by Mongoose documents). */
  @Prop({ type: String, default: null })
  llmModel: string | null;

  @Prop({ type: String, default: null })
  errorMessage: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  usage: { inputTokens: number; outputTokens: number } | null;

  createdAt?: Date;
}

export type AiLogDocument = HydratedDocument<AiLog>;
export const AiLogSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(AiLog));

AiLogSchema.index({ userId: 1, createdAt: -1 });
AiLogSchema.index({ feature: 1, createdAt: -1 });
