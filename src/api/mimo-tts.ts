const ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
const MODEL = 'mimo-v2.5-tts';

export const DEFAULT_VOICE = 'Chloe';
export const DEFAULT_FORMAT = 'wav' as const;

export type AudioFormat = 'wav' | 'mp3' | 'pcm16';

export interface SynthesizeOptions {
  text: string;
  voice?: string;
  format?: AudioFormat;
  /** Optional natural-language instruction sent in the `user` role to nudge prosody. */
  styleInstruction?: string;
}

export interface SynthesizeResult {
  base64: string;
  format: AudioFormat;
  voice: string;
}

export class MimoTtsError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'MimoTtsError';
  }
}

export async function synthesizeSpeech(
  options: SynthesizeOptions
): Promise<SynthesizeResult> {
  const apiKey = process.env.EXPO_PUBLIC_MIMO_API_KEY;
  if (!apiKey) {
    throw new MimoTtsError(
      'EXPO_PUBLIC_MIMO_API_KEY is not set. Add it to your .env file.'
    );
  }

  const voice = options.voice ?? DEFAULT_VOICE;
  const format = options.format ?? DEFAULT_FORMAT;

  const messages: { role: string; content: string }[] = [];
  if (options.styleInstruction) {
    messages.push({ role: 'user', content: options.styleInstruction });
  }
  // MiMo requires the actual TTS target text to be in an `assistant` message.
  messages.push({ role: 'assistant', content: options.text });

  const body = {
    model: MODEL,
    messages,
    audio: { format, voice },
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await safeReadText(response);
    throw new MimoTtsError(
      `MiMo TTS failed (${response.status}): ${errBody}`,
      response.status
    );
  }

  const json = (await response.json()) as MimoTtsResponse;
  const audio = json?.choices?.[0]?.message?.audio;
  if (!audio?.data || typeof audio.data !== 'string') {
    throw new MimoTtsError(
      `MiMo TTS response missing audio.data. Got: ${JSON.stringify(json).slice(0, 400)}`
    );
  }
  return { base64: audio.data, format, voice };
}

interface MimoTtsResponse {
  choices?: Array<{
    message?: {
      audio?: { data?: string; transcript?: string };
    };
  }>;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
