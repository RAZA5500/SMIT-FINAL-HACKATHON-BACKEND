import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe.js';
import { DepartmentsService } from './departments.service.js';
import { DesignationsService } from './designations.service.js';
import {
  CreateDepartmentDto,
  CreateDesignationDto,
  CreateHolidayDto,
  CreateLeaveTypeDto,
  HolidayQueryDto,
  IncludeInactiveQueryDto,
  UpdateDepartmentDto,
  UpdateDesignationDto,
  UpdateHolidayDto,
  UpdateLeaveTypeDto,
} from './dto/org.dto.js';
import { HolidaysService } from './holidays.service.js';
import { LeaveTypesService } from './leave-types.service.js';

/** Permissions (M2): Admin = manage; HR = view; Employee = view own relevant policies/holidays. */

@ApiTags('Setup: Departments')
@ApiBearerAuth()
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'List departments with headcount (Admin/HR)' })
  findAll(@Query() query: IncludeInactiveQueryDto) {
    return this.departments.findAll(query.includeInactive);
  }

  @Get(':id')
  @Roles('Admin', 'HR')
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return (await this.departments.findOne(id)).toJSON();
  }

  @Post()
  @Roles('Admin')
  @ApiOperation({ summary: 'Create department (Admin)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDepartmentDto) {
    return this.departments.create(user, dto);
  }

  @Patch(':id')
  @Roles('Admin')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateDepartmentDto) {
    return this.departments.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('Admin')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.departments.remove(user, id);
  }
}

@ApiTags('Setup: Designations')
@ApiBearerAuth()
@Controller('designations')
export class DesignationsController {
  constructor(private readonly designations: DesignationsService) {}

  @Get()
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'List designations with headcount (Admin/HR)' })
  findAll(@Query() query: IncludeInactiveQueryDto) {
    return this.designations.findAll(query.includeInactive);
  }

  @Get(':id')
  @Roles('Admin', 'HR')
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return (await this.designations.findOne(id)).toJSON();
  }

  @Post()
  @Roles('Admin')
  @ApiOperation({ summary: 'Create designation (Admin)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDesignationDto) {
    return this.designations.create(user, dto);
  }

  @Patch(':id')
  @Roles('Admin')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateDesignationDto) {
    return this.designations.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('Admin')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.designations.remove(user, id);
  }
}

@ApiTags('Setup: Leave types')
@ApiBearerAuth()
@Controller('leave-types')
export class LeaveTypesController {
  constructor(private readonly leaveTypes: LeaveTypesService) {}

  @Get()
  @ApiOperation({ summary: 'List leave types & quotas (all roles; inactive ones for Admin/HR only)' })
  findAll(@CurrentUser() user: AuthUser, @Query() query: IncludeInactiveQueryDto) {
    const includeInactive = user.role !== 'Employee' && query.includeInactive === true;
    return this.leaveTypes.findAll(includeInactive);
  }

  @Post()
  @Roles('Admin')
  @ApiOperation({ summary: 'Create leave type (Admin). annualQuota null = unlimited' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeaveTypeDto) {
    return this.leaveTypes.create(user, dto);
  }

  @Patch(':id')
  @Roles('Admin')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateLeaveTypeDto) {
    return this.leaveTypes.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('Admin')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.leaveTypes.remove(user, id);
  }
}

@ApiTags('Setup: Public holidays')
@ApiBearerAuth()
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  @ApiOperation({ summary: 'List public holidays (all roles) — filter by year or from/to' })
  findAll(@Query() query: HolidayQueryDto) {
    return this.holidays.findAll(query);
  }

  @Post()
  @Roles('Admin')
  @ApiOperation({ summary: 'Add a public holiday (Admin)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateHolidayDto) {
    return this.holidays.create(user, dto);
  }

  @Patch(':id')
  @Roles('Admin')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateHolidayDto) {
    return this.holidays.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('Admin')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.holidays.remove(user, id);
  }
}
