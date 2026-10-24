import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

@Schema({ timestamps: true, collection: 'designations' })
export class Designation {
  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, trim: true, default: '' })
  description: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type DesignationDocument = HydratedDocument<Designation>;
export const DesignationSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(Designation));

DesignationSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
