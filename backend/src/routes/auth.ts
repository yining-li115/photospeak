import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import { db, schema } from '../db/client.js';
import {
  requireUser,
  type AuthVars,
} from '../auth/middleware.js';
import {
  AccountDeletionInProgressError,
  beginAccountDeletion,
  createLoginSession,
  revokeSession,
  rotateRefreshToken,
} from '../auth/session-service.js';
import {
  createDeletionReceiptServiceFromEnv,
  type DeletionReceiptService,
} from '../auth/deletion-receipt.js';
import { verifyAppleIdentityToken } from '../auth/apple.js';
import {
  AppleCredentialError,
  AppleIdentityMismatchError,
  AppleServerError,
  createAppleServerTokenServiceFromEnv,
  type AppleServerTokenGateway,
} from '../auth/apple-server.js';
import {
  AppleLoginCompensationError,
  completeAppleLogin,
} from '../auth/apple-account-service.js';
import { findOrCreatePhoneUser } from '../auth/phone-account-service.js';
import {
  isAppReviewPhone,
  verifyAppReviewCode,
  type AppReviewAccessConfig,
} from '../auth/app-review-access.js';
import { processPendingAccountDeletion } from '../services/apple-deletion-recovery.js';
import {
  sendVerifyCode,
  checkVerifyCode,
  SmsThrottledError,
  SmsUnavailableError,
} from '../auth/sms.js';
import {
  clientIp,
  rateLimit,
  rateLimitConsume,
} from '../middleware/rate-limit.js';
import { safeLogReference } from '../logging/safe-reference.js';
import {
  parseConsentReceipt,
  type ConsentFields,
  type ValidConsentReceipt,
} from '../privacy/consent-policy.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_15_MS = 15 * 60 * 1000;

interface Config {
  /** iOS bundle id — Apple's identity token's `aud` claim. */
  appleBundleId: string;
  /** Master switch for /send-code + /verify (phone path). */
  phoneLoginEnabled: boolean;
  /** Explicitly enabled, server-only credential used by Apple App Review. */
  appReviewAccess?: AppReviewAccessConfig;
  /** Only trust X-Forwarded-For when the app is network-isolated behind nginx. */
  trustProxy?: boolean;
  /** Test/alternate implementation hook; production builds from env. */
  appleServer?: AppleServerTokenGateway;
  /** Test/alternate implementation hook; production builds from env. */
  deletionReceiptService?: DeletionReceiptService;
}

const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{6}$/;
export function createAuthRouter(config: Config) {
  const app = new Hono<{ Variables: AuthVars }>();
  const appleServer =
    config.appleServer ??
    createAppleServerTokenServiceFromEnv(config.appleBundleId);
  const deletionReceipts =
    config.deletionReceiptService ?? createDeletionReceiptServiceFromEnv();

  app.use(
    '*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: '请求内容过大' }, 413),
    })
  );

  app.use(
    '/apple',
    rateLimit({
      name: 'apple-login-ip',
      windowMs: MIN_15_MS,
      max: 20,
      keyFn: (c) =>
        `ip:${clientIp(c, { trustProxy: config.trustProxy })}`,
    })
  );
  app.use(
    '/refresh',
    rateLimit({
      name: 'refresh-ip',
      windowMs: MIN_15_MS,
      max: 60,
      keyFn: (c) =>
        `ip:${clientIp(c, { trustProxy: config.trustProxy })}`,
    })
  );
  app.use(
    '/deletion-status',
    rateLimit({
      name: 'deletion-status-ip',
      windowMs: MIN_15_MS,
      max: 60,
      keyFn: (c) =>
        `ip:${clientIp(c, { trustProxy: config.trustProxy })}`,
    })
  );
  app.use(
    '/deletion-receipt',
    rateLimit({
      name: 'deletion-receipt-ip',
      windowMs: MIN_15_MS,
      max: 20,
      keyFn: (c) =>
        `ip:${clientIp(c, { trustProxy: config.trustProxy })}`,
    })
  );

  // The client must durably store this narrow receipt before it sends DELETE.
  // A receipt is not accepted by ordinary auth middleware and survives access
  // JWT expiry, session revocation, and independent access-key rotation.
  app.post('/deletion-receipt', requireUser(), (c) => {
    const receipt = deletionReceipts.issue(c.get('userId'));
    return c.json({
      deletion_receipt: receipt.token,
      expires_at: receipt.expiresAt.toISOString(),
    });
  });

  // A narrowly scoped reconciliation channel for a lost DELETE response. It
  // returns only deletion state, never profile or general account data.
  app.get('/deletion-status', async (c) => {
    const authorization = c.req.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return c.json(
        { error: 'unauthorized', code: 'AUTH_DELETION_STATUS_UNAVAILABLE' },
        401
      );
    }
    let payload;
    try {
      payload = deletionReceipts.verify(authorization.slice(7));
    } catch {
      return c.json(
        { error: 'unauthorized', code: 'AUTH_DELETION_STATUS_UNAVAILABLE' },
        401
      );
    }

    const [account] = await db
      .select({
        deletedAt: schema.users.deletedAt,
        deletionState: schema.users.deletionState,
        appleUserId: schema.users.appleUserId,
        appleTokenRevokedAt: schema.users.appleTokenRevokedAt,
        appleManualRevokeRequiredAt:
          schema.users.appleManualRevokeRequiredAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, payload.sub))
      .limit(1);

    if (!account) {
      // Hard deletion runs only after the seven-day retention period. A valid
      // old token reaching this state therefore confirms that the account no
      // longer exists; preserve a conservative Apple reminder because its
      // former login method was intentionally erased with the profile.
      return c.json({
        status: 'deleted' as const,
        apple_revocation: 'unknown' as const,
        manual_revoke_instructions:
          '如果你曾使用“通过 Apple 登录”，请在 Apple 账户设置中确认已停止使用 PhotoSpeak。',
      });
    }
    if (
      account.deletionState === 'deleting' &&
      account.deletedAt === null
    ) {
      return c.json({
        status: 'deleting' as const,
        apple_revocation: 'pending' as const,
      });
    }
    if (account.deletedAt || account.deletionState === 'deleted') {
      const appleRevocation = account.appleManualRevokeRequiredAt
        ? ('manual_required' as const)
        : account.appleTokenRevokedAt
          ? ('revoked' as const)
          : account.appleUserId
            ? ('unknown' as const)
            : ('not_applicable' as const);
      return c.json({
        status: 'deleted' as const,
        apple_revocation: appleRevocation,
        manual_revoke_instructions:
          appleRevocation === 'manual_required'
            ? '请在 Apple 账户设置的“使用 Apple 登录”中停止使用 PhotoSpeak。'
            : undefined,
      });
    }
    return c.json({
      status: 'active' as const,
      apple_revocation: 'not_applicable' as const,
    });
  });

  // ─── POST /auth/apple ─────────────────────────────────────────────
  app.post('/apple', async (c) => {
    let body: {
      identity_token?: string;
      authorization_code?: string;
      full_name?: { givenName?: string; familyName?: string } | null;
    } & ConsentFields = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const consent = parseConsentReceipt(body);
    if (!consent) {
      return c.json(
        {
          error: '请先同意当前用户协议与隐私政策',
          code: 'CONSENT_REQUIRED',
        },
        400
      );
    }
    const identityToken = body.identity_token;
    if (
      !identityToken ||
      typeof identityToken !== 'string' ||
      identityToken.length > 20_000
    ) {
      return c.json({ error: 'identity_token is required' }, 400);
    }
    const authorizationCode = body.authorization_code;
    if (
      !authorizationCode ||
      typeof authorizationCode !== 'string' ||
      authorizationCode.length > 10_000
    ) {
      return c.json(
        {
          error: 'authorization_code is required',
          code: 'AUTH_APPLE_CODE_REQUIRED',
        },
        400
      );
    }

    let identity;
    try {
      identity = await verifyAppleIdentityToken(
        identityToken,
        config.appleBundleId
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'auth.apple.invalid_token',
          message: err instanceof Error ? err.message : String(err),
        })
      );
      return c.json(
        { error: 'Apple 登录凭证无效', code: 'AUTH_APPLE_INVALID' },
        401
      );
    }

    try {
      const result = await completeAppleLogin({
        identity,
        authorizationCode,
        fullName: body.full_name,
        consent: {
          version: consent.version,
          acceptedAt: consent.acceptedAt,
          source: 'apple_login',
        },
        appleServer,
      });
      return c.json({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        user: sanitizeUser(result.user),
      });
    } catch (err) {
      logAppleFailure('auth.apple.code_exchange_failed', err);
      if (err instanceof AccountDeletionInProgressError) {
        return c.json(
          {
            error: '账号正在注销，请等待当前操作完成后再登录',
            code: 'AUTH_ACCOUNT_DELETE_IN_PROGRESS',
          },
          409
        );
      }
      if (
        err instanceof AppleServerError &&
        err.kind === 'rejected' &&
        err.upstreamCode === 'invalid_grant'
      ) {
        return c.json(
          {
            error: 'Apple 授权码无效或已使用',
            code: 'AUTH_APPLE_CODE_INVALID',
          },
          401
        );
      }
      if (err instanceof AppleIdentityMismatchError) {
        return c.json(
          {
            error: 'Apple 登录身份不匹配',
            code: 'AUTH_APPLE_IDENTITY_MISMATCH',
          },
          401
        );
      }
      if (err instanceof AppleLoginCompensationError) {
        return c.json(
          {
            error: 'Apple 登录未完成，凭证清理需要重试',
            code: 'AUTH_APPLE_COMPENSATION_REQUIRED',
          },
          503
        );
      }
      return c.json(
        {
          error: 'Apple 登录服务暂时不可用，请稍后重试',
          code: 'AUTH_APPLE_UNAVAILABLE',
        },
        503
      );
    }
  });

  // ─── POST /auth/send-code (phone) ─────────────────────────────────
  // Two-layer rate limit:
  //   - Per IP (middleware, cheap): blocks a single attacker enumerating
  //     phone numbers. 20/hour is generous for real users on shared NAT.
  //   - Per phone (handler, after body parse): caps SMS spend per number
  //     even if the attacker rotates IPs. 5/day matches Aliyun's daily
  //     SMS quota assumption.
  app.post(
    '/send-code',
    rateLimit({
      name: 'send-code-ip',
      windowMs: HOUR_MS,
      max: 20,
      keyFn: (c) =>
        `ip:${clientIp(c, { trustProxy: config.trustProxy })}`,
      message: '请求过于频繁，请稍后再试',
    }),
    async (c) => {
      if (!config.phoneLoginEnabled) {
        return c.json({ error: '手机号登录暂未开放' }, 403);
      }
      let body: { phone?: string } = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      const phone = body.phone;
      const isReviewPhone =
        !!phone && isAppReviewPhone(config.appReviewAccess, phone);
      if (!phone || (!PHONE_RE.test(phone) && !isReviewPhone)) {
        return c.json({ error: '请输入有效的手机号' }, 400);
      }

      const phoneCheck = rateLimitConsume({
        name: 'send-code-phone',
        key: `phone:${phone}`,
        windowMs: DAY_MS,
        max: 5,
      });
      if (!phoneCheck.ok) {
        c.header('Retry-After', String(phoneCheck.retryAfterSec));
        return c.json(
          { error: '该手机号今日发送次数已达上限，请明天再试' },
          429
        );
      }

      if (isReviewPhone) {
        console.info(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'auth.app_review.code_requested',
            phoneRef: safeLogReference('phone', phone),
          })
        );
      } else {
        try {
          await sendVerifyCode(phone);
        } catch (err) {
          if (err instanceof SmsThrottledError) {
            return c.json({ error: '发送过于频繁，请稍后再试' }, 429);
          }
          if (err instanceof SmsUnavailableError) {
            return c.json({ error: '验证码服务暂时不可用' }, 503);
          }
          throw err;
        }
      }
      return c.json({ message: '验证码已发送' });
    }
  );

  // ─── POST /auth/verify (phone) ────────────────────────────────────
  // Two-layer limit again:
  //   - Per IP: 30/15min — blocks broad brute-force from one attacker.
  //   - Per phone: 10/15min — locks out brute-forcers cycling through IPs
  //     against a specific number. After 10 wrong tries the user (or
  //     attacker) waits 15 minutes.
  app.post(
    '/verify',
    rateLimit({
      name: 'verify-ip',
      windowMs: MIN_15_MS,
      max: 30,
      keyFn: (c) =>
        `ip:${clientIp(c, { trustProxy: config.trustProxy })}`,
    }),
    async (c) => {
      if (!config.phoneLoginEnabled) {
        return c.json({ error: '手机号登录暂未开放' }, 403);
      }
      let body: {
        phone?: string;
        code?: string;
        nickname?: string;
      } & ConsentFields = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      const consent = parseConsentReceipt(body);
      if (!consent) {
        return c.json(
          {
            error: '请先同意当前用户协议与隐私政策',
            code: 'CONSENT_REQUIRED',
          },
          400
        );
      }
      const phone = body.phone;
      const code = body.code;
      const isReviewPhone =
        !!phone && isAppReviewPhone(config.appReviewAccess, phone);
      if (!phone || (!PHONE_RE.test(phone) && !isReviewPhone)) {
        return c.json({ error: '手机号无效' }, 400);
      }
      if (!code || !CODE_RE.test(code)) {
        return c.json({ error: '请输入 6 位验证码' }, 400);
      }

      const phoneCheck = rateLimitConsume({
        name: 'verify-phone',
        key: `phone:${phone}`,
        windowMs: MIN_15_MS,
        max: 10,
      });
      if (!phoneCheck.ok) {
        c.header('Retry-After', String(phoneCheck.retryAfterSec));
        return c.json(
          { error: '验证次数过多，请 15 分钟后再试' },
          429
        );
      }

      let isValid: boolean;
      if (isReviewPhone) {
        isValid = verifyAppReviewCode(config.appReviewAccess, phone, code);
      } else {
        try {
          isValid = await checkVerifyCode(phone, code);
        } catch {
          return c.json({ error: '验证码服务暂时不可用' }, 503);
        }
      }
      if (!isValid) {
        return c.json(
          { error: '验证码错误或已过期', code: 'AUTH_CODE_INVALID' },
          401
        );
      }

      try {
        const suppliedNickname =
          typeof body.nickname === 'string'
            ? body.nickname.trim().slice(0, 50)
            : '';
        const user = await findOrCreatePhoneUser({
          phone,
          nickname:
            suppliedNickname ||
            (isReviewPhone ? 'App Review' : `用户${phone.slice(-4)}`),
        });
        await recordConsentReceipt(user.id, consent, 'phone_login');
        return c.json(await issueSession(user));
      } catch (error) {
        if (error instanceof AccountDeletionInProgressError) {
          return c.json(
            {
              error: '账号正在注销，请等待当前操作完成后再登录',
              code: 'AUTH_ACCOUNT_DELETE_IN_PROGRESS',
            },
            409
          );
        }
        throw error;
      }
    }
  );

  // ─── POST /auth/refresh ───────────────────────────────────────────
  app.post('/refresh', async (c) => {
    let body: { refresh_token?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const refreshToken = body.refresh_token;
    if (!refreshToken) {
      return c.json({ error: 'refresh_token required' }, 400);
    }

    const idempotencyKey = c.req.header('idempotency-key');
    const result = await rotateRefreshToken(refreshToken, idempotencyKey);
    if (result.status === 'invalid_idempotency_key') {
      return c.json(
        {
          error: 'invalid Idempotency-Key',
          code: 'AUTH_IDEMPOTENCY_KEY_INVALID',
        },
        400
      );
    }
    if (result.status === 'reuse_detected') {
      return c.json(
        {
          error: '检测到登录凭证重复使用，请重新登录',
          code: 'AUTH_REFRESH_REUSE_DETECTED',
        },
        401
      );
    }
    if (result.status === 'invalid') {
      return c.json(
        { error: 'invalid refresh token', code: 'AUTH_REFRESH_INVALID' },
        401
      );
    }
    return c.json({
      access_token: result.tokens.accessToken,
      refresh_token: result.tokens.refreshToken,
    });
  });

  // ─── DELETE /auth/logout ──────────────────────────────────────────
  app.delete('/logout', requireUser(), async (c) => {
    // The access token's session id is authoritative. If the client auto-
    // refreshed immediately before retrying logout, it is still the same
    // family, so the newly issued refresh token is revoked as well. The old
    // refresh_token request field remains accepted but is no longer trusted.
    await revokeSession(c.get('userId'), c.get('sessionId'));
    return c.json({ message: '已登出' });
  });

  // ─── GET /auth/me ─────────────────────────────────────────────────
  app.get('/me', requireUser(), async (c) => {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, c.get('userId')))
      .limit(1);
    if (!user || user.deletedAt) {
      return c.json({ error: 'user not found' }, 404);
    }
    return c.json({ user: sanitizeUser(user) });
  });

  // ─── PATCH /auth/me ───────────────────────────────────────────────
  // Currently only nickname is editable. Add other fields (avatar, etc.)
  // to the allowlist below as the UI grows.
  app.patch('/me', requireUser(), async (c) => {
    let body: { nickname?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const nickname =
      typeof body.nickname === 'string' ? body.nickname.trim() : undefined;
    if (nickname === undefined || nickname.length === 0 || nickname.length > 50) {
      return c.json({ error: '昵称需在 1-50 字符之间' }, 400);
    }
    const [user] = await db
      .update(schema.users)
      .set({ nickname, updatedAt: new Date() })
      .where(eq(schema.users.id, c.get('userId')))
      .returning();
    if (!user || user.deletedAt) {
      return c.json({ error: 'user not found' }, 404);
    }
    return c.json({ user: sanitizeUser(user) });
  });

  // ─── DELETE /auth/me ──────────────────────────────────────────────
  // Soft delete: set deleted_at + revoke ALL refresh tokens. The
  // account is recoverable for 7 days (a separate cron job hard-
  // deletes after that). Re-logging in via Apple/phone within the
  // window reactivates the account (clears deleted_at) — see
  // /auth/apple's reactivation branch.
  app.delete('/me', requireUser({ allowDeleting: true }), async (c) => {
    const userId = c.get('userId');
    const sessionId = c.get('sessionId');
    const begin = await beginAccountDeletion(userId, sessionId);
    if (begin.status === 'recent_auth_required') {
      return c.json(
        {
          error: '删除账号前请重新登录以确认身份',
          code: 'AUTH_RECENT_LOGIN_REQUIRED',
        },
        403
      );
    }
    if (begin.status === 'invalid_session') {
      return c.json(
        { error: 'unauthorized', code: 'AUTH_ACCESS_EXPIRED' },
        401
      );
    }

    // deletion_state='deleting' is durable before the first network call.
    // Deletion clears any short Apple-login reservation; a late exchange then
    // takes the compensation/outbox path and cannot reactivate this account.
    const finalized = await processPendingAccountDeletion({
      userId,
      sessionId,
      appleServer,
    });
    if (finalized.status === 'revocation_failed') {
      logAppleFailure('auth.apple.revoke_failed', finalized.error, userId);
      return c.json(
        {
          error: 'Apple 授权撤销失败，账号尚未删除，请稍后重试',
          code: 'APPLE_REVOCATION_UNAVAILABLE',
        },
        503
      );
    }
    if (finalized.status === 'credentials_remaining') {
      return c.json(
        {
          error: 'Apple 凭证刚刚发生变化，账号尚未删除，请重试',
          code: 'AUTH_ACCOUNT_DELETE_RETRY',
        },
        409
      );
    }
    if (finalized.status === 'invalid_session') {
      return c.json(
        { error: 'unauthorized', code: 'AUTH_ACCESS_EXPIRED' },
        401
      );
    }
    if (finalized.outcome === 'manual_required') {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'auth.apple.manual_revocation_required',
          userRef: safeLogReference('user', userId),
        })
      );
      return c.json({
        message: '账号已注销，7 天内重新登录可恢复',
        code: 'APPLE_MANUAL_REVOKE_REQUIRED',
        apple_revocation: 'manual_required',
        manual_revoke_instructions:
          '请在 Apple 账户设置的“使用 Apple 登录”中停止使用本 App。',
      });
    }
    return c.json({
      message: '账号已注销，7 天内重新登录可恢复',
      apple_revocation: finalized.outcome,
    });
  });

  return app;
}

// ─── helpers ────────────────────────────────────────────────────────

async function issueSession(user: typeof schema.users.$inferSelect) {
  const tokens = await createLoginSession(user.id);
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    user: sanitizeUser(user),
  };
}

function sanitizeUser(u: typeof schema.users.$inferSelect) {
  return {
    id: u.id,
    nickname: u.nickname,
    phone: u.phone,
    email: u.email,
    created_at: u.createdAt.toISOString(),
  };
}

async function recordConsentReceipt(
  userId: string,
  receipt: ValidConsentReceipt,
  source: string
): Promise<void> {
  await db
    .insert(schema.consentReceipts)
    .values({
      userId,
      consentVersion: receipt.version,
      acceptedAt: receipt.acceptedAt,
      source,
    })
    .onConflictDoNothing({
      target: [
        schema.consentReceipts.userId,
        schema.consentReceipts.consentVersion,
      ],
    });
}

function logAppleFailure(event: string, error: unknown, userId?: string): void {
  const compensationError =
    error instanceof AppleLoginCompensationError ? error : undefined;
  const cause = compensationError?.originalError ?? error;
  const appleError = cause instanceof AppleServerError ? cause : undefined;
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      userRef: safeLogReference('user', userId),
      errorKind:
        appleError?.kind ||
        (cause instanceof AppleIdentityMismatchError
          ? 'identity_mismatch'
          : cause instanceof AppleCredentialError
            ? 'credential_error'
            : 'verification_error'),
      upstreamStatus: appleError?.httpStatus,
      upstreamCode: appleError?.upstreamCode,
      compensationCleanupQueued: compensationError?.cleanupQueued,
    })
  );
}
