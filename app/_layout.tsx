import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import TrackPlayer from 'react-native-track-player';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { AccountRuntimeEffects } from '../src/components/AccountRuntimeEffects';
import { AuthProvider, useAuth } from '../src/context/auth';
import { PlayerProvider } from '../src/context/player';
import { initializeSentryIfEnabled } from '../src/monitoring/sentry';
import { readCurrentConsent } from '../src/privacy/consent';
import { loadDiagnosticsPreference } from '../src/privacy/diagnostics';
import { playbackService } from '../src/services/playback-service';

// Register the rntp background service at module load — must happen
// before any TrackPlayer command is issued and outside any React
// component tree (the service runs in a separate JS context).
TrackPlayer.registerPlaybackService(() => playbackService);

function RootLayout() {
  const [dataRevision, setDataRevision] = useState(0);
  const handleLegacyDataImported = useCallback(
    () => setDataRevision((value) => value + 1),
    []
  );

  useEffect(() => {
    // Diagnostics are a separate, optional preference. Accepting the privacy
    // policy is necessary for sign-in, but must not silently opt a new device
    // into analytics or crash reporting.
    void readCurrentConsent()
      .then((consent) =>
        consent ? loadDiagnosticsPreference(false) : false
      )
      .then((enabled) => {
        if (enabled) initializeSentryIfEnabled();
      })
      .catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <AuthProvider>
          <AccountScopedRuntime
            dataRevision={dataRevision}
            onLegacyDataImported={handleLegacyDataImported}
          />
        </AuthProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

function AccountScopedRuntime({
  dataRevision,
  onLegacyDataImported,
}: {
  dataRevision: number;
  onLegacyDataImported: () => void;
}) {
  const { user } = useAuth();
  return (
    <PlayerProvider
      key={user?.id ?? 'signed-out'}
      ownerId={user?.id ?? null}
    >
      <AccountRuntimeEffects onLegacyDataImported={onLegacyDataImported} />
      <RootStack key={dataRevision} />
      <StatusBar style="auto" />
    </PlayerProvider>
  );
}

/**
 * While AuthProvider is checking SecureStore on launch, return null —
 * iOS keeps showing the native splash until we render something. This
 * is more graceful than a spinner overlay (which would dismiss the
 * splash immediately and leave the user staring at our spinner if
 * the network is slow).
 *
 * Auth gating itself is declarative, done per-group in the
 * (auth)/_layout and (tabs)/_layout files via <Redirect>. There's no
 * imperative router.replace inside a useEffect anymore, so there's no
 * race window where a route mounts before the redirect fires.
 */
function RootStack() {
  const { loading } = useAuth();
  if (loading) return null;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="(auth)" />
    </Stack>
  );
}

// Wrap the root in Sentry's ErrorBoundary HOC when initialized so
// uncaught render errors flow up to the dashboard. Falls through
// transparently in dev / no-DSN setups.
export default RootLayout;
