import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { SetupModule } from '../setup/setup.module.js';
import { EmployeeImportService } from './employee-import.service.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';

@Module({
  imports: [AuthModule, SetupModule, AuditModule, AttendanceModule, LeaveModule, PayrollModule, DashboardModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeImportService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
