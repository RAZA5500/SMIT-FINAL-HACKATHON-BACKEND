import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TIME_HHMM_REGEX, WEEK_DAYS } from '../../../common/utils/date.util.js';
import { PASSWORD_REGEX, PASSWORD_RULE_MESSAGE } from '../../../common/utils/password.util.js';
import { ToLowerTrim, Trim } from '../../../common/utils/transform.util.js';
import { IsTimeZone } from '../../../common/validators/custom.validators.js';

export class OfficeLocationDto {
  @ApiProperty({ example: 24.8607, description: 'Office latitude' })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({ example: 67.0011, description: 'Office longitude' })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @ApiPropertyOptional({ example: 150, default: 150, description: 'Geofence radius in meters' })
  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(10_000)
  radiusMeters?: number;
}

export class UpdateOfficeLocationDto extends PartialType(OfficeLocationDto) {}

/** Policy fields shared by first-run init and later settings updates. */
export class CompanyPolicyFieldsDto {
  @ApiPropertyOptional({ example: 'Asia/Karachi', default: 'Asia/Karachi' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ example: 'PKR', default: 'PKR' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code such as PKR' })
  currency?: string;

  @ApiPropertyOptional({ example: '09:00', default: '09:00' })
  @IsOptional()
  @Matches(TIME_HHMM_REGEX, { message: 'officeStartTime must be HH:mm (24-hour)' })
  officeStartTime?: string;

  @ApiPropertyOptional({ example: 15, default: 15 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  graceMinutes?: number;

  @ApiPropertyOptional({ example: 5, default: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(24)
  halfDayThresholdHours?: number;

  @ApiPropertyOptional({ example: ['Saturday', 'Sunday'], enum: WEEK_DAYS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(6)
  @IsIn(WEEK_DAYS, { each: true })
  weekendDays?: string[];

  @ApiPropertyOptional({ default: false, description: 'Bonus rule: every 3 lates = 0.5 day deduction' })
  @IsOptional()
  @IsBoolean()
  latePenaltyRuleEnabled?: boolean;
}

export class InitAdminDto {
  @ApiProperty({ example: 'System Admin' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ example: 'admin@company.com' })
  @ToLowerTrim()
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'StrongPass123', description: PASSWORD_RULE_MESSAGE })
  @IsString()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_RULE_MESSAGE })
  password: string;
}

export class InitSetupDto extends CompanyPolicyFieldsDto {
  @ApiProperty({ example: 'Acme Pvt Ltd' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  companyName: string;

  @ApiPropertyOptional({ type: OfficeLocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OfficeLocationDto)
  officeLocation?: OfficeLocationDto;

  @ApiProperty({ type: InitAdminDto })
  @ValidateNested()
  @Type(() => InitAdminDto)
  admin: InitAdminDto;
}

export class UpdateSettingsDto extends CompanyPolicyFieldsDto {
  @ApiPropertyOptional({ example: 'Acme Pvt Ltd' })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  companyName?: string;

  @ApiPropertyOptional({ type: UpdateOfficeLocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateOfficeLocationDto)
  officeLocation?: UpdateOfficeLocationDto;
}
