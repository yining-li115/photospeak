import {
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder as useExpoAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useState } from 'react';

export type RecorderPermission = 'unknown' | 'granted' | 'denied';

export interface UseRecorder {
  start: () => Promise<boolean>;
  stop: () => Promise<string | null>;
  isRecording: boolean;
  durationMs: number;
  permission: RecorderPermission;
}

export function useRecorder(): UseRecorder {
  const recorder = useExpoAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [permission, setPermission] = useState<RecorderPermission>('unknown');

  useEffect(() => {
    (async () => {
      const p = await getRecordingPermissionsAsync();
      setPermission(p.granted ? 'granted' : 'denied');
    })();
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    let p = await getRecordingPermissionsAsync();
    if (!p.granted) {
      p = await requestRecordingPermissionsAsync();
    }
    if (!p.granted) {
      setPermission('denied');
      return false;
    }
    setPermission('granted');

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    });
    await recorder.prepareToRecordAsync();
    recorder.record();
    return true;
  }, [recorder]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (!recorder.isRecording) return null;
    await recorder.stop();
    // iOS AVAudioRecorder needs a moment to flush the m4a footer to disk
    // before the file is readable. Without this, base64() can return ''.
    await new Promise((r) => setTimeout(r, 150));
    await setAudioModeAsync({ allowsRecording: false });
    return recorder.uri;
  }, [recorder]);

  return {
    start,
    stop,
    isRecording: state.isRecording,
    durationMs: state.durationMillis,
    permission,
  };
}
