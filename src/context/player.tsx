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
    if (next < queueRef.current.length) {
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
          // key forces a fresh useAudioPlayer instance whenever the source
          // URI changes. Critical: the hook MUST be created with a valid
          // string source — passing null and relying on .replace() leaves
          // the native player stuck at isLoaded=false on iOS.
          key={currentUri}
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
  // Constructed with a real URI — the native player initializes correctly.
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);

  // Publish/withdraw the imperative handle.
  useEffect(() => {
    onPlayerHandle(player);
    return () => onPlayerHandle(null);
  }, [player, onPlayerHandle]);

  // Mirror status into the Provider.
  useEffect(() => {
    onStatus({ playing: status.playing, isLoaded: status.isLoaded });
  }, [status.playing, status.isLoaded, onStatus]);

  // Re-apply loop + speed; these don't survive player recreation.
  useEffect(() => {
    try {
      player.loop = loop;
    } catch {
      /* swallow */
    }
  }, [player, loop]);

  useEffect(() => {
    try {
      player.setPlaybackRate(speed);
    } catch {
      /* swallow */
    }
  }, [player, speed]);

  // Autoplay once the new source is loaded.
  useEffect(() => {
    if (!autoplay) return;
    if (!status.isLoaded) return;
    try {
      player.play();
    } catch {
      /* swallow */
    }
    onAutoplayConsumed();
  }, [autoplay, status.isLoaded, player, onAutoplayConsumed]);

  // didJustFinish edge — Provider decides what to do next.
  // didJustFinish stays true across multiple status snapshots, so latch it.
  const handledRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !handledRef.current) {
      handledRef.current = true;
      onFinished();
    } else if (!status.didJustFinish) {
      handledRef.current = false;
    }
  }, [status.didJustFinish, onFinished]);

  return null;
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer must be used inside PlayerProvider');
  }
  return ctx;
}
