import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

@Schema({ timestamps: true, collection: 'public_holidays' })
export class PublicHoliday {
  @Prop({ type: String, required: true, trim: true })
  name: string;

  /** Local calendar date `YYYY-MM-DD`. */
  @Prop({ type: String, required: true, unique: true })
  date: string;

  @Prop({ type: String, trim: true, default: '' })
  description: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type PublicHolidayDocument = HydratedDocument<PublicHoliday>;
export const PublicHolidaySchema = applyBaseSchemaOptions(SchemaFactory.createForClass(PublicHoliday));
