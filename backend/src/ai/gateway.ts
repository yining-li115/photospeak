import { ZodError } from 'zod';
import type { AnalyzeRequest, TtsRequest } from './contracts.js';
import { parseAnalysisContent } from './contracts.js';
import { buildAnalyzeMessages } from './prompts.js';
import {
  AiProviderError,
  type AiUsage,
  type AiUsageUnit,
  type ModerationProvider,
  type SpeechAiProvider,
  type TextAiProvider,
} from './types.js';
import { recordUsage, type AiCapability } from './usage.js';

export interface GatewayContext {
  requestId: string;
  operationId: string;
  providerIdempotencyKey: string;
  userId: string;
  plan: string;
}

export interface AiUnitPricing {
  /** Must match the adapter's declared usage unit. */
  unit: AiUsageUnit;
  inputPerMillion?: number;
  outputPerMillion?: number;
}

export interface AiPricing {
  chat?: AiUnitPricing;
  speech?: AiUnitPricing;
  currency?: string;
}

export interface CompatibleChatResponse {
  choices: {
    message: {
      content?: string;
      audio?: { data: string; transcript?: string };
    };
  }[];
  usage?: {
    unit: AiUsageUnit;
    input_units?: number;
    output_units?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  audio_format?: 'wav' | 'mp3' | 'ogg_opus';
  voice?: string;
  photospeak?: {
    provider: string;
    model: string;
    format?: 'wav' | 'mp3' | 'ogg_opus';
    voice?: string;
  };
}

/** An upstream response was syntactically valid but violated our domain DTO. */
export class AiOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiOutputValidationError';
  }
}

export class ContentRejectedError extends Error {
  constructor() {
    super('Content was rejected by the moderation policy');
    this.name = 'ContentRejectedError';
  }
}

function usageShape(usage?: AiUsage) {
  if (!usage) return undefined;
  return {
    unit: usage.unit,
    input_units: usage.inputUnits,
    output_units: usage.outputUnits,
    ...(usage.unit === 'tokens'
      ? {
          prompt_tokens: usage.inputUnits,
          completion_tokens: usage.outputUnits,
        }
      : {}),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof AiProviderError) return `provider_${error.kind}`;
  if (error instanceof AiOutputValidationError) return 'invalid_model_output';
  if (error instanceof ContentRejectedError) return 'content_rejected';
  return 'internal_error';
}

export class AiGateway {
  constructor(
    private readonly textProvider: TextAiProvider,
    private readonly speechProvider: SpeechAiProvider,
    private readonly moderation?: ModerationProvider,
    private readonly pricing: AiPricing = {}
  ) {
    assertPricingUnit('chat', pricing.chat, textProvider.usageUnit);
    assertPricingUnit('speech', pricing.speech, speechProvider.usageUnit);
    if (!moderation) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'ai.moderation.disabled',
          message:
            'No moderation provider is configured; input validation is active but content is not safety-classified',
        })
      );
    }
  }

  get readiness() {
    return {
      textProvider: this.textProvider.name,
      speechProvider: this.speechProvider.name,
      chatModel: this.textProvider.chatModel,
      ttsModel: this.speechProvider.ttsModel,
      moderation: this.moderation?.name ?? 'not_configured',
      textIdempotency: this.textProvider.idempotencyCapability,
      speechIdempotency: this.speechProvider.idempotencyCapability,
      costAccounting:
        hasPrice(this.pricing.chat) || hasPrice(this.pricing.speech)
          ? 'configured'
          : 'usage_units_only',
    };
  }

  operationPolicy(capability: AiCapability) {
    const speech = capability === 'speech_synthesis';
    const provider = speech ? this.speechProvider : this.textProvider;
    const model = speech
      ? this.speechProvider.ttsModel
      : this.textProvider.chatModel;
    const voice = speech
      ? `${this.speechProvider.ttsVoice}:${this.speechProvider.ttsFormat}`
      : '';
    return {
      provider: provider.name,
      model,
      idempotencyCapability: provider.idempotencyCapability,
      executionFingerprint: [
        'v1',
        capability,
        provider.name,
        model,
        provider.idempotencyCapability,
        voice,
      ].join(':'),
    };
  }

  async analyze(
    request: AnalyzeRequest,
    context: GatewayContext
  ): Promise<CompatibleChatResponse> {
    const startedAt = Date.now();
    const capability: AiCapability = request.operation;
    try {
      if (this.moderation) {
        const moderation = await this.moderation.moderate({
          text:
            request.operation === 'session_analysis'
              ? request.transcript
              : `${request.transcript}\n${request.question}`,
          imageDataUrl: request.photo_data_url,
        });
        if (!moderation.allowed) throw new ContentRejectedError();
      }
      const result = await this.textProvider.completeText({
        messages: buildAnalyzeMessages(request),
        maxOutputTokens:
          request.operation === 'session_analysis' ? 12_288 : 4_096,
        temperature: request.operation === 'session_analysis' ? 0.4 : 0.5,
        providerIdempotencyKey: context.providerIdempotencyKey,
      });

      let content = result.content.trim();
      if (request.operation === 'session_analysis') {
        try {
          content = JSON.stringify(parseAnalysisContent(content));
        } catch (error) {
          const reason =
            error instanceof ZodError
              ? error.issues.map((issue) => issue.path.join('.')).join(', ')
              : 'invalid JSON';
          throw new AiOutputValidationError(
            `AI analysis did not match the required schema: ${reason}`
          );
        }
      } else if (content.length === 0 || content.length > 8_000) {
        throw new AiOutputValidationError(
          'AI follow-up response was empty or exceeded the response limit'
        );
      }

      await recordUsage({
        requestId: context.requestId,
        operationId: context.operationId,
        userId: context.userId,
        capability,
        provider: this.textProvider.name,
        model: this.textProvider.chatModel,
        status: 'succeeded',
        plan: context.plan,
        inputUnits: result.usage?.inputUnits,
        outputUnits: result.usage?.outputUnits,
        ...this.estimatedCost(result.usage, this.pricing.chat),
        latencyMs: Date.now() - startedAt,
      });

      return {
        choices: [{ message: { content } }],
        usage: usageShape(result.usage),
        photospeak: {
          provider: this.textProvider.name,
          model: this.textProvider.chatModel,
        },
      };
    } catch (error) {
      await recordUsage({
        requestId: context.requestId,
        operationId: context.operationId,
        userId: context.userId,
        capability,
        provider: this.textProvider.name,
        model: this.textProvider.chatModel,
        status: 'failed',
        plan: context.plan,
        latencyMs: Date.now() - startedAt,
        errorCode: errorCode(error),
      });
      throw error;
    }
  }

  async synthesize(
    request: TtsRequest,
    context: GatewayContext
  ): Promise<CompatibleChatResponse> {
    const startedAt = Date.now();
    try {
      if (this.moderation) {
        const moderation = await this.moderation.moderate({
          text: request.text,
        });
        if (!moderation.allowed) throw new ContentRejectedError();
      }
      const result = await this.speechProvider.synthesizeSpeech({
        text: request.text,
        style: request.style,
        providerIdempotencyKey: context.providerIdempotencyKey,
      });
      await recordUsage({
        requestId: context.requestId,
        operationId: context.operationId,
        userId: context.userId,
        capability: 'speech_synthesis',
        provider: this.speechProvider.name,
        model: this.speechProvider.ttsModel,
        status: 'succeeded',
        plan: context.plan,
        inputUnits: result.usage?.inputUnits,
        outputUnits: result.usage?.outputUnits,
        ...this.estimatedCost(result.usage, this.pricing.speech),
        latencyMs: Date.now() - startedAt,
      });
      return {
        choices: [
          {
            message: {
              audio: {
                data: result.base64,
                transcript: result.transcript,
              },
            },
          },
        ],
        usage: usageShape(result.usage),
        audio_format: this.speechProvider.ttsFormat,
        voice: this.speechProvider.ttsVoice,
        photospeak: {
          provider: this.speechProvider.name,
          model: this.speechProvider.ttsModel,
          format: this.speechProvider.ttsFormat,
          voice: this.speechProvider.ttsVoice,
        },
      };
    } catch (error) {
      await recordUsage({
        requestId: context.requestId,
        operationId: context.operationId,
        userId: context.userId,
        capability: 'speech_synthesis',
        provider: this.speechProvider.name,
        model: this.speechProvider.ttsModel,
        status: 'failed',
        plan: context.plan,
        latencyMs: Date.now() - startedAt,
        errorCode: errorCode(error),
      });
      throw error;
    }
  }

  private estimatedCost(
    usage: AiUsage | undefined,
    pricing: AiUnitPricing | undefined
  ): { estimatedCostMicros?: number; billingCurrency?: string } {
    if (!usage || !pricing) {
      return {};
    }
    // A price of one currency unit per million reported units equals one
    // micro-unit per unit, whether this adapter reports tokens or characters.
    const micros = Math.ceil(
      (usage.inputUnits ?? 0) * (pricing.inputPerMillion ?? 0) +
        (usage.outputUnits ?? 0) * (pricing.outputPerMillion ?? 0)
    );
    return {
      estimatedCostMicros: Math.max(0, micros),
      billingCurrency: this.pricing.currency ?? 'CNY',
    };
  }
}

function hasPrice(pricing: AiUnitPricing | undefined): boolean {
  return Boolean(
    pricing &&
      (pricing.inputPerMillion !== undefined ||
        pricing.outputPerMillion !== undefined)
  );
}

function assertPricingUnit(
  label: string,
  pricing: AiUnitPricing | undefined,
  providerUnit: AiUsageUnit
): void {
  if (pricing && pricing.unit !== providerUnit) {
    throw new Error(
      `${label} AI price unit ${pricing.unit} does not match provider unit ${providerUnit}`
    );
  }
}
