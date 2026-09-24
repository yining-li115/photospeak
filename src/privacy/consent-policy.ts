export const CURRENT_POLICY_VERSION = '2026-09-22.1';

export interface ConsentReceipt {
  version: string;
  acceptedAt: string;
}

export function isCurrentConsentReceipt(
  value: Partial<ConsentReceipt> | null | undefined
): value is ConsentReceipt {
  return (
    value?.version === CURRENT_POLICY_VERSION &&
    typeof value.acceptedAt === 'string' &&
    !Number.isNaN(Date.parse(value.acceptedAt))
  );
}

export function requireCurrentConsentReceipt(
  value: ConsentReceipt | null
): ConsentReceipt {
  if (!isCurrentConsentReceipt(value)) {
    throw new Error('请先阅读并同意当前用户协议与隐私政策');
  }
  return value;
}
