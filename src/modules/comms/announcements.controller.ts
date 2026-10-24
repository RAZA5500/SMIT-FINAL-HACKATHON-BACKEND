import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe.js';
import { AnnouncementsService } from './announcements.service.js';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto/announcement.dto.js';

@ApiTags('Comms: Announcements')
@ApiBearerAuth()
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post()
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Post an announcement (Admin/HR) — notifies every active user' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAnnouncementDto) {
    return this.announcements.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List announcements (all roles)' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.announcements.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an announcement (all roles)' })
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.announcements.findOne(id);
  }

  @Patch(':id')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Edit an announcement (Admin: any, HR: own)' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    return this.announcements.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Delete an announcement (Admin: any, HR: own)' })
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.announcements.remove(user, id);
  }
}
