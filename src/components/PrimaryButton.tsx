import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';
import { colors, radius } from '../theme';

interface PrimaryButtonProps {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  variant?: 'amber' | 'dark' | 'ghost';
  style?: ViewStyle;
  fullWidth?: boolean;
}

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  icon,
  variant = 'amber',
  style,
  fullWidth = false,
}: PrimaryButtonProps) {
  const palette = variantColors(variant);
  const inactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg },
        fullWidth && styles.fullWidth,
        pressed && !inactive && { opacity: 0.8 },
        inactive && { opacity: 0.5 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={18} color={palette.fg} />}
          <Text style={[styles.label, { color: palette.fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

function variantColors(variant: 'amber' | 'dark' | 'ghost') {
  switch (variant) {
    case 'amber':
      return { bg: colors.accent, fg: colors.textPrimary };
    case 'dark':
      return { bg: colors.textPrimary, fg: colors.card };
    case 'ghost':
      return { bg: colors.pillBg, fg: colors.textPrimary };
  }
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: radius.card,
    gap: 8,
  },
  fullWidth: {
    width: '100%',
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
});
