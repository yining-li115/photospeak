/**
 * STT provider resolver.
 *
 * Production path is `aliyun-qwen`: the recorder hook
 * (`src/hooks/useAudioRecorder.ts`) opens a streaming WebSocket to
 * DashScope's paraformer-realtime-v2 directly, signed by a
 * short-lived token from our backend. Audio bytes never transit our
 * Node process.
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
export type SttProvider = 'whisper' | 'aliyun-qwen';

export function currentSttProvider(): SttProvider {
  const raw = process.env.EXPO_PUBLIC_STT_PROVIDER?.toLowerCase().trim();
  return raw === 'whisper' ? 'whisper' : 'aliyun-qwen';
}
