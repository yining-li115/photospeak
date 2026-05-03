import { StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../theme';

interface ScreenProps extends ViewProps {
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  /** Skip SafeArea (use when nested under a header that already handles it). */
  flat?: boolean;
}

export function Screen({
  style,
  children,
  edges = ['top'],
  flat = false,
  ...rest
}: ScreenProps) {
  if (flat) {
    return (
      <View style={[styles.bg, style]} {...rest}>
        {children}
      </View>
    );
  }
  return (
    <SafeAreaView style={[styles.bg, style]} edges={edges} {...rest}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
