import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AnnouncementsController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [AuditModule],
  controllers: [AnnouncementsController, NotificationsController],
  providers: [AnnouncementsService, NotificationsService],
  exports: [NotificationsService],
})
export class CommsModule {}
