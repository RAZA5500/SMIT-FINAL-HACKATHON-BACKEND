import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsMongoId, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Trim } from '../../../common/utils/transform.util.js';
import { IsMonthString } from '../../../common/validators/custom.validators.js';
import { PAYROLL_STATUSES, type PayrollStatus } from '../schemas/payroll-run.schema.js';

export class CreatePayrollRunDto {
  @ApiProperty({ example: '2026-10', description: 'Payroll month (YYYY-MM)' })
  @IsMonthString()
  month: string;

  @ApiPropertyOptional({ example: 'October payroll' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdatePayrollRunDto {
  @ApiProperty({ example: 'Includes new joiners' })
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes: string;
}

export class PayrollRunQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026' })
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'year must be YYYY' })
  year?: string;

  @ApiPropertyOptional({ enum: PAYROLL_STATUSES })
  @IsOptional()
  @IsIn(PAYROLL_STATUSES)
  status?: PayrollStatus;
}

export class PayslipQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-10' })
  @IsOptional()
  @IsMonthString()
  month?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  payrollRunId?: string;

  @ApiPropertyOptional({ description: 'Admin/HR only — Employees are always scoped to themselves' })
  @IsOptional()
  @IsMongoId()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  departmentId?: string;
}

export class SalaryCalculatorQueryDto {
  @ApiProperty({ example: 100000, description: 'Monthly basic salary' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  basic: number;
}
