import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe.js';
import { CreateHrUserDto, ListUsersQueryDto, ResetPasswordDto, UpdateUserRoleDto } from './dto/users.dto.js';
import { UsersService } from './users.service.js';

/** Login management — Admin only. */
@ApiTags('Auth: Users')
@ApiBearerAuth()
@Roles('Admin')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List logins (Admin)' })
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Post('hr')
  @ApiOperation({ summary: 'Create an HR login (Admin) — returns a one-time temporary password if none given' })
  createHr(@CurrentUser() actor: AuthUser, @Body() dto: CreateHrUserDto) {
    return this.users.createHrUser(actor, dto);
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate an HR/Employee login (Admin) — revokes its tokens' })
  deactivate(@CurrentUser() actor: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.users.setActive(actor, id, false);
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Re-activate an HR/Employee login (Admin)' })
  activate(@CurrentUser() actor: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.users.setActive(actor, id, true);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset an HR/Employee password to a temporary one (Admin)' })
  resetPassword(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.users.resetPassword(actor, id, dto);
  }

  @Patch(':id/role')
  @ApiOperation({ summary: 'Promote an employee login to HR, or demote HR to Employee (Admin)' })
  updateRole(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.users.updateRole(actor, id, dto);
  }
}
