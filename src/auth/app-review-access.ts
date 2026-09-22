/**
 * Non-routable sentinel used only by Apple's dedicated review credential.
 * This identifier is intentionally public; the fixed code remains server-side
 * and the backend accepts this number only while review access is enabled.
 */
export const APP_REVIEW_PHONE = '10000000000';

export function isAcceptedPhoneInput(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone) || phone === APP_REVIEW_PHONE;
}
