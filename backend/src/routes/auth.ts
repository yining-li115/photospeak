import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import {
  signAccess,
  signRefresh,
  refreshExpiresAt,
  verifyToken,
} from '../auth/jwt.js';
import {
  requireUser,
  type AuthVars,
} from '../auth/middleware.js';
import { verifyAppleIdentityToken } from '../auth/apple.js';
import {
  sendVerifyCode,
  checkVerifyCode,
  SmsThrottledError,
  SmsUnavailableError,
} from '../auth/sms.js';

interface Config {
  /** iOS bundle id — Apple's identity token's `aud` claim. */
  appleBundleId: string;
  /** Master switch for /send-code + /verify (phone path). */
  phoneLoginEnabled: boolean;
}

const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{6}$/;

export function createAuthRouter(config: Config) {
  const app = new Hono<{ Variables: AuthVars }>();

  // ─── POST /auth/apple ─────────────────────────────────────────────
  app.post('/apple', async (c) => {
    let body: { identity_token?: string; full_name?: { givenName?: string; familyName?: string } | null } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const identityToken = body.identity_token;
    if (!identityToken || typeof identityToken !== 'string') {
      return c.json({ error: 'identity_token is required' }, 400);
    }

    let identity;
    try {
      identity = await verifyAppleIdentityToken(
        identityToken,
        config.appleBundleId
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Apple token verification failed: ${msg}` }, 401);
    }

    // Upsert user.
    const [existing] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.appleUserId, identity.sub))
      .limit(1);

    let user = existing;
    if (!user) {
      const givenName = body.full_name?.givenName ?? '';
      const familyName = body.full_name?.familyName ?? '';
      // Apple sends fullName ONLY on the first login; subsequent logins
      // get null. So fall back to a tail-of-sub placeholder if missing.
      const nickname =
        [familyName, givenName].filter(Boolean).join('') ||
        `用户${identity.sub.slice(-4)}`;

      const [created] = await db
        .insert(schema.users)
        .values({
          appleUserId: identity.sub,
          email: identity.email,
          nickname,
        })
        .returning();
      user = created;
    } else if (user.deletedAt) {
      // Reactivate within cooldown — clear deleted_at.
      const [reactivated] = await db
        .update(schema.users)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id))
        .returning();
      user = reactivated;
    }

    return c.json(await issueSession(user));
  });

  // ─── POST /auth/send-code (phone) ─────────────────────────────────
  app.post('/send-code', async (c) => {
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
    if (!phone || !PHONE_RE.test(phone)) {
      return c.json({ error: '请输入有效的手机号' }, 400);
    }
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
    return c.json({ message: '验证码已发送' });
  });

  // ─── POST /auth/verify (phone) ────────────────────────────────────
  app.post('/verify', async (c) => {
    if (!config.phoneLoginEnabled) {
      return c.json({ error: '手机号登录暂未开放' }, 403);
    }
    let body: { phone?: string; code?: string; nickname?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const phone = body.phone;
    const code = body.code;
    if (!phone || !PHONE_RE.test(phone)) {
      return c.json({ error: '手机号无效' }, 400);
    }
    if (!code || !CODE_RE.test(code)) {
      return c.json({ error: '请输入 6 位验证码' }, 400);
    }

    let isValid: boolean;
    try {
      isValid = await checkVerifyCode(phone, code);
    } catch {
      return c.json({ error: '验证码服务暂时不可用' }, 503);
    }
    if (!isValid) {
      return c.json({ error: '验证码错误或已过期' }, 401);
    }

    // Upsert user by phone (active rows only).
    const [existing] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.phone, phone), isNull(schema.users.deletedAt)))
      .limit(1);

    let user = existing;
    if (!user) {
      const nickname = body.nickname?.trim() || `用户${phone.slice(-4)}`;
      const [created] = await db
        .insert(schema.users)
        .values({ phone, nickname })
        .returning();
      user = created;
    }

    return c.json(await issueSession(user));
  });

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

    // Token must (a) verify cryptographically AND (b) still be in
    // refresh_tokens with revoked=false. Either check alone isn't
    // enough — JWT-only would let a logout-revoked token still work;
    // DB-only would let an expired-but-still-rowed token through.
    let payload;
    try {
      payload = verifyToken(refreshToken, 'refresh');
    } catch {
      return c.json({ error: 'invalid refresh token' }, 401);
    }
    const [stored] = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.token, refreshToken))
      .limit(1);
    if (!stored || stored.revoked || stored.expiresAt.getTime() < Date.now()) {
      return c.json({ error: 'invalid refresh token' }, 401);
    }

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, payload.sub))
      .limit(1);
    if (!user || user.deletedAt) {
      return c.json({ error: 'user not found' }, 401);
    }

    return c.json({ access_token: signAccess(user.id) });
  });

  // ─── DELETE /auth/logout ──────────────────────────────────────────
  app.delete('/logout', requireUser(), async (c) => {
    let body: { refresh_token?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // logout body is optional — we'll just no-op the token revoke.
    }
    const refreshToken = body.refresh_token;
    if (refreshToken) {
      await db
        .update(schema.refreshTokens)
        .set({ revoked: true })
        .where(
          and(
            eq(schema.refreshTokens.token, refreshToken),
            eq(schema.refreshTokens.userId, c.get('userId'))
          )
        );
    }
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
  app.delete('/me', requireUser(), async (c) => {
    const userId = c.get('userId');
    const now = new Date();
    await db
      .update(schema.users)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.users.id, userId));
    await db
      .update(schema.refreshTokens)
      .set({ revoked: true })
      .where(eq(schema.refreshTokens.userId, userId));
    return c.json({ message: '账号已注销，7 天内重新登录可恢复' });
  });

  return app;
}

// ─── helpers ────────────────────────────────────────────────────────

async function issueSession(user: typeof schema.users.$inferSelect) {
  const access = signAccess(user.id);
  const refresh = signRefresh(user.id);
  await db.insert(schema.refreshTokens).values({
    token: refresh,
    userId: user.id,
    expiresAt: refreshExpiresAt(),
  });
  return {
    access_token: access,
    refresh_token: refresh,
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
