import * as SecureStore from 'expo-secure-store';

const DIAGNOSTICS_PREFERENCE_KEY = 'privacy_diagnostics_enabled_v1';

// Fail closed until the durable preference has been read. This value is used
// synchronously by Sentry's beforeSend/tracesSampler callbacks.
let diagnosticsEnabled = false;

export function isDiagnosticsEnabled(): boolean {
  return diagnosticsEnabled;
}

export async function loadDiagnosticsPreference(
  defaultEnabledAfterConsent: boolean
): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(DIAGNOSTICS_PREFERENCE_KEY);
    diagnosticsEnabled =
      stored === null ? defaultEnabledAfterConsent : stored === 'true';
  } catch {
    diagnosticsEnabled = false;
  }
  return diagnosticsEnabled;
}

export async function setDiagnosticsEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(
    DIAGNOSTICS_PREFERENCE_KEY,
    enabled ? 'true' : 'false'
  );
  diagnosticsEnabled = enabled;
}
