/**
 * react-native-track-player background service.
 *
 * Registered once at app launch (see app/_layout.tsx). Receives remote
 * playback events from iOS Control Center / lock screen / Bluetooth
 * controls and proxies them to TrackPlayer commands.
 *
 * Must NOT touch React state — runs in a separate JS context outside
 * of any component tree.
 */
import TrackPlayer, { Event } from 'react-native-track-player';
import {
  isRemotePlaybackEnabled,
  setRemotePlaybackEnabled,
} from '../audio/playback-gate';

async function runIfRemotePlaybackEnabled(
  operation: () => Promise<unknown>
): Promise<void> {
  if (!(await isRemotePlaybackEnabled())) return;
  await operation();
}

export const playbackService = async (): Promise<void> => {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    runIfRemotePlaybackEnabled(() => TrackPlayer.play()).catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemotePause, () => {
    // Pausing is always safe, including while an account transition is
    // disabling the durable remote-control gate.
    TrackPlayer.pause().catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    runIfRemotePlaybackEnabled(() => TrackPlayer.skipToNext()).catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    runIfRemotePlaybackEnabled(() =>
      TrackPlayer.skipToPrevious()
    ).catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    void (async () => {
      try {
        await setRemotePlaybackEnabled(false);
      } finally {
        await TrackPlayer.reset().catch(() => {});
      }
    })();
  });
};
