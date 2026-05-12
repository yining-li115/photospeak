/**
 * Audio recorder with parallel streaming STT.
 *
 * One hook owns three coupled lifecycles:
 *   1. The microphone recording (file output, kept on disk for replay)
 *   2. A WebSocket session to DashScope paraformer-realtime-v2
 *   3. PCM frames being teed from #1 into #2
 *
 * Start path is parallelised so the user sees immediate feedback:
 *   - studio.startRecording() and TranscriptionSession.create() run
 *     concurrently. The recording starts in ~100ms regardless of how
 *     long the WS handshake takes.
 *   - PCM frames that arrive before the session is open are buffered
 *     in memory, then flushed once the session is ready.
 *
 * UI contract preserved:
 *   - `start()` returns true/false synchronously after audio is rolling
 *   - `stop()` returns a recording file URI on disk
 *   - `getTranscript()` resolves to the final transcript. Safe to call
 *     any time after `stop()`; it just awaits a promise that's been
 *     in flight since the moment recording ended.
 *
 * If any part of the streaming path fails (token, WS connect, mid-
 * stream disconnect), the failure surfaces via getTranscript()'s
 * rejection, tagged with the stage so the call site can log
 * meaningfully. We do not fall back to a batch path — that was
 * deliberately removed (docs/optimization.md).
 *
 * Dev override: if `EXPO_PUBLIC_STT_PROVIDER=whisper`, the WS path
 * is skipped entirely and `getTranscript()` instead resolves via a
 * batch POST to a local Whisper-compatible server (see whisper.ts).
 * Whisper is NEVER used as a fallback for aliyun-qwen — production
 * builds with `EXPO_PUBLIC_STT_PROVIDER=aliyun-qwen` (the default)
 * fail loudly via the transcript rejection if streaming breaks.
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

// Cap the pre-session PCM buffer at ~10 seconds. The WS handshake
// should resolve in well under a second; if it hasn't by the time
// we've recorded ten seconds, something is wrong upstream and we
// drop the oldest frames rather than blow up JS memory.
const MAX_BUFFERED_FRAMES = 100; // 100 × 100ms intervals = 10s

export function useRecorder(): UseRecorder {
  const studio = useAudioStudioRecorder();
  const [permission, setPermission] = useState<RecorderPermission>('unknown');

  const sessionRef = useRef<TranscriptionSession | null>(null);
  const transcriptPromiseRef = useRef<Promise<string> | null>(null);
  // Prevents the "I tapped the button three times because nothing
  // happened" cascade — start() is async and the user can re-fire it
  // while the previous call is still in flight. Re-entrant calls now
  // resolve with `false` immediately.
  const startingRef = useRef(false);

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
    if (startingRef.current) return false;
    startingRef.current = true;

    try {
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
      sessionRef.current = null;

      if (provider !== 'aliyun-qwen') {
        // Whisper dev path: no streaming, just record to a file.
        try {
          await studio.startRecording({ ...RECORDING_CONFIG });
          return true;
        } catch (e) {
          console.warn('[recorder] failed to start recording', e);
          return false;
        }
      }

      // ── aliyun-qwen: parallel audio + WS handshake ──
      //
      // Frames that arrive on the mic before the WS is open get
      // buffered here; once `sessionReady` flips true the buffer
      // drains in order. This lets the recording UI react in
      // ~100ms while the network handshake (~250–750ms) runs in
      // the background.
      const buffer: string[] = [];
      let sessionReady = false;
      let sessionFailed = false;

      const sessionPromise = TranscriptionSession.create()
        .then((s) => {
          if (sessionFailed) {
            // start() bailed before we got here — just close it.
            s.cancel();
            return;
          }
          sessionRef.current = s;
          sessionReady = true;
          for (const frame of buffer) {
            try {
              s.sendAudio(frame);
            } catch {
              break;
            }
          }
          buffer.length = 0;
        })
        .catch((e) => {
          sessionFailed = true;
          console.warn('[recorder] failed to open transcription session', e);
        });

      try {
        await studio.startRecording({
          ...RECORDING_CONFIG,
          onAudioStream: async (event: AudioDataEvent) => {
            // streamFormat defaults to 'raw' → data is base64 PCM
            // bytes on native. Web emits typed arrays, which we
            // don't ship today; ignore those frames defensively.
            if (typeof event.data !== 'string') return;
            if (event.data.length === 0) return;

            if (sessionReady && sessionRef.current) {
              try {
                sessionRef.current.sendAudio(event.data);
              } catch {
                // WS dropped mid-stream. Failure surfaces when the
                // caller awaits getTranscript().
              }
              return;
            }

            // Session still opening — buffer with a cap so a
            // never-opening session doesn't grow JS heap unboundedly.
            buffer.push(event.data);
            if (buffer.length > MAX_BUFFERED_FRAMES) buffer.shift();
          },
        });
      } catch (e) {
        console.warn('[recorder] failed to start recording', e);
        sessionFailed = true;
        // If the session opens after we've bailed, the .then above
        // closes it. If it opened first, sessionRef.current already
        // points at the live session and we close it ourselves.
        await sessionPromise;
        // Cast: TS narrows sessionRef.current to null based on the
        // synchronous assignment a few lines up; the .then callback
        // mutates it asynchronously and TS can't see that.
        const opened = sessionRef.current as TranscriptionSession | null;
        opened?.cancel();
        sessionRef.current = null;
        return false;
      }

      return true;
    } finally {
      startingRef.current = false;
    }
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

    const provider = currentSttProvider();
    const session = sessionRef.current;
    sessionRef.current = null;

    if (provider === 'whisper') {
      // Dev path: post the saved WAV to a local Whisper server.
      transcriptPromiseRef.current = fileUri
        ? transcribeWithWhisper(fileUri)
        : Promise.reject(
            new AliyunAsrError(
              'no recording file to transcribe',
              'finalize'
            )
          );
    } else if (session) {
      // Production: finalise the streaming session. The promise is
      // stored (not awaited) so the call site sees "recording saved"
      // right away; the transcript resolves in the background and is
      // ready by the time the user taps the transcribe button.
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
    } else {
      // aliyun-qwen mode but session never opened — most likely
      // network / auth failure during the parallel handshake. Surface
      // it loudly rather than silently falling back to whisper.
      transcriptPromiseRef.current = Promise.reject(
        new AliyunAsrError(
          'transcription session was not available — check network and re-record',
          'finalize'
        )
      );
    }

    // Attach a no-op catch so a never-awaited rejection doesn't fire
    // an "unhandledRejection" warning before the caller gets to
    // getTranscript().
    transcriptPromiseRef.current.catch(() => {});

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
