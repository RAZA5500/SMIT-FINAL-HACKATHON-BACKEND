import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { TIME_HHMM_REGEX } from '../../../common/utils/date.util.js';
import { Trim } from '../../../common/utils/transform.util.js';
import { IsIsoDateOnly } from '../../../common/validators/custom.validators.js';
import { REQUEST_STATUSES, type CorrectionStatus } from '../schemas/attendance-correction.schema.js';
import { ATTENDANCE_STATUSES, type AttendanceStatus } from '../schemas/attendance.schema.js';

/**
 * Check-in / check-out payload. The server stamps the time — the client never sends it.
 * For `source: 'camera'` the client sends its face-detection result and GPS fix
 * (`latitude`/`longitude`/`accuracy`, or the short aliases `lat`/`lng`/`gpsAccuracy`).
 */
export class AttendancePunchDto {
  @ApiPropertyOptional({ enum: ['manual', 'camera'], default: 'manual' })
  @IsOptional()
  @IsIn(['manual', 'camera'])
  source?: 'manual' | 'camera';

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  faceDetected?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  faceCount?: number;

  @ApiPropertyOptional({ example: 24.8607 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ example: 67.0011 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ example: 25, description: 'GPS accuracy in meters (must be ≤ 100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;

  @ApiPropertyOptional({ description: 'Alias of latitude' })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({ description: 'Alias of longitude' })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @ApiPropertyOptional({ description: 'Alias of accuracy' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  gpsAccuracy?: number;
}

export class AttendanceQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsIsoDateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsIsoDateOnly()
  to?: string;

  @ApiPropertyOptional({ description: 'Admin/HR only — Employees are always scoped to themselves' })
  @IsOptional()
  @IsMongoId()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  departmentId?: string;

  @ApiPropertyOptional({ enum: ATTENDANCE_STATUSES })
  @IsOptional()
  @IsIn(ATTENDANCE_STATUSES)
  status?: AttendanceStatus;
}

export class CreateCorrectionDto {
  @ApiProperty({ example: '2026-10-20' })
  @IsIsoDateOnly()
  date: string;

  @ApiPropertyOptional({ example: '09:05', description: 'Requested local check-in time (HH:mm)' })
  @IsOptional()
  @Matches(TIME_HHMM_REGEX, { message: 'requestedCheckIn must be HH:mm' })
  requestedCheckIn?: string;

  @ApiPropertyOptional({ example: '18:00', description: 'Requested local check-out time (HH:mm)' })
  @IsOptional()
  @Matches(TIME_HHMM_REGEX, { message: 'requestedCheckOut must be HH:mm' })
  requestedCheckOut?: string;

  @ApiProperty({ example: 'Forgot to check out — was in a client meeting until 6 PM' })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

export class ReviewCorrectionDto {
  @ApiPropertyOptional({ example: 'Verified with team lead' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class RejectCorrectionDto {
  @ApiProperty({ example: 'No evidence of presence' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  comment: string;
}

export class CorrectionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: REQUEST_STATUSES })
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  status?: CorrectionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  employeeId?: string;
}

export class AttendanceBoardQueryDto {
  @ApiPropertyOptional({ example: '2026-10-26', description: 'Day to show (default: today)' })
  @IsOptional()
  @IsIsoDateOnly()
  date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  departmentId?: string;
}

export class CloseDaysDto {
  @ApiPropertyOptional({ example: '2026-10-23', description: 'Close every pending day up to this date (max: yesterday)' })
  @IsOptional()
  @IsIsoDateOnly()
  upTo?: string;
}

export class AttendanceRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsIsoDateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsIsoDateOnly()
  to?: string;

  @ApiPropertyOptional({ default: 31 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  limit?: number;
}
