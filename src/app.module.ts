import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard.js';
import { validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CommsModule } from './modules/comms/comms.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { LeaveModule } from './modules/leave/leave.module.js';
import { PayrollModule } from './modules/payroll/payroll.module.js';
import { SetupModule } from './modules/setup/setup.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: Number(config.get<string>('THROTTLE_LIMIT') ?? 300) }],
      }),
    }),
    DatabaseModule,
    AuditModule, // M9
    AuthModule, // M1
    CommsModule, // M9
    SetupModule, // M2
    EmployeesModule, // M3
    AttendanceModule, // M4
    LeaveModule, // M5
    PayrollModule, // M6
    DashboardModule, // M7
    AiModule, // M8
  ],
  controllers: [AppController],
  providers: [
    // Order matters: authenticate → authorize (roles) → rate-limit per user.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
