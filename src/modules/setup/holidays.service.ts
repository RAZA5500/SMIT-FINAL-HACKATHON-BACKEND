import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateHolidayDto, HolidayQueryDto, UpdateHolidayDto } from './dto/org.dto.js';
import { PublicHoliday, type PublicHolidayDocument } from './schemas/public-holiday.schema.js';

@Injectable()
export class HolidaysService {
  constructor(
    @InjectModel(PublicHoliday.name) private readonly holidayModel: Model<PublicHolidayDocument>,
    private readonly audit: AuditService,
  ) {}

  async create(actor: AuthUser, dto: CreateHolidayDto) {
    const holiday = await this.holidayModel.create({
      name: dto.name,
      date: dto.date,
      description: dto.description ?? '',
    });
    await this.audit.record({ actor, action: 'create', entity: 'PublicHoliday', entityId: holiday._id, after: holiday });
    return holiday.toJSON();
  }

  async findAll(query: HolidayQueryDto) {
    const filter: Record<string, unknown> = {};
    const date: Record<string, string> = {};
    if (query.year) {
      date.$gte = `${query.year}-01-01`;
      date.$lte = `${query.year}-12-31`;
    }
    if (query.from) date.$gte = query.from;
    if (query.to) date.$lte = query.to;
    if (date.$gte && date.$lte && date.$gte > date.$lte) {
      throw new BadRequestException('from must be on or before to');
    }
    if (Object.keys(date).length) filter.date = date;
    const holidays = await this.holidayModel.find(filter).sort({ date: 1 }).exec();
    return holidays.map((h) => h.toJSON());
  }

  async findOne(id: string) {
    const holiday = await this.holidayModel.findById(id).exec();
    if (!holiday) throw new NotFoundException('Holiday not found');
    return holiday;
  }

  async update(actor: AuthUser, id: string, dto: UpdateHolidayDto) {
    const holiday = await this.findOne(id);
    const before = holiday.toObject();
    if (dto.name !== undefined) holiday.name = dto.name;
    if (dto.date !== undefined) holiday.date = dto.date;
    if (dto.description !== undefined) holiday.description = dto.description;
    await holiday.save();
    await this.audit.record({ actor, action: 'update', entity: 'PublicHoliday', entityId: holiday._id, before, after: holiday });
    return holiday.toJSON();
  }

  async remove(actor: AuthUser, id: string): Promise<{ deleted: true }> {
    const holiday = await this.findOne(id);
    await holiday.deleteOne();
    await this.audit.record({ actor, action: 'delete', entity: 'PublicHoliday', entityId: holiday._id, before: holiday });
    return { deleted: true };
  }

  /** Holiday dates within an inclusive range. */
  async datesBetween(from: string, to: string): Promise<Set<string>> {
    const holidays = await this.holidayModel
      .find({ date: { $gte: from, $lte: to } }, { date: 1 })
      .lean()
      .exec();
    return new Set(holidays.map((h) => h.date));
  }
}
