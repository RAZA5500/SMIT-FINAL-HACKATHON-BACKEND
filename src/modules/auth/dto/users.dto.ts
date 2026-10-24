import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ROLES, type Role } from '../../../common/constants/roles.js';
import { PASSWORD_REGEX, PASSWORD_RULE_MESSAGE } from '../../../common/utils/password.util.js';
import { EmptyToUndefined, ToBoolean, ToLowerTrim, Trim } from '../../../common/utils/transform.util.js';

export class CreateHrUserDto {
  @ApiProperty({ example: 'Sara Khan' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ example: 'hr@company.com' })
  @ToLowerTrim()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    description: `Initial password. Omit to auto-generate a temporary one. ${PASSWORD_RULE_MESSAGE}`,
  })
  @IsOptional()
  @IsString()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_RULE_MESSAGE })
  password?: string;

  @ApiPropertyOptional({ description: 'Link this HR login to an existing employee profile (for own leave/attendance)' })
  @IsOptional()
  @IsMongoId()
  employeeId?: string;
}

export class ResetPasswordDto {
  @ApiPropertyOptional({ description: `New temporary password. Omit to auto-generate. ${PASSWORD_RULE_MESSAGE}` })
  @IsOptional()
  @IsString()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_RULE_MESSAGE })
  newPassword?: string;
}

export class UpdateUserRoleDto {
  @ApiProperty({ enum: ['HR', 'Employee'] })
  @IsIn(['HR', 'Employee'])
  role: 'HR' | 'Employee';
}

export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;

  @ApiPropertyOptional()
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Search by name or email' })
  @IsOptional()
  @EmptyToUndefined()
  @IsString()
  @MaxLength(100)
  q?: string;
}
