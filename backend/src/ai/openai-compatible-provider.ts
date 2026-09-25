import { z } from 'zod';
import { fetchWithTimeout, readTextBounded } from './http.js';
import { buildTtsMessages } from './prompts.js';
import {
  MAX_TTS_BASE64_CHARACTERS,
  validateEncodedAudio,
} from './speech-audio.js';
import {
  AiProviderError,
  type SpeechAiProvider,
  type TextAiProvider,
  type AiSpeechResult,
  type AiTextResult,
  type SpeechSynthesisInput,
  type TextCompletionInput,
} from './types.js';

/**
 * A single generated clip must stay small enough for a mobile client to hold
 * the JSON/base64 response briefly and persist a multi-sentence session without
 * one anomalous provider response consuming the device. Compressed formats can
 * hold several minutes of speech in this budget; WAV remains supported for
 * short clips, but production should prefer MP3 or Ogg Opus.
 */
const MAX_TTS_RESPONSE_BYTES = MAX_TTS_BASE64_CHARACTERS + 128 * 1024;

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const textResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).passthrough(),
          })
          .passthrough()
      )
      .min(1),
    usage: usageSchema.optional(),
  })
  .passthrough();

const speechResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                audio: z.object({
                  // 1,500 characters cannot legitimately require tens of MB
                  // in our supported mono speech formats. Keep the JSON/base64
                  // response bounded so one upstream anomaly cannot exhaust a
                  // phone or API process heap.
                  data: z.string().min(1).max(MAX_TTS_BASE64_CHARACTERS),
                  transcript: z.string().max(2_000).optional(),
                }),
              })
              .passthrough(),
          })
          .passthrough()
      )
      .min(1),
    usage: usageSchema.optional(),
  })
  .passthrough();

export interface OpenAiCompatibleTextProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  authStyle: 'bearer' | 'api-key';
  model: string;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  thinking?: 'enabled' | 'disabled' | 'auto';
  timeoutMs?: number;
}

export interface ChatCompletionsSpeechProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  authStyle: 'bearer' | 'api-key';
  model: string;
  voice: string;
  format: 'wav' | 'mp3' | 'ogg_opus';
  timeoutMs?: number;
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

function authHeader(
  style: 'bearer' | 'api-key',
  apiKey: string
): Record<string, string> {
  return style === 'bearer'
    ? { Authorization: `Bearer ${apiKey}` }
    : { 'api-key': apiKey };
}

const upstreamErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(160).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function upstreamErrorCode(text: string): string | undefined {
  try {
    const code = upstreamErrorSchema.parse(JSON.parse(text)).error?.code;
    return code && /^[A-Za-z0-9_.-]+$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function providerErrorForResponse(status: number, text: string): AiProviderError {
  const code = upstreamErrorCode(text);
  if (
    status === 403 &&
    (code === 'OperationDenied.ServiceOverdue' ||
      code === 'AccountOverdueError')
  ) {
    return new AiProviderError(
      'billing',
      'AI provider billing is unavailable',
      status,
      code
    );
  }
  if (
    (status === 403 || status === 404) &&
    (code === 'OperationDenied.ServiceNotOpen' ||
      code === 'OperationDenied.PermissionDenied' ||
      code === 'InvalidEndpointOrModel.NotFound' ||
      code === 'InvalidEndpointOrModel.ModelIDAccessDisabled' ||
      code === 'ModelNotOpen' ||
      code === 'AccessDenied')
  ) {
    return new AiProviderError(
      'configuration',
      'AI provider model access is unavailable',
      status,
      code
    );
  }
  if (status === 401 || status === 403) {
    return new AiProviderError(
      'authentication',
      'AI provider credentials were rejected',
      status,
      code
    );
  }
  if (status === 429) {
    return new AiProviderError(
      'rate_limited',
      'AI provider rate limit reached',
      status,
      code
    );
  }
  return new AiProviderError(
    status >= 500 ? 'unavailable' : 'bad_response',
    `AI provider returned HTTP ${status}`,
    status,
    code
  );
}

/** Vision/text adapter for providers exposing OpenAI chat completions. */
export class OpenAiCompatibleTextProvider implements TextAiProvider {
  readonly name: string;
  readonly chatModel: string;
  readonly usageUnit = 'tokens' as const;
  // OpenAI-compatible syntax does not imply provider-side idempotency.
  readonly idempotencyCapability = 'none' as const;

  constructor(private readonly config: OpenAiCompatibleTextProviderConfig) {
    this.name = config.name;
    this.chatModel = config.model;
  }

  async completeText(input: TextCompletionInput): Promise<AiTextResult> {
    const response = await fetchWithTimeout(
      endpoint(this.config.baseUrl),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(this.config.authStyle, this.config.apiKey),
        },
        body: JSON.stringify({
          model: this.chatModel,
          messages: input.messages,
          [this.config.maxTokensField ?? 'max_completion_tokens']:
            input.maxOutputTokens,
          temperature: input.temperature,
          ...(this.config.thinking
            ? { thinking: { type: this.config.thinking } }
            : {}),
        }),
      },
      this.config.timeoutMs ?? 60_000
    );
    const text = await readTextBounded(response, 2 * 1024 * 1024);
    if (!response.ok) {
      throw providerErrorForResponse(response.status, text);
    }

    let parsed: z.infer<typeof textResponseSchema>;
    try {
      parsed = textResponseSchema.parse(JSON.parse(text));
    } catch {
      throw new AiProviderError(
        'bad_response',
        'AI provider returned an invalid text response'
      );
    }
    return {
      content: parsed.choices[0].message.content,
      usage: {
        unit: this.usageUnit,
        inputUnits: parsed.usage?.prompt_tokens,
        outputUnits: parsed.usage?.completion_tokens,
      },
    };
  }

}

/**
 * Speech adapter for vendors that return audio from chat completions. It is
 * intentionally separate from the text adapter: Ark text and Volcengine TTS
 * use different products, credentials and protocols.
 */
export class ChatCompletionsSpeechProvider implements SpeechAiProvider {
  readonly name: string;
  readonly ttsModel: string;
  readonly ttsVoice: string;
  readonly ttsFormat: 'wav' | 'mp3' | 'ogg_opus';
  readonly usageUnit = 'tokens' as const;
  readonly idempotencyCapability = 'none' as const;

  constructor(
    private readonly config: ChatCompletionsSpeechProviderConfig
  ) {
    this.name = config.name;
    this.ttsModel = config.model;
    this.ttsVoice = config.voice;
    this.ttsFormat = config.format;
  }

  async synthesizeSpeech(
    input: SpeechSynthesisInput
  ): Promise<AiSpeechResult> {
    const response = await fetchWithTimeout(
      endpoint(this.config.baseUrl),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(this.config.authStyle, this.config.apiKey),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: buildTtsMessages({ text: input.text, style: input.style }),
          audio: { format: this.ttsFormat, voice: this.ttsVoice },
        }),
      },
      this.config.timeoutMs ?? 60_000
    );
    const text = await readTextBounded(response, MAX_TTS_RESPONSE_BYTES);
    if (!response.ok) {
      throw providerErrorForResponse(response.status, text);
    }

    let parsed: z.infer<typeof speechResponseSchema>;
    try {
      parsed = speechResponseSchema.parse(JSON.parse(text));
    } catch {
      throw new AiProviderError(
        'bad_response',
        'AI provider returned an invalid speech response'
      );
    }
    const audio = parsed.choices[0].message.audio;
    validateEncodedAudio(audio.data, this.ttsFormat);
    return {
      base64: audio.data,
      transcript: audio.transcript,
      usage: {
        unit: this.usageUnit,
        inputUnits: parsed.usage?.prompt_tokens,
        outputUnits: parsed.usage?.completion_tokens,
      },
    };
  }
}
