import { AiProviderError } from './types.js';

/** Shared output contract for every speech-provider adapter. */
export const MAX_TTS_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_TTS_BASE64_CHARACTERS =
  4 * Math.ceil(MAX_TTS_AUDIO_BYTES / 3);
const CANONICAL_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Validate the declared container without decoding another full audio copy. */
export function validateEncodedAudio(
  base64: string,
  format: 'wav' | 'mp3' | 'ogg_opus'
): number {
  if (
    base64.length === 0 ||
    base64.length > MAX_TTS_BASE64_CHARACTERS ||
    base64.length % 4 !== 0 ||
    !CANONICAL_BASE64_RE.test(base64)
  ) {
    throw invalidSpeechResponse();
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedBytes = (base64.length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > MAX_TTS_AUDIO_BYTES) {
    throw invalidSpeechResponse();
  }

  const header = Buffer.from(base64.slice(0, 128), 'base64');
  const valid =
    format === 'wav'
      ? hasAsciiAt(header, 'RIFF', 0) && hasAsciiAt(header, 'WAVE', 8)
      : format === 'ogg_opus'
        ? hasAsciiAt(header, 'OggS', 0) && header.includes(Buffer.from('OpusHead'))
        : isMp3Header(header);
  if (!valid) throw invalidSpeechResponse();
  return decodedBytes;
}

function hasAsciiAt(buffer: Buffer, value: string, offset: number): boolean {
  return (
    buffer.length >= offset + value.length &&
    buffer.subarray(offset, offset + value.length).equals(Buffer.from(value))
  );
}

function isMp3Header(header: Buffer): boolean {
  if (hasAsciiAt(header, 'ID3', 0)) return true;
  if (header.length < 3) return false;
  return (
    header[0] === 0xff &&
    (header[1] & 0xe0) === 0xe0 &&
    (header[1] & 0x06) !== 0 &&
    (header[2] & 0xf0) !== 0 &&
    (header[2] & 0xf0) !== 0xf0
  );
}

function invalidSpeechResponse(): AiProviderError {
  return new AiProviderError(
    'bad_response',
    'AI provider returned invalid or oversized audio'
  );
}
