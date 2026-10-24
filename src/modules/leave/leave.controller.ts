import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe.js';
import {
  CreateLeaveDto,
  LeaveBalanceQueryDto,
  LeaveQueryDto,
  RejectLeaveDto,
  ReviewLeaveDto,
  WorkingDaysQueryDto,
} from './dto/leave.dto.js';
import { LeaveService } from './leave.service.js';

@ApiTags('Leave')
@ApiBearerAuth()
@Controller('leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Post('requests')
  @ApiOperation({
    summary: 'Apply for leave (own). 422 on overlap with pending/approved leave or insufficient quota',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeaveDto) {
    return this.leave.create(user, dto);
  }

  @Get('requests')
  @ApiOperation({ summary: 'Leave requests (Admin/HR: all; Employee: own)' })
  findAll(@CurrentUser() user: AuthUser, @Query() query: LeaveQueryDto) {
    return this.leave.findAll(user, query);
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'One leave request (Employee: own only)' })
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.leave.findOne(user, id);
  }

  @Patch('requests/:id/approve')
  @Roles('HR')
  @ApiOperation({ summary: 'Approve with optional comment → notification + audit (HR; Admin can view)' })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ReviewLeaveDto) {
    return this.leave.approve(user, id, dto);
  }

  @Patch('requests/:id/reject')
  @Roles('HR')
  @ApiOperation({ summary: 'Reject with a comment → notification + audit (HR)' })
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: RejectLeaveDto) {
    return this.leave.reject(user, id, dto);
  }

  @Patch('requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel my own leave (pending, or approved before it starts)' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.leave.cancel(user, id);
  }

  @Get('balance')
  @ApiOperation({ summary: 'Leave balance per type for a year (Employee: own; Admin/HR: any employeeId)' })
  balance(@CurrentUser() user: AuthUser, @Query() query: LeaveBalanceQueryDto) {
    return this.leave.getBalances(user, query);
  }

  @Get('working-days')
  @ApiOperation({ summary: 'Count working days in a range (skips weekend days & public holidays)' })
  workingDays(@Query() query: WorkingDaysQueryDto) {
    return this.leave.workingDays(query);
  }
}
