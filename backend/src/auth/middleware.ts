import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { verifyToken } from './jwt.js';

export type AuthVars = {
  userId: string;
  sessionId: string;
  authenticatedAt: Date;
  plan: string;
};

function logAuth(c: Context, userId: string): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'auth',
      path: c.req.path,
      method: c.req.method,
      mode: 'jwt',
      userId,
      clientVersion: c.req.header('x-client-version') || '',
      clientPlatform: c.req.header('x-client-platform') || '',
    })
  );
}

/**
 * Authenticate a PhotoSpeak access token and verify that its owner is still
 * active. The database lookup is deliberate: account deletion takes effect
 * immediately rather than waiting for a stateless JWT to expire.
 */
export function requireUser(options?: {
  /** Only the deletion endpoint may resume a durable in-progress saga. */
  allowDeleting?: boolean;
}): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      return c.json(
        { error: 'unauthorized', code: 'AUTH_ACCESS_EXPIRED' },
        401
      );
    }

    let payload;
    try {
      payload = verifyToken(header.slice(7), 'access');
    } catch {
      return c.json(
        { error: 'unauthorized', code: 'AUTH_ACCESS_EXPIRED' },
        401
      );
    }

    const [activeUser] = await db
      .select({
        id: schema.users.id,
        sessionId: schema.authSessions.id,
        authenticatedAt: schema.authSessions.authenticatedAt,
        plan: schema.userEntitlements.plan,
        entitlementStatus: schema.userEntitlements.status,
        currentPeriodEnd: schema.userEntitlements.currentPeriodEnd,
      })
      .from(schema.users)
      .innerJoin(
        schema.authSessions,
        and(
          eq(schema.authSessions.id, payload.sid),
          eq(schema.authSessions.userId, schema.users.id),
          isNull(schema.authSessions.revokedAt),
          gt(schema.authSessions.expiresAt, new Date())
        )
      )
      .leftJoin(
        schema.userEntitlements,
        eq(schema.userEntitlements.userId, schema.users.id)
      )
      .where(
        and(
          eq(schema.users.id, payload.sub),
          isNull(schema.users.deletedAt),
          options?.allowDeleting
            ? undefined
            : eq(schema.users.deletionState, 'active')
        )
      )
      .limit(1);
    if (!activeUser) {
      // A deletion request can commit and revoke the session after the mobile
      // client sent it but before the HTTP response reaches the phone. Return
      // an authenticated account-state signal so that a later retry/startup
      // can finish the already-authorized local wipe without guessing from a
      // generic 401. A merely revoked/expired session for an active account
      // still receives the ordinary AUTH_ACCESS_EXPIRED response below.
      const [account] = await db
        .select({
          deletedAt: schema.users.deletedAt,
          deletionState: schema.users.deletionState,
        })
        .from(schema.users)
        .where(eq(schema.users.id, payload.sub))
        .limit(1);
      if (account?.deletedAt || account?.deletionState === 'deleted') {
        return c.json(
          { error: 'account deleted', code: 'AUTH_ACCOUNT_DELETED' },
          410
        );
      }
      if (account?.deletionState === 'deleting') {
        return c.json(
          {
            error: 'account deletion is in progress',
            code: 'AUTH_ACCOUNT_DELETING',
          },
          409
        );
      }
      return c.json(
        { error: 'unauthorized', code: 'AUTH_ACCESS_EXPIRED' },
        401
      );
    }
    if (
      Math.abs(
        activeUser.authenticatedAt.getTime() - payload.auth_time * 1_000
      ) >= 1_000
    ) {
      return c.json(
        { error: 'unauthorized', code: 'AUTH_ACCESS_EXPIRED' },
        401
      );
    }

    c.set('userId', payload.sub);
    c.set('sessionId', activeUser.sessionId);
    c.set('authenticatedAt', activeUser.authenticatedAt);
    const entitlementActive =
      (activeUser.entitlementStatus === 'active' ||
        activeUser.entitlementStatus === 'grace_period') &&
      (!activeUser.currentPeriodEnd ||
        activeUser.currentPeriodEnd.getTime() > Date.now());
    c.set('plan', entitlementActive ? activeUser.plan || 'free' : 'free');
    logAuth(c, payload.sub);
    await next();
  };
}
