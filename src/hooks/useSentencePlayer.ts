import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

export type PlaybackSpeed = 0.75 | 1 | 1.25;

export interface UseSentencePlayer {
  currentIndex: number;
  isPlaying: boolean;
  isLoaded: boolean;
  loopSingle: boolean;
  speed: PlaybackSpeed;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  playFrom: (index: number, opts?: { loop?: boolean }) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
}

export function useSentencePlayer(uris: string[]): UseSentencePlayer {
  const initial = uris[0] ?? null;
  const player = useAudioPlayer(initial);
  const status = useAudioPlayerStatus(player);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [loopSingle, setLoopSingle] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);

  // Configure session for playback (silent-mode + background hint).
  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
    }).catch(() => {});
  }, []);

  // Apply speed to current player whenever it (or speed) changes.
  useEffect(() => {
    if (player) player.setPlaybackRate(speed);
  }, [player, speed]);

  // didJustFinish edge: advance to next or loop the same sentence.
  const lastFinishedAt = useRef<number>(0);
  useEffect(() => {
    if (!status.didJustFinish) return;
    // didJustFinish can fire repeatedly per render — debounce by render tick.
    const stamp = Date.now();
    if (stamp - lastFinishedAt.current < 100) return;
    lastFinishedAt.current = stamp;

    if (loopSingle) {
      player.seekTo(0).then(() => player.play()).catch(() => {});
      return;
    }
    if (currentIndex + 1 < uris.length) {
      const next = currentIndex + 1;
      setCurrentIndex(next);
      player.replace(uris[next]);
      player.play();
    }
    // else: end of podcast — leave paused
  }, [status.didJustFinish, loopSingle, currentIndex, uris, player]);

  const togglePlay = useCallback(() => {
    if (status.playing) player.pause();
    else player.play();
  }, [player, status.playing]);

  const playFrom = useCallback(
    (index: number, opts?: { loop?: boolean }) => {
      if (index < 0 || index >= uris.length) return;
      setLoopSingle(opts?.loop ?? false);
      setCurrentIndex(index);
      player.replace(uris[index]);
      player.seekTo(0).catch(() => {});
      player.play();
    },
    [player, uris]
  );

  const next = useCallback(() => {
    if (currentIndex + 1 >= uris.length) return;
    playFrom(currentIndex + 1, { loop: false });
  }, [currentIndex, uris.length, playFrom]);

  const prev = useCallback(() => {
    if (currentIndex - 1 < 0) return;
    playFrom(currentIndex - 1, { loop: false });
  }, [currentIndex, playFrom]);

  const setSpeed = useCallback((s: PlaybackSpeed) => {
    setSpeedState(s);
  }, []);

  return {
    currentIndex,
    isPlaying: status.playing,
    isLoaded: status.isLoaded,
    loopSingle,
    speed,
    togglePlay,
    next,
    prev,
    playFrom,
    setSpeed,
  };
}
