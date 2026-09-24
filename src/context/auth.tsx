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
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';
import {
  authApi,
  type AccountDeletionResult,
  type AccountDeletionStatus,
  type AuthUser,
} from '../api/auth';
import {
  BackendError,
  clearSessionTokens,
  getRefreshToken,
  onAuthExpired,
  setSessionTokens,
  UnauthorizedError,
} from '../api/backend';
import {
  clearOwnerDeletionPending,
  markOwnerDeletionIntent,
  markOwnerDeletionServerCommitted,
} from '../db/deletions';
import { clearCurrentOwner, setCurrentOwner } from '../db/owner';
import {
  clearConsentReceipt,
  type ConsentReceipt,
  readCurrentConsent,
  recordCurrentConsent,
  requireCurrentConsentReceipt,
} from '../privacy/consent';
import { setDiagnosticsEnabled } from '../privacy/diagnostics';
import { shutdownSentry } from '../monitoring/sentry';
import {
  clearDeletionReconciliationReceipt,
  listDeletionReconciliationReceipts,
  saveDeletionReconciliationReceipt,
  type DeletionReconciliationRecord,
} from '../services/account-deletion-reconciliation';
import {
  purgeOwnerLocalData,
  retryPendingLocalDeletions,
} from '../services/delete';
import { resetRecordingRuntime } from '../hooks/useAudioRecorder';
import { cleanupManagedStorage } from '../storage/maintenance';
import { resetPlaybackRuntime } from './player';

interface AuthState {
  /** False while we're checking SecureStore on app launch. UI should
   *  show a splash or nothing during this window. */
  loading: boolean;
  /** Null when logged out; populated after successful login or
   *  after launch-time token validation. */
  user: AuthUser | null;
  /** Current policy receipt used by both the welcome UI and authentication. */
  consent: ConsentReceipt | null;
  acceptCurrentConsent: () => Promise<ConsentReceipt>;
  withdrawCurrentConsent: () => Promise<void>;
  loginWithApple: (
    identityToken: string,
    authorizationCode: string,
    fullName?: { givenName?: string | null; familyName?: string | null } | null
  ) => Promise<void>;
  loginWithPhone: (
    phone: string,
    code: string,
    nickname?: string
  ) => Promise<void>;
  logout: () => Promise<void>;
  /** Soft-delete the account server-side, then locally log out. */
  deleteAccount: () => Promise<AccountDeletionResult>;
  /** Patch profile fields server-side and update the cached user. */
  updateProfile: (patch: { nickname?: string }) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const CACHED_USER_KEY = 'authenticated_user';
const STORE_PREVIEW_MODE =
  __DEV__ && process.env.EXPO_PUBLIC_STORE_PREVIEW === '1';
const STORE_PREVIEW_USER: AuthUser = {
  id: 'store-preview-user',
  nickname: 'Alex',
  phone: null,
  email: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState<ConsentReceipt | null>(null);
  const consentRef = useRef<ConsentReceipt | null>(null);

  const updateConsent = useCallback((receipt: ConsentReceipt | null) => {
    consentRef.current = receipt;
    setConsent(receipt);
  }, []);

  const acceptCurrentConsent = useCallback(async () => {
    const receipt = await recordCurrentConsent();
    updateConsent(receipt);
    return receipt;
  }, [updateConsent]);

  const withdrawCurrentConsent = useCallback(async () => {
    await clearConsentReceipt();
    updateConsent(null);
  }, [updateConsent]);

  // Boot: do we have a stored token? If yes, hit /auth/me to confirm
  // it still works. If /me returns 401, backendRequest already wiped
  // the tokens; we stay logged out.
  //
  // No watchdog needed anymore — the root layout returns null while
  // loading, so iOS keeps the splash up. If /auth/me hangs, the user
  // sees a normal-looking splash, not a stuck spinner. The /me call
  // itself has its own retry-on-401 inside backendRequest.
  useEffect(() => {
    let cancelled = false;
    let backgroundReconciliations: DeletionReconciliationRecord[] = [];
    let pendingCurrentReconciliation: DeletionReconciliationRecord | null =
      null;
    (async () => {
      try {
        // Local-only harness for capturing accurate App Store screenshots.
        // __DEV__ makes this branch unreachable in TestFlight/App Store
        // binaries even if the environment variable is accidentally present.
        if (STORE_PREVIEW_MODE) {
          await setCurrentOwner(STORE_PREVIEW_USER.id);
          if (!cancelled) setUser(STORE_PREVIEW_USER);
          return;
        }
        // A native TrackPlayer queue can outlive the previous React process.
        // Establish silence before deciding which cached identity, if any,
        // will own this launch.
        await resetAccountAudioRuntime();
        const cachedUser = await readCachedUser();
        const reconciliations =
          await listDeletionReconciliationReceipts();
        const currentReconciliation = cachedUser
          ? reconciliations.find((item) => item.owner === cachedUser.id)
          : undefined;
        backgroundReconciliations = reconciliations.filter(
          (item) => item !== currentReconciliation
        );
        const currentReconciliationOutcome = currentReconciliation
          ? await reconcileDeletionReceipt(
            currentReconciliation,
            true,
            2_500
          )
          : 'active';
        if (currentReconciliationOutcome === 'accepted') {
          return;
        }
        if (currentReconciliationOutcome === 'unresolved') {
          pendingCurrentReconciliation = currentReconciliation ?? null;
        }
        // Old accounts must never add serial network latency to the current
        // owner's splash screen. Reconcile two at a time in the background;
        // failures retain their receipt for the next launch.
        // Older committed tombstones that predate the separate credential can
        // still finish their local filesystem cleanup.
        await retryPendingLocalDeletions();
        // A policy-version bump requires an explicit fresh acceptance before
        // restoring an old session. Do not silently carry consent forward.
        const storedConsent = await readCurrentConsent();
        if (!cancelled) updateConsent(storedConsent);
        if (!storedConsent) {
          await Promise.all([clearSessionTokens(), clearCachedUser()]);
          return;
        }
        const refresh = await getRefreshToken();
        if (!refresh) return;
        try {
          const { user } = await authApi.me();
          if (reconciliations.some((item) => item.owner === user.id)) {
            // A fully authenticated active profile is stronger evidence than
            // an expired status credential: the earlier DELETE never stuck.
            await Promise.all([
              clearOwnerDeletionPending(user.id).catch(() => {}),
              clearDeletionReconciliationReceipt(user.id),
            ]);
          }
          await setCurrentOwner(user.id);
          await cacheUser(user).catch(() => {});
          if (!cancelled) {
            setUser(user);
            void cleanupManagedStorage().catch(() => {});
          } else {
            clearCurrentOwner();
          }
        } catch (error) {
          if (isServerDeletionState(error) && cachedUser) {
            // A DELETE response can be lost after the server has durably
            // accepted or completed deletion. These explicit states are safe
            // proof; a generic network/401 failure is deliberately not.
            await finishLocalAccountDeletion(cachedUser.id, true);
            return;
          }
          if (error instanceof UnauthorizedError) {
            await clearCachedUser();
            throw error;
          }
          // A network/provider outage must not masquerade as logout. Local
          // learning data remains usable offline under the last verified user.
          if (!cachedUser) throw error;
          await setCurrentOwner(cachedUser.id);
          if (!cancelled) {
            setUser(cachedUser);
            void cleanupManagedStorage().catch(() => {});
          } else {
            clearCurrentOwner();
          }
        }
      } catch {
        if (!cancelled) {
          clearCurrentOwner();
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          void reconcileDeletionReceiptsInBackground(
            backgroundReconciliations
          );
          if (pendingCurrentReconciliation) {
            void reconcileDeletionReceipt(
              pendingCurrentReconciliation,
              true,
              8_000
            ).then((outcome) => {
              if (outcome === 'accepted' && !cancelled) setUser(null);
            });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [updateConsent]);

  useEffect(
    () =>
      onAuthExpired(() => {
        void resetAccountAudioRuntime()
          .catch((error: unknown) => {
            // Credentials must still be cleared. Both audio runtimes remain
            // quarantined, so a new account cannot reuse unknown native state.
            console.warn('[auth] audio reset failed after auth expiry', error);
            showAudioRestartReminder();
          })
          .finally(() => {
            void clearCachedUser();
            clearCurrentOwner();
            setUser(null);
          });
      }),
    []
  );

  const loginWithApple = useCallback(
    async (
      identityToken: string,
      authorizationCode: string,
      fullName?:
        | { givenName?: string | null; familyName?: string | null }
        | null
    ) => {
      const acceptedConsent = requireCurrentConsentReceipt(consentRef.current);
      // Prove that no previous account's native queue can survive before the
      // server creates a fresh session family for this login.
      await resetAccountAudioRuntime();
      const session = await authApi.appleLogin(
        identityToken,
        authorizationCode,
        fullName ?? null,
        {
          consent_version: acceptedConsent.version,
          consent_accepted_at: acceptedConsent.acceptedAt,
        }
      );
      await setSessionTokens(session.access_token, session.refresh_token);
      await setCurrentOwner(session.user.id);
      await cacheUser(session.user).catch(() => {});
      setUser(session.user);
      void cleanupManagedStorage().catch(() => {});
    },
    []
  );

  const loginWithPhone = useCallback(
    async (phone: string, code: string, nickname?: string) => {
      const acceptedConsent = requireCurrentConsentReceipt(consentRef.current);
      await resetAccountAudioRuntime();
      const session = await authApi.verify(phone, code, nickname, {
        consent_version: acceptedConsent.version,
        consent_accepted_at: acceptedConsent.acceptedAt,
      });
      await setSessionTokens(session.access_token, session.refresh_token);
      await setCurrentOwner(session.user.id);
      await cacheUser(session.user).catch(() => {});
      setUser(session.user);
      void cleanupManagedStorage().catch(() => {});
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await resetAccountAudioRuntime();
    } catch (error) {
      // Do not cross an identity boundary while a late native recorder/player
      // can still revive. Restarting gives native audio a known baseline.
      showAudioRestartReminder();
      throw error;
    }
    const refresh = await getRefreshToken();
    if (refresh) {
      try {
        await authApi.logout();
      } catch {
        // Network failure shouldn't block local logout. Worst case the
        // backend still has a row; refresh token will eventually expire.
      }
    }
    try {
      await Promise.all([clearSessionTokens(), clearCachedUser()]);
    } finally {
      clearCurrentOwner();
      setUser(null);
    }
  }, []);

  const deleteAccount = useCallback(async (): Promise<AccountDeletionResult> => {
    // Server marks deleted_at + revokes refresh tokens. We still need
    // to wipe local tokens & cached user state to bounce back to the
    // welcome screen.
    try {
      await resetAccountAudioRuntime();
    } catch (error) {
      // Do not commit an irreversible server deletion while native microphone
      // or playback ownership is unknown. The user can restart and retry.
      showAudioRestartReminder();
      throw error;
    }
    const deletingOwner = user?.id;
    if (!deletingOwner) throw new Error('当前没有可注销的账号');
    // A purpose-bound receipt must be durable before DELETE leaves the phone.
    // If the destructive response is lost, this is independent proof with
    // which a later process can reconcile server state.
    const existingReceipt = (
      await listDeletionReconciliationReceipts()
    ).find(
      (item) =>
        item.owner === deletingOwner &&
        new Date(item.expiresAt).getTime() > Date.now()
    );
    if (!existingReceipt) {
      const reconciliation = await authApi.deletionReceipt();
      await saveDeletionReconciliationReceipt(
        deletingOwner,
        reconciliation.deletion_receipt,
        reconciliation.expires_at
      );
    }
    try {
      await markOwnerDeletionIntent(deletingOwner);
    } catch (error) {
      await clearDeletionReconciliationReceipt(deletingOwner).catch(
        () => {}
      );
      throw error;
    }
    let result: AccountDeletionResult;
    try {
      result = await authApi.deleteAccount();
    } catch (error) {
      if (isDurablyAcceptedDeletion(error)) {
        // Apple may be temporarily unavailable, but deletion_state='deleting'
        // is already durable and the server recovery worker will continue.
        result = {
          message: '账号注销已受理；服务器会继续完成授权撤销',
          code: 'ACCOUNT_DELETION_PENDING',
          apple_revocation: 'pending',
        };
      } else {
        // Keep the marker after an ambiguous network failure so a retry can
        // reconcile against AUTH_ACCOUNT_DELETING/AUTH_ACCOUNT_DELETED. Only
        // a definite pre-commit rejection is safe to clear here.
        if (isDefinitePreCommitDeletionFailure(error)) {
          await Promise.all([
            clearOwnerDeletionPending(deletingOwner).catch(() => {}),
            clearDeletionReconciliationReceipt(deletingOwner).catch(
              () => {}
            ),
          ]);
        }
        throw error;
      }
    }

    const cleanupDeferred = await finishLocalAccountDeletion(
      deletingOwner,
      true
    );
    // Once the server accepted deletion, React state must leave the account
    // even if SecureStore or filesystem cleanup needs a later retry.
    setUser(null);
    if (result.apple_revocation === 'manual_required') {
      showManualRevocationReminder(
        {
          apple_revocation: 'manual_required',
          manual_revoke_instructions: result.manual_revoke_instructions,
        },
        deletingOwner,
        !cleanupDeferred
      );
    } else if (
      result.apple_revocation !== 'pending' &&
      !cleanupDeferred
    ) {
      await clearDeletionReconciliationReceipt(deletingOwner);
    }
    if (cleanupDeferred) {
      return {
        ...result,
        code: 'LOCAL_CLEANUP_PENDING',
        message: '账号已注销；本机数据将在下次启动时继续清理',
      };
    }
    return result;
  }, [user?.id]);

  const updateProfile = useCallback(
    async (patch: { nickname?: string }) => {
      const { user } = await authApi.updateProfile(patch);
      await cacheUser(user).catch(() => {});
      setUser(user);
    },
    []
  );

  return (
    <AuthContext.Provider
      value={{
        loading,
        user,
        consent,
        acceptCurrentConsent,
        withdrawCurrentConsent,
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

async function resetAccountAudioRuntime(): Promise<void> {
  // Stop the microphone first. Initializing TrackPlayer while a late recorder
  // is recovering can itself change the native audio session.
  await resetRecordingRuntime();
  await resetPlaybackRuntime();
}

async function cacheUser(user: AuthUser): Promise<void> {
  await SecureStore.setItemAsync(CACHED_USER_KEY, JSON.stringify(user));
}

async function clearCachedUser(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHED_USER_KEY).catch(() => {});
}

function isServerDeletionState(error: unknown): error is BackendError {
  return (
    error instanceof BackendError &&
    (error.code === 'AUTH_ACCOUNT_DELETING' ||
      error.code === 'AUTH_ACCOUNT_DELETED')
  );
}

function showManualRevocationReminder(
  status: Pick<
    AccountDeletionStatus,
    'apple_revocation' | 'manual_revoke_instructions'
  >,
  owner: string,
  clearOnAcknowledge = true
): void {
  if (
    status.apple_revocation !== 'manual_required' &&
    status.apple_revocation !== 'unknown'
  ) {
    return;
  }
  Alert.alert(
    '请确认 Apple 授权已撤销',
    status.manual_revoke_instructions ??
      '如果你曾使用“通过 Apple 登录”，请在 Apple 账户设置中停止使用 PhotoSpeak。',
    [
      {
        text: '知道了',
        onPress: () => {
          if (clearOnAcknowledge) {
            void clearDeletionReconciliationReceipt(owner);
          }
        },
      },
    ]
  );
}

function showAudioRestartReminder(): void {
  Alert.alert(
    '请重新打开 PhotoSpeak',
    '系统未能确认录音或播放器已经安全停止。为保护麦克风和账号数据，本次运行已禁用音频功能；完全关闭并重新打开 App 后即可恢复。'
  );
}

function isDurablyAcceptedDeletion(error: unknown): error is BackendError {
  return (
    error instanceof BackendError &&
    (error.code === 'APPLE_REVOCATION_UNAVAILABLE' ||
      error.code === 'AUTH_ACCOUNT_DELETE_RETRY' ||
      error.code === 'AUTH_ACCOUNT_DELETING' ||
      error.code === 'AUTH_ACCOUNT_DELETED')
  );
}

function isDefinitePreCommitDeletionFailure(error: unknown): boolean {
  return (
    error instanceof BackendError &&
    (error.code === 'AUTH_RECENT_LOGIN_REQUIRED' ||
      error.code === 'VALIDATION_ERROR')
  );
}

/**
 * Reconcile one pre-persisted deletion receipt. The explicit outcome lets boot
 * distinguish an active account from a temporary network failure; only proven
 * server acceptance is destructive. Errors leave receipt and tombstone intact.
 */
async function reconcileDeletionReceipt(
  reconciliation: DeletionReconciliationRecord,
  isCurrentOwner: boolean,
  timeoutMs: number
): Promise<'accepted' | 'active' | 'unresolved'> {
  try {
    const status = await authApi.deletionStatus(reconciliation.receipt, {
      timeoutMs,
    });
    if (status.status === 'active') {
      await Promise.all([
        clearOwnerDeletionPending(reconciliation.owner).catch(() => {}),
        clearDeletionReconciliationReceipt(reconciliation.owner),
      ]);
      return 'active';
    }

    const cleanupDeferred = await finishLocalAccountDeletion(
      reconciliation.owner,
      isCurrentOwner
    );
    if (status.status === 'deleted') {
      if (
        status.apple_revocation === 'manual_required' ||
        status.apple_revocation === 'unknown'
      ) {
        showManualRevocationReminder(
          status,
          reconciliation.owner,
          !cleanupDeferred
        );
      } else if (!cleanupDeferred) {
        await clearDeletionReconciliationReceipt(reconciliation.owner);
      }
    }
    return 'accepted';
  } catch {
    return 'unresolved';
  }
}

async function reconcileDeletionReceiptsInBackground(
  records: DeletionReconciliationRecord[]
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < records.length) {
      const record = records[nextIndex];
      nextIndex += 1;
      await reconcileDeletionReceipt(record, false, 8_000);
    }
  };
  const workerCount = Math.min(2, records.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );
}

/**
 * Complete the device side of the account-deletion saga. The committed marker
 * is written before destructive work so a crash or filesystem error is
 * resumed on the next launch. Authentication is always cleared once the
 * server has accepted deletion, even if media cleanup must be retried.
 */
async function finishLocalAccountDeletion(
  owner: string,
  clearAuthentication: boolean
): Promise<boolean> {
  let durableRetryMarker = true;
  try {
    await markOwnerDeletionServerCommitted(owner);
  } catch {
    durableRetryMarker = false;
  }

  let cleanupDeferred = false;
  try {
    await purgeOwnerLocalData(owner);
    await clearOwnerDeletionPending(owner);
  } catch {
    cleanupDeferred = true;
    if (!durableRetryMarker) {
      await markOwnerDeletionServerCommitted(owner).catch(() => {});
    }
  }

  if (clearAuthentication) {
    try {
      // The policy receipt is device-scoped, not owned by the deleted account.
      // Clearing it from a late deletion reconciliation can otherwise race a
      // new login and leave the welcome checkbox out of sync. It is revoked
      // only by the explicit checkbox action or a policy-version change.
      await Promise.all([
        clearSessionTokens(),
        clearCachedUser(),
        setDiagnosticsEnabled(false),
        shutdownSentry(),
      ]);
    } catch {
      cleanupDeferred = true;
    } finally {
      clearCurrentOwner();
    }
  }
  return cleanupDeferred;
}

async function readCachedUser(): Promise<AuthUser | null> {
  try {
    const raw = await SecureStore.getItemAsync(CACHED_USER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AuthUser>;
    if (
      typeof value.id !== 'string' ||
      !value.id ||
      typeof value.nickname !== 'string' ||
      typeof value.created_at !== 'string'
    ) {
      return null;
    }
    return {
      id: value.id,
      nickname: value.nickname,
      phone: typeof value.phone === 'string' ? value.phone : null,
      email: typeof value.email === 'string' ? value.email : null,
      created_at: value.created_at,
    };
  } catch {
    return null;
  }
}
