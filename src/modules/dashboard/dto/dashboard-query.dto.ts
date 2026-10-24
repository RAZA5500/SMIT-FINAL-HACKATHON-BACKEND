import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { IsIsoDateOnly } from '../../../common/validators/custom.validators.js';

export class DashboardQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Defaults to the first day of the end month' })
  @IsOptional()
  @IsIsoDateOnly()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Defaults to today (company timezone)' })
  @IsOptional()
  @IsIsoDateOnly()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  departmentId?: string;
}

export class DepartmentFilterQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  departmentId?: string;
}

export class DashboardListQueryDto extends DashboardQueryDto {
  @ApiPropertyOptional({ default: 10, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
