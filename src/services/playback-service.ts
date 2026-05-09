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

export const playbackService = async (): Promise<void> => {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    TrackPlayer.play().catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemotePause, () => {
    TrackPlayer.pause().catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    TrackPlayer.skipToNext().catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    TrackPlayer.skipToPrevious().catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    TrackPlayer.reset().catch(() => {});
  });
};
