import { StyleSheet, View, type ViewProps } from 'react-native';
import { colors, radius, shadow, spacing } from '../theme';

interface CardProps extends ViewProps {
  padding?: keyof typeof spacing | number;
}

export function Card({ style, padding = 'lg', children, ...rest }: CardProps) {
  const pad = typeof padding === 'number' ? padding : spacing[padding];
  return (
    <View style={[styles.card, { padding: pad }, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    ...shadow,
  },
});
