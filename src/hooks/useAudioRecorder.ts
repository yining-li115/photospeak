/**
 * Audio recorder with parallel streaming STT.
 *
 * One hook owns three coupled lifecycles:
 *   1. The microphone recording (file output, kept on disk for replay)
 *   2. A WebSocket session to DashScope paraformer-realtime-v2
 *   3. PCM frames being teed from #1 into #2
 *
 * The point of doing all three together is the user-visible win: by
 * the time the user taps "transcribe" after stopping, the transcript
 * is already finalised (or finishing) because we streamed audio
 * throughout the recording. The previous flow shipped a base64 m4a
 * after the fact, which is what the 4–10s wait was measuring.
 *
 * UI contract preserved:
 *   - `start()` / `stop()` look the same to callers
 *   - `stop()` still returns a recording file URI on disk
 *   - New: `getTranscript()` resolves to the final transcript. Safe
 *     to call any time after `stop()`; it just awaits a promise
 *     that's been in flight since the moment recording ended.
 *
 * If any part of the streaming path fails (token, WS connect, mid-
 * stream disconnect), the failure surfaces via getTranscript()'s
 * rejection, tagged with the stage so the call site can log
 * meaningfully. We do not fall back to a batch path — that was
 * deliberately removed (docs/optimization.md).
 *
 * Dev override: if `EXPO_PUBLIC_STT_PROVIDER=whisper`, the WS path
 * is skipped and `getTranscript()` instead resolves via a batch
 * POST to a local Whisper-compatible server (see whisper.ts). This
 * is only useful when running against `scripts/local_whisper_server.py`
 * on the developer's Mac; production builds should leave this unset.
 */
import {
  AudioStudioModule,
  useAudioRecorder as useAudioStudioRecorder,
  type AudioDataEvent,
} from '@siteed/audio-studio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TranscriptionSession, AliyunAsrError } from '../api/aliyun-asr';
import { currentSttProvider } from '../api/stt';
import { transcribeAudio as transcribeWithWhisper } from '../api/whisper';

export type RecorderPermission = 'unknown' | 'granted' | 'denied';

export interface UseRecorder {
  start: () => Promise<boolean>;
  stop: () => Promise<string | null>;
  /**
   * Awaits the transcript for the most-recently-stopped recording.
   * Resolves with the text (may be empty if the user spoke nothing)
   * or rejects with an error from the upstream STT path. Throws
   * synchronously if called before a recording has been stopped.
   */
  getTranscript: () => Promise<string>;
  isRecording: boolean;
  durationMs: number;
  permission: RecorderPermission;
}

const RECORDING_CONFIG = {
  // 16 kHz mono PCM 16-bit is the canonical ASR input format and is
  // what paraformer-realtime-v2 expects when we set `format: "pcm"`
  // / `sample_rate: 16000` in run-task.
  sampleRate: 16000 as const,
  channels: 1 as const,
  encoding: 'pcm_16bit' as const,
  // 100ms chunks match DashScope's "send 100ms every 100ms" guidance
  // and keep round-trip latency low without thrashing the WS.
  interval: 100,
  // Default streamFormat is 'raw' on native: base64-encoded PCM
  // bytes. We hand that string straight to the session, which
  // decodes once and ships as a binary WS frame.
};

export function useRecorder(): UseRecorder {
  const studio = useAudioStudioRecorder();
  const [permission, setPermission] = useState<RecorderPermission>('unknown');

  const sessionRef = useRef<TranscriptionSession | null>(null);
  const transcriptPromiseRef = useRef<Promise<string> | null>(null);

  useEffect(() => {
    (async () => {
      const p = await AudioStudioModule.getPermissionsAsync();
      setPermission(p.granted ? 'granted' : 'denied');
    })();
  }, []);

  useEffect(() => {
    // Defensive: if the screen unmounts mid-recording, cancel the
    // upstream WS so we don't leak a session. The audio recorder
    // itself is owned by the studio hook and will clean up on its
    // own.
    return () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
    };
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    let p = await AudioStudioModule.getPermissionsAsync();
    if (!p.granted) {
      p = await AudioStudioModule.requestPermissionsAsync();
    }
    if (!p.granted) {
      setPermission('denied');
      return false;
    }
    setPermission('granted');

    const provider = currentSttProvider();
    transcriptPromiseRef.current = null;

    // For aliyun-qwen (production), open the streaming session
    // before rolling the mic. If the session can't open (network,
    // expired JWT, upstream down), we don't want a recording the
    // user can't transcribe.
    if (provider === 'aliyun-qwen') {
      try {
        sessionRef.current = await TranscriptionSession.create();
      } catch (e) {
        console.warn('[recorder] failed to open transcription session', e);
        return false;
      }
    } else {
      sessionRef.current = null;
    }

    try {
      await studio.startRecording({
        ...RECORDING_CONFIG,
        onAudioStream:
          provider === 'aliyun-qwen'
            ? async (event: AudioDataEvent) => {
                // streamFormat defaults to 'raw' → data is base64
                // PCM bytes on native. Web emits typed arrays, which
                // we don't ship today; ignore those frames defensively.
                if (typeof event.data !== 'string') return;
                if (event.data.length === 0) return;
                try {
                  sessionRef.current?.sendAudio(event.data);
                } catch {
                  // WS dropped mid-stream. Swallow here — the failure
                  // resurfaces when the caller awaits getTranscript().
                }
              }
            : undefined,
      });
    } catch (e) {
      console.warn('[recorder] failed to start recording', e);
      sessionRef.current?.cancel();
      sessionRef.current = null;
      return false;
    }

    return true;
  }, [studio]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (!studio.isRecording) return null;

    let fileUri: string | null = null;
    try {
      const result = await studio.stopRecording();
      fileUri = result.fileUri ?? null;
    } catch (e) {
      console.warn('[recorder] stopRecording failed', e);
      // Still try to finalise the transcript — we sent audio frames
      // already and the user shouldn't lose their session just
      // because the file flush errored.
    }

    // Kick off finalisation immediately. The promise is stored
    // (not awaited) so the call site sees "recording saved" right
    // away; the transcript resolves in the background and is ready
    // by the time the user taps the transcribe button.
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      transcriptPromiseRef.current = session.finish().catch((err) => {
        if (err instanceof AliyunAsrError) {
          console.warn(
            `[recorder] transcription failed (${err.stage ?? 'unknown'})`,
            err.message
          );
        } else {
          console.warn('[recorder] transcription failed', err);
        }
        throw err;
      });
    } else if (fileUri) {
      // whisper dev path: no streaming, fire batch request against
      // local server using the recorded file.
      transcriptPromiseRef.current = transcribeWithWhisper(fileUri);
    }

    return fileUri;
  }, [studio]);

  const getTranscript = useCallback(async (): Promise<string> => {
    const p = transcriptPromiseRef.current;
    if (!p) {
      throw new AliyunAsrError(
        'no transcript available — stop a recording first',
        'finalize'
      );
    }
    return p;
  }, []);

  return {
    start,
    stop,
    getTranscript,
    isRecording: studio.isRecording,
    durationMs: studio.durationMs,
    permission,
  };
}
