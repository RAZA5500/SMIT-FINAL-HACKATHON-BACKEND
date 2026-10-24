import { Global, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, MongooseModule, type ModelDefinition } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AiLog, AiLogSchema } from '../modules/ai/schemas/ai-log.schema.js';
import {
  AttendanceCorrection,
  AttendanceCorrectionSchema,
} from '../modules/attendance/schemas/attendance-correction.schema.js';
import { Attendance, AttendanceSchema } from '../modules/attendance/schemas/attendance.schema.js';
import { AuditLog, AuditLogSchema } from '../modules/audit/schemas/audit-log.schema.js';
import { User, UserSchema } from '../modules/auth/schemas/user.schema.js';
import { Announcement, AnnouncementSchema } from '../modules/comms/schemas/announcement.schema.js';
import { Notification, NotificationSchema } from '../modules/comms/schemas/notification.schema.js';
import { Employee, EmployeeSchema } from '../modules/employees/schemas/employee.schema.js';
import { LeaveRequest, LeaveRequestSchema } from '../modules/leave/schemas/leave-request.schema.js';
import { PayrollRun, PayrollRunSchema } from '../modules/payroll/schemas/payroll-run.schema.js';
import { Payslip, PayslipSchema } from '../modules/payroll/schemas/payslip.schema.js';
import { CompanySettings, CompanySettingsSchema } from '../modules/setup/schemas/company-settings.schema.js';
import { Department, DepartmentSchema } from '../modules/setup/schemas/department.schema.js';
import { Designation, DesignationSchema } from '../modules/setup/schemas/designation.schema.js';
import { LeaveType, LeaveTypeSchema } from '../modules/setup/schemas/leave-type.schema.js';
import { PublicHoliday, PublicHolidaySchema } from '../modules/setup/schemas/public-holiday.schema.js';

/** Every collection, registered once. Modules own their schemas; this module only wires them. */
const MODELS: ModelDefinition[] = [
  { name: User.name, schema: UserSchema },
  { name: CompanySettings.name, schema: CompanySettingsSchema },
  { name: Department.name, schema: DepartmentSchema },
  { name: Designation.name, schema: DesignationSchema },
  { name: LeaveType.name, schema: LeaveTypeSchema },
  { name: PublicHoliday.name, schema: PublicHolidaySchema },
  { name: Employee.name, schema: EmployeeSchema },
  { name: Attendance.name, schema: AttendanceSchema },
  { name: AttendanceCorrection.name, schema: AttendanceCorrectionSchema },
  { name: LeaveRequest.name, schema: LeaveRequestSchema },
  { name: PayrollRun.name, schema: PayrollRunSchema },
  { name: Payslip.name, schema: PayslipSchema },
  { name: Notification.name, schema: NotificationSchema },
  { name: Announcement.name, schema: AnnouncementSchema },
  { name: AuditLog.name, schema: AuditLogSchema },
  { name: AiLog.name, schema: AiLogSchema },
];

/**
 * Waits for every index (notably the unique attendance employee/day index) to exist
 * before the app starts serving requests.
 */
@Injectable()
class IndexInitializer implements OnModuleInit {
  private readonly logger = new Logger('Database');

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onModuleInit(): Promise<void> {
    await Promise.all(Object.values(this.connection.models).map((model) => model.init()));
    this.logger.log(`Connected to MongoDB "${this.connection.name}" — ${Object.keys(this.connection.models).length} collections ready`);
  }
}

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('DATABASE_URL'),
        autoIndex: true,
        serverSelectionTimeoutMS: 10_000,
      }),
    }),
    MongooseModule.forFeature(MODELS),
  ],
  providers: [IndexInitializer],
  exports: [MongooseModule],
})
export class DatabaseModule {}
