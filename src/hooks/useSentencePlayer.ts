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
  toggleLoopMode: () => void;
  next: () => void;
  prev: () => void;
  playFrom: (index: number) => void;
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
        // expo-audio loads the new source on the next tick — calling
        // play() immediately races the load and silently drops the start.
        setTimeout(() => {
          try {
            player.play();
          } catch {
            /* player may be torn down during navigation */
          }
        }, 80);
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
    (index: number) => {
      if (index < 0 || index >= uris.length) return;
      handledFinishRef.current = false;
      setCurrentIndex(index);
      player.replace(uris[index]);
      // Same race as the auto-advance path — let the native source attach.
      setTimeout(() => {
        try {
          player.seekTo(0).catch(() => {});
          player.play();
        } catch {
          /* swallow */
        }
      }, 80);
    },
    [player, uris]
  );

  const next = useCallback(() => {
    if (currentIndex + 1 >= uris.length) return;
    playFrom(currentIndex + 1);
  }, [currentIndex, uris.length, playFrom]);

  const prev = useCallback(() => {
    if (currentIndex - 1 < 0) return;
    playFrom(currentIndex - 1);
  }, [currentIndex, playFrom]);

  const toggleLoopMode = useCallback(() => {
    setLoopSingle((v) => !v);
  }, []);

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
    toggleLoopMode,
    next,
    prev,
    playFrom,
    setSpeed,
  };
}
