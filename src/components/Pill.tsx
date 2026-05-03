import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { colors, radius } from '../theme';

interface PillProps {
  label: string;
  active?: boolean;
  onPress?: () => void;
  variant?: 'filter' | 'chunk' | 'amberSoft';
  style?: ViewStyle;
}

export function Pill({
  label,
  active = false,
  onPress,
  variant = 'filter',
  style,
}: PillProps) {
  const palette = variantColors(variant, active);
  const Wrapper = onPress ? Pressable : View;
  return (
    <Wrapper
      onPress={onPress}
      style={({ pressed }: { pressed?: boolean } = {}) => [
        styles.base,
        { backgroundColor: palette.bg },
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      <Text style={[styles.label, { color: palette.text }]}>{label}</Text>
    </Wrapper>
  );
}

function variantColors(
  variant: 'filter' | 'chunk' | 'amberSoft',
  active: boolean
) {
  if (variant === 'chunk' || variant === 'amberSoft') {
    return { bg: colors.accentBgSoft, text: colors.accentText };
  }
  return active
    ? { bg: colors.textPrimary, text: colors.card }
    : { bg: colors.pillBg, text: colors.textSecondary };
}

const styles = StyleSheet.create({
  base: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
});
