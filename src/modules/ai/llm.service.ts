import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type * as z from 'zod/v4';
import {
  AI_MAX_TOOL_ITERATIONS,
  AI_TIMEOUT_MS,
  DEFAULT_AI_MODEL,
  SERVER_FALLBACK_BETA,
  SERVER_FALLBACK_MODELS,
} from './ai.constants.js';

type RunnableTool = Parameters<Anthropic['beta']['messages']['toolRunner']>[0]['tools'][number];

/** Models that accept `output_config.effort` (older models reject it). */
const EFFORT_MODEL_PATTERN = /^claude-(opus-4-[5-9]|opus-5|sonnet-4-6|sonnet-5|haiku-5|fable|mythos)/;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Thin server-side wrapper around the Anthropic SDK. The API key is read from
 * AI_API_KEY on the server only. Every call carries an AbortSignal so the caller's
 * 15-second budget is enforced, and never mutates application data.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: Anthropic | null;
  readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('AI_API_KEY')?.trim();
    this.model = config.get<string>('AI_MODEL')?.trim() || DEFAULT_AI_MODEL;
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 1, timeout: AI_TIMEOUT_MS }) : null;
    if (!this.client) this.logger.warn('AI_API_KEY is not set — AI endpoints will return friendly fallbacks.');
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Agentic tool loop (SDK tool runner): the model calls our read-only tools until it can answer. */
  async runTools(params: {
    system: BetaTextBlockParam[];
    messages: BetaMessageParam[];
    tools: RunnableTool[];
    signal: AbortSignal;
  }): Promise<BetaMessage> {
    const runner = this.requireClient().beta.messages.toolRunner(
      {
        ...this.baseParams(),
        max_tokens: 4096,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        max_iterations: AI_MAX_TOOL_ITERATIONS,
        thread: false,
      },
      { signal: params.signal },
    );
    return runner.runUntilDone();
  }

  /** Single call with a structured (JSON-schema) output, parsed and validated with Zod. */
  async parse<Schema extends z.ZodType>(params: {
    system: string;
    messages: BetaMessageParam[];
    schema: Schema;
    signal: AbortSignal;
    maxTokens?: number;
  }): Promise<{ parsed: z.infer<Schema> | null; message: BetaMessage }> {
    const message = await this.requireClient().beta.messages.parse(
      {
        ...this.baseParams(),
        max_tokens: params.maxTokens ?? 2048,
        system: params.system,
        messages: params.messages,
        output_config: { ...this.effortConfig(), format: betaZodOutputFormat(params.schema) },
      },
      { signal: params.signal },
    );
    return { parsed: (message.parsed_output ?? null) as z.infer<Schema> | null, message };
  }

  static textOf(message: BetaMessage): string {
    return message.content
      .filter((block): block is Extract<BetaMessage['content'][number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  static usageOf(message: BetaMessage | null | undefined): LlmUsage | null {
    if (!message?.usage) return null;
    return { inputTokens: message.usage.input_tokens ?? 0, outputTokens: message.usage.output_tokens ?? 0 };
  }

  static isAbort(error: unknown, signal?: AbortSignal): boolean {
    return (
      signal?.aborted === true ||
      error instanceof Anthropic.APIUserAbortError ||
      error instanceof Anthropic.APIConnectionTimeoutError ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    );
  }

  static describeError(error: unknown): string {
    if (error instanceof Anthropic.AuthenticationError) return 'Invalid AI_API_KEY (authentication failed)';
    if (error instanceof Anthropic.PermissionDeniedError) return 'AI_API_KEY lacks permission for this model';
    if (error instanceof Anthropic.NotFoundError) return 'AI model not found — check AI_MODEL';
    if (error instanceof Anthropic.RateLimitError) return 'AI provider rate limit reached';
    if (error instanceof Anthropic.BadRequestError) return `AI request rejected: ${error.message}`;
    if (error instanceof Anthropic.APIError) return `AI provider error ${error.status ?? ''}: ${error.message}`;
    return (error as Error)?.message ?? 'Unknown AI error';
  }

  /** Model + effort + server-side refusal fallback (`fallbacks: "default"`) where supported. */
  private baseParams() {
    return {
      model: this.model,
      ...(Object.keys(this.effortConfig()).length ? { output_config: this.effortConfig() } : {}),
      ...(SERVER_FALLBACK_MODELS.has(this.model)
        ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const }
        : {}),
    };
  }

  /** Low effort keeps HR Q&A fast enough for the 15-second budget. */
  private effortConfig(): { effort?: 'low' } {
    return EFFORT_MODEL_PATTERN.test(this.model) ? { effort: 'low' } : {};
  }

  private requireClient(): Anthropic {
    if (!this.client) throw new Error('AI is not configured (AI_API_KEY missing)');
    return this.client;
  }
}
