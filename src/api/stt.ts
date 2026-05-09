import { transcribeAudioWithAliyun } from './aliyun-asr';
import { transcribeAudio as transcribeWithWhisper } from './whisper';

export type SttProvider = 'whisper' | 'aliyun-qwen';

// Default to aliyun-qwen (production path — routes through the
// backend proxy, no upstream key in the client). `whisper` is now a
// dev-only path that talks to a local Whisper server set via
// EXPO_PUBLIC_WHISPER_ENDPOINT. The previous OpenAI-cloud fallback
// (with EXPO_PUBLIC_OPENAI_API_KEY embedded in the bundle) was
// removed because the key shipped inside every IPA/APK — see
// optimization item P10.
function resolveProvider(): SttProvider {
  const raw = process.env.EXPO_PUBLIC_STT_PROVIDER?.toLowerCase().trim();
  if (raw === 'whisper') return 'whisper';
  return 'aliyun-qwen';
}

export async function transcribeAudio(recordingUri: string): Promise<string> {
  const provider = resolveProvider();
  if (provider === 'whisper') {
    return transcribeWithWhisper(recordingUri);
  }
  return transcribeAudioWithAliyun(recordingUri);
}

export function currentSttProvider(): SttProvider {
  return resolveProvider();
}
