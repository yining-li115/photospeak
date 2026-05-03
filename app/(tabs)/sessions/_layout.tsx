import { Stack } from 'expo-router';
import { colors } from '../../../src/theme';

export default function SessionsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
        headerTitleStyle: {
          fontSize: 17,
          fontWeight: '700',
          color: colors.textPrimary,
        },
        headerTintColor: colors.accent,
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
