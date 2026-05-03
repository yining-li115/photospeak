import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
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
  const [shouldAutoPlay, setShouldAutoPlay] = useState(false);

  // The player is recreated every time the source URI changes. This avoids
  // the "useAudioPlayer(null) + later replace()" path which leaves the
  // native player in an isLoaded=false / duration=NaN state on iOS.
  const currentUri = queue[currentIndex]?.audioUri ?? null;
  const player = useAudioPlayer(currentUri);
  const status = useAudioPlayerStatus(player);

  const queueRef = useRef(queue);
  const indexRef = useRef(currentIndex);
  const loopRef = useRef(loopSingle);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    indexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    loopRef.current = loopSingle;
  }, [loopSingle]);

  // Audio session: silent-mode play; background play in a separate call so
  // its native-config dependency can fail without taking down the basics.
  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
    }).catch(() => {});
    setAudioModeAsync({ shouldPlayInBackground: true }).catch(() => {});
  }, []);

  // Apply current playback rate + loop flag to whichever player instance
  // is alive right now (these props don't survive recreation).
  useEffect(() => {
    if (!player) return;
    try {
      player.setPlaybackRate(speed);
    } catch {
      /* swallow */
    }
  }, [player, speed]);

  useEffect(() => {
    if (!player) return;
    try {
      player.loop = loopSingle;
    } catch {
      /* swallow */
    }
  }, [player, loopSingle]);

  // When a freshly-created player finishes loading, kick off playback if
  // we asked for it (loadQueue / next / prev / jumpTo set this flag).
  useEffect(() => {
    if (!shouldAutoPlay) return;
    if (!status.isLoaded) return;
    setShouldAutoPlay(false);
    try {
      player.play();
    } catch {
      /* swallow */
    }
  }, [shouldAutoPlay, status.isLoaded, player]);

  // Auto-advance on finish (debounced via ref since didJustFinish stays
  // true across multiple status snapshots).
  const handledFinishRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !handledFinishRef.current) {
      handledFinishRef.current = true;
      if (loopRef.current) return; // single-loop is handled by player.loop
      const nextIdx = indexRef.current + 1;
      if (nextIdx < queueRef.current.length) {
        setCurrentIndex(nextIdx);
        setShouldAutoPlay(true);
      }
    } else if (!status.didJustFinish) {
      handledFinishRef.current = false;
    }
  }, [status.didJustFinish]);

  const loadQueue = useCallback((newQueue: Track[], startAt = 0) => {
    if (newQueue.length === 0) return;
    const start = Math.max(0, Math.min(startAt, newQueue.length - 1));
    handledFinishRef.current = false;
    setQueue(newQueue);
    setCurrentIndex(start);
    setLoopSingle(false);
    setShouldAutoPlay(true);
  }, []);

  const togglePlay = useCallback(() => {
    if (queue.length === 0) return;
    try {
      if (status.playing) player.pause();
      else player.play();
    } catch {
      /* swallow */
    }
  }, [player, status.playing, queue.length]);

  const jumpTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= queue.length) return;
      handledFinishRef.current = false;
      if (index === currentIndex) {
        // Same track — just restart it.
        try {
          player.seekTo(0).catch(() => {});
          player.play();
        } catch {
          /* swallow */
        }
        return;
      }
      setCurrentIndex(index);
      setShouldAutoPlay(true);
    },
    [queue.length, currentIndex, player]
  );

  const next = useCallback(() => {
    if (currentIndex + 1 >= queue.length) return;
    setCurrentIndex(currentIndex + 1);
    setShouldAutoPlay(true);
  }, [currentIndex, queue.length]);

  const prev = useCallback(() => {
    if (currentIndex - 1 < 0) return;
    setCurrentIndex(currentIndex - 1);
    setShouldAutoPlay(true);
  }, [currentIndex]);

  const toggleLoopMode = useCallback(() => {
    setLoopSingle((v) => !v);
  }, []);

  const setSpeed = useCallback((s: PlaybackSpeed) => {
    setSpeedState(s);
  }, []);

  const stop = useCallback(() => {
    try {
      player.pause();
    } catch {
      /* swallow */
    }
    setQueue([]);
    setCurrentIndex(0);
    setLoopSingle(false);
    setShouldAutoPlay(false);
  }, [player]);

  const current = queue[currentIndex] ?? null;

  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      isPlaying: status.playing,
      isLoaded: status.isLoaded,
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
      status.playing,
      status.isLoaded,
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
