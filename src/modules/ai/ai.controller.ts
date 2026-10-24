import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ThrottleScope } from '../../common/decorators/throttle-scope.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { AiLogService } from './ai-log.service.js';
import { AiTimeoutInterceptor } from './ai-timeout.interceptor.js';
import { AI_RATE_LIMIT } from './ai.constants.js';
import { AiService } from './ai.service.js';
import { AiChatDto, AiDashboardSummaryDto, AiLogQueryDto, AiSmartLeaveDto } from './dto/ai.dto.js';

/** AI endpoints — 20 requests per user per hour in total (shared bucket), 15 s timeout. */
@ApiTags('AI')
@ApiBearerAuth()
@ThrottleScope('ai')
@Throttle({ default: AI_RATE_LIMIT })
@UseInterceptors(AiTimeoutInterceptor)
@ApiTooManyRequestsResponse({ description: 'More than 20 AI requests in the last hour' })
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'HR assistant chat (English / Roman Urdu) with tool calling over the same services as the dashboards',
  })
  chat(@CurrentUser() user: AuthUser, @Body() dto: AiChatDto) {
    return this.ai.chat(user, dto);
  }

  @Post('dashboard-summary')
  @HttpCode(HttpStatus.OK)
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Summarize the filtered KPI JSON into 3-5 insight bullets using only those numbers' })
  dashboardSummary(@CurrentUser() user: AuthUser, @Body() dto: AiDashboardSummaryDto) {
    return this.ai.dashboardSummary(user, dto);
  }

  @Post('smart-leave')
  @HttpCode(HttpStatus.OK)
  @Roles('Employee', 'HR')
  @ApiOperation({
    summary: 'Parse a natural-language leave request into { type, startDate, endDate, reason } (never submits it)',
  })
  smartLeave(@CurrentUser() user: AuthUser, @Body() dto: AiSmartLeaveDto) {
    return this.ai.smartLeave(user, dto);
  }
}

/** Read access to `ai_logs` (outside the AI rate-limit bucket). */
@ApiTags('AI')
@ApiBearerAuth()
@Roles('Admin')
@Controller('ai-logs')
export class AiLogsController {
  constructor(private readonly logs: AiLogService) {}

  @Get()
  @ApiOperation({ summary: 'AI call logs (Admin only)' })
  findAll(@Query() query: AiLogQueryDto) {
    return this.logs.findAll(query);
  }
}
