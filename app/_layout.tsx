import * as Sentry from '@sentry/react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { AuthProvider, useAuth } from '../src/context/auth';
import { PlayerProvider } from '../src/context/player';

// Crash + error reporting. Only initializes when EXPO_PUBLIC_SENTRY_DSN
// is set, so dev / pre-Sentry-account builds skip it cleanly. Init at
// module load so it captures errors that happen during the very first
// render (e.g. SecureStore native module failing to link).
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: __DEV__ ? 'development' : 'production',
    // Lower trace sampling in production — we mainly care about
    // errors, not every span. Bump if you start using Sentry's
    // performance dashboards.
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
  });
}

function RootLayout() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <AuthProvider>
          <PlayerProvider>
            <RootStack />
            <StatusBar style="auto" />
          </PlayerProvider>
        </AuthProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
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
export default SENTRY_DSN ? Sentry.wrap(RootLayout) : RootLayout;
