import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { UpdateSettingsDto } from './dto/settings.dto.js';
import { SettingsService } from './settings.service.js';

@ApiTags('Setup: Company settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Company settings (Admin: manage, HR: view)' })
  get() {
    return this.settings.getJson();
  }

  @Patch()
  @Roles('Admin')
  @ApiOperation({ summary: 'Update company policy (Admin) — applies to new records only' })
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateSettingsDto) {
    return this.settings.update(user, dto);
  }

  @Get('policies')
  @ApiOperation({ summary: 'Attendance/leave/payroll policies + holidays visible to every role' })
  policies() {
    return this.settings.policies();
  }
}
