import { backendRequest } from './backend';

export const PLUS_MONTHLY_PRODUCT_ID =
  'com.yining.photospeak.plus.monthly';
export const PLUS_ANNUAL_PRODUCT_ID =
  'com.yining.photospeak.plus.annual';
export const PLUS_PRODUCT_IDS = [
  PLUS_MONTHLY_PRODUCT_ID,
  PLUS_ANNUAL_PRODUCT_ID,
] as const;

export interface SubscriptionState {
  plan: 'free' | 'plus';
  status: string;
  productId: string | null;
  currentPeriodEnd: string | null;
  usage: {
    periodMonth: string;
    completedSessions: number;
    sessionLimit: number;
  };
}

export const subscriptionsApi = {
  status: () => backendRequest<SubscriptionState>('GET', '/subscriptions/me'),

  verifyAppleTransaction: (signedTransaction: string) =>
    backendRequest<SubscriptionState>(
      'POST',
      '/subscriptions/apple/transactions',
      { signed_transaction: signedTransaction },
      { timeoutMs: 30_000 }
    ),
};
