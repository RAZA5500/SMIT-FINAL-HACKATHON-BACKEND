import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardListQueryDto, DashboardQueryDto, DepartmentFilterQueryDto } from './dto/dashboard-query.dto.js';
import { PersonalDashboardService } from './personal-dashboard.service.js';

/**
 * Company (Admin) and HR dashboards plus the personal Employee dashboard. Every KPI is
 * computed server-side with DB aggregations, filtered by startDate/endDate/departmentId.
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly personal: PersonalDashboardService,
  ) {}

  @Get('me')
  @ApiOperation({
    summary: 'Personal dashboard: today, hours this week vs 40 h, late count, leave balance, last payslip, announcements',
  })
  me(@CurrentUser() user: AuthUser) {
    return this.personal.getMine(user);
  }

  @Get('summary')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Every KPI in one response (today, trend, attrition YTD, demographics, …)' })
  summary(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getSummary(user, query);
  }

  @Get('today')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Today: headcount, present, late, on leave, not checked in, pending approvals' })
  today(@CurrentUser() user: AuthUser, @Query() query: DepartmentFilterQueryDto) {
    return this.dashboard.getToday(user, query);
  }

  @Get('headcount')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Headcount = active + probation on the end date' })
  headcount(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getHeadcount(user, query);
  }

  @Get('attrition')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Attrition % = exits in period / average headcount × 100' })
  attrition(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getAttrition(user, query);
  }

  @Get('attendance')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Attendance rate & late % (overall and per department)' })
  attendance(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getAttendanceSummary(user, query);
  }

  @Get('attendance-trend')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Daily attendance counts and rate for trend charts' })
  attendanceTrend(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getAttendanceTrend(user, query);
  }

  @Get('late-comers')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Employees with the most late arrivals' })
  lateComers(@CurrentUser() user: AuthUser, @Query() query: DashboardListQueryDto) {
    return this.dashboard.getLateComers(user, query);
  }

  @Get('absenteeism')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Absenteeism = absent days / expected working days, per department' })
  absenteeism(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getAbsenteeism(user, query);
  }

  @Get('leave-utilization')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Approved leave days / quota, per leave type and department' })
  leaveUtilization(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getLeaveUtilization(user, query);
  }

  @Get('leave-summary')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Leave requests by status, who is on leave in the period, utilization' })
  leaveSummary(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getLeaveSummary(user, query);
  }

  @Get('payroll-cost')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Sum of gross and net by month and department' })
  payrollCost(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getPayrollCost(user, query);
  }

  @Get('average-salary')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Mean gross by department and designation' })
  averageSalary(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getAverageSalary(user, query);
  }

  @Get('demographics')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Gender mix and tenure bands of the headcount' })
  demographics(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getDemographics(user, query);
  }

  @Get('attrition-risk')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Bonus: per-employee attrition risk score (explainable factors)' })
  attritionRisk(@CurrentUser() user: AuthUser, @Query() query: DashboardListQueryDto) {
    return this.dashboard.getAttritionRisk(user, query);
  }

  @Get('absence-anomalies')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Bonus: absence anomaly flags per employee' })
  absenceAnomalies(@CurrentUser() user: AuthUser, @Query() query: DashboardListQueryDto) {
    return this.dashboard.getAbsenceAnomalies(user, query);
  }
}
