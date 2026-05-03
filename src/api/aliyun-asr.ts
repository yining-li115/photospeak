import { File } from 'expo-file-system';

const ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const MODEL = 'qwen3-asr-flash';

export class AliyunAsrError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'AliyunAsrError';
  }
}

export async function transcribeAudioWithAliyun(
  recordingUri: string,
  options: { language?: string } = {}
): Promise<string> {
  const apiKey = process.env.EXPO_PUBLIC_DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new AliyunAsrError(
      'EXPO_PUBLIC_DASHSCOPE_API_KEY is not set. Add it to your .env file.'
    );
  }

  const base64 = await new File(recordingUri).base64();
  const dataUri = `data:${mimeTypeFromUri(recordingUri)};base64,${base64}`;

  const body = {
    model: MODEL,
    input: {
      messages: [
        {
          role: 'user',
          content: [{ audio: dataUri }],
        },
      ],
    },
    parameters: {
      asr_options: {
        enable_itn: false,
        // Don't pin a language — qwen3-asr is LLM-based and handles
        // code-switching (e.g. user falling back to a Chinese word
        // mid-English sentence). Only set it if the caller asked.
        ...(options.language ? { language: options.language } : {}),
      },
    },
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new AliyunAsrError(
      `DashScope ASR failed (${response.status}): ${text}`,
      response.status
    );
  }

  const json = (await response.json()) as DashScopeAsrResponse;
  const text = extractTranscript(json);
  // null = unparseable response (real bug); '' = model produced no text
  // (usually an empty/too-short recording — let the UI handle it).
  if (text === null) {
    throw new AliyunAsrError(
      `DashScope response missing transcript text. Got: ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return text.trim();
}

interface DashScopeAsrResponse {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{ text?: string } | string> | string;
      };
    }>;
    text?: string;
  };
}

function extractTranscript(json: DashScopeAsrResponse): string | null {
  const message = json.output?.choices?.[0]?.message;
  if (typeof message?.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (typeof part === 'string' && part.length > 0) return part;
      if (
        typeof part === 'object' &&
        part !== null &&
        typeof part.text === 'string'
      ) {
        return part.text;
      }
    }
    // Empty array is a valid "I heard nothing" response — return ''
    // so the UI can show a friendly retry prompt.
    return '';
  }
  if (typeof json.output?.text === 'string') return json.output.text;
  return null;
}

function mimeTypeFromUri(uri: string): string {
  const ext = uri.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
      return 'audio/ogg';
    case 'opus':
      return 'audio/opus';
    case 'flac':
      return 'audio/flac';
    default:
      return 'audio/mp4';
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
