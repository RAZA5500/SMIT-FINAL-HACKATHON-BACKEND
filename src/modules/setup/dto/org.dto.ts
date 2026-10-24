import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ToBoolean, Trim } from '../../../common/utils/transform.util.js';
import { IsIsoDateOnly } from '../../../common/validators/custom.validators.js';

// ── Departments ──────────────────────────────────────────
export class CreateDepartmentDto {
  @ApiProperty({ example: 'Engineering' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'ENG' })
  @IsOptional()
  @Trim()
  @Matches(/^[A-Za-z0-9_-]{1,20}$/, { message: 'code must be 1-20 letters, digits, - or _' })
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {}

// ── Designations ─────────────────────────────────────────
export class CreateDesignationDto {
  @ApiProperty({ example: 'Software Engineer' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDesignationDto extends PartialType(CreateDesignationDto) {}

// ── Leave types ──────────────────────────────────────────
export class CreateLeaveTypeDto {
  @ApiProperty({ example: 'Annual' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({
    example: 14,
    nullable: true,
    description: 'Working days per calendar year; null = unlimited (e.g. Unpaid)',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(366)
  annualQuota?: number | null;

  @ApiPropertyOptional({ default: true, description: 'Unpaid leave days are deducted in payroll' })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateLeaveTypeDto extends PartialType(CreateLeaveTypeDto) {}

// ── Public holidays ──────────────────────────────────────
export class CreateHolidayDto {
  @ApiProperty({ example: 'Independence Day' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '2026-08-14' })
  @IsIsoDateOnly()
  date: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateHolidayDto extends PartialType(CreateHolidayDto) {}

export class HolidayQueryDto {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'year must be a 4-digit year' })
  year?: string;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsIsoDateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsIsoDateOnly()
  to?: string;
}

export class IncludeInactiveQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  includeInactive?: boolean;
}
