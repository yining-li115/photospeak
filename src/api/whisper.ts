/**
 * Local-only Whisper client (dev convenience).
 *
 * Production STT goes through the backend's `/api/transcribe` proxy
 * to DashScope; see `aliyun-asr.ts`. This file is dev-only — it
 * speaks to a Whisper-compatible HTTP endpoint set via
 * `EXPO_PUBLIC_WHISPER_ENDPOINT` (typically `scripts/local_whisper_server.py`
 * on the developer's Mac). The previous fallback to OpenAI's cloud
 * (with `EXPO_PUBLIC_OPENAI_API_KEY` baked into the bundle) was
 * removed in P10 — that key would have shipped inside every IPA/APK.
 *
 * Anyone running on a real device or shipping to TestFlight should
 * keep `EXPO_PUBLIC_STT_PROVIDER` unset (or set it to `aliyun-qwen`)
 * so this file is never reached.
 */
const MODEL = 'whisper-1';

export class WhisperError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'WhisperError';
  }
}

export async function transcribeAudio(
  recordingUri: string,
  options: { language?: string } = {}
): Promise<string> {
  const endpoint = process.env.EXPO_PUBLIC_WHISPER_ENDPOINT?.trim();
  if (!endpoint) {
    throw new WhisperError(
      'Local Whisper endpoint is not configured. Either set ' +
        'EXPO_PUBLIC_WHISPER_ENDPOINT to a local server URL, or set ' +
        'EXPO_PUBLIC_STT_PROVIDER=aliyun-qwen to use the backend ' +
        'proxy (production path).'
    );
  }

  const form = new FormData();
  form.append('file', {
    uri: recordingUri,
    name: filenameFromUri(recordingUri),
    type: mimeTypeFromUri(recordingUri),
    // RN's FormData accepts this object shape; cast bypasses lib.dom typing
  } as unknown as Blob);
  form.append('model', MODEL);
  form.append('language', options.language ?? 'en');
  form.append('response_format', 'text');

  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    const body = await safeReadText(response);
    throw new WhisperError(
      `Whisper request failed (${response.status}): ${body}`,
      response.status
    );
  }

  const text = await response.text();
  return text.trim();
}

function filenameFromUri(uri: string): string {
  const tail = uri.split('/').pop() ?? 'recording.m4a';
  return tail.includes('.') ? tail : `${tail}.m4a`;
}

function mimeTypeFromUri(uri: string): string {
  const ext = uri.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'm4a':
    case 'mp4':
      return 'audio/m4a';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'caf':
      return 'audio/x-caf';
    case 'aac':
      return 'audio/aac';
    default:
      return 'audio/m4a';
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
