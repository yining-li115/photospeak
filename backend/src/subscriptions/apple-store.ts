import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Environment,
  SignedDataVerifier,
  Status,
  type JWSTransactionDecodedPayload,
  type JWSRenewalInfoDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { eq, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export const APPLE_PLUS_MONTHLY_PRODUCT =
  'com.yining.photospeak.plus.monthly';
export const APPLE_PLUS_ANNUAL_PRODUCT =
  'com.yining.photospeak.plus.annual';

const PLUS_PRODUCTS = new Set([
  APPLE_PLUS_MONTHLY_PRODUCT,
  APPLE_PLUS_ANNUAL_PRODUCT,
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AppleStoreConfig {
  bundleId: string;
  appAppleId: number;
  rootCertificatePaths: string[];
  enableOnlineChecks: boolean;
}

export interface SubscriptionSnapshot {
  plan: 'free' | 'plus';
  status: string;
  productId: string | null;
  currentPeriodEnd: string | null;
}

export class AppleStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'AppleStoreError';
  }
}

/**
 * Server-authoritative Apple subscription verifier. The untrusted JWS payload
 * is read only to select Sandbox vs Production; the chosen verifier still
 * validates the certificate chain, bundle id, app id and environment.
 */
export class AppleStoreService {
  private readonly production: SignedDataVerifier;
  private readonly sandbox: SignedDataVerifier;

  constructor(config: AppleStoreConfig) {
    const roots = config.rootCertificatePaths.map((path) => readFileSync(path));
    if (roots.length === 0) {
      throw new Error('APPLE_ROOT_CA_PATHS must contain at least one certificate');
    }
    this.production = new SignedDataVerifier(
      roots,
      config.enableOnlineChecks,
      Environment.PRODUCTION,
      config.bundleId,
      config.appAppleId
    );
    this.sandbox = new SignedDataVerifier(
      roots,
      config.enableOnlineChecks,
      Environment.SANDBOX,
      config.bundleId
    );
  }

  async verifyDeviceTransaction(
    userId: string,
    signedTransaction: string
  ): Promise<SubscriptionSnapshot> {
    const transaction = await this.verifyTransaction(signedTransaction);
    const normalized = normalizeTransaction(transaction, signedTransaction);
    if (normalized.appAccountToken !== userId) {
      throw new AppleStoreError(
        'APPLE_ACCOUNT_MISMATCH',
        '此购买记录不属于当前 PhotoSpeak 账号',
        409
      );
    }

    await this.persistTransaction(userId, normalized);
    const active =
      !normalized.revokedAt && normalized.expiresAt.getTime() > Date.now();
    // Device submissions may contain an old restored transaction. They can
    // grant a currently valid entitlement, but only server notifications are
    // allowed to revoke or expire one. This prevents a freshly signed JWS for
    // an older period from overwriting a newer renewal.
    if (active) {
      await this.applyEntitlementEvent({
        userId,
        productId: normalized.productId,
        originalTransactionId: normalized.originalTransactionId,
        eventSignedAt: normalized.signedAt,
        periodEnd: normalized.expiresAt,
        active: true,
        status: 'active',
      });
    }
    return this.snapshot(userId);
  }

  async processNotification(signedPayload: string): Promise<void> {
    const verifier = this.verifierFor(signedPayload);
    let notification: ResponseBodyV2DecodedPayload;
    try {
      notification = await verifier.verifyAndDecodeNotification(signedPayload);
    } catch {
      throw new AppleStoreError(
        'APPLE_NOTIFICATION_INVALID',
        'invalid signed notification',
        400
      );
    }

    const notificationUuid = requiredString(
      notification.notificationUUID,
      'notificationUUID'
    );
    const notificationType = requiredString(
      notification.notificationType,
      'notificationType'
    );
    const eventSignedAt = dateFromMillis(notification.signedDate, 'signedDate');
    const environment = requiredString(
      notification.data?.environment ?? readJwsEnvironment(signedPayload),
      'environment'
    );
    const payloadSha256 = sha256(signedPayload);

    const alreadyProcessed = await db
      .select({ id: schema.appStoreNotifications.notificationUuid })
      .from(schema.appStoreNotifications)
      .where(eq(schema.appStoreNotifications.notificationUuid, notificationUuid))
      .limit(1);
    if (alreadyProcessed.length > 0) return;

    const signedTransaction = notification.data?.signedTransactionInfo;
    if (!signedTransaction) {
      await db.insert(schema.appStoreNotifications).values({
        notificationUuid,
        notificationType,
        subtype: notification.subtype,
        environment,
        payloadSha256,
        signedAt: eventSignedAt,
      }).onConflictDoNothing();
      return;
    }

    const transaction = await verifier.verifyAndDecodeTransaction(
      signedTransaction
    );
    const normalized = normalizeTransaction(transaction, signedTransaction);
    let renewal: JWSRenewalInfoDecodedPayload | undefined;
    if (notification.data?.signedRenewalInfo) {
      renewal = await verifier.verifyAndDecodeRenewalInfo(
        notification.data.signedRenewalInfo
      );
    }

    const userId = await this.resolveNotificationUser(normalized);
    if (!userId) {
      // Apple can send a notification before the device verification request
      // reaches us. Return a non-2xx response so Apple retries; once the client
      // binds the original transaction to an account the retry becomes safe.
      throw new AppleStoreError(
        'APPLE_TRANSACTION_UNBOUND',
        'subscription transaction is not bound to an account yet',
        503
      );
    }

    await db.transaction(async (tx) => {
      await tx.insert(schema.appStoreNotifications).values({
        notificationUuid,
        notificationType,
        subtype: notification.subtype,
        environment,
        originalTransactionId: normalized.originalTransactionId,
        payloadSha256,
        signedAt: eventSignedAt,
      }).onConflictDoNothing();
      await upsertTransaction(tx, userId, normalized);
    });

    const graceEnd = optionalDateFromMillis(renewal?.gracePeriodExpiresDate);
    const dataStatus = notification.data?.status;
    const periodEnd = latestDate(normalized.expiresAt, graceEnd);
    const activeStatus =
      dataStatus === undefined ||
      dataStatus === Status.ACTIVE ||
      dataStatus === Status.BILLING_GRACE_PERIOD;
    const active =
      !normalized.revokedAt &&
      activeStatus &&
      periodEnd.getTime() > Date.now();
    await this.applyEntitlementEvent({
      userId,
      productId: normalized.productId,
      originalTransactionId: normalized.originalTransactionId,
      eventSignedAt,
      periodEnd,
      active,
      status: active
        ? dataStatus === Status.BILLING_GRACE_PERIOD
          ? 'grace_period'
          : 'active'
        : normalized.revokedAt
          ? 'revoked'
          : 'expired',
    });
  }

  async snapshot(userId: string): Promise<SubscriptionSnapshot> {
    const [row] = await db
      .select({
        plan: schema.userEntitlements.plan,
        status: schema.userEntitlements.status,
        productId: schema.userEntitlements.storeProductId,
        currentPeriodEnd: schema.userEntitlements.currentPeriodEnd,
      })
      .from(schema.userEntitlements)
      .where(eq(schema.userEntitlements.userId, userId))
      .limit(1);
    const active =
      row?.plan === 'plus' &&
      (row.status === 'active' || row.status === 'grace_period') &&
      !!row.currentPeriodEnd &&
      row.currentPeriodEnd.getTime() > Date.now();
    return {
      plan: active ? 'plus' : 'free',
      status: row?.status ?? 'free',
      productId: row?.productId ?? null,
      currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  private verifierFor(jws: string): SignedDataVerifier {
    const environment = readJwsEnvironment(jws);
    if (environment === Environment.PRODUCTION) return this.production;
    if (environment === Environment.SANDBOX) return this.sandbox;
    throw new AppleStoreError(
      'APPLE_ENVIRONMENT_INVALID',
      'unsupported App Store environment',
      400
    );
  }

  private async verifyTransaction(jws: string) {
    if (jws.length < 100 || jws.length > 32_000) {
      throw new AppleStoreError(
        'APPLE_TRANSACTION_INVALID',
        '购买凭证格式无效',
        400
      );
    }
    try {
      return await this.verifierFor(jws).verifyAndDecodeTransaction(jws);
    } catch (error) {
      if (error instanceof AppleStoreError) throw error;
      throw new AppleStoreError(
        'APPLE_TRANSACTION_INVALID',
        '无法验证 App Store 购买记录',
        400
      );
    }
  }

  private async resolveNotificationUser(
    transaction: NormalizedTransaction
  ): Promise<string | null> {
    const [existing] = await db
      .select({ userId: schema.appStoreTransactions.userId })
      .from(schema.appStoreTransactions)
      .where(
        eq(
          schema.appStoreTransactions.originalTransactionId,
          transaction.originalTransactionId
        )
      )
      .limit(1);
    if (existing) return existing.userId;

    if (transaction.appAccountToken && UUID.test(transaction.appAccountToken)) {
      const [user] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, transaction.appAccountToken))
        .limit(1);
      if (user) return user.id;
    }
    return null;
  }

  private async persistTransaction(
    userId: string,
    transaction: NormalizedTransaction
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Every renewal has a different transaction id but shares one original
      // transaction id. Lock the subscription lineage so two accounts cannot
      // win a first-bind race with different renewal transactions.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`app-store:${transaction.originalTransactionId}`}, 0))`
      );
      const [owner] = await tx
        .select({ userId: schema.appStoreTransactions.userId })
        .from(schema.appStoreTransactions)
        .where(
          eq(
            schema.appStoreTransactions.originalTransactionId,
            transaction.originalTransactionId
          )
        )
        .limit(1);
      if (owner && owner.userId !== userId) {
        throw new AppleStoreError(
          'APPLE_PURCHASE_ALREADY_BOUND',
          '此订阅已绑定其他 PhotoSpeak 账号',
          409
        );
      }
      await upsertTransaction(tx, userId, transaction);
    });
  }

  private async applyEntitlementEvent(input: {
    userId: string;
    productId: string;
    originalTransactionId: string;
    eventSignedAt: Date;
    periodEnd: Date;
    active: boolean;
    status: string;
  }): Promise<void> {
    const plan = input.active ? 'plus' : 'free';
    await db
      .insert(schema.userEntitlements)
      .values({
        userId: input.userId,
        plan,
        status: input.status,
        source: 'apple',
        storeProductId: input.productId,
        originalTransactionId: input.originalTransactionId,
        storeEventSignedAt: input.eventSignedAt,
        currentPeriodEnd: input.periodEnd,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.userEntitlements.userId,
        set: {
          plan,
          status: input.status,
          source: 'apple',
          storeProductId: input.productId,
          originalTransactionId: input.originalTransactionId,
          storeEventSignedAt: input.eventSignedAt,
          currentPeriodEnd: input.periodEnd,
          updatedAt: new Date(),
        },
        setWhere: or(
          isNull(schema.userEntitlements.storeEventSignedAt),
          sql`${schema.userEntitlements.storeEventSignedAt} < ${input.eventSignedAt}`
        ),
      });
  }
}

interface NormalizedTransaction {
  transactionId: string;
  originalTransactionId: string;
  appAccountToken: string;
  productId: string;
  environment: string;
  ownershipType?: string;
  purchaseAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  signedAt: Date;
  payloadSha256: string;
}

function normalizeTransaction(
  value: JWSTransactionDecodedPayload,
  signedTransaction: string
): NormalizedTransaction {
  const productId = requiredString(value.productId, 'productId');
  if (!PLUS_PRODUCTS.has(productId)) {
    throw new AppleStoreError(
      'APPLE_PRODUCT_INVALID',
      '未知的 PhotoSpeak 订阅商品',
      400
    );
  }
  const appAccountToken = requiredString(
    value.appAccountToken,
    'appAccountToken'
  );
  if (!UUID.test(appAccountToken)) {
    throw new AppleStoreError(
      'APPLE_ACCOUNT_TOKEN_INVALID',
      '购买记录缺少有效账号绑定',
      400
    );
  }
  return {
    transactionId: requiredString(value.transactionId, 'transactionId'),
    originalTransactionId: requiredString(
      value.originalTransactionId,
      'originalTransactionId'
    ),
    appAccountToken,
    productId,
    environment: requiredString(value.environment, 'environment'),
    ownershipType:
      typeof value.inAppOwnershipType === 'string'
        ? value.inAppOwnershipType
        : undefined,
    purchaseAt: dateFromMillis(value.purchaseDate, 'purchaseDate'),
    expiresAt: dateFromMillis(value.expiresDate, 'expiresDate'),
    revokedAt: optionalDateFromMillis(value.revocationDate),
    signedAt: dateFromMillis(value.signedDate, 'signedDate'),
    payloadSha256: sha256(signedTransaction),
  };
}

type TransactionExecutor = Pick<typeof db, 'insert'>;

async function upsertTransaction(
  executor: TransactionExecutor,
  userId: string,
  value: NormalizedTransaction
): Promise<void> {
  await executor
    .insert(schema.appStoreTransactions)
    .values({
      transactionId: value.transactionId,
      originalTransactionId: value.originalTransactionId,
      userId,
      productId: value.productId,
      environment: value.environment,
      ownershipType: value.ownershipType,
      purchaseAt: value.purchaseAt,
      expiresAt: value.expiresAt,
      revokedAt: value.revokedAt,
      signedAt: value.signedAt,
      payloadSha256: value.payloadSha256,
    })
    .onConflictDoUpdate({
      target: schema.appStoreTransactions.transactionId,
      set: {
        expiresAt: value.expiresAt,
        revokedAt: value.revokedAt,
        signedAt: value.signedAt,
        payloadSha256: value.payloadSha256,
        updatedAt: new Date(),
      },
    });
}

function readJwsEnvironment(jws: string): string {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts[1].length > 24_000) {
    throw new AppleStoreError(
      'APPLE_JWS_INVALID',
      'invalid App Store signed payload',
      400
    );
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as { environment?: unknown; data?: { environment?: unknown } };
    const environment = payload.environment ?? payload.data?.environment;
    return requiredString(environment, 'environment');
  } catch (error) {
    if (error instanceof AppleStoreError) throw error;
    throw new AppleStoreError(
      'APPLE_JWS_INVALID',
      'invalid App Store signed payload',
      400
    );
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new AppleStoreError(
      'APPLE_PAYLOAD_INVALID',
      `missing ${field}`,
      400
    );
  }
  return value;
}

function dateFromMillis(value: unknown, field: string): Date {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppleStoreError(
      'APPLE_PAYLOAD_INVALID',
      `missing ${field}`,
      400
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppleStoreError(
      'APPLE_PAYLOAD_INVALID',
      `invalid ${field}`,
      400
    );
  }
  return date;
}

function optionalDateFromMillis(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  return dateFromMillis(value, 'date');
}

function latestDate(a: Date, b: Date | null): Date {
  return b && b.getTime() > a.getTime() ? b : a;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
