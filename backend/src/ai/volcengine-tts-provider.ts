import { randomUUID } from 'node:crypto';
import {
  AiProviderError,
  type AiSpeechResult,
  type SpeechAiProvider,
  type SpeechSynthesisInput,
} from './types.js';
import {
  MAX_TTS_AUDIO_BYTES,
  validateEncodedAudio,
} from './speech-audio.js';

const DEFAULT_ENDPOINT =
  'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_TIMEOUT_MS = 60_000;
const TERMINAL_SUCCESS_CODE = 20_000_000;
const AUDIO_FRAME_SUCCESS_CODE = 0;

/** Keep this aligned with the public TTS DTO's business limit. */
export const VOLCENGINE_TTS_MAX_TEXT_CHARACTERS = 1_500;
export const VOLCENGINE_TTS_MAX_AUDIO_BYTES = MAX_TTS_AUDIO_BYTES;

// A 4 MiB binary response expands to about 5.34 MiB in base64. Leave room for
// NDJSON framing, usage and sentence metadata without allowing an unbounded
// upstream stream to consume the API process heap.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_LINE_CHARACTERS = 6 * 1024 * 1024;
const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type FetchLike = typeof globalThis.fetch;

export interface VolcengineTtsProviderConfig {
  apiKey: string;
  voice: string;
  name?: string;
  resourceId?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  requestId?: () => string;
}

interface ParsedStreamState {
  audioChunks: Buffer[];
  audioBytes: number;
  terminalSeen: boolean;
}

/**
 * Doubao/Volcengine TTS 2.0 V3 HTTP Chunked adapter.
 *
 * `X-Api-Request-Id` is deliberately generated for each upstream attempt. The
 * vendor documents it as a request identifier, not a replay guarantee, so the
 * application's provider idempotency key must never be forwarded as though it
 * were natively supported.
 */
export class VolcengineTtsProvider implements SpeechAiProvider {
  readonly name: string;
  readonly ttsModel: string;
  readonly ttsVoice: string;
  readonly ttsFormat = 'mp3' as const;
  readonly usageUnit = 'characters' as const;
  readonly idempotencyCapability = 'none' as const;

  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly requestId: () => string;

  constructor(private readonly config: VolcengineTtsProviderConfig) {
    if (!config.apiKey.trim()) throw new Error('Volcengine API key is required');
    if (!config.voice.trim()) throw new Error('Volcengine TTS voice is required');

    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Volcengine TTS timeout must be a positive integer');
    }

    this.name = config.name ?? 'volcengine-tts';
    this.ttsModel = config.resourceId ?? DEFAULT_RESOURCE_ID;
    this.ttsVoice = config.voice;
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.requestId = config.requestId ?? randomUUID;
  }

  async synthesizeSpeech(
    input: SpeechSynthesisInput
  ): Promise<AiSpeechResult> {
    const submittedCharacters = countCharacters(input.text);
    if (
      input.text.trim().length === 0 ||
      submittedCharacters > VOLCENGINE_TTS_MAX_TEXT_CHARACTERS
    ) {
      throw new AiProviderError(
        'bad_response',
        'TTS text violates the configured business limit'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await raceWithAbort(
        this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': this.config.apiKey,
            'X-Api-Resource-Id': this.ttsModel,
            'X-Api-Request-Id': this.requestId(),
            // Volcengine returns usage.text_words in the terminal frame when
            // this control header is present.
            'X-Control-Require-Usage-Tokens-Return': '*',
          },
          body: JSON.stringify({
            req_params: {
              text: input.text,
              speaker: this.ttsVoice,
              audio_params: {
                format: this.ttsFormat,
                sample_rate: 24_000,
              },
              ...styleParameters(input.style),
            },
          }),
          signal: controller.signal,
        }),
        controller.signal
      );

      if (!response.ok) throw errorForHttpStatus(response.status);

      const parsed = await readNdjsonAudio(response, controller.signal);
      if (!parsed.terminalSeen) {
        throw invalidResponse('AI speech provider ended without a finish frame');
      }
      if (parsed.audioBytes === 0) {
        throw invalidResponse('AI speech provider returned no audio');
      }

      const audio = Buffer.concat(parsed.audioChunks, parsed.audioBytes);
      const base64 = audio.toString('base64');
      validateEncodedAudio(base64, this.ttsFormat);
      return {
        base64,
        transcript: input.text,
        usage: {
          unit: this.usageUnit,
          inputUnits: submittedCharacters,
        },
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (controller.signal.aborted || isAbortError(error)) {
        throw new AiProviderError(
          'timeout',
          'AI speech provider request timed out'
        );
      }
      throw new AiProviderError(
        'unavailable',
        'AI speech provider is unavailable'
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function styleParameters(
  style: SpeechSynthesisInput['style']
): { additions?: string } {
  const instruction =
    style === 'warm'
      ? '请用温暖、自然的语气说话。'
      : style === 'encouraging'
        ? '请用鼓励、积极且自然的语气说话。'
        : style === 'slow'
          ? '请放慢语速，清晰自然地说话。'
          : undefined;
  return instruction
    ? { additions: JSON.stringify({ context_texts: [instruction] }) }
    : {};
}

async function readNdjsonAudio(
  response: Response,
  signal: AbortSignal
): Promise<ParsedStreamState> {
  if (!response.body) throw invalidResponse('AI speech provider had no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const state: ParsedStreamState = {
    audioChunks: [],
    audioBytes: 0,
    terminalSeen: false,
  };
  let pending = '';
  let responseBytes = 0;

  try {
    while (!state.terminalSeen) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;

      responseBytes += value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        throw invalidResponse('AI speech provider response was too large');
      }
      pending += decoder.decode(value, { stream: true });
      if (pending.length > MAX_PENDING_LINE_CHARACTERS) {
        throw invalidResponse('AI speech provider returned an oversized frame');
      }
      pending = processCompleteLines(pending, state);
    }

    if (!state.terminalSeen) {
      pending += decoder.decode();
      if (pending.trim()) processLine(pending, state);
    }
    return state;
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (signal.aborted || isAbortError(error)) throw error;
    throw invalidResponse('AI speech provider returned malformed NDJSON');
  } finally {
    if (state.terminalSeen || signal.aborted) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or aborted; the primary outcome is
        // more useful than a secondary cancellation error.
      }
    }
    reader.releaseLock();
  }
}

function processCompleteLines(
  text: string,
  state: ParsedStreamState
): string {
  let start = 0;
  while (!state.terminalSeen) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) return text.slice(start);
    const line = text.slice(start, newline).replace(/\r$/, '');
    start = newline + 1;
    if (line.trim()) processLine(line, state);
  }
  return '';
}

function processLine(line: string, state: ParsedStreamState): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw invalidResponse('AI speech provider returned malformed NDJSON');
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.code)) {
    throw invalidResponse('AI speech provider returned an invalid frame');
  }

  const code = value.code as number;

  if (code === TERMINAL_SUCCESS_CODE) {
    state.terminalSeen = true;
    return;
  }
  if (code !== AUDIO_FRAME_SUCCESS_CODE) {
    throw errorForBusinessCode(code, value.message);
  }

  if (value.data === null || value.data === undefined || value.data === '') {
    return;
  }
  if (typeof value.data !== 'string') {
    throw invalidResponse('AI speech provider returned invalid audio data');
  }

  const chunk = decodeBase64(value.data);
  if (state.audioBytes + chunk.byteLength > VOLCENGINE_TTS_MAX_AUDIO_BYTES) {
    throw invalidResponse('AI speech provider returned oversized audio');
  }
  state.audioChunks.push(chunk);
  state.audioBytes += chunk.byteLength;
}

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64_RE.test(value)
  ) {
    throw invalidResponse('AI speech provider returned invalid audio data');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const expectedBytes = (value.length / 4) * 3 - padding;
  const decoded = Buffer.from(value, 'base64');
  if (expectedBytes <= 0 || decoded.byteLength !== expectedBytes) {
    throw invalidResponse('AI speech provider returned invalid audio data');
  }
  return decoded;
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function errorForHttpStatus(status: number): AiProviderError {
  if (status === 401 || status === 403) {
    return new AiProviderError(
      'authentication',
      'AI speech provider credentials were rejected',
      status
    );
  }
  if (status === 429) {
    return new AiProviderError(
      'rate_limited',
      'AI speech provider rate limit reached',
      status
    );
  }
  return new AiProviderError(
    status >= 500 ? 'unavailable' : 'bad_response',
    'AI speech provider returned an unsuccessful HTTP response',
    status
  );
}

function errorForBusinessCode(
  code: number,
  upstreamMessage: unknown
): AiProviderError {
  const classificationText =
    typeof upstreamMessage === 'string' ? upstreamMessage.toLowerCase() : '';
  if (
    classificationText.includes('concurrency') ||
    classificationText.includes('quota exceeded') ||
    classificationText.includes('rate limit')
  ) {
    return new AiProviderError(
      'rate_limited',
      'AI speech provider rate limit reached'
    );
  }
  if (
    classificationText.includes('permission denied') ||
    classificationText.includes('access denied') ||
    classificationText.includes('authenticate')
  ) {
    return new AiProviderError(
      'authentication',
      'AI speech provider credentials or voice access were rejected'
    );
  }
  if (code >= 55_000_000) {
    return new AiProviderError(
      'unavailable',
      'AI speech provider failed to synthesize audio'
    );
  }
  return invalidResponse('AI speech provider rejected the synthesis request');
}

function invalidResponse(message: string): AiProviderError {
  return new AiProviderError('bad_response', message);
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
