import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { SetupModule } from '../setup/setup.module.js';
import { AiLogService } from './ai-log.service.js';
import { AiTimeoutInterceptor } from './ai-timeout.interceptor.js';
import { AiToolsService } from './ai-tools.service.js';
import { AiController, AiLogsController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { LlmService } from './llm.service.js';

@Module({
  imports: [SetupModule, DashboardModule, EmployeesModule, LeaveModule, PayrollModule],
  controllers: [AiController, AiLogsController],
  providers: [AiService, AiToolsService, AiLogService, LlmService, AiTimeoutInterceptor],
})
export class AiModule {}
