/**
 * Audio player context, backed by react-native-track-player.
 *
 * Why rntp instead of expo-audio: per-sentence playback by recreating
 * an expo-audio player on every track change races with iOS 26's
 * native AVPlayer teardown — auto-advance was unreliable in
 * play-through mode (some sentences chained, some stopped dead).
 *
 * rntp wraps iOS AVQueuePlayer (and Android ExoPlayer), so the queue
 * lives natively. JS only sends commands; native handles seamless
 * playlist progression, lock-screen controls, and Bluetooth events.
 *
 * The public surface (`usePlayer()` hook return shape) is preserved
 * so consumer screens (listening/[id].tsx etc.) keep working.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  RepeatMode,
  State,
  useIsPlaying,
  useTrackPlayerEvents,
} from 'react-native-track-player';
import {
  acquirePlaybackAudioLease,
  beginAudioRecoveryQuarantine,
  endAudioRecoveryQuarantine,
  invalidatePlaybackAudioLease,
  isAudioLeaseCurrent,
  releaseAudioLease,
  type AudioRecoveryQuarantine,
  type AudioRuntimeLease,
} from '../audio/runtime';
import { setRemotePlaybackEnabled } from '../audio/playback-gate';
import { addListeningSecondsForOwner } from '../db/stats';
import { localDateKey } from '../utils/local-date';

export type PlaybackSpeed = 0.75 | 1 | 1.25;

export interface Track {
  sessionId: string;
  sentenceIndex: number;
  /** Absolute file:// URI — already resolved by the DB layer. */
  audioUri: string;
  sentenceText: string;
  photoUri: string;
  photoThumbnailUri: string;
  sessionDate: string;
}

interface PlayerContextValue {
  queue: Track[];
  currentIndex: number;
  isPlaying: boolean;
  isLoaded: boolean;
  loopSingle: boolean;
  speed: PlaybackSpeed;
  current: Track | null;
  loadQueue: (queue: Track[], startAt?: number) => Promise<boolean>;
  togglePlay: () => void;
  toggleLoopMode: () => void;
  setSpeed: (s: PlaybackSpeed) => void;
  next: () => void;
  prev: () => void;
  jumpTo: (index: number) => void;
  stop: () => Promise<void>;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

// rntp's setupPlayer is one-shot per process. Use a module-level
// promise so concurrent callers (Provider remounts during dev hot
// reload) await the same init rather than racing.
let setupPromise: Promise<void> | null = null;
let playerMutationTail: Promise<void> = Promise.resolve();
let playerRuntimeGeneration = 0;
interface PlaybackResetOperation {
  readonly promise: Promise<void>;
}

interface PlaybackResetRecovery extends PlaybackResetOperation {
  readonly quarantine: AudioRecoveryQuarantine;
}

let playbackResetOperation: PlaybackResetOperation | null = null;
let playbackResetRecovery: PlaybackResetRecovery | null = null;
const accountResetQuarantines = new Set<AudioRecoveryQuarantine>();
const pendingNativeCommands = new Set<Promise<unknown>>();

const NATIVE_PLAYER_COMMAND_TIMEOUT_MS = 4_000;
const NATIVE_PLAYER_RECOVERY_WAIT_MS = 3_000;

class NativePlaybackTimeoutError extends Error {
  constructor(command: string) {
    super(`Native playback command timed out: ${command}`);
    this.name = 'NativePlaybackTimeoutError';
  }
}

export class PlaybackRecoveryRequiredError extends Error {
  constructor(restartRequired: boolean, cause?: unknown) {
    super(
      restartRequired
        ? '播放器未能安全停止，请完全关闭并重新打开 PhotoSpeak'
        : '播放器正在安全停止，请稍候几秒再试',
      cause === undefined ? undefined : { cause }
    );
    this.name = 'PlaybackRecoveryRequiredError';
  }
}

/**
 * TrackPlayer is process-global. Serialize every queue mutation so two mounted
 * screens (or an account transition) cannot interleave reset/add/play calls
 * and leave native state belonging to the wrong request.
 */
function runPlayerMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = playerMutationTail.then(operation, operation);
  playerMutationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * A timed-out React Native bridge promise may still mutate native state later.
 * Keep the raw promise registered even after the caller times out. Recovery
 * waits for every detached command before issuing its final reset, so an old
 * add/play can never run after the reset that declared the device silent.
 */
function runNativePlayerCommand<T>(
  command: string,
  operation: () => Promise<T>
): Promise<T> {
  const nativePromise = Promise.resolve().then(operation);
  pendingNativeCommands.add(nativePromise);
  nativePromise.then(
    () => pendingNativeCommands.delete(nativePromise),
    () => pendingNativeCommands.delete(nativePromise)
  );
  nativePromise.catch(() => {});

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () =>
        finish(() => reject(new NativePlaybackTimeoutError(command))),
      NATIVE_PLAYER_COMMAND_TIMEOUT_MS
    );
    nativePromise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

async function waitForDetachedNativeCommands(): Promise<void> {
  // Commands can settle and schedule a following command while this loop is
  // awaiting the current snapshot, hence the loop rather than one Promise.all.
  while (pendingNativeCommands.size > 0) {
    const outcome = await settleWithinResult(
      Promise.allSettled([...pendingNativeCommands]),
      NATIVE_PLAYER_COMMAND_TIMEOUT_MS
    );
    if (outcome.status === 'timeout') {
      throw new NativePlaybackTimeoutError('wait-for-detached-commands');
    }
  }
}

async function ensurePlayerSetup(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      await runNativePlayerCommand('setup', () =>
        TrackPlayer.setupPlayer({
          autoHandleInterruptions: true,
        })
      );
    } catch (e) {
      // setupPlayer throws "The player has already been initialized"
      // when called twice — which is fine, we just want to ensure
      // it's running before we issue commands.
      const msg = String(e);
      if (!msg.includes('already been initialized')) {
        setupPromise = null; // allow retry
        throw e;
      }
    }
    await runNativePlayerCommand('update-options', () =>
      TrackPlayer.updateOptions({
        android: {
          appKilledPlaybackBehavior:
            AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
        },
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause],
      })
    );
  })();
  return setupPromise;
}

/** Stop native playback before account-owned files or identity can change. */
export async function resetPlaybackRuntime(): Promise<void> {
  playerRuntimeGeneration += 1;
  const quarantine = beginAudioRecoveryQuarantine();
  accountResetQuarantines.add(quarantine);
  invalidatePlaybackAudioLease();
  try {
    // This durable flag is also read by TrackPlayer's separate background JS
    // service, so remote controls fail closed before account state can change.
    await setRemotePlaybackEnabled(false);
    await resetNativePlayback();
    clearAccountResetQuarantine(quarantine);
  } catch (error) {
    const recovery = recoverNativePlaybackReset();
    recovery.then(
      () => clearAccountResetQuarantine(quarantine),
      () => {
        // Both quarantine tokens deliberately remain until process restart.
      }
    );
    const outcome = await settleWithinResult(
      recovery,
      NATIVE_PLAYER_RECOVERY_WAIT_MS
    );
    if (outcome.status === 'timeout') {
      throw new PlaybackRecoveryRequiredError(false, error);
    }
    if (outcome.status === 'rejected') {
      throw new PlaybackRecoveryRequiredError(true, outcome.reason);
    }
  }
}

async function resetNativePlayback(): Promise<void> {
  // Once recovery owns the native player, every later reset must join it.
  // Starting an independent reset could otherwise report success and release
  // a quarantine while recovery still waits for a late add/play command.
  const recovery = playbackResetRecovery;
  if (recovery) return recovery.promise;

  const activeOperation = playbackResetOperation;
  if (activeOperation) return activeOperation.promise;

  const operation: PlaybackResetOperation = {
    promise: performFinalNativePlaybackReset(),
  };
  playbackResetOperation = operation;
  operation.promise.then(
    () => clearOwnedResetOperation(operation),
    () => clearOwnedResetOperation(operation)
  );
  operation.promise.catch(() => {});
  return operation.promise;
}

/**
 * The only path that may issue a native reset. It runs inside the mutation
 * queue and drains timed-out bridge calls immediately before the final reset,
 * so no detached add/play can arrive after silence has been established.
 */
async function performFinalNativePlaybackReset(): Promise<void> {
  await runPlayerMutation(async () => {
    await waitForDetachedNativeCommands();
    await ensurePlayerSetup();
    // setup/updateOptions are native calls too. Re-check after setup so a
    // timed-out setup cannot outlive the reset that follows it.
    await waitForDetachedNativeCommands();
    await runNativePlayerCommand('reset', () => TrackPlayer.reset());
  });
}

function clearOwnedResetOperation(owner: PlaybackResetOperation): void {
  if (playbackResetOperation === owner) playbackResetOperation = null;
}

/**
 * A failed reset means lock-screen/remote controls may still revive native
 * audio even when React state says stopped. Quarantine all audio, retry a
 * bounded number of times, and fail closed until process restart if silence
 * cannot be proven.
 */
function recoverNativePlaybackReset(): Promise<void> {
  const activeRecovery = playbackResetRecovery;
  if (activeRecovery) return activeRecovery.promise;

  const quarantine = beginAudioRecoveryQuarantine();
  const recovery = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Bypass resetNativePlayback: after this recovery is registered that
        // function deliberately joins this promise, which would self-deadlock.
        await performFinalNativePlaybackReset();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await delay(250 * 2 ** attempt);
      }
    }
    throw lastError ?? new Error('native playback reset failed');
  })();
  const owner: PlaybackResetRecovery = { promise: recovery, quarantine };
  playbackResetRecovery = owner;
  recovery.then(
    () => {
      clearOwnedPlaybackResetRecovery(owner);
    },
    (error: unknown) => {
      // Keep the quarantine/rejected barrier: native audio state is unknown.
      console.warn('[player] native reset recovery failed', error);
    }
  );
  recovery.catch(() => {});
  return recovery;
}

function clearOwnedPlaybackResetRecovery(owner: PlaybackResetRecovery): void {
  if (playbackResetRecovery !== owner) return;
  playbackResetRecovery = null;
  endAudioRecoveryQuarantine(owner.quarantine);
}

function clearAccountResetQuarantine(
  quarantine: AudioRecoveryQuarantine
): void {
  if (!accountResetQuarantines.delete(quarantine)) return;
  endAudioRecoveryQuarantine(quarantine);
}

function recoverAfterNativeTimeout(error: unknown): void {
  if (!(error instanceof NativePlaybackTimeoutError)) return;
  void setRemotePlaybackEnabled(false).catch(() => {});
  recoverNativePlaybackReset().catch(() => {});
}

function toRntpTrack(t: Track) {
  return {
    id: `${t.sessionId}-${t.sentenceIndex}`,
    url: t.audioUri,
    title: t.sentenceText.slice(0, 80),
    artist: 'PhotoSpeak',
    artwork: t.photoThumbnailUri || undefined,
  };
}

export function PlayerProvider({
  children,
  ownerId,
}: {
  children: React.ReactNode;
  ownerId: string | null;
}) {
  const [providerGeneration] = useState(() => ++playerRuntimeGeneration);
  const playbackLeaseRef = useRef<AudioRuntimeLease | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loopSingle, setLoopSingle] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);
  const [isReady, setIsReady] = useState(false);

  // One-shot rntp setup.
  useEffect(() => {
    ensurePlayerSetup()
      .then(() => {
        if (providerGeneration === playerRuntimeGeneration) setIsReady(true);
      })
      .catch((e) => console.warn('[player] setup failed', e));
  }, [providerGeneration]);

  const { playing } = useIsPlaying();
  const isPlaying = !!playing;

  // Native fires this whenever the active track changes — auto-advance
  // at end of one track, manual skip, jumpTo, queue load. Single source
  // of truth for currentIndex.
  useTrackPlayerEvents(
    [Event.PlaybackActiveTrackChanged],
    (event) => {
      const idx = (event as { index?: number }).index;
      if (
        providerGeneration === playerRuntimeGeneration &&
        typeof idx === 'number'
      ) {
        setCurrentIndex(idx);
      }
    }
  );
  // Keep the playback lease for the lifetime of the loaded queue, including
  // its naturally-ended state. Queue-ended events carry no queue generation,
  // so an old native event must never release a newer queue's lease. loadQueue
  // replaces the playback lease; stop/account reset releases it explicitly.

  // Listening time: each transition into 'playing' starts a stopwatch;
  // on the next change (pause / queue end / unmount) the elapsed
  // seconds get added to today's row in stats.
  useEffect(() => {
    if (!isPlaying) return;
    const startedAt = Date.now();
    return () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsed <= 0) return;
      const today = localDateKey();
      if (
        ownerId &&
        providerGeneration === playerRuntimeGeneration
      ) {
        addListeningSecondsForOwner(ownerId, today, elapsed).catch(() => {});
      }
    };
  }, [isPlaying, ownerId, providerGeneration]);

  const loadQueue = useCallback(
    async (newQueue: Track[], startAt = 0) => {
      if (newQueue.length === 0) return false;
      if (providerGeneration !== playerRuntimeGeneration) return false;
      const lease = acquirePlaybackAudioLease();
      if (!lease) return false;
      playbackLeaseRef.current = lease;
      const start = Math.max(0, Math.min(startAt, newQueue.length - 1));
      try {
        // Do not let a stale background service command act on a queue while
        // it is being replaced. Re-enable only after the complete queue is
        // installed and belongs to the still-current account generation.
        await setRemotePlaybackEnabled(false);
        await runPlayerMutation(async () => {
          assertPlayerOperationCurrent(providerGeneration, lease);
          await ensurePlayerSetup();
          assertPlayerOperationCurrent(providerGeneration, lease);
          await runNativePlayerCommand('load-reset', () =>
            TrackPlayer.reset()
          );
          assertPlayerOperationCurrent(providerGeneration, lease);
          await runNativePlayerCommand('add-queue', () =>
            TrackPlayer.add(newQueue.map(toRntpTrack))
          );
          assertPlayerOperationCurrent(providerGeneration, lease);
          if (start > 0) {
            await runNativePlayerCommand('initial-skip', () =>
              TrackPlayer.skip(start)
            );
            assertPlayerOperationCurrent(providerGeneration, lease);
          }
          await runNativePlayerCommand('set-repeat', () =>
            TrackPlayer.setRepeatMode(RepeatMode.Off)
          );
          assertPlayerOperationCurrent(providerGeneration, lease);
          await runNativePlayerCommand('set-rate', () =>
            TrackPlayer.setRate(speed)
          );
          assertPlayerOperationCurrent(providerGeneration, lease);
          await runNativePlayerCommand('play', () => TrackPlayer.play());
          assertPlayerOperationCurrent(providerGeneration, lease);
        });
        assertPlayerOperationCurrent(providerGeneration, lease);
        await setRemotePlaybackEnabled(true);
        assertPlayerOperationCurrent(providerGeneration, lease);
      } catch (e) {
        void setRemotePlaybackEnabled(false).catch(() => {});
        if (playbackLeaseRef.current === lease) {
          const recovery = recoverNativePlaybackReset();
          recovery.then(
            () => {
              if (playbackLeaseRef.current === lease) {
                playbackLeaseRef.current = null;
                releaseAudioLease(lease);
                if (providerGeneration === playerRuntimeGeneration) {
                  setQueue([]);
                  setCurrentIndex(0);
                  setLoopSingle(false);
                }
              }
            },
            () => {
              // Keep the lease and global quarantine while native state is
              // unknown. Recording must remain unavailable.
            }
          );
        } else {
          releaseAudioLease(lease);
        }
        console.warn('[player] loadQueue failed', e);
        return false;
      }
      if (!isPlayerOperationCurrent(providerGeneration, lease)) return false;
      setQueue(newQueue);
      setCurrentIndex(start);
      setLoopSingle(false);
      return true;
    },
    [providerGeneration, speed]
  );

  const togglePlay = useCallback(async () => {
    const lease = playbackLeaseRef.current;
    if (!isPlayerOperationCurrent(providerGeneration, lease)) return;
    try {
      await runPlayerMutation(async () => {
        assertPlayerOperationCurrent(providerGeneration, lease);
        const state = await runNativePlayerCommand('get-state', () =>
          TrackPlayer.getPlaybackState()
        );
        assertPlayerOperationCurrent(providerGeneration, lease);
        if (state.state === State.Playing) {
          await runNativePlayerCommand('pause', () => TrackPlayer.pause());
        } else {
          await runNativePlayerCommand('resume', () => TrackPlayer.play());
        }
      });
    } catch (e) {
      recoverAfterNativeTimeout(e);
      console.warn('[player] togglePlay failed', e);
    }
  }, [providerGeneration]);

  const next = useCallback(async () => {
    const lease = playbackLeaseRef.current;
    if (!isPlayerOperationCurrent(providerGeneration, lease)) return;
    try {
      await runPlayerMutation(() => {
        assertPlayerOperationCurrent(providerGeneration, lease);
        return runNativePlayerCommand('next', () =>
          TrackPlayer.skipToNext()
        );
      });
    } catch (error) {
      recoverAfterNativeTimeout(error);
      /* end of queue */
    }
  }, [providerGeneration]);

  const prev = useCallback(async () => {
    const lease = playbackLeaseRef.current;
    if (!isPlayerOperationCurrent(providerGeneration, lease)) return;
    try {
      await runPlayerMutation(() => {
        assertPlayerOperationCurrent(providerGeneration, lease);
        return runNativePlayerCommand('previous', () =>
          TrackPlayer.skipToPrevious()
        );
      });
    } catch (error) {
      recoverAfterNativeTimeout(error);
      /* start of queue */
    }
  }, [providerGeneration]);

  const jumpTo = useCallback(async (index: number) => {
    const lease = playbackLeaseRef.current;
    if (!isPlayerOperationCurrent(providerGeneration, lease)) return;
    try {
      await runPlayerMutation(async () => {
        assertPlayerOperationCurrent(providerGeneration, lease);
        await runNativePlayerCommand('jump', () => TrackPlayer.skip(index));
        await runNativePlayerCommand('jump-play', () => TrackPlayer.play());
      });
    } catch (e) {
      recoverAfterNativeTimeout(e);
      console.warn('[player] jumpTo failed', e);
    }
  }, [providerGeneration]);

  const toggleLoopMode = useCallback(() => {
    const lease = playbackLeaseRef.current;
    if (!isPlayerOperationCurrent(providerGeneration, lease)) return;
    setLoopSingle((v) => {
      const next = !v;
      void runPlayerMutation(() => {
        assertPlayerOperationCurrent(providerGeneration, lease);
        return runNativePlayerCommand('toggle-repeat', () =>
          TrackPlayer.setRepeatMode(
            next ? RepeatMode.Track : RepeatMode.Off
          )
        );
      }).catch((error: unknown) => recoverAfterNativeTimeout(error));
      return next;
    });
  }, [providerGeneration]);

  const setSpeed = useCallback((s: PlaybackSpeed) => {
    setSpeedState(s);
    const lease = playbackLeaseRef.current;
    if (!isPlayerOperationCurrent(providerGeneration, lease)) return;
    void runPlayerMutation(() => {
      assertPlayerOperationCurrent(providerGeneration, lease);
      return runNativePlayerCommand('change-rate', () =>
        TrackPlayer.setRate(s)
      );
    }).catch((error: unknown) => recoverAfterNativeTimeout(error));
  }, [providerGeneration]);

  const stop = useCallback(async () => {
    const lease = playbackLeaseRef.current;
    if (!isPlayerOperationCurrent(providerGeneration, lease)) return;
    try {
      await setRemotePlaybackEnabled(false);
      await resetNativePlayback();
    } catch (error) {
      const recovery = recoverNativePlaybackReset();
      let recovered = false;
      recovery.then(
        () => {
          recovered = true;
          if (playbackLeaseRef.current === lease) {
            playbackLeaseRef.current = null;
            releaseAudioLease(lease);
            if (providerGeneration === playerRuntimeGeneration) {
              setQueue([]);
              setCurrentIndex(0);
              setLoopSingle(false);
            }
          }
        },
        () => {
          // Keep both lease and quarantine; a process restart is required.
        }
      );
      await settleWithin(recovery, NATIVE_PLAYER_RECOVERY_WAIT_MS);
      if (!recovered) {
        throw new Error('无法确认播放器已停止，请重新打开 PhotoSpeak', {
          cause: error,
        });
      }
      return;
    }
    if (playbackLeaseRef.current !== lease) return;
    playbackLeaseRef.current = null;
    releaseAudioLease(lease);
    if (providerGeneration !== playerRuntimeGeneration) return;
    setQueue([]);
    setCurrentIndex(0);
    setLoopSingle(false);
  }, [providerGeneration]);

  const current = queue[currentIndex] ?? null;

  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      isPlaying,
      isLoaded: isReady,
      loopSingle,
      speed,
      current,
      loadQueue,
      togglePlay,
      toggleLoopMode,
      setSpeed,
      next,
      prev,
      jumpTo,
      stop,
    }),
    [
      queue,
      currentIndex,
      isPlaying,
      isReady,
      loopSingle,
      speed,
      current,
      loadQueue,
      togglePlay,
      toggleLoopMode,
      setSpeed,
      next,
      prev,
      jumpTo,
      stop,
    ]
  );

  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
}

function isPlayerOperationCurrent(
  providerGeneration: number,
  lease: AudioRuntimeLease | null
): lease is AudioRuntimeLease {
  return (
    providerGeneration === playerRuntimeGeneration &&
    lease !== null &&
    isAudioLeaseCurrent(lease)
  );
}

function assertPlayerOperationCurrent(
  providerGeneration: number,
  lease: AudioRuntimeLease
): void {
  if (!isPlayerOperationCurrent(providerGeneration, lease)) {
    throw new Error('Playback operation was superseded');
  }
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

type TimedSettlement =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timeout' };

function settleWithinResult(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<TimedSettlement> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TimedSettlement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    operation.then(
      () => finish({ status: 'fulfilled' }),
      (reason: unknown) => finish({ status: 'rejected', reason })
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer must be used inside PlayerProvider');
  }
  return ctx;
}
