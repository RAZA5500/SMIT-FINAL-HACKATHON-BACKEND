import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { paginate } from '../../common/utils/query.util.js';
import { AiLogQueryDto } from './dto/ai.dto.js';
import {
  AiLog,
  type AiCallStatus,
  type AiFeature,
  type AiLogDocument,
  type AiToolCall,
} from './schemas/ai-log.schema.js';

export interface AiLogEntry {
  user: AuthUser;
  feature: AiFeature;
  prompt: string;
  toolsCalled: AiToolCall[];
  response: unknown;
  status: AiCallStatus;
  latencyMs: number;
  model: string | null;
  errorMessage?: string | null;
  usage?: { inputTokens: number; outputTokens: number } | null;
}

/** Every AI call is logged in `ai_logs` (userId, role, feature, prompt, toolsCalled, response, status, latencyMs). */
@Injectable()
export class AiLogService {
  private readonly logger = new Logger(AiLogService.name);

  constructor(@InjectModel(AiLog.name) private readonly aiLogModel: Model<AiLogDocument>) {}

  async log(entry: AiLogEntry): Promise<string | null> {
    try {
      const doc = await this.aiLogModel.create({
        userId: new Types.ObjectId(entry.user.userId),
        role: entry.user.role,
        feature: entry.feature,
        prompt: entry.prompt.slice(0, 20_000),
        toolsCalled: entry.toolsCalled,
        response: entry.response,
        status: entry.status,
        latencyMs: entry.latencyMs,
        llmModel: entry.model,
        errorMessage: entry.errorMessage ?? null,
        usage: entry.usage ?? null,
      });
      return String(doc._id);
    } catch (error) {
      this.logger.error(`Failed to write ai_logs entry: ${(error as Error).message}`);
      return null;
    }
  }

  findAll(query: AiLogQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.feature) filter.feature = query.feature;
    if (query.status) filter.status = query.status;
    if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    return paginate(this.aiLogModel, filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
  }
}
