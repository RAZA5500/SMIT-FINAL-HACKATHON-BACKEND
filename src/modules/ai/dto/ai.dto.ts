import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Trim } from '../../../common/utils/transform.util.js';
import { IsIsoDateOnly } from '../../../common/validators/custom.validators.js';
import { AI_CALL_STATUSES, AI_FEATURES, type AiCallStatus, type AiFeature } from '../schemas/ai-log.schema.js';

export class ChatHistoryMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content: string;
}

export class AiChatDto {
  @ApiProperty({ example: 'Is mahine kitne log late aaye?' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;

  @ApiPropertyOptional({ type: [ChatHistoryMessageDto], description: 'Previous turns (max 10) for follow-up questions' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryMessageDto)
  history?: ChatHistoryMessageDto[];
}

export class AiDashboardSummaryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsIsoDateOnly()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsIsoDateOnly()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  departmentId?: string;
}

export class AiSmartLeaveDto {
  @ApiProperty({ example: 'Mujhe kal se 3 din ki sick leave chahiye, bukhar hai' })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  text: string;
}

export class AiLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AI_FEATURES })
  @IsOptional()
  @IsIn(AI_FEATURES)
  feature?: AiFeature;

  @ApiPropertyOptional({ enum: AI_CALL_STATUSES })
  @IsOptional()
  @IsIn(AI_CALL_STATUSES)
  status?: AiCallStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  userId?: string;
}

/** Schema the smart-leave parse must satisfy before it is offered to the user. */
export class SmartLeaveDraftDto {
  @IsString()
  @IsNotEmpty()
  type: string;

  @IsIsoDateOnly()
  startDate: string;

  @IsIsoDateOnly()
  endDate: string;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason: string;
}
