/**
 * Auth API client. Talks to the Hono backend's /auth/* routes.
 *
 * Token storage and 401-retry logic live in src/api/backend.ts (the
 * shared `request` helper). This file is just typed thin wrappers.
 */
import { backendRequest } from './backend';

export interface AuthConsent {
  consent_version: string;
  consent_accepted_at: string;
}

export interface AuthUser {
  id: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  created_at: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

export interface AccountDeletionResult {
  message: string;
  code?:
    | 'APPLE_MANUAL_REVOKE_REQUIRED'
    | 'ACCOUNT_DELETION_PENDING'
    | 'LOCAL_CLEANUP_PENDING';
  apple_revocation?:
    | 'revoked'
    | 'not_applicable'
    | 'manual_required'
    | 'pending';
  manual_revoke_instructions?: string;
}

export interface AccountDeletionStatus {
  status: 'active' | 'deleting' | 'deleted';
  apple_revocation:
    | 'revoked'
    | 'not_applicable'
    | 'manual_required'
    | 'pending'
    | 'unknown';
  manual_revoke_instructions?: string;
}

export interface AccountDeletionReceipt {
  deletion_receipt: string;
  expires_at: string;
}

export const authApi = {
  /** Send both Apple credentials: identity token proves the user, while the
   *  one-use authorization code is exchanged server-side for a revocable
   *  refresh token. fullName is available on Apple's first login only. */
  appleLogin: (
    identity_token: string,
    authorization_code: string,
    full_name: { givenName?: string | null; familyName?: string | null } | null,
    consent: AuthConsent
  ): Promise<AuthSession> =>
    backendRequest('POST', '/auth/apple', {
      identity_token,
      authorization_code,
      full_name: full_name ?? null,
      ...consent,
    }, { withAuth: false }),

  sendCode: (phone: string): Promise<{ message: string }> =>
    backendRequest('POST', '/auth/send-code', { phone }, { withAuth: false }),

  verify: (
    phone: string,
    code: string,
    nickname: string | undefined,
    consent: AuthConsent
  ): Promise<AuthSession> =>
    backendRequest(
      'POST',
      '/auth/verify',
      { phone, code, nickname, ...consent },
      { withAuth: false }
    ),

  logout: (): Promise<{ message: string }> =>
    backendRequest('DELETE', '/auth/logout'),

  me: (): Promise<{ user: AuthUser }> =>
    backendRequest('GET', '/auth/me', undefined, { timeoutMs: 8_000 }),

  /** Soft-delete account on the server. Returns success even if local
   *  cleanup needs to follow (caller is responsible for clearing
   *  tokens via the AuthProvider). */
  deleteAccount: (): Promise<AccountDeletionResult> =>
    backendRequest('DELETE', '/auth/me'),

  /** Mint a purpose-bound receipt and persist it before sending DELETE. */
  deletionReceipt: (): Promise<AccountDeletionReceipt> =>
    backendRequest('POST', '/auth/deletion-receipt'),

  /** Reconcile a possibly lost DELETE response. The receipt is not an access
   * token and can only read deletion/revocation state. */
  deletionStatus: (
    receipt: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<AccountDeletionStatus> =>
    backendRequest('GET', '/auth/deletion-status', undefined, {
      withAuth: false,
      autoRefresh: false,
      timeoutMs: options.timeoutMs ?? 8_000,
      signal: options.signal,
      authorizationToken: receipt,
    }),

  /** Update mutable profile fields. Today only nickname; the backend's
   *  /auth/me PATCH allowlist will grow as we add more. */
  updateProfile: (patch: { nickname?: string }): Promise<{ user: AuthUser }> =>
    backendRequest('PATCH', '/auth/me', patch),
};
