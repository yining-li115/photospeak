const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
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
  const apiKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) {
    throw new WhisperError(
      'EXPO_PUBLIC_OPENAI_API_KEY is not set. Add it to your .env file.'
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

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
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
