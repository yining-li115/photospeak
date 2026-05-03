import AsyncStorage from '@react-native-async-storage/async-storage';

export const VOICES = [
  { id: 'Mia', label: 'Mia', gender: 'female', description: 'Steady & clear' },
  { id: 'Chloe', label: 'Chloe', gender: 'female', description: 'Warm & young' },
  { id: 'Milo', label: 'Milo', gender: 'male', description: 'Light & lively' },
  { id: 'Dean', label: 'Dean', gender: 'male', description: 'Mature & calm' },
] as const;

export type VoiceId = (typeof VOICES)[number]['id'];

const VOICE_KEY = 'photospeak.voice';
const STYLE_KEY = 'photospeak.podcastStyle';

export const DEFAULT_VOICE: VoiceId = 'Chloe';

/** Natural-language style instruction sent in the `user` role of MiMo TTS
 *  to nudge prosody toward a podcast-host delivery. */
export const PODCAST_STYLE_INSTRUCTION =
  'Read this like a friendly language-learning podcast host. Use a clear, warm, slightly slow pace with natural intonation and engaging delivery, so a learner can comfortably follow each word.';

export async function getVoice(): Promise<VoiceId> {
  const v = await AsyncStorage.getItem(VOICE_KEY);
  if (v && (VOICES as readonly { id: string }[]).some((x) => x.id === v)) {
    return v as VoiceId;
  }
  return DEFAULT_VOICE;
}

export async function setVoice(v: VoiceId): Promise<void> {
  await AsyncStorage.setItem(VOICE_KEY, v);
}

export async function getPodcastStyle(): Promise<boolean> {
  const v = await AsyncStorage.getItem(STYLE_KEY);
  return v === '1';
}

export async function setPodcastStyle(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(STYLE_KEY, enabled ? '1' : '0');
}
