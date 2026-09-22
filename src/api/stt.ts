/**
 * STT provider resolver.
 *
 * Production path is `backend-streaming`: the recorder hook
 * (`src/hooks/useAudioRecorder.ts`) opens a streaming WebSocket to
 * PhotoSpeak's constrained backend relay. The relay owns the provider
 * credential and fixes the model, task, format and resource limits.
 *
 * The only other value, `whisper`, is a dev convenience that talks
 * to a local Whisper-compatible HTTP server set via
 * `EXPO_PUBLIC_WHISPER_ENDPOINT` (typically
 * `scripts/local_whisper_server.py`). The previous OpenAI-cloud
 * fallback was removed in P10 — shipping a third-party API key in
 * the bundle was a security mistake.
 *
 * No `transcribeAudio()` function lives here anymore. The recorder
 * hook is the single source of truth for STT lifecycle — call
 * `recorder.getTranscript()` after `recorder.stop()`.
 */
export type SttProvider = 'whisper' | 'backend-streaming';

export function currentSttProvider(): SttProvider {
  const raw = process.env.EXPO_PUBLIC_STT_PROVIDER?.toLowerCase().trim();
  // Treat the old beta value as the secure backend path so an OTA rollout can
  // migrate existing installs without accidentally switching them to a local
  // development-only Whisper server.
  return raw === 'whisper' ? 'whisper' : 'backend-streaming';
}
