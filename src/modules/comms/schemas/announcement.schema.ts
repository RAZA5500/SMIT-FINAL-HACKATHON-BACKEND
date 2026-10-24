import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument, type Types } from 'mongoose';
import { ROLES, type Role } from '../../../common/constants/roles.js';
import { applyBaseSchemaOptions } from '../../../common/schema/base-schema.js';

@Schema({ timestamps: true, collection: 'announcements' })
export class Announcement {
  @Prop({ type: String, required: true, trim: true })
  title: string;

  @Prop({ type: String, required: true, trim: true })
  body: string;

  @Prop({ type: Boolean, default: false })
  pinned: boolean;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: String, required: true })
  createdByName: string;

  @Prop({ type: String, enum: ROLES, required: true })
  createdByRole: Role;

  createdAt?: Date;
  updatedAt?: Date;
}

export type AnnouncementDocument = HydratedDocument<Announcement>;
export const AnnouncementSchema = applyBaseSchemaOptions(SchemaFactory.createForClass(Announcement));

AnnouncementSchema.index({ pinned: -1, createdAt: -1 });
