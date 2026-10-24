import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CommsModule } from '../comms/comms.module.js';
import { SetupModule } from '../setup/setup.module.js';
import { AttendanceCloserService } from './attendance-closer.service.js';
import { AttendanceCorrectionsService } from './attendance-corrections.service.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';

@Module({
  imports: [SetupModule, AuditModule, CommsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService, AttendanceCorrectionsService, AttendanceCloserService],
  exports: [AttendanceService, AttendanceCloserService],
})
export class AttendanceModule {}
