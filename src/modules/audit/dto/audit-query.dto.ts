import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional, IsString, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ISO_DATE_REGEX } from '../../../common/utils/date.util.js';
import { AUDIT_ACTIONS, type AuditAction } from '../schemas/audit-log.schema.js';

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'Employee' })
  @IsOptional()
  @IsString()
  entity?: string;

  @ApiPropertyOptional({ enum: AUDIT_ACTIONS })
  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  action?: AuditAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  actorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'From date (YYYY-MM-DD, UTC)' })
  @IsOptional()
  @Matches(ISO_DATE_REGEX, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'To date (YYYY-MM-DD, UTC)' })
  @IsOptional()
  @Matches(ISO_DATE_REGEX, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}
