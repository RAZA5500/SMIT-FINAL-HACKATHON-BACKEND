import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Connection } from 'mongoose';
import { Public } from './common/decorators/public.decorator.js';

@ApiTags('Health')
@SkipThrottle()
@Controller()
export class AppController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Served at the bare root (`GET /`, outside the /api prefix) so a browser shows the API is up. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Root check — returns "API is working"' })
  root() {
    return 'API is working';
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness + database connectivity' })
  health() {
    const database = this.connection.readyState === 1 ? 'up' : 'down';
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    };
  }
}
