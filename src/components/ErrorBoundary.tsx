/**
 * Top-level React error boundary. A React render-time exception
 * normally leaves the screen frozen on the last good frame; without
 * this, users see a "stuck" UI with no way out. We catch and show a
 * minimal recovery screen.
 */
import { Component, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, text } from '../theme';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string }) {
    // If Sentry is configured at the app root it will pick this up
    // automatically via the beforeSend hook; we still log here so dev
    // build users see it in Metro console too.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, errorInfo.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.subtitle}>
              The app hit an unexpected error. Tap below to try again — your
              data is still saved.
            </Text>
            <View style={styles.errorBox}>
              <Text style={styles.errorMessage} selectable>
                {this.state.error.message}
              </Text>
              {__DEV__ && this.state.error.stack && (
                <Text style={styles.errorStack} selectable>
                  {this.state.error.stack.split('\n').slice(0, 8).join('\n')}
                </Text>
              )}
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.button,
                pressed && { opacity: 0.85 },
              ]}
              onPress={this.reset}
            >
              <Text style={styles.buttonText}>Try Again</Text>
            </Pressable>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    gap: spacing.lg,
  },
  title: {
    ...text.greeting,
    textAlign: 'center',
  },
  subtitle: {
    ...text.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  errorBox: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  errorMessage: {
    ...text.body,
    color: colors.rating.againText,
  },
  errorStack: {
    fontSize: 11,
    color: colors.textTertiary,
    fontFamily: 'Menlo',
  },
  button: {
    backgroundColor: colors.textPrimary,
    borderRadius: radius.pill,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: colors.card,
    fontSize: 15,
    fontWeight: '700',
  },
});
