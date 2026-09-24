import * as SecureStore from 'expo-secure-store';

import {
  CURRENT_POLICY_VERSION,
  isCurrentConsentReceipt,
  type ConsentReceipt,
} from './consent-policy';

export {
  CURRENT_POLICY_VERSION,
  isCurrentConsentReceipt,
  requireCurrentConsentReceipt,
} from './consent-policy';
export type { ConsentReceipt } from './consent-policy';

const CONSENT_KEY = 'privacy_consent_receipt';

export async function readCurrentConsent(): Promise<ConsentReceipt | null> {
  try {
    const raw = await SecureStore.getItemAsync(CONSENT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ConsentReceipt>;
    if (!isCurrentConsentReceipt(value)) return null;
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
