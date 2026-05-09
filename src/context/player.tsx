import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioPlayer,
} from 'expo-audio';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { addListeningSeconds } from '../db/stats';

// Tagged logger for the play-through auto-advance path. Greppable
// from Xcode console / Metro logs as `[player]`. Cheap to leave on
// while we stabilize the audio session race; tighten or remove once
// the issue stops surfacing in the wild.
const plog = (event: string, data?: Record<string, unknown>) => {
  if (data) {
    console.log(`[player] ${event}`, JSON.stringify(data));
  } else {
    console.log(`[player] ${event}`);
  }
};

export type PlaybackSpeed = 0.75 | 1 | 1.25;

export interface Track {
  sessionId: string;
  sentenceIndex: number;
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

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loopSingle, setLoopSingle] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);
  const [autoplayWanted, setAutoplayWanted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Imperative handle to whichever AudioEngine instance is currently
  // mounted. The Provider's actions (togglePlay, jumpTo same-index seek)
  // operate on this player; the engine swaps players as the source URI
  // changes via its key prop.
  const playerRef = useRef<AudioPlayer | null>(null);

  // Refs so callbacks invoked by the engine see fresh state without
  // having to depend on it (would re-create callbacks every render).
  const queueRef = useRef(queue);
  const indexRef = useRef(currentIndex);
  const loopRef = useRef(loopSingle);
  // True once the queue has played all the way through. togglePlay uses
  // this to restart from index 0 instead of trying to play() a player
  // that's already parked at the end of the last sentence.
  const finishedRef = useRef(false);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    indexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    loopRef.current = loopSingle;
  }, [loopSingle]);

  // Audio session: silent-mode play only. shouldPlayInBackground was
  // disabled here because, on a dev build without UIBackgroundModes
  // baked in, the native call appears to mutate the AVAudioSession
  // category before rejecting — which leaves playback "playing" but
  // silent. We'll reintroduce background play after confirming the
  // basic path works (and after `expo run:ios` has been rerun so the
  // Info.plist actually has UIBackgroundModes=["audio"]).
  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
    }).catch(() => {});
  }, []);

  // Listening time: each time the player transitions into a 'playing'
  // state, start a stopwatch; on the next change (pause / queue end /
  // unmount) write the elapsed seconds to today's row in stats.
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

  // Stable callback identities — the AudioEngine effects depend on
  // these and we don't want to retrigger them on every Provider render.
  const handlePlayerHandle = useCallback((p: AudioPlayer | null) => {
    playerRef.current = p;
  }, []);

  const handleStatus = useCallback(
    (s: { playing: boolean; isLoaded: boolean }) => {
      setIsPlaying(s.playing);
      setIsLoaded(s.isLoaded);
    },
    []
  );

  const handleFinished = useCallback(() => {
    if (loopRef.current) return; // single-loop is handled by player.loop
    const next = indexRef.current + 1;
    plog('finished', { next, queueLen: queueRef.current.length });
    if (next < queueRef.current.length) {
      // We now reuse a single AudioPlayer instance + replace() to swap
      // sources, so the previous teardown race is gone. The state
      // update can be synchronous; no setTimeout dance.
      plog('swap', { to: next });
      setCurrentIndex(next);
      setAutoplayWanted(true);
    } else {
      // End of queue. Park the flag so togglePlay can restart cleanly.
      finishedRef.current = true;
    }
  }, []);

  const handleAutoplayConsumed = useCallback(() => {
    setAutoplayWanted(false);
  }, []);

  const loadQueue = useCallback((newQueue: Track[], startAt = 0) => {
    if (newQueue.length === 0) return;
    const start = Math.max(0, Math.min(startAt, newQueue.length - 1));
    finishedRef.current = false;
    setQueue(newQueue);
    setCurrentIndex(start);
    setLoopSingle(false);
    setAutoplayWanted(true);
  }, []);

  const togglePlay = useCallback(() => {
    if (queueRef.current.length === 0) return;

    // Queue ended — restart from index 0 instead of trying to play() a
    // player that's already parked at the last sentence's end.
    if (finishedRef.current) {
      finishedRef.current = false;
      if (indexRef.current === 0) {
        // Source URI is the same as the current player → no remount.
        // Just seek+play in place.
        const p = playerRef.current;
        if (!p) {
          setAutoplayWanted(true);
          return;
        }
        try {
          p.seekTo(0).catch(() => {});
          p.play();
        } catch {
          /* swallow */
        }
      } else {
        // Need to load index 0's source.
        setCurrentIndex(0);
        setAutoplayWanted(true);
      }
      return;
    }

    const p = playerRef.current;
    if (!p) return;
    try {
      if (p.playing) p.pause();
      else p.play();
    } catch {
      /* swallow */
    }
  }, []);

  const jumpTo = useCallback((index: number) => {
    if (index < 0 || index >= queueRef.current.length) return;
    finishedRef.current = false;
    if (index === indexRef.current) {
      // Same source — restart in place; no engine remount needed.
      const p = playerRef.current;
      if (!p) return;
      try {
        p.seekTo(0).catch(() => {});
        p.play();
      } catch {
        /* swallow */
      }
      return;
    }
    setCurrentIndex(index);
    setAutoplayWanted(true);
  }, []);

  const next = useCallback(() => {
    if (indexRef.current + 1 >= queueRef.current.length) return;
    finishedRef.current = false;
    setCurrentIndex(indexRef.current + 1);
    setAutoplayWanted(true);
  }, []);

  const prev = useCallback(() => {
    if (indexRef.current - 1 < 0) return;
    finishedRef.current = false;
    setCurrentIndex(indexRef.current - 1);
    setAutoplayWanted(true);
  }, []);

  const toggleLoopMode = useCallback(() => {
    setLoopSingle((v) => !v);
  }, []);

  const setSpeed = useCallback((s: PlaybackSpeed) => {
    setSpeedState(s);
  }, []);

  const stop = useCallback(() => {
    const p = playerRef.current;
    if (p) {
      try {
        p.pause();
      } catch {
        /* swallow */
      }
    }
    finishedRef.current = false;
    setQueue([]);
    setCurrentIndex(0);
    setLoopSingle(false);
    setAutoplayWanted(false);
    setIsPlaying(false);
    setIsLoaded(false);
  }, []);

  const currentUri = queue[currentIndex]?.audioUri ?? null;
  const current = queue[currentIndex] ?? null;

  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      isPlaying,
      isLoaded,
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
      isLoaded,
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
    <PlayerContext.Provider value={value}>
      {currentUri && (
        <AudioEngine
          // No `key` — we deliberately keep the same useAudioPlayer
          // instance for the lifetime of the queue and call
          // player.replace() to swap sources. Recreating the native
          // player on every sentence boundary races with expo-audio's
          // teardown on iOS 26 and gets stuck at isLoaded=false.
          uri={currentUri}
          autoplay={autoplayWanted}
          loop={loopSingle}
          speed={speed}
          onPlayerHandle={handlePlayerHandle}
          onStatus={handleStatus}
          onFinished={handleFinished}
          onAutoplayConsumed={handleAutoplayConsumed}
        />
      )}
      {children}
    </PlayerContext.Provider>
  );
}

interface AudioEngineProps {
  uri: string;
  autoplay: boolean;
  loop: boolean;
  speed: PlaybackSpeed;
  onPlayerHandle: (p: AudioPlayer | null) => void;
  onStatus: (s: { playing: boolean; isLoaded: boolean }) => void;
  onFinished: () => void;
  onAutoplayConsumed: () => void;
}

function AudioEngine({
  uri,
  autoplay,
  loop,
  speed,
  onPlayerHandle,
  onStatus,
  onFinished,
  onAutoplayConsumed,
}: AudioEngineProps) {
  // Pin useAudioPlayer's source to the FIRST uri ever passed in. We
  // ignore subsequent uri prop changes here on purpose — the native
  // player is reused, with `player.replace()` (below) swapping the
  // source. This avoids the iOS 26 teardown/init race that getting a
  // fresh useAudioPlayer per sentence triggers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialUri = useMemo(() => uri, []);
  const player = useAudioPlayer(initialUri);
  const status = useAudioPlayerStatus(player);

  // Source swap on uri prop change — single shared player, no remount.
  const currentSourceRef = useRef(initialUri);
  useEffect(() => {
    if (uri === currentSourceRef.current) return;
    currentSourceRef.current = uri;
    plog('replace', { uri: uri.slice(-40) });
    try {
      player.replace(uri);
    } catch (e) {
      plog('replace-throw', { msg: String(e) });
    }
  }, [uri, player]);

  // Publish/withdraw the imperative handle.
  useEffect(() => {
    onPlayerHandle(player);
    return () => onPlayerHandle(null);
  }, [player, onPlayerHandle]);

  // Mirror status into the Provider.
  useEffect(() => {
    onStatus({ playing: status.playing, isLoaded: status.isLoaded });
  }, [status.playing, status.isLoaded, onStatus]);

  // Re-apply loop + speed on every source swap — replace() resets
  // these on the native player. `uri` in the deps does that.
  useEffect(() => {
    try {
      player.loop = loop;
    } catch {
      /* swallow */
    }
  }, [player, loop, uri]);

  useEffect(() => {
    try {
      player.setPlaybackRate(speed);
    } catch {
      /* swallow */
    }
  }, [player, speed, uri]);

  // Autoplay once the new source is loaded.
  //
  // Critical: do NOT consume `autoplay` immediately after calling
  // play(). On iOS 26 the play() call can no-op silently if the audio
  // session is mid-transition between players (e.g. right after a
  // didJustFinish swap). We only consume the flag after status.playing
  // has actually flipped to true — so if the first attempt fails, the
  // effect will retry on the next status change.
  //
  // Belt-and-suspenders: if status doesn't change after play() (silent
  // failure with no signal), schedule a single retry 200ms later.
  useEffect(() => {
    if (!autoplay) return;
    if (!status.isLoaded) return;
    if (status.playing) {
      plog('autoplay-consume');
      onAutoplayConsumed();
      return;
    }
    plog('autoplay-call', { isLoaded: status.isLoaded });
    try {
      player.play();
    } catch (e) {
      plog('autoplay-call-throw', { msg: String(e) });
    }
    const retry = setTimeout(() => {
      plog('autoplay-retry');
      try {
        player.play();
      } catch {
        /* swallow */
      }
    }, 200);
    return () => clearTimeout(retry);
  }, [autoplay, status.isLoaded, status.playing, player, onAutoplayConsumed]);

  // didJustFinish edge — Provider decides what to do next.
  // didJustFinish stays true across multiple status snapshots, so latch it.
  const handledRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !handledRef.current) {
      handledRef.current = true;
      plog('didJustFinish');
      onFinished();
    } else if (!status.didJustFinish) {
      handledRef.current = false;
    }
  }, [status.didJustFinish, onFinished]);

  // Trace status transitions so we can see whether the new player ever
  // becomes loaded / playing for sentences that fail to advance.
  const lastStatusRef = useRef<{ isLoaded: boolean; playing: boolean }>({
    isLoaded: false,
    playing: false,
  });
  useEffect(() => {
    const prev = lastStatusRef.current;
    if (prev.isLoaded !== status.isLoaded || prev.playing !== status.playing) {
      plog('status', {
        isLoaded: status.isLoaded,
        playing: status.playing,
        uri: uri.slice(-40),
      });
      lastStatusRef.current = {
        isLoaded: status.isLoaded,
        playing: status.playing,
      };
    }
  }, [status.isLoaded, status.playing, uri]);

  return null;
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer must be used inside PlayerProvider');
  }
  return ctx;
}
