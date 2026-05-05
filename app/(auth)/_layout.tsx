import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/context/auth';

export default function AuthLayout() {
  // If the user is already logged in (e.g. has a refresh token in
  // SecureStore on relaunch), don't even render the auth screens —
  // bounce them straight to the main app. This is the inverse of
  // what (tabs)/_layout does for unauthed users.
  const { user } = useAuth();
  if (user) {
    return <Redirect href="/(tabs)/sessions" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
