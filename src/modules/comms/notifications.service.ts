import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Role } from '../../common/constants/roles.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { paginate } from '../../common/utils/query.util.js';
import { User, type UserDocument } from '../auth/schemas/user.schema.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { NotificationQueryDto } from './dto/notification-query.dto.js';
import {
  Notification,
  type NotificationDocument,
  type NotificationType,
} from './schemas/notification.schema.js';

export interface NotificationPayload {
  title: string;
  message: string;
  type: NotificationType;
  entity?: string;
  entityId?: unknown;
}

/**
 * In-app notifications. Senders never fail the business operation if a notification
 * cannot be written; readers are always scoped to their own `userId`.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
  ) {}

  async notifyUsers(userIds: (string | Types.ObjectId)[], payload: NotificationPayload): Promise<void> {
    const unique = [...new Set(userIds.map(String))];
    if (unique.length === 0) return;
    try {
      await this.notificationModel.insertMany(
        unique.map((userId) => ({
          userId: new Types.ObjectId(userId),
          title: payload.title,
          message: payload.message,
          type: payload.type,
          entity: payload.entity ?? null,
          entityId: payload.entityId != null ? String(payload.entityId) : null,
        })),
      );
    } catch (error) {
      this.logger.error(`Failed to create notifications: ${(error as Error).message}`);
    }
  }

  /** Notifies the login linked to an employee profile (if any). */
  async notifyEmployee(employeeId: string | Types.ObjectId, payload: NotificationPayload): Promise<void> {
    const employee = await this.employeeModel.findById(employeeId, { userId: 1 }).lean().exec();
    if (employee?.userId) await this.notifyUsers([employee.userId], payload);
  }

  async notifyEmployees(employeeIds: (string | Types.ObjectId)[], payload: NotificationPayload): Promise<void> {
    if (employeeIds.length === 0) return;
    const employees = await this.employeeModel
      .find({ _id: { $in: employeeIds }, userId: { $ne: null } }, { userId: 1 })
      .lean()
      .exec();
    await this.notifyUsers(
      employees.map((e) => e.userId!).filter(Boolean),
      payload,
    );
  }

  /** Notifies every active user holding one of the roles (optionally excluding the actor). */
  async notifyRoles(roles: Role[], payload: NotificationPayload, excludeUserId?: string): Promise<void> {
    const users = await this.userModel
      .find({ role: { $in: roles }, isActive: true }, { _id: 1 })
      .lean()
      .exec();
    await this.notifyUsers(
      users.map((u) => String(u._id)).filter((id) => id !== excludeUserId),
      payload,
    );
  }

  async notifyAllActiveUsers(payload: NotificationPayload, excludeUserId?: string): Promise<void> {
    const users = await this.userModel.find({ isActive: true }, { _id: 1 }).lean().exec();
    await this.notifyUsers(
      users.map((u) => String(u._id)).filter((id) => id !== excludeUserId),
      payload,
    );
  }

  async findMine(user: AuthUser, query: NotificationQueryDto) {
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(user.userId) };
    if (query.unreadOnly) filter.isRead = false;
    return paginate(this.notificationModel, filter, {
      page: query.page,
      limit: query.limit,
      sort: { createdAt: -1 },
    });
  }

  async unreadCount(user: AuthUser): Promise<{ unread: number }> {
    const unread = await this.notificationModel
      .countDocuments({ userId: new Types.ObjectId(user.userId), isRead: false })
      .exec();
    return { unread };
  }

  async markRead(user: AuthUser, id: string) {
    const notification = await this.notificationModel
      .findOneAndUpdate(
        { _id: id, userId: new Types.ObjectId(user.userId) },
        { $set: { isRead: true, readAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!notification) throw new NotFoundException('Notification not found');
    return notification.toJSON();
  }

  async markAllRead(user: AuthUser): Promise<{ updated: number }> {
    const result = await this.notificationModel
      .updateMany(
        { userId: new Types.ObjectId(user.userId), isRead: false },
        { $set: { isRead: true, readAt: new Date() } },
      )
      .exec();
    return { updated: result.modifiedCount };
  }
}
