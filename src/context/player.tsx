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
  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);

  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loopSingle, setLoopSingle] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);

  const indexRef = useRef(currentIndex);
  const loopRef = useRef(loopSingle);
  const queueRef = useRef(queue);
  useEffect(() => {
    indexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    loopRef.current = loopSingle;
  }, [loopSingle]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Configure background audio + silent-mode playback once.
  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    }).catch(() => {});
  }, []);

  // Native loop reflects mode.
  useEffect(() => {
    if (player) player.loop = loopSingle;
  }, [player, loopSingle]);

  // Keep playback rate in sync.
  useEffect(() => {
    if (player) player.setPlaybackRate(speed);
  }, [player, speed]);

  // Auto-advance on finish (debounced via ref since didJustFinish stays true
  // across multiple status snapshots).
  const handledFinishRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !handledFinishRef.current) {
      handledFinishRef.current = true;
      if (loopRef.current) return;
      const nextIdx = indexRef.current + 1;
      const list = queueRef.current;
      if (nextIdx < list.length) {
        setCurrentIndex(nextIdx);
        player.replace(list[nextIdx].audioUri);
        setTimeout(() => {
          try {
            player.play();
          } catch {
            /* player torn down */
          }
        }, 80);
      }
    } else if (!status.didJustFinish) {
      handledFinishRef.current = false;
    }
  }, [status.didJustFinish, player]);

  const loadQueue = useCallback(
    (newQueue: Track[], startAt = 0) => {
      if (newQueue.length === 0) return;
      const start = Math.max(0, Math.min(startAt, newQueue.length - 1));
      handledFinishRef.current = false;
      setQueue(newQueue);
      setCurrentIndex(start);
      setLoopSingle(false);
      player.replace(newQueue[start].audioUri);
      setTimeout(() => {
        try {
          player.seekTo(0).catch(() => {});
          player.play();
        } catch {
          /* swallow */
        }
      }, 80);
    },
    [player]
  );

  const togglePlay = useCallback(() => {
    if (queue.length === 0) return;
    if (status.playing) player.pause();
    else player.play();
  }, [player, status.playing, queue.length]);

  const jumpTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= queue.length) return;
      handledFinishRef.current = false;
      setCurrentIndex(index);
      player.replace(queue[index].audioUri);
      setTimeout(() => {
        try {
          player.seekTo(0).catch(() => {});
          player.play();
        } catch {
          /* swallow */
        }
      }, 80);
    },
    [player, queue]
  );

  const next = useCallback(() => {
    if (currentIndex + 1 >= queue.length) return;
    jumpTo(currentIndex + 1);
  }, [currentIndex, queue.length, jumpTo]);

  const prev = useCallback(() => {
    if (currentIndex - 1 < 0) return;
    jumpTo(currentIndex - 1);
  }, [currentIndex, jumpTo]);

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
