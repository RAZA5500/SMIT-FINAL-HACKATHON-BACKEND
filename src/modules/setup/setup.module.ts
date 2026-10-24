import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CalendarService } from './calendar.service.js';
import { DepartmentsService } from './departments.service.js';
import { DesignationsService } from './designations.service.js';
import { HolidaysService } from './holidays.service.js';
import { LeaveTypesService } from './leave-types.service.js';
import {
  DepartmentsController,
  DesignationsController,
  HolidaysController,
  LeaveTypesController,
} from './org.controllers.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { SetupBootstrapService } from './setup-bootstrap.service.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [
    SetupController,
    SettingsController,
    DepartmentsController,
    DesignationsController,
    LeaveTypesController,
    HolidaysController,
  ],
  providers: [
    SetupService,
    SetupBootstrapService,
    SettingsService,
    CalendarService,
    DepartmentsService,
    DesignationsService,
    LeaveTypesService,
    HolidaysService,
  ],
  exports: [SettingsService, CalendarService, DepartmentsService, DesignationsService, LeaveTypesService, HolidaysService],
})
export class SetupModule {}
