import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider, useAuth } from '../src/context/auth';
import { PlayerProvider } from '../src/context/player';
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <PlayerProvider>
          <AuthGate>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="(auth)" />
            </Stack>
          </AuthGate>
          <StatusBar style="auto" />
        </PlayerProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Watches auth state + current route segment and redirects whenever
 * there's a mismatch:
 *   - logged out user inside (tabs)  → push to (auth)/welcome
 *   - logged in  user inside (auth)  → push to (tabs)
 *
 * While the AuthProvider is still checking SecureStore on app launch,
 * shows a centered spinner so we don't flash the welcome screen for
 * users who actually have a valid session.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    // Expo Router types haven't picked up `(auth)` yet — they
    // regenerate on metro startup. Keep this string-typed.
    const inAuthGroup = (segments[0] as string) === '(auth)';
    if (!user && !inAuthGroup) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.replace('/(auth)/welcome' as any);
    } else if (user && inAuthGroup) {
      router.replace('/(tabs)/sessions');
    }
  }, [user, loading, segments, router]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.bg,
        }}
      >
        <ActivityIndicator color={colors.textTertiary} />
      </View>
    );
  }

  return <>{children}</>;
}
