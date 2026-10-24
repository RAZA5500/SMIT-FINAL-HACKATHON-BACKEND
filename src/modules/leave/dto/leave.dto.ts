import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Trim } from '../../../common/utils/transform.util.js';
import { IsIsoDateOnly } from '../../../common/validators/custom.validators.js';
import { LEAVE_STATUSES, type LeaveStatus } from '../schemas/leave-request.schema.js';

export class CreateLeaveDto {
  @ApiPropertyOptional({ description: 'Leave type id (or send `leaveType` by name instead)' })
  @ValidateIf((o: CreateLeaveDto) => !o.leaveType)
  @IsMongoId()
  leaveTypeId?: string;

  @ApiPropertyOptional({ example: 'Sick', description: 'Leave type name (alternative to leaveTypeId)' })
  @ValidateIf((o: CreateLeaveDto) => !o.leaveTypeId)
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  leaveType?: string;

  @ApiProperty({ example: '2026-11-02' })
  @IsIsoDateOnly()
  startDate: string;

  @ApiProperty({ example: '2026-11-04' })
  @IsIsoDateOnly()
  endDate: string;

  @ApiPropertyOptional({ example: 'Fever — doctor advised rest' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReviewLeaveDto {
  @ApiPropertyOptional({ example: 'Approved. Get well soon!' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class RejectLeaveDto {
  @ApiProperty({ example: 'Project deadline that week — please reschedule' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  comment: string;
}

export class LeaveQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LEAVE_STATUSES })
  @IsOptional()
  @IsIn(LEAVE_STATUSES)
  status?: LeaveStatus;

  @ApiPropertyOptional({ description: 'Admin/HR only — Employees are always scoped to themselves' })
  @IsOptional()
  @IsMongoId()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  leaveTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  departmentId?: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Requests overlapping this range' })
  @IsOptional()
  @IsIsoDateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsIsoDateOnly()
  to?: string;
}

export class LeaveBalanceQueryDto {
  @ApiPropertyOptional({ description: 'Admin/HR only — defaults to the caller' })
  @IsOptional()
  @IsMongoId()
  employeeId?: string;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

export class WorkingDaysQueryDto {
  @ApiProperty({ example: '2026-11-02' })
  @IsIsoDateOnly()
  startDate: string;

  @ApiProperty({ example: '2026-11-06' })
  @IsIsoDateOnly()
  endDate: string;
}
