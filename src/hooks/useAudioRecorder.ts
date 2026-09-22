/**
 * Audio recording coordinator.
 *
 * This hook is the single owner of the microphone, the streaming-ASR
 * connection and their shared lifecycle. Every recording gets an operation
 * id, so late WebSocket handshakes and audio callbacks from an old attempt can
 * never attach themselves to a newer recording.
 */
import * as Sentry from '@sentry/react-native';
import {
  AudioStudioModule,
  useAudioRecorder as useAudioStudioRecorder,
  type AudioDataEvent,
  type AudioRecording,
  type RecordingInterruptionEvent,
  type StartRecordingResult,
} from '@siteed/audio-studio';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  TranscriptionError,
  TranscriptionSession,
} from '../api/streaming-asr';
import {
  acquireRecordingAudioLease,
  beginAudioRecoveryQuarantine,
  endAudioRecoveryQuarantine,
  releaseAudioLease,
  type AudioRecoveryQuarantine,
  type AudioRuntimeLease,
} from '../audio/runtime';
import { currentSttProvider, type SttProvider } from '../api/stt';
import { transcribeAudio as transcribeWithWhisper } from '../api/whisper';
import {
  getRecordingCountdown,
  RECORDING_GRACE_MS,
  RECORDING_MAX_MS,
  RECORDING_TARGET_MS,
  type RecordingPeriod,
} from '../recording/policy';
import {
  RecorderRuntimeResetBarrier,
  type RecorderResetPermit,
} from '../recording/runtime-reset';

export type RecorderPermission = 'unknown' | 'granted' | 'denied';
export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'stopping';
export type RecorderAutoStopReason =
  | 'limit'
  | 'background'
  | 'interruption';

export interface RecorderStoppedEvent {
  fileUri: string | null;
  durationMs: number;
  reason: RecorderAutoStopReason;
  /** The same final transcript exposed by getTranscript(). */
  transcript: Promise<string>;
}

export interface UseRecorderOptions {
  /** Called after a non-manual stop has safely closed the microphone. */
  onAutoStop?: (event: RecorderStoppedEvent) => void | Promise<void>;
  /** Called once when the 60-second target changes into the 10-second grace. */
  onGraceStarted?: () => void;
}

export interface UseRecorder {
  start: () => Promise<boolean>;
  stop: () => Promise<string | null>;
  /** Stop, cancel transcription and delete the temporary recording. */
  discard: () => Promise<void>;
  getTranscript: () => Promise<string>;
  phase: RecorderPhase;
  isRecording: boolean;
  durationMs: number;
  period: RecordingPeriod;
  remainingMs: number;
  permission: RecorderPermission;
}

export class RecorderRecoveryRequiredError extends Error {
  constructor(restartRequired: boolean, cause?: unknown) {
    super(
      restartRequired
        ? '录音组件未能安全释放麦克风，请完全关闭并重新打开 PhotoSpeak'
        : '录音组件正在安全恢复，请稍候几秒再试',
      cause === undefined ? undefined : { cause }
    );
    this.name = 'RecorderRecoveryRequiredError';
  }
}

const RECORDING_CONFIG = {
  sampleRate: 16000 as const,
  channels: 1 as const,
  encoding: 'pcm_16bit' as const,
  interval: 100,
  // Audio analysis is not used. Explicitly avoid retaining an ever-growing
  // history in JS if processing is enabled by a future platform default.
  keepFullAnalysis: false,
};

// At 100 ms per frame this is a 10-second upper bound. A handshake that takes
// longer has already missed too much speech to return a trustworthy transcript.
const MAX_BUFFERED_FRAMES = 100;
const SESSION_READY_ON_STOP_MS = 2_000;
// Native startup normally resolves in a fraction of a second. A bounded wait
// is essential because backgrounding/unmounting while this promise is stuck is
// otherwise able to strand both the microphone and the process audio lease.
const NATIVE_START_TIMEOUT_MS = 10_000;
const NATIVE_RECOVERY_WAIT_MS = 3_000;
// Permission APIs are outside our cancellation control. Account transitions
// must not hang forever if the OS bridge never resolves, but a timeout cannot
// be treated as proof of silence: reset fails and its quarantine stays held.
const RESET_OVERLAPPING_START_WAIT_MS = 15_000;

// A timed-out native start can outlive the React screen that created it. Keep
// this barrier at module scope so a remount cannot start a second recorder
// while the first native operation is still being stopped. The audio-runtime
// quarantine below also blocks playback until recovery is known to be safe. A
// failed recovery deliberately remains blocked until app restart.
let nativeRecoveryBarrier: Promise<unknown> | null = null;
let nativeRecoveryFailed = false;
const recorderShutdownHandlers = new Map<symbol, () => Promise<void>>();
let recorderResetTail: Promise<void> = Promise.resolve();
const recorderRuntimeResetBarrier = new RecorderRuntimeResetBarrier();

interface RecorderResetRequest {
  readonly permit: RecorderResetPermit;
  readonly quarantine: AudioRecoveryQuarantine;
}

/**
 * Account identity is process-global while recorder hooks live inside screens.
 * Registering every mounted hook here lets authentication transitions first
 * invalidate permission/start attempts and prove that the native microphone is
 * silent. A pending native recovery remains a process-wide barrier even after
 * its screen unmounts.
 */
export function resetRecordingRuntime(): Promise<void> {
  // Establish both barriers synchronously. If another reset is already queued,
  // its quarantine remains held while this request waits its turn.
  const request: RecorderResetRequest = {
    permit: recorderRuntimeResetBarrier.beginReset(),
    quarantine: beginAudioRecoveryQuarantine(),
  };
  const result = recorderResetTail
    .then(
      () => resetRecordingRuntimeNow(request),
      () => resetRecordingRuntimeNow(request)
    )
    .finally(() => request.permit.finish());
  recorderResetTail = result.catch(() => {});
  return result;
}

async function resetRecordingRuntimeNow(
  request: RecorderResetRequest
): Promise<void> {
  const shutdowns = [...recorderShutdownHandlers.values()].map((shutdown) =>
    shutdown()
  );
  // Shutdown invalidates each hook-local operation. The start barrier covers
  // the independent gap where start() crossed an await before that shutdown
  // snapshot ran. Do not prove silence until both groups have settled.
  const [shutdownResults, startSettlement] = await Promise.all([
    Promise.allSettled(shutdowns),
    request.permit.waitForOverlappingStarts(
      RESET_OVERLAPPING_START_WAIT_MS
    ),
  ]);
  const shutdownFailure = shutdownResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (startSettlement === 'timeout') {
    // The old attempt remains generation-invalid, and the audio quarantine is
    // deliberately not released. The account transition therefore fails
    // closed instead of crossing identities while an await is indeterminate.
    throw new RecorderRecoveryRequiredError(
      true,
      new Error('overlapping recorder start did not settle before reset timeout')
    );
  }

  const recovery = nativeRecoveryBarrier;
  if (recovery) {
    const outcome = await settleWithinResult(
      recovery,
      NATIVE_RECOVERY_WAIT_MS
    );
    if (outcome.status === 'fulfilled') {
      endAudioRecoveryQuarantine(request.quarantine);
      return;
    }
    if (outcome.status === 'timeout') {
      recovery.then(
        () => endAudioRecoveryQuarantine(request.quarantine),
        () => {
          // Unknown native microphone state stays quarantined until restart.
        }
      );
      throw new RecorderRecoveryRequiredError(false, shutdownFailure?.reason);
    }
    throw new RecorderRecoveryRequiredError(true, outcome.reason);
  }

  if (shutdownFailure || nativeRecoveryFailed) {
    // A rejection without a tracked successful recovery cannot prove the
    // microphone is silent. Deliberately retain the quarantine.
    throw new RecorderRecoveryRequiredError(
      true,
      shutdownFailure?.reason
    );
  }

  endAudioRecoveryQuarantine(request.quarantine);
}

type InternalStopReason = RecorderAutoStopReason | 'manual' | 'discard' | 'unmount';

interface RecordingOperation {
  id: number;
  provider: SttProvider;
  controller: AbortController;
  session: TranscriptionSession | null;
  sessionPromise: Promise<void> | null;
  sessionError: Error | null;
  bufferedFrames: string[];
  nativeStartPromise: Promise<StartRecordingResult> | null;
  nativeRecoveryPromise: Promise<AudioRecording | null> | null;
  nativeRecoveryQuarantine: AudioRecoveryQuarantine | null;
  nativeStarted: boolean;
  startedAtMonotonicMs: number | null;
  aborted: boolean;
  discardRequested: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  hardStopTimer: ReturnType<typeof setTimeout> | null;
  audioLease: AudioRuntimeLease | null;
}

interface InternalStopResult {
  fileUri: string | null;
  durationMs: number;
  transcript: Promise<string> | null;
  reason: InternalStopReason;
}

export function useRecorder(options: UseRecorderOptions = {}): UseRecorder {
  const studio = useAudioStudioRecorder();
  const studioRef = useRef(studio);
  studioRef.current = studio;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [permission, setPermission] = useState<RecorderPermission>('unknown');
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const phaseRef = useRef<RecorderPhase>('idle');
  const mountedRef = useRef(true);
  const operationCounterRef = useRef(0);
  const operationRef = useRef<RecordingOperation | null>(null);
  const stopPromiseRef = useRef<Promise<InternalStopResult | null> | null>(null);
  const transcriptPromiseRef = useRef<Promise<string> | null>(null);
  const stopInternalRef = useRef<
    (reason: InternalStopReason) => Promise<InternalStopResult | null>
  >(async () => null);

  const updatePhase = useCallback((next: RecorderPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    AudioStudioModule.getPermissionsAsync()
      .then((result: { granted: boolean }) => {
        if (!cancelled && mountedRef.current) {
          setPermission(result.granted ? 'granted' : 'denied');
        }
      })
      .catch((error: unknown) => {
        console.warn('[recorder] permission check failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openStreamingSession = useCallback((operation: RecordingOperation) => {
    operation.sessionPromise = TranscriptionSession.create({
      signal: operation.controller.signal,
    })
      .then((session) => {
        if (
          operation.aborted ||
          operationRef.current?.id !== operation.id
        ) {
          session.cancel();
          return;
        }

        operation.session = session;
        const pending = operation.bufferedFrames.splice(0);
        try {
          for (const frame of pending) session.sendAudio(frame);
        } catch (error) {
          operation.sessionError = normalizeAsrError(error, 'stream');
          operation.session = null;
          session.cancel();
        }
      })
      .catch((error: unknown) => {
        // Cancellation is an expected part of discard/unmount. Keep the
        // original overflow/send error when one already explains the failure.
        if (!operation.sessionError) {
          operation.sessionError = normalizeAsrError(error, 'connect');
        }
        if (operation.aborted) return;

        console.warn('[recorder] failed to open transcription session', error);
        Sentry.captureException(error, {
          tags: {
            area: 'recorder.session.create',
            stage:
              error instanceof TranscriptionError
                ? (error.stage ?? 'unknown')
                : 'unknown',
          },
        });
      });
  }, []);

  const runNativeRecovery = useCallback(
    (
      operation: RecordingOperation,
      area: 'start' | 'stop',
      task: () => Promise<AudioRecording | null>
    ): Promise<AudioRecording | null> => {
      if (operation.nativeRecoveryPromise) {
        return operation.nativeRecoveryPromise;
      }

      operation.nativeRecoveryQuarantine = beginAudioRecoveryQuarantine();
      const recovery = task();
      operation.nativeRecoveryPromise = recovery;
      nativeRecoveryBarrier = recovery;
      nativeRecoveryFailed = false;

      recovery.then(
        (recording) => {
          // A caller that gave up its bounded wait turns the eventual result
          // into an orphan unless recovery owns deletion here.
          if (operation.discardRequested) {
            deleteTemporaryFile(recording?.fileUri ?? null);
          }
          if (operation.nativeRecoveryQuarantine) {
            endAudioRecoveryQuarantine(operation.nativeRecoveryQuarantine);
            operation.nativeRecoveryQuarantine = null;
          }
          if (nativeRecoveryBarrier === recovery) {
            nativeRecoveryBarrier = null;
            nativeRecoveryFailed = false;
          }
        },
        (error: unknown) => {
          // Native state is unknown. Keep both the module barrier and global
          // quarantine until process restart instead of failing open.
          nativeRecoveryFailed = true;
          console.warn(`[recorder] native ${area} recovery failed`, error);
          Sentry.captureException(error, {
            tags: { area: `recorder.native-${area}-recovery` },
          });
        }
      );
      recovery.catch(() => {});
      return recovery;
    },
    []
  );

  const recoverIncompleteNativeStart = useCallback(
    (operation: RecordingOperation): Promise<AudioRecording | null> => {
      const startPromise = operation.nativeStartPromise;
      if (!startPromise) return Promise.resolve(null);
      const nativeRecorder = studioRef.current;

      return runNativeRecovery(operation, 'start', async () => {
        let started: StartRecordingResult;
        try {
          // A late start can activate the microphone after this screen is gone.
          // Do not declare recovery complete until that exact promise settles.
          started = await startPromise;
        } catch {
          return null;
        }

        const stopped = await stopNativeRecorderWithRetries(nativeRecorder);
        deleteTemporaryFile(stopped.fileUri);
        if (started.fileUri !== stopped.fileUri) {
          deleteTemporaryFile(started.fileUri);
        }
        return stopped;
      });
    },
    [runNativeRecovery]
  );

  const recoverStartedNativeRecording = useCallback(
    (operation: RecordingOperation): Promise<AudioRecording | null> => {
      const nativeRecorder = studioRef.current;
      return runNativeRecovery(operation, 'stop', () =>
        stopNativeRecorderWithRetries(nativeRecorder)
      );
    },
    [runNativeRecovery]
  );

  const stopInternal = useCallback(
    async (reason: InternalStopReason): Promise<InternalStopResult | null> => {
      if (stopPromiseRef.current) {
        if (reason === 'discard' || reason === 'unmount') {
          const active = operationRef.current;
          if (active) {
            active.discardRequested = true;
            active.aborted = true;
            active.controller.abort();
            active.session?.cancel();
            active.session = null;
          }
        }
        return stopPromiseRef.current;
      }

      const operation = operationRef.current;
      if (!operation) {
        // start() can still be awaiting a permission sheet. Invalidating the
        // attempt prevents that late continuation from opening the microphone
        // after the screen has left or the app has backgrounded.
        if (phaseRef.current === 'starting') {
          operationCounterRef.current += 1;
          updatePhase('idle');
        }
        return null;
      }

      const promise = (async (): Promise<InternalStopResult | null> => {
        const incompleteNativeStart =
          !operation.nativeStarted && operation.nativeStartPromise !== null;
        operation.discardRequested =
          reason === 'discard' ||
          reason === 'unmount' ||
          incompleteNativeStart ||
          (reason === 'background' && !operation.nativeStarted);
        clearOperationTimers(operation);
        if (reason !== 'unmount') updatePhase('stopping');

        if (operation.discardRequested) {
          operation.aborted = true;
          operation.controller.abort();
          operation.session?.cancel();
          operation.session = null;
        }

        const abandonUnsafeNativeState = (
          restartRequired: boolean,
          cause?: unknown
        ): RecorderRecoveryRequiredError => {
          operation.discardRequested = true;
          operation.aborted = true;
          operation.controller.abort();
          operation.session?.cancel();
          operation.session = null;
          operation.bufferedFrames.length = 0;
          releaseOperationAudio(operation);
          if (operationRef.current?.id === operation.id) {
            operationRef.current = null;
          }
          transcriptPromiseRef.current = null;
          if (reason !== 'unmount') updatePhase('idle');
          return new RecorderRecoveryRequiredError(restartRequired, cause);
        };

        let fileUri: string | null = null;
        let recordedDurationMs = elapsedFor(operation);
        if (operation.nativeStarted) {
          const stopped = await settleWithinResult(
            recoverStartedNativeRecording(operation),
            NATIVE_RECOVERY_WAIT_MS
          );
          if (stopped.status === 'timeout') {
            throw abandonUnsafeNativeState(false);
          }
          if (stopped.status === 'rejected') {
            throw abandonUnsafeNativeState(true, stopped.reason);
          }
          if (!stopped.value) {
            throw abandonUnsafeNativeState(
              true,
              new Error('native recorder returned no stop result')
            );
          }
          const recording = stopped.value;
          fileUri = recording.fileUri;
          recordedDurationMs = recording.durationMs || recordedDurationMs;
        } else if (operation.nativeStartPromise) {
          // Do not wait forever for a wedged native bridge. Recovery continues
          // outside the screen and prevents another recorder from starting.
          const recovered = await settleWithinResult(
            recoverIncompleteNativeStart(operation),
            NATIVE_RECOVERY_WAIT_MS
          );
          if (recovered.status === 'timeout') {
            throw abandonUnsafeNativeState(false);
          }
          if (recovered.status === 'rejected') {
            throw abandonUnsafeNativeState(true, recovered.reason);
          }
        }
        releaseOperationAudio(operation);

        let transcript: Promise<string> | null = null;
        if (operation.discardRequested) {
          deleteTemporaryFile(fileUri);
          transcriptPromiseRef.current = null;
        } else if (operation.provider === 'whisper') {
          transcript = fileUri
            ? transcribeWithWhisper(fileUri)
            : Promise.reject(
                new TranscriptionError(
                  'no recording file to transcribe',
                  'finalize'
                )
              );
          transcriptPromiseRef.current = observeTranscript(transcript);
        } else {
          // A quick tap can stop before the parallel WebSocket handshake is
          // done. Give it a short bounded chance to open and flush buffered
          // speech; never leave the UI waiting indefinitely.
          if (!operation.session && operation.sessionPromise) {
            await settleWithin(
              operation.sessionPromise,
              SESSION_READY_ON_STOP_MS
            );
          }

          if (operation.discardRequested) {
            deleteTemporaryFile(fileUri);
            transcriptPromiseRef.current = null;
          } else {
            const session = operation.session;
            if (session) {
              transcript = session.finish();
            } else {
              operation.controller.abort();
              transcript = Promise.reject(
                operation.sessionError ??
                  new TranscriptionError(
                    'transcription session was not available — check network and re-record',
                    'finalize'
                  )
              );
            }
            transcriptPromiseRef.current = observeTranscript(transcript);
          }
        }

        operation.aborted = true;
        operation.controller.abort();
        operation.bufferedFrames.length = 0;
        if (operationRef.current?.id === operation.id) {
          operationRef.current = null;
        }
        if (reason !== 'unmount') updatePhase('idle');

        const result = {
          fileUri,
          durationMs: Math.min(recordedDurationMs, RECORDING_MAX_MS),
          transcript,
          reason,
        };

        if (
          !operation.discardRequested &&
          (reason === 'limit' ||
            reason === 'background' ||
            reason === 'interruption')
        ) {
          // Transcript is always present for a completed non-discard stop.
          const event: RecorderStoppedEvent = {
            fileUri,
            durationMs: result.durationMs,
            reason,
            transcript:
              transcript ??
              Promise.reject(
                new TranscriptionError('transcription unavailable', 'finalize')
              ),
          };
          Promise.resolve(optionsRef.current.onAutoStop?.(event)).catch(
            (error: unknown) => {
              console.warn('[recorder] auto-stop callback failed', error);
              Sentry.captureException(error, {
                tags: { area: 'recorder.auto-stop', reason },
              });
            }
          );
        }

        return result;
      })().finally(() => {
        stopPromiseRef.current = null;
      });

      stopPromiseRef.current = promise;
      return promise;
    },
    [
      recoverIncompleteNativeStart,
      recoverStartedNativeRecording,
      updatePhase,
    ]
  );
  stopInternalRef.current = stopInternal;

  const start = useCallback(async (): Promise<boolean> => {
    const runtimePermit = recorderRuntimeResetBarrier.beginStart();
    if (!runtimePermit) throw new RecorderRecoveryRequiredError(false);
    try {
      if (phaseRef.current !== 'idle' || operationRef.current) return false;
      if (nativeRecoveryBarrier) {
        throw new RecorderRecoveryRequiredError(nativeRecoveryFailed);
      }
      const attemptId = ++operationCounterRef.current;
      updatePhase('starting');

      try {
        let permissionResult = await AudioStudioModule.getPermissionsAsync();
        if (
          !recorderRuntimeResetBarrier.isStartCurrent(runtimePermit) ||
          attemptId !== operationCounterRef.current ||
          !mountedRef.current
        ) {
          if (attemptId === operationCounterRef.current) updatePhase('idle');
          return false;
        }
        if (!permissionResult.granted) {
          permissionResult =
            await AudioStudioModule.requestPermissionsAsync();
          if (
            !recorderRuntimeResetBarrier.isStartCurrent(runtimePermit) ||
            attemptId !== operationCounterRef.current ||
            !mountedRef.current
          ) {
            if (attemptId === operationCounterRef.current) updatePhase('idle');
            return false;
          }
        }
        if (!permissionResult.granted) {
          setPermission('denied');
          updatePhase('idle');
          return false;
        }
        setPermission('granted');
      } catch (error) {
        if (attemptId === operationCounterRef.current) updatePhase('idle');
        throw error;
      }

      // No await can interleave between the last generation check above and
      // installing this operation, so reset must now see either the tracked
      // start permit or the hook-local shutdown handler (normally both).
      const operation: RecordingOperation = {
        id: attemptId,
        provider: currentSttProvider(),
        controller: new AbortController(),
        session: null,
        sessionPromise: null,
        sessionError: null,
        bufferedFrames: [],
        nativeStartPromise: null,
        nativeRecoveryPromise: null,
        nativeRecoveryQuarantine: null,
        nativeStarted: false,
        startedAtMonotonicMs: null,
        aborted: false,
        discardRequested: false,
        graceTimer: null,
        hardStopTimer: null,
        audioLease: null,
      };
      operationRef.current = operation;
      transcriptPromiseRef.current = null;

      operation.audioLease = acquireRecordingAudioLease();
      if (!operation.audioLease) {
        operationRef.current = null;
        updatePhase('idle');
        throw new Error('Audio is currently in use by playback');
      }

      if (operation.provider === 'backend-streaming') {
        openStreamingSession(operation);
      }

      try {
        const nativeStartPromise = studioRef.current.startRecording({
          ...RECORDING_CONFIG,
          autoResumeAfterInterruption: false,
          onRecordingInterrupted: (event: RecordingInterruptionEvent) => {
            if (
              shouldStopForInterruption(event) &&
              operationRef.current?.id === operation.id &&
              phaseRef.current === 'recording'
            ) {
              observeAutomaticStop(
                stopInternalRef.current('interruption'),
                'interruption'
              );
            }
          },
          onAudioStream: async (event: AudioDataEvent) => {
            if (
              operation.aborted ||
              operationRef.current?.id !== operation.id ||
              typeof event.data !== 'string' ||
              event.data.length === 0
            ) {
              return;
            }

            if (operation.session) {
              try {
                operation.session.sendAudio(event.data);
              } catch (error) {
                operation.sessionError = normalizeAsrError(error, 'stream');
                operation.session.cancel();
                operation.session = null;
              }
              return;
            }

            if (operation.sessionError) return;
            operation.bufferedFrames.push(event.data);
            if (operation.bufferedFrames.length > MAX_BUFFERED_FRAMES) {
              operation.sessionError = new TranscriptionError(
                'transcription connection took too long; buffered speech limit exceeded',
                'connect'
              );
              operation.bufferedFrames.length = 0;
              operation.controller.abort();
            }
          },
        });
        operation.nativeStartPromise = nativeStartPromise;
        await waitForNativeStart(
          nativeStartPromise,
          operation.controller.signal,
          NATIVE_START_TIMEOUT_MS
        );
        operation.nativeStarted = true;
        operation.startedAtMonotonicMs = performance.now();

        // Reset, unmount and discard can all win while native start is in
        // flight. A generation mismatch is treated exactly like cancellation:
        // the late microphone is stopped before this attempt can settle.
        if (
          !recorderRuntimeResetBarrier.isStartCurrent(runtimePermit) ||
          operation.aborted ||
          operationRef.current?.id !== operation.id
        ) {
          await stopInternalRef.current('discard');
          return false;
        }

        updatePhase('recording');
        operation.graceTimer = setTimeout(() => {
          if (
            operationRef.current?.id === operation.id &&
            phaseRef.current === 'recording'
          ) {
            optionsRef.current.onGraceStarted?.();
          }
        }, RECORDING_TARGET_MS);
        operation.hardStopTimer = setTimeout(() => {
          if (operationRef.current?.id === operation.id) {
            observeAutomaticStop(stopInternalRef.current('limit'), 'limit');
          }
        }, RECORDING_MAX_MS);
        return true;
      } catch (error) {
        const expectedCancellation =
          operation.aborted || error instanceof NativeStartCancelledError;
        await stopInternalRef.current('discard');
        if (expectedCancellation) return false;
        console.warn('[recorder] failed to start recording', error);
        Sentry.captureException(error, {
          tags: { area: 'recorder.start', provider: operation.provider },
        });
        throw error;
      }
    } finally {
      // resetRecordingRuntime() snapshots this promise before advancing. Keep
      // it pending through native cleanup so a successful reset always means
      // the overlapping start can no longer activate the microphone.
      runtimePermit.finish();
    }
  }, [openStreamingSession, updatePhase]);

  const stop = useCallback(async (): Promise<string | null> => {
    const result = await stopInternal('manual');
    // If a hard limit/interruption already won the single-flight stop race,
    // its onAutoStop callback owns persistence. The manual caller must not try
    // to move the same native temporary file a second time.
    return result?.reason === 'manual' ? result.fileUri : null;
  }, [stopInternal]);

  const discard = useCallback(async (): Promise<void> => {
    await stopInternal('discard');
  }, [stopInternal]);

  const getTranscript = useCallback(async (): Promise<string> => {
    const transcript = transcriptPromiseRef.current;
    if (!transcript) {
      throw new TranscriptionError(
        'no transcript available — stop a recording first',
        'finalize'
      );
    }
    return transcript;
  }, []);

  // A background transition is a privacy boundary: the microphone must not
  // continue invisibly. Native interruptions use the callback above.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (
        nextState === 'background' &&
        (phaseRef.current === 'starting' || phaseRef.current === 'recording')
      ) {
        observeAutomaticStop(
          stopInternalRef.current('background'),
          'background'
        );
      }
    });
    return () => subscription.remove();
  }, []);

  // The native recorder reports duration at a platform-defined cadence. The
  // timer is the primary limit; this is a defensive second gate for timer
  // throttling or clock suspension.
  useEffect(() => {
    if (
      phase === 'recording' &&
      studio.durationMs >= RECORDING_MAX_MS &&
      operationRef.current
    ) {
      observeAutomaticStop(stopInternalRef.current('limit'), 'limit');
    }
  }, [phase, studio.durationMs]);

  useEffect(() => {
    mountedRef.current = true;
    const shutdownToken = Symbol('mounted-recorder-shutdown');
    recorderShutdownHandlers.set(shutdownToken, async () => {
      await stopInternalRef.current('discard');
    });
    return () => {
      recorderShutdownHandlers.delete(shutdownToken);
      mountedRef.current = false;
      observeAutomaticStop(stopInternalRef.current('unmount'), 'unmount');
    };
  }, []);

  const durationMs =
    phase === 'recording'
      ? Math.min(studio.durationMs, RECORDING_MAX_MS)
      : 0;
  const countdown = getRecordingCountdown(durationMs);

  return {
    start,
    stop,
    discard,
    getTranscript,
    phase,
    isRecording: phase === 'recording',
    durationMs,
    period: phase === 'recording' ? countdown.period : 'idle',
    remainingMs: phase === 'recording' ? countdown.remainingMs : RECORDING_TARGET_MS,
    permission,
  };
}

function shouldStopForInterruption(event: RecordingInterruptionEvent): boolean {
  return (
    event.reason === 'audioFocusLoss' ||
    event.reason === 'phoneCall' ||
    event.reason === 'recordingStopped' ||
    event.reason === 'deviceDisconnected'
  );
}

function normalizeAsrError(
  error: unknown,
  stage: 'connect' | 'stream'
): Error {
  if (error instanceof Error) return error;
  return new TranscriptionError(String(error), stage);
}

function observeTranscript(transcript: Promise<string>): Promise<string> {
  const observed = transcript.catch((error: unknown) => {
    const stage =
      error instanceof TranscriptionError
        ? (error.stage ?? 'unknown')
        : 'unknown';
    console.warn(`[recorder] transcription failed (${stage})`, error);
    Sentry.captureException(error, {
      tags: { area: 'recorder.transcript', stage },
    });
    throw error;
  });
  // Avoid an unhandled rejection when the user leaves before tapping
  // Transcribe. The original rejecting promise remains observable.
  observed.catch(() => {});
  return observed;
}

function observeAutomaticStop(
  stop: Promise<InternalStopResult | null>,
  reason: RecorderAutoStopReason | 'unmount'
): void {
  stop.catch((error: unknown) => {
    console.warn(`[recorder] automatic ${reason} stop failed`, error);
    // Native recovery paths already report their root error. This observer is
    // primarily here so lifecycle-driven fire-and-forget stops never become an
    // unhandled rejection.
  });
}

function elapsedFor(operation: RecordingOperation): number {
  if (operation.startedAtMonotonicMs === null) return 0;
  return Math.max(0, performance.now() - operation.startedAtMonotonicMs);
}

function clearOperationTimers(operation: RecordingOperation): void {
  if (operation.graceTimer) clearTimeout(operation.graceTimer);
  if (operation.hardStopTimer) clearTimeout(operation.hardStopTimer);
  operation.graceTimer = null;
  operation.hardStopTimer = null;
}

function releaseOperationAudio(operation: RecordingOperation): void {
  if (!operation.audioLease) return;
  releaseAudioLease(operation.audioLease);
  operation.audioLease = null;
}

function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    operation.then(finish, finish);
  });
}

type TimedSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timeout' };

function settleWithinResult<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<TimedSettlement<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TimedSettlement<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    operation.then(
      (value) => finish({ status: 'fulfilled', value }),
      (reason: unknown) => finish({ status: 'rejected', reason })
    );
  });
}

interface NativeRecorderStopController {
  stopRecording: () => Promise<AudioRecording>;
}

async function stopNativeRecorderWithRetries(
  recorder: NativeRecorderStopController
): Promise<AudioRecording> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await recorder.stopRecording();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(250 * 2 ** attempt);
    }
  }
  throw (
    lastError ?? new Error('native recorder could not be stopped safely')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NativeStartCancelledError extends Error {
  constructor() {
    super('native recording start was cancelled');
    this.name = 'NativeStartCancelledError';
  }
}

class NativeStartTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`native recording did not start within ${timeoutMs}ms`);
    this.name = 'NativeStartTimeoutError';
  }
}

function waitForNativeStart(
  operation: Promise<StartRecordingResult>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<StartRecordingResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const succeed = (value: StartRecordingResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new NativeStartCancelledError());
    const timer = setTimeout(
      () => fail(new NativeStartTimeoutError(timeoutMs)),
      timeoutMs
    );

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    operation.then(
      succeed,
      (error: unknown) =>
        fail(
          error instanceof Error ? error : new Error(String(error))
        )
    );
  });
}

function deleteTemporaryFile(uri: string | null): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Best effort during cancellation/unmount.
  }
}

export { RECORDING_GRACE_MS, RECORDING_MAX_MS, RECORDING_TARGET_MS };
