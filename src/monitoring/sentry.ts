import * as Sentry from '@sentry/react-native';
import { isDiagnosticsEnabled } from '../privacy/diagnostics';

let initialized = false;

/** Initialize network diagnostics only after consent + the durable opt-out. */
export function initializeSentryIfEnabled(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (initialized || !dsn || !isDiagnosticsEnabled()) return;
  Sentry.init({
    dsn,
    environment: __DEV__ ? 'development' : 'production',
    sendDefaultPii: false,
    tracesSampler: () =>
      isDiagnosticsEnabled() ? (__DEV__ ? 1.0 : 0.05) : 0,
    beforeSendTransaction(event) {
      return isDiagnosticsEnabled() ? event : null;
    },
    beforeSend(event) {
      if (!isDiagnosticsEnabled()) return null;
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
      }
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : undefined;
      }
      event.breadcrumbs = event.breadcrumbs?.map((breadcrumb) => ({
        ...breadcrumb,
        data: undefined,
        message:
          breadcrumb.category === 'console'
            ? undefined
            : redactSensitiveText(breadcrumb.message),
      }));
      for (const value of event.exception?.values ?? []) {
        value.value = redactSensitiveText(value.value);
      }
      return event;
    },
  });
  initialized = true;
}

export async function shutdownSentry(): Promise<void> {
  if (!initialized) return;
  // A zero timeout disables transport without waiting to flush queued events
  // after the user has opted out.
  try {
    await Sentry.getClient()?.close(0);
  } catch {
    // Preference already fails closed in beforeSend/tracesSampler.
  }
  initialized = false;
}

function redactSensitiveText(value?: string): string | undefined {
  if (!value) return value;
  return value
    .replace(
      /data:(?:image|audio)\/[^;]+;base64,[a-z0-9+/=]+/gi,
      '[media redacted]'
    )
    .replace(
      /(?:Full response|--- raw ---|Got:)[\s\S]*/gi,
      '[provider payload redacted]'
    );
}
