import { Module } from '@nestjs/common';
import { LeaveModule } from '../leave/leave.module.js';
import { SetupModule } from '../setup/setup.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { PersonalDashboardService } from './personal-dashboard.service.js';

@Module({
  imports: [SetupModule, LeaveModule],
  controllers: [DashboardController],
  providers: [DashboardService, PersonalDashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
