import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requireUser, type AuthVars } from '../auth/middleware.js';
import {
  AppleStoreError,
  AppleStoreService,
} from '../subscriptions/apple-store.js';
import { readFreeUsage } from '../subscriptions/free-quota.js';

const transactionSchema = z
  .object({ signed_transaction: z.string().min(100).max(32_000) })
  .strict();
const notificationSchema = z
  .object({ signedPayload: z.string().min(100).max(64_000) })
  .strict();

export function createSubscriptionRouter(service: AppleStoreService) {
  const router = new Hono<{ Variables: AuthVars }>();

  // Apple must be able to reach this endpoint without PhotoSpeak auth. The
  // notification's certificate chain and app identity are the authentication.
  router.post('/apple/notifications', bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: 'notification body too large' }, 413),
  }), async (c) => {
    const parsed = notificationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid notification body' }, 400);
    }
    try {
      await service.processNotification(parsed.data.signedPayload);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AppleStoreError) {
        return c.json({ error: error.message, code: error.code }, error.status as never);
      }
      throw error;
    }
  });

  router.use('/me', requireUser());
  router.use('/apple/transactions', requireUser());

  router.get('/me', async (c) => {
    const userId = c.get('userId');
    const [subscription, usage] = await Promise.all([
      service.snapshot(userId),
      readFreeUsage(userId),
    ]);
    return c.json({ ...subscription, usage });
  });

  router.post(
    '/apple/transactions',
    zValidator('json', transactionSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: '购买凭证格式无效', code: 'VALIDATION_ERROR' },
          400
        );
      }
    }),
    async (c) => {
      try {
        const userId = c.get('userId');
        const [subscription, usage] = await Promise.all([
          service.verifyDeviceTransaction(
            userId,
            c.req.valid('json').signed_transaction
          ),
          readFreeUsage(userId),
        ]);
        return c.json({ ...subscription, usage });
      } catch (error) {
        if (error instanceof AppleStoreError) {
          return c.json(
            { error: error.message, code: error.code },
            error.status as never
          );
        }
        throw error;
      }
    }
  );

  return router;
}
