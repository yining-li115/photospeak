import * as SecureStore from 'expo-secure-store';

export const CURRENT_POLICY_VERSION = '2026-09-22.1';
const CONSENT_KEY = 'privacy_consent_receipt';

export interface ConsentReceipt {
  version: string;
  acceptedAt: string;
}

export async function readCurrentConsent(): Promise<ConsentReceipt | null> {
  try {
    const raw = await SecureStore.getItemAsync(CONSENT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ConsentReceipt>;
    if (
      value.version !== CURRENT_POLICY_VERSION ||
      typeof value.acceptedAt !== 'string' ||
      Number.isNaN(Date.parse(value.acceptedAt))
    ) {
      return null;
    }
    return { version: value.version, acceptedAt: value.acceptedAt };
  } catch {
    return null;
  }
}

export async function recordCurrentConsent(): Promise<ConsentReceipt> {
  const receipt: ConsentReceipt = {
    version: CURRENT_POLICY_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(CONSENT_KEY, JSON.stringify(receipt));
  return receipt;
}

export async function clearConsentReceipt(): Promise<void> {
  await SecureStore.deleteItemAsync(CONSENT_KEY).catch(() => {});
}
