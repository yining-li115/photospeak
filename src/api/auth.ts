/**
 * Auth API client. Talks to the Hono backend's /auth/* routes.
 *
 * Token storage and 401-retry logic live in src/api/backend.ts (the
 * shared `request` helper). This file is just typed thin wrappers.
 */
import { backendRequest } from './backend';

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

export const authApi = {
  /** Send identityToken from `expo-apple-authentication`. fullName is
   *  Apple's first-login-only name dictionary (or null on subsequent
   *  logins); we forward it so the backend can pre-fill nickname. */
  appleLogin: (
    identity_token: string,
    full_name?: { givenName?: string | null; familyName?: string | null } | null
  ): Promise<AuthSession> =>
    backendRequest('POST', '/auth/apple', {
      identity_token,
      full_name: full_name ?? null,
    }, { withAuth: false }),

  sendCode: (phone: string): Promise<{ message: string }> =>
    backendRequest('POST', '/auth/send-code', { phone }, { withAuth: false }),

  verify: (
    phone: string,
    code: string,
    nickname?: string
  ): Promise<AuthSession> =>
    backendRequest(
      'POST',
      '/auth/verify',
      { phone, code, nickname },
      { withAuth: false }
    ),

  logout: (refresh_token: string): Promise<{ message: string }> =>
    backendRequest('DELETE', '/auth/logout', { refresh_token }),

  me: (): Promise<{ user: AuthUser }> => backendRequest('GET', '/auth/me'),

  /** Soft-delete account on the server. Returns success even if local
   *  cleanup needs to follow (caller is responsible for clearing
   *  tokens via the AuthProvider). */
  deleteAccount: (): Promise<{ message: string }> =>
    backendRequest('DELETE', '/auth/me'),

  /** Update mutable profile fields. Today only nickname; the backend's
   *  /auth/me PATCH allowlist will grow as we add more. */
  updateProfile: (patch: { nickname?: string }): Promise<{ user: AuthUser }> =>
    backendRequest('PATCH', '/auth/me', patch),
};

