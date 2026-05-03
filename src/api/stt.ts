import { transcribeAudioWithAliyun } from './aliyun-asr';
import { transcribeAudio as transcribeWithWhisper } from './whisper';

export type SttProvider = 'whisper' | 'aliyun-qwen';

function resolveProvider(): SttProvider {
  const raw = process.env.EXPO_PUBLIC_STT_PROVIDER?.toLowerCase().trim();
  if (raw === 'aliyun-qwen' || raw === 'aliyun' || raw === 'dashscope') {
    return 'aliyun-qwen';
  }
  return 'whisper';
}

export async function transcribeAudio(recordingUri: string): Promise<string> {
  const provider = resolveProvider();
  if (provider === 'aliyun-qwen') {
    return transcribeAudioWithAliyun(recordingUri);
  }
  return transcribeWithWhisper(recordingUri);
}

export function currentSttProvider(): SttProvider {
  return resolveProvider();
}
