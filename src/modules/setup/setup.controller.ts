import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator.js';
import { InitSetupDto } from './dto/settings.dto.js';
import { SetupService } from './setup.service.js';

@ApiTags('Setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'First-run check: { initialized } (public)' })
  status() {
    return this.setup.status();
  }

  @Public()
  @Post('init')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'First-run setup: create CompanySettings + first Admin (public, works only once)',
  })
  init(@Body() dto: InitSetupDto) {
    return this.setup.initialize(dto, 'api');
  }
}
