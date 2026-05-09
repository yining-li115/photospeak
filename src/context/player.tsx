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
import { addListeningSeconds } from '../db/stats';

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
  loadQueue: (queue: Track[], startAt?: number) => void;
  togglePlay: () => void;
  toggleLoopMode: () => void;
  setSpeed: (s: PlaybackSpeed) => void;
  next: () => void;
  prev: () => void;
  jumpTo: (index: number) => void;
  stop: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

// rntp's setupPlayer is one-shot per process. Use a module-level
// promise so concurrent callers (Provider remounts during dev hot
// reload) await the same init rather than racing.
let setupPromise: Promise<void> | null = null;

async function ensurePlayerSetup(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      await TrackPlayer.setupPlayer({
        autoHandleInterruptions: true,
      });
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
    await TrackPlayer.updateOptions({
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
    });
  })();
  return setupPromise;
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

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loopSingle, setLoopSingle] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);
  const [isReady, setIsReady] = useState(false);

  // One-shot rntp setup.
  useEffect(() => {
    ensurePlayerSetup()
      .then(() => setIsReady(true))
      .catch((e) => console.warn('[player] setup failed', e));
  }, []);

  const { playing } = useIsPlaying();
  const isPlaying = !!playing;

  // Native fires this whenever the active track changes — auto-advance
  // at end of one track, manual skip, jumpTo, queue load. Single source
  // of truth for currentIndex.
  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], (event) => {
    if (event.type === Event.PlaybackActiveTrackChanged) {
      const idx = (event as { index?: number }).index;
      if (typeof idx === 'number') {
        setCurrentIndex(idx);
      }
    }
  });

  // Listening time: each transition into 'playing' starts a stopwatch;
  // on the next change (pause / queue end / unmount) the elapsed
  // seconds get added to today's row in stats.
  useEffect(() => {
    if (!isPlaying) return;
    const startedAt = Date.now();
    return () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsed <= 0) return;
      const today = new Date().toISOString().slice(0, 10);
      addListeningSeconds(today, elapsed).catch(() => {});
    };
  }, [isPlaying]);

  const loadQueue = useCallback(
    async (newQueue: Track[], startAt = 0) => {
      if (newQueue.length === 0) return;
      const start = Math.max(0, Math.min(startAt, newQueue.length - 1));
      try {
        await ensurePlayerSetup();
        await TrackPlayer.reset();
        await TrackPlayer.add(newQueue.map(toRntpTrack));
        if (start > 0) await TrackPlayer.skip(start);
        await TrackPlayer.setRepeatMode(RepeatMode.Off);
        await TrackPlayer.setRate(speed);
        await TrackPlayer.play();
      } catch (e) {
        console.warn('[player] loadQueue failed', e);
        return;
      }
      setQueue(newQueue);
      setCurrentIndex(start);
      setLoopSingle(false);
    },
    [speed]
  );

  const togglePlay = useCallback(async () => {
    try {
      const state = await TrackPlayer.getPlaybackState();
      if (state.state === State.Playing) {
        await TrackPlayer.pause();
      } else {
        await TrackPlayer.play();
      }
    } catch (e) {
      console.warn('[player] togglePlay failed', e);
    }
  }, []);

  const next = useCallback(async () => {
    try {
      await TrackPlayer.skipToNext();
    } catch {
      /* end of queue */
    }
  }, []);

  const prev = useCallback(async () => {
    try {
      await TrackPlayer.skipToPrevious();
    } catch {
      /* start of queue */
    }
  }, []);

  const jumpTo = useCallback(async (index: number) => {
    try {
      await TrackPlayer.skip(index);
      await TrackPlayer.play();
    } catch (e) {
      console.warn('[player] jumpTo failed', e);
    }
  }, []);

  const toggleLoopMode = useCallback(() => {
    setLoopSingle((v) => {
      const next = !v;
      TrackPlayer.setRepeatMode(next ? RepeatMode.Track : RepeatMode.Off).catch(
        () => {}
      );
      return next;
    });
  }, []);

  const setSpeed = useCallback((s: PlaybackSpeed) => {
    setSpeedState(s);
    TrackPlayer.setRate(s).catch(() => {});
  }, []);

  const stop = useCallback(async () => {
    try {
      await TrackPlayer.reset();
    } catch {
      /* swallow */
    }
    setQueue([]);
    setCurrentIndex(0);
    setLoopSingle(false);
  }, []);

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

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer must be used inside PlayerProvider');
  }
  return ctx;
}
