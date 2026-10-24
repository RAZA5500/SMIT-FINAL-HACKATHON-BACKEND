import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe.js';
import { AttendanceCloserService } from './attendance-closer.service.js';
import { AttendanceCorrectionsService } from './attendance-corrections.service.js';
import { AttendanceService } from './attendance.service.js';
import {
  AttendanceBoardQueryDto,
  AttendancePunchDto,
  AttendanceQueryDto,
  AttendanceRangeQueryDto,
  CloseDaysDto,
  CorrectionQueryDto,
  CreateCorrectionDto,
  RejectCorrectionDto,
  ReviewCorrectionDto,
} from './dto/attendance.dto.js';

@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly corrections: AttendanceCorrectionsService,
    private readonly closer: AttendanceCloserService,
  ) {}

  @Post('check-in')
  @ApiOperation({
    summary: 'Check in (server-stamped). 409 on a second check-in the same day; camera source is geofenced',
  })
  checkIn(@CurrentUser() user: AuthUser, @Body() dto: AttendancePunchDto) {
    return this.attendance.checkIn(user, dto);
  }

  @Post('check-out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check out (server-stamped). Worked < 5h → half_day' })
  checkOut(@CurrentUser() user: AuthUser, @Body() dto: AttendancePunchDto) {
    return this.attendance.checkOut(user, dto);
  }

  @Get('today')
  @ApiOperation({ summary: "My attendance status for today" })
  today(@CurrentUser() user: AuthUser) {
    return this.attendance.today(user);
  }

  @Get('me')
  @ApiOperation({ summary: 'My attendance records (default: last 30 days)' })
  mine(@CurrentUser() user: AuthUser, @Query() query: AttendanceRangeQueryDto) {
    return this.attendance.findMine(user, query);
  }

  @Get()
  @ApiOperation({ summary: 'Attendance records (Admin/HR: everyone; Employee: own only)' })
  findAll(@CurrentUser() user: AuthUser, @Query() query: AttendanceQueryDto) {
    return this.attendance.findAll(user, query);
  }

  @Get('board')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Daily attendance board: every employee with their status for the day (Admin/HR)' })
  board(@CurrentUser() user: AuthUser, @Query() query: AttendanceBoardQueryDto) {
    return this.attendance.board(user, query);
  }

  @Post('close-days')
  @HttpCode(HttpStatus.OK)
  @Roles('Admin', 'HR')
  @ApiOperation({
    summary: 'Run the end-of-day close now (absent / on_leave / missing_checkout) up to yesterday (Admin/HR)',
  })
  closeDays(@CurrentUser() user: AuthUser, @Body() dto: CloseDaysDto) {
    return this.closer.closePendingDays(user, dto.upTo);
  }

  // ── Corrections ────────────────────────────────────────
  @Post('corrections')
  @ApiOperation({ summary: 'Request an attendance correction with a reason (own records)' })
  requestCorrection(@CurrentUser() user: AuthUser, @Body() dto: CreateCorrectionDto) {
    return this.corrections.create(user, dto);
  }

  @Get('corrections')
  @ApiOperation({ summary: 'Correction requests (Admin/HR: all; Employee: own)' })
  listCorrections(@CurrentUser() user: AuthUser, @Query() query: CorrectionQueryDto) {
    return this.corrections.findAll(user, query);
  }

  @Patch('corrections/:id/approve')
  @Roles('HR')
  @ApiOperation({ summary: 'Approve a correction — updates the record and writes an audit log (HR; Admin can view)' })
  approveCorrection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: ReviewCorrectionDto,
  ) {
    return this.corrections.approve(user, id, dto);
  }

  @Patch('corrections/:id/reject')
  @Roles('HR')
  @ApiOperation({ summary: 'Reject a correction with a comment (HR)' })
  rejectCorrection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: RejectCorrectionDto,
  ) {
    return this.corrections.reject(user, id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One attendance record (Employee: own only)' })
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.attendance.findOne(user, id);
  }
}
