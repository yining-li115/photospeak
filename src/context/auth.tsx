/**
 * AuthProvider — single source of truth for "am I logged in?".
 *
 * Stores access + refresh tokens in expo-secure-store via the helpers
 * in src/api/backend.ts. On mount, checks for an existing token and
 * (if present) fetches /auth/me to verify it still works.
 *
 * Render gating happens in app/_layout.tsx: while `loading`, we don't
 * route anywhere; once `loading` is false, we show /(auth) or /(tabs).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { authApi, type AuthUser } from '../api/auth';
import {
  clearSessionTokens,
  getRefreshToken,
  setSessionTokens,
} from '../api/backend';

interface AuthState {
  /** False while we're checking SecureStore on app launch. UI should
   *  show a splash or nothing during this window. */
  loading: boolean;
  /** Null when logged out; populated after successful login or
   *  after launch-time token validation. */
  user: AuthUser | null;
  loginWithApple: (
    identityToken: string,
    fullName?: { givenName?: string | null; familyName?: string | null } | null
  ) => Promise<void>;
  loginWithPhone: (
    phone: string,
    code: string,
    nickname?: string
  ) => Promise<void>;
  logout: () => Promise<void>;
  /** Soft-delete the account server-side, then locally log out. */
  deleteAccount: () => Promise<void>;
  /** Patch profile fields server-side and update the cached user. */
  updateProfile: (patch: { nickname?: string }) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Boot: do we have a stored token? If yes, hit /auth/me to confirm
  // it still works. If /me returns 401, backendRequest already wiped
  // the tokens; we just stay logged out.
  //
  // Watchdog: if SecureStore or /auth/me hangs (e.g. a TestFlight
  // build with a wrong entitlement, or the backend domain unreachable
  // from the user's network), force loading=false after 5s so the
  // user lands on the welcome screen instead of staring at a spinner
  // forever. They can still log in and use the app from there.
  useEffect(() => {
    let cancelled = false;
    const watchdog = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 5000);

    (async () => {
      try {
        const refresh = await getRefreshToken();
        if (!refresh) return;
        const { user } = await authApi.me();
        if (!cancelled) setUser(user);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) {
          clearTimeout(watchdog);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
    };
  }, []);

  const loginWithApple = useCallback(
    async (
      identityToken: string,
      fullName?:
        | { givenName?: string | null; familyName?: string | null }
        | null
    ) => {
      const session = await authApi.appleLogin(identityToken, fullName);
      await setSessionTokens(session.access_token, session.refresh_token);
      setUser(session.user);
    },
    []
  );

  const loginWithPhone = useCallback(
    async (phone: string, code: string, nickname?: string) => {
      const session = await authApi.verify(phone, code, nickname);
      await setSessionTokens(session.access_token, session.refresh_token);
      setUser(session.user);
    },
    []
  );

  const logout = useCallback(async () => {
    const refresh = await getRefreshToken();
    if (refresh) {
      try {
        await authApi.logout(refresh);
      } catch {
        // Network failure shouldn't block local logout. Worst case the
        // backend still has a row; refresh token will eventually expire.
      }
    }
    await clearSessionTokens();
    setUser(null);
  }, []);

  const deleteAccount = useCallback(async () => {
    // Server marks deleted_at + revokes refresh tokens. We still need
    // to wipe local tokens & cached user state to bounce back to the
    // welcome screen.
    await authApi.deleteAccount();
    await clearSessionTokens();
    setUser(null);
  }, []);

  const updateProfile = useCallback(
    async (patch: { nickname?: string }) => {
      const { user } = await authApi.updateProfile(patch);
      setUser(user);
    },
    []
  );

  return (
    <AuthContext.Provider
      value={{
        loading,
        user,
        loginWithApple,
        loginWithPhone,
        logout,
        deleteAccount,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
