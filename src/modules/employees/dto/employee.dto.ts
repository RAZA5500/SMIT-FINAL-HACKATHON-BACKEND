import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { EmptyToUndefined, ToBoolean, ToLowerTrim, Trim } from '../../../common/utils/transform.util.js';
import { IsIsoDateOnly } from '../../../common/validators/custom.validators.js';
import { EMPLOYEE_STATUSES, GENDERS, type EmployeeStatus, type Gender } from '../schemas/employee.schema.js';

export const EMPLOYEE_CODE_REGEX = /^[A-Za-z0-9_-]{1,20}$/;
export const PHONE_REGEX = /^[+\d][\d\s()-]{5,19}$/;

const ToLower = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));

export class CreateEmployeeDto {
  @ApiProperty({ example: 'EMP-001', description: 'Unique code (letters, digits, - or _; stored upper-case)' })
  @Trim()
  @Matches(EMPLOYEE_CODE_REGEX, { message: 'code may only contain letters, digits, - or _ (max 20)' })
  code: string;

  @ApiProperty({ example: 'Ali Raza' })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ example: 'ali.raza@company.com' })
  @ToLowerTrim()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: '+92 300 1234567' })
  @IsOptional()
  @Trim()
  @Matches(PHONE_REGEX, { message: 'phone must be a valid phone number' })
  phone?: string;

  @ApiPropertyOptional({ example: 'House 1, Street 2, Karachi' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @ToLower()
  @IsIn(GENDERS)
  gender?: Gender;

  @ApiProperty()
  @IsMongoId()
  departmentId: string;

  @ApiProperty()
  @IsMongoId()
  designationId: string;

  @ApiProperty({ example: '2026-10-01' })
  @IsIsoDateOnly()
  joinDate: string;

  @ApiPropertyOptional({ enum: EMPLOYEE_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(EMPLOYEE_STATUSES)
  status?: EmployeeStatus;

  @ApiPropertyOptional({ example: null, nullable: true, description: 'Last working day (required when exited)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIsoDateOnly()
  exitDate?: string | null;

  @ApiProperty({ example: 100000, description: 'Monthly basic salary (> 0)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'basicSalary must be greater than 0' })
  basicSalary: number;
}

export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}

/** Employees may edit ONLY their own phone and address — any other field is rejected (400). */
export class UpdateMyProfileDto {
  @ApiPropertyOptional({ example: '+92 300 1234567' })
  @IsOptional()
  @Trim()
  @Matches(PHONE_REGEX, { message: 'phone must be a valid phone number' })
  phone?: string;

  @ApiPropertyOptional({ example: 'House 1, Street 2, Karachi' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  address?: string;
}

export const EMPLOYEE_SORT_FIELDS = ['fullName', 'code', 'joinDate', 'createdAt', 'basicSalary'] as const;

export class ListEmployeesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search by name, code, email or phone' })
  @IsOptional()
  @EmptyToUndefined()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @EmptyToUndefined()
  @IsMongoId()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @EmptyToUndefined()
  @IsMongoId()
  designationId?: string;

  @ApiPropertyOptional({ enum: EMPLOYEE_STATUSES })
  @IsOptional()
  @EmptyToUndefined()
  @IsIn(EMPLOYEE_STATUSES)
  status?: EmployeeStatus;

  @ApiPropertyOptional({ enum: EMPLOYEE_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(EMPLOYEE_SORT_FIELDS)
  sortBy?: (typeof EMPLOYEE_SORT_FIELDS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

export class ExportEmployeesQueryDto extends OmitType(ListEmployeesQueryDto, ['page', 'limit'] as const) {}

export class ImportEmployeesQueryDto {
  @ApiPropertyOptional({ default: true, description: 'true = validate only; false = insert if every row is valid' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  dryRun?: boolean;
}

export class ImportEmployeesBodyDto {
  @ApiPropertyOptional({ description: 'Raw CSV text (alternative to uploading a file)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000_000)
  csv?: string;
}
