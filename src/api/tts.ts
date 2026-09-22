import { BackendError, backendRequest } from './backend';

const MAX_TTS_TEXT_CHARS = 1_500;

export type AudioFormat = 'wav' | 'mp3' | 'ogg_opus';
export type SpeechStyle = 'neutral' | 'warm' | 'encouraging' | 'slow';

export interface SynthesizeOptions {
  text: string;
  idempotencyKey: string;
  /** Bounded business intent; provider prompts and voice IDs stay server-side. */
  style?: SpeechStyle;
}

export interface SynthesizeResult {
  base64: string;
  format: AudioFormat;
  voice?: string;
}

export class SpeechSynthesisError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'SpeechSynthesisError';
  }
}

interface TtsResponse {
  audio_format?: unknown;
  voice?: unknown;
  choices?: {
    message?: {
      audio?: { data?: string };
    };
  }[];
}

/** Provider-neutral TTS call. Model, voice and output format are policy. */
export async function synthesizeSpeech(
  options: SynthesizeOptions
): Promise<SynthesizeResult> {
  const text = options.text.trim();
  if (!text) throw new SpeechSynthesisError('待合成文本为空');
  if (text.length > MAX_TTS_TEXT_CHARS) {
    throw new SpeechSynthesisError('待合成文本过长');
  }

  let response: TtsResponse;
  try {
    response = await backendRequest<TtsResponse>(
      'POST',
      '/api/tts',
      { text, style: options.style ?? 'neutral' },
      { timeoutMs: 60_000, idempotencyKey: options.idempotencyKey }
    );
  } catch (error) {
    if (error instanceof BackendError) {
      throw new SpeechSynthesisError(error.message, error.status, error.code);
    }
    throw new SpeechSynthesisError(
      error instanceof Error ? error.message : '语音合成服务暂时不可用'
    );
  }

  const base64 = response.choices?.[0]?.message?.audio?.data;
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new SpeechSynthesisError(
      '语音服务返回格式错误，请重试',
      502,
      'TTS_INVALID_RESPONSE'
    );
  }
  if (!isAudioFormat(response.audio_format)) {
    throw new SpeechSynthesisError(
      '语音服务未返回有效音频格式，请重试',
      502,
      'TTS_INVALID_RESPONSE'
    );
  }

  return {
    base64,
    format: response.audio_format,
    voice: typeof response.voice === 'string' ? response.voice : undefined,
  };
}

function isAudioFormat(value: unknown): value is AudioFormat {
  return value === 'wav' || value === 'mp3' || value === 'ogg_opus';
}
