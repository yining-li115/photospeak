// Keep this aligned with the backend's provider-neutral TTS response ceiling.
export const MAX_GENERATED_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_GENERATED_SENTENCES_PER_SESSION = 12;
export const MAX_SESSION_GENERATED_AUDIO_BYTES =
  MAX_GENERATED_AUDIO_BYTES * MAX_GENERATED_SENTENCES_PER_SESSION;

const CANONICAL_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Validate canonical base64 and return its exact decoded byte count. */
export function generatedAudioByteLength(base64: string): number {
  if (
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !CANONICAL_BASE64_RE.test(base64)
  ) {
    throw new Error('Generated audio was not valid base64');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = (base64.length / 4) * 3 - padding;
  if (bytes <= 0) throw new Error('Generated audio was empty');
  if (bytes > MAX_GENERATED_AUDIO_BYTES) {
    throw new Error('Generated audio exceeded the per-file safety limit');
  }
  return bytes;
}
