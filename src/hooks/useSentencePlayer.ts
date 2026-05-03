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

  // Always-fresh refs so the didJustFinish effect can avoid noisy deps.
  const indexRef = useRef(currentIndex);
  const loopRef = useRef(loopSingle);
  const urisRef = useRef(uris);
  useEffect(() => {
    indexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    loopRef.current = loopSingle;
  }, [loopSingle]);
  useEffect(() => {
    urisRef.current = uris;
  }, [uris]);

  // iOS: still play in silent mode.
  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
    }).catch(() => {});
  }, []);

  // Hand single-sentence looping to the native player so we don't have to
  // race didJustFinish against playFrom.
  useEffect(() => {
    if (!player) return;
    player.loop = loopSingle;
  }, [player, loopSingle]);

  // Keep playback rate in sync.
  useEffect(() => {
    if (player) player.setPlaybackRate(speed);
  }, [player, speed]);

  // Auto-advance to the next sentence when the current one finishes.
  // didJustFinish stays `true` for multiple status snapshots, so we use
  // a ref to advance exactly once per finish event.
  const handledFinishRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !handledFinishRef.current) {
      handledFinishRef.current = true;
      // If loopSingle is on, native loop already replays — don't advance.
      if (loopRef.current) return;
      const nextIdx = indexRef.current + 1;
      const list = urisRef.current;
      if (nextIdx < list.length) {
        setCurrentIndex(nextIdx);
        player.replace(list[nextIdx]);
        player.play();
      }
    } else if (!status.didJustFinish) {
      // Reset latch once we're playing again or fully stopped.
      handledFinishRef.current = false;
    }
  }, [status.didJustFinish, player]);

  const togglePlay = useCallback(() => {
    if (status.playing) player.pause();
    else player.play();
  }, [player, status.playing]);

  const playFrom = useCallback(
    (index: number, opts?: { loop?: boolean }) => {
      if (index < 0 || index >= uris.length) return;
      handledFinishRef.current = false;
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
