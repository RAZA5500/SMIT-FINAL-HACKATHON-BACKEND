import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../../common/constants/roles.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { paginate } from '../../common/utils/query.util.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto/announcement.dto.js';
import { NotificationsService } from './notifications.service.js';
import { Announcement, type AnnouncementDocument } from './schemas/announcement.schema.js';

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectModel(Announcement.name) private readonly announcementModel: Model<AnnouncementDocument>,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: AuthUser, dto: CreateAnnouncementDto) {
    const announcement = await this.announcementModel.create({
      title: dto.title,
      body: dto.body,
      pinned: dto.pinned ?? false,
      createdBy: actor.userId,
      createdByName: actor.fullName,
      createdByRole: actor.role,
    });
    await this.audit.record({
      actor,
      action: 'create',
      entity: 'Announcement',
      entityId: announcement._id,
      after: announcement,
    });
    await this.notifications.notifyAllActiveUsers(
      {
        title: `Announcement: ${announcement.title}`,
        message: announcement.body.length > 160 ? `${announcement.body.slice(0, 157)}...` : announcement.body,
        type: 'announcement',
        entity: 'Announcement',
        entityId: announcement._id,
      },
      actor.userId,
    );
    return announcement.toJSON();
  }

  findAll(query: PaginationQueryDto) {
    return paginate(this.announcementModel, {}, {
      page: query.page,
      limit: query.limit,
      sort: { pinned: -1, createdAt: -1 },
    });
  }

  async findOne(id: string) {
    const announcement = await this.announcementModel.findById(id).exec();
    if (!announcement) throw new NotFoundException('Announcement not found');
    return announcement.toJSON();
  }

  async update(actor: AuthUser, id: string, dto: UpdateAnnouncementDto) {
    const announcement = await this.getEditable(actor, id);
    const before = announcement.toObject();
    if (dto.title !== undefined) announcement.title = dto.title;
    if (dto.body !== undefined) announcement.body = dto.body;
    if (dto.pinned !== undefined) announcement.pinned = dto.pinned;
    await announcement.save();
    await this.audit.record({
      actor,
      action: 'update',
      entity: 'Announcement',
      entityId: announcement._id,
      before,
      after: announcement,
    });
    return announcement.toJSON();
  }

  async remove(actor: AuthUser, id: string): Promise<{ deleted: true }> {
    const announcement = await this.getEditable(actor, id);
    await announcement.deleteOne();
    await this.audit.record({
      actor,
      action: 'delete',
      entity: 'Announcement',
      entityId: announcement._id,
      before: announcement,
    });
    return { deleted: true };
  }

  /** Admin can edit any announcement; HR only their own. */
  private async getEditable(actor: AuthUser, id: string) {
    const announcement = await this.announcementModel.findById(id).exec();
    if (!announcement) throw new NotFoundException('Announcement not found');
    if (actor.role !== Role.Admin && String(announcement.createdBy) !== actor.userId) {
      throw new ForbiddenException('HR can only edit or delete their own announcements.');
    }
    return announcement;
  }
}
