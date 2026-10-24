import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CommsModule } from '../comms/comms.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { SetupModule } from '../setup/setup.module.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';
import { PayslipPdfService } from './payslip-pdf.service.js';

@Module({
  imports: [SetupModule, AuditModule, CommsModule, DashboardModule],
  controllers: [PayrollController],
  providers: [PayrollService, PayslipPdfService],
  exports: [PayrollService],
})
export class PayrollModule {}
