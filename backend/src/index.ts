import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { AiGateway, type AiPricing } from './ai/gateway.js';
import {
  AiRequestHasher,
  AiResultVault,
  parseAiCryptoConfig,
  type AiCryptoConfig,
} from './ai/idempotency-crypto.js';
import { PostgresAiOperationStore } from './ai/idempotency-store.js';
import { AiOperationService } from './ai/idempotency.js';
import { parseAiRecoveryFenceCutoff } from './ai/idempotency-key.js';
import { AiOrchestrator } from './ai/orchestrator.js';
import {
  ChatCompletionsSpeechProvider,
  type ChatCompletionsSpeechProviderConfig,
  OpenAiCompatibleTextProvider,
  type OpenAiCompatibleTextProviderConfig,
} from './ai/openai-compatible-provider.js';
import type { SpeechAiProvider } from './ai/types.js';
import {
  VolcengineTtsProvider,
  type VolcengineTtsProviderConfig,
} from './ai/volcengine-tts-provider.js';
import { jwtPublicConfig } from './auth/jwt.js';
import { type AuthVars } from './auth/middleware.js';
import {
  parseAppReviewAccessConfig,
  type AppReviewAccessConfig,
} from './auth/app-review-access.js';
import { checkDatabase, closeDatabase } from './db/client.js';
import {
  landingHtml,
  privacyHtml,
  supportHtml,
  termsHtml,
} from './legal.js';
import { requireSupportedClient } from './middleware/client-version.js';
import { safeLogReference } from './logging/safe-reference.js';
import { createAuthRouter } from './routes/auth.js';
import { createAiRouter } from './routes/ai.js';
import { createSubscriptionRouter } from './routes/subscriptions.js';
import { createTranscribeRouter } from './routes/transcribe.js';
import { attachTranscriptionRelay } from './transcription/relay.js';
import {
  VolcengineAsrProvider,
  type VolcengineAsrProviderConfig,
} from './transcription/volcengine-provider.js';
import { drainForShutdown } from './services/graceful-shutdown.js';
import { AppleStoreService } from './subscriptions/apple-store.js';

type SpeechProviderConfig =
  | {
      adapter: 'chat-completions';
      config: ChatCompletionsSpeechProviderConfig;
    }
  | {
      adapter: 'volcengine-v3-http';
      config: VolcengineTtsProviderConfig;
    };

interface Env {
  /** iOS bundle identifier — used as the `aud` claim when verifying
   *  Apple identity tokens. Must match `ios.bundleIdentifier` in
   *  app.json. */
  APPLE_BUNDLE_ID: string;
  PHONE_LOGIN_ENABLED: boolean;
  appReviewAccess: AppReviewAccessConfig;
  TRUST_PROXY: boolean;
  AI_REQUESTS_PER_MINUTE: number;
  AI_GLOBAL_CONCURRENCY: number;
  AI_FREE_DAILY_SAFETY_LIMIT: number;
  AI_PLUS_DAILY_SAFETY_LIMIT: number;
  AI_FREE_DAILY_COST_LIMIT_MICROS?: number;
  AI_PLUS_DAILY_COST_LIMIT_MICROS?: number;
  TRANSCRIBE_MAX_CONCURRENCY: number;
  MIN_IOS_CLIENT_BUILD: number;
  MIN_ANDROID_CLIENT_BUILD: number;
  textAi: OpenAiCompatibleTextProviderConfig;
  speechAi: SpeechProviderConfig;
  transcriptionAi: VolcengineAsrProviderConfig;
  pricing: AiPricing;
  aiCrypto: AiCryptoConfig;
  aiRecoveryFenceCutoff: Date | null;
  legalAiProviderName: string;
  legalAiProviderUrl?: string;
  legalDiagnosticsRegion: string;
  legalDiagnosticsRetentionDays: number;
  appleStore: {
    appAppleId: number;
    rootCertificatePaths: string[];
    enableOnlineChecks: boolean;
  };
}

function readEnv(): Env {
  const e = process.env;
  const required = (name: string): string => {
    const value = e[name]?.trim();
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
  };
  const requiredHttpsUrl = (name: string): string => {
    const value = required(name);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid URL in ${name}`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error(`${name} must be an HTTPS URL without embedded credentials`);
    }
    return value.replace(/\/$/, '');
  };
  const requiredWssUrl = (name: string, allowedHost: string): string => {
    const value = required(name);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid URL in ${name}`);
    }
    if (
      parsed.protocol !== 'wss:' ||
      parsed.hostname !== allowedHost ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error(
        `${name} must be a WSS URL on ${allowedHost} without credentials`
      );
    }
    return value.replace(/\/$/, '');
  };
  for (const k of ['APPLE_BUNDLE_ID', 'JWT_SECRET', 'DATABASE_URL']) {
    if (!e[k]) throw new Error(`Missing required env var: ${k}`);
  }
  const chatProviderName = required('AI_CHAT_PROVIDER');
  const speechProviderName = required('AI_TTS_PROVIDER');
  const asrProviderName = required('AI_ASR_PROVIDER');
  if (asrProviderName !== 'volcengine-seed') {
    throw new Error(
      `Unsupported AI_ASR_PROVIDER: ${asrProviderName}. ` +
        'Install a dedicated streaming adapter before changing providers.'
    );
  }
  const speechAdapter = required('AI_TTS_ADAPTER');
  if (
    speechAdapter !== 'chat-completions' &&
    speechAdapter !== 'volcengine-v3-http'
  ) {
    throw new Error(
      `Unsupported AI_TTS_ADAPTER: ${speechAdapter}. ` +
        'Install a dedicated speech adapter before changing protocols.'
    );
  }
  const authStyle = (value: string | undefined): 'api-key' | 'bearer' => {
    const parsed = value || 'bearer';
    if (parsed !== 'api-key' && parsed !== 'bearer') {
      throw new Error(`Invalid AI auth style: ${parsed}`);
    }
    return parsed;
  };
  const positiveInt = (value: string | undefined, fallback: number) => {
    const parsed = Number(value ?? fallback);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const optionalNonNegative = (value: string | undefined) => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid non-negative price value: ${value}`);
    }
    return parsed;
  };
  const optionalCurrencyMicros = (value: string | undefined) => {
    const parsed = optionalNonNegative(value);
    return parsed === undefined ? undefined : Math.round(parsed * 1_000_000);
  };
  const booleanValue = (value: string | undefined, fallback: boolean) => {
    if (value === undefined || value === '') return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Invalid boolean value: ${value}`);
  };
  const boundedInt = (
    name: string,
    value: string | undefined,
    fallback: number,
    min: number,
    max: number
  ) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return parsed;
  };
  const speechTimeoutMs = positiveInt(e.AI_TTS_TIMEOUT_MS, 60_000);
  let speechAi: SpeechProviderConfig;
  if (speechAdapter === 'volcengine-v3-http') {
    if (e.AI_TTS_FORMAT && e.AI_TTS_FORMAT !== 'mp3') {
      throw new Error('Volcengine V3 HTTP adapter currently requires MP3');
    }
    const resourceId = e.AI_TTS_RESOURCE_ID?.trim() || 'seed-tts-2.0';
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(resourceId)) {
      throw new Error('Invalid AI_TTS_RESOURCE_ID');
    }
    speechAi = {
      adapter: 'volcengine-v3-http',
      config: {
        name: speechProviderName,
        apiKey: required('AI_TTS_API_KEY'),
        resourceId,
        voice: required('AI_TTS_VOICE'),
        timeoutMs: speechTimeoutMs,
      },
    };
  } else {
    const ttsFormat = e.AI_TTS_FORMAT || 'mp3';
    if (!['wav', 'mp3', 'ogg_opus'].includes(ttsFormat)) {
      throw new Error(`Invalid AI_TTS_FORMAT: ${ttsFormat}`);
    }
    speechAi = {
      adapter: 'chat-completions',
      config: {
        name: speechProviderName,
        baseUrl: requiredHttpsUrl('AI_TTS_BASE_URL'),
        apiKey: required('AI_TTS_API_KEY'),
        authStyle: authStyle(e.AI_TTS_AUTH_STYLE),
        model: required('AI_TTS_MODEL'),
        voice: required('AI_TTS_VOICE'),
        format: ttsFormat as 'wav' | 'mp3' | 'ogg_opus',
        timeoutMs: speechTimeoutMs,
      },
    };
  }
  const chatInputPrice = optionalNonNegative(
    e.AI_CHAT_INPUT_PRICE_PER_MILLION
  );
  const chatOutputPrice = optionalNonNegative(
    e.AI_CHAT_OUTPUT_PRICE_PER_MILLION
  );
  const speechInputPrice = optionalNonNegative(
    e.AI_TTS_INPUT_PRICE_PER_MILLION
  );
  const speechOutputPrice = optionalNonNegative(
    e.AI_TTS_OUTPUT_PRICE_PER_MILLION
  );
  const asrResourceId =
    e.AI_ASR_RESOURCE_ID?.trim() || 'volc.seedasr.sauc.duration';
  if (!/^volc\.[A-Za-z0-9._-]{1,100}$/.test(asrResourceId)) {
    throw new Error('Invalid AI_ASR_RESOURCE_ID');
  }
  const asrPricePerHour = optionalNonNegative(e.AI_ASR_PRICE_PER_HOUR);
  const appAppleId = boundedInt(
    'APPLE_APP_ID',
    required('APPLE_APP_ID'),
    1,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const rootCertificatePaths = required('APPLE_ROOT_CA_PATHS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(process.cwd(), value));
  if (rootCertificatePaths.length === 0) {
    throw new Error('APPLE_ROOT_CA_PATHS must contain at least one path');
  }
  return {
    APPLE_BUNDLE_ID: e.APPLE_BUNDLE_ID!,
    PHONE_LOGIN_ENABLED: e.PHONE_LOGIN_ENABLED === 'true',
    appReviewAccess: parseAppReviewAccessConfig({
      enabled: e.APP_REVIEW_ACCESS_ENABLED,
      phone: e.APP_REVIEW_PHONE,
      codeHmac: e.APP_REVIEW_CODE_HMAC,
      hmacKey: e.JWT_SECRET,
    }),
    TRUST_PROXY: e.TRUST_PROXY === 'true',
    AI_REQUESTS_PER_MINUTE: positiveInt(e.AI_REQUESTS_PER_MINUTE, 60),
    AI_GLOBAL_CONCURRENCY: positiveInt(e.AI_GLOBAL_CONCURRENCY, 4),
    AI_FREE_DAILY_SAFETY_LIMIT: positiveInt(
      e.AI_FREE_DAILY_SAFETY_LIMIT,
      200
    ),
    AI_PLUS_DAILY_SAFETY_LIMIT: positiveInt(
      e.AI_PLUS_DAILY_SAFETY_LIMIT,
      1_000
    ),
    AI_FREE_DAILY_COST_LIMIT_MICROS: optionalCurrencyMicros(
      e.AI_FREE_DAILY_COST_LIMIT
    ),
    AI_PLUS_DAILY_COST_LIMIT_MICROS: optionalCurrencyMicros(
      e.AI_PLUS_DAILY_COST_LIMIT
    ),
    TRANSCRIBE_MAX_CONCURRENCY: positiveInt(
      e.TRANSCRIBE_MAX_CONCURRENCY,
      12
    ),
    MIN_IOS_CLIENT_BUILD: positiveInt(e.MIN_IOS_CLIENT_BUILD, 0),
    MIN_ANDROID_CLIENT_BUILD: positiveInt(
      e.MIN_ANDROID_CLIENT_BUILD,
      0
    ),
    textAi: {
      name: chatProviderName,
      baseUrl: requiredHttpsUrl('AI_CHAT_BASE_URL'),
      apiKey: required('AI_CHAT_API_KEY'),
      authStyle: authStyle(e.AI_CHAT_AUTH_STYLE),
      model: required('AI_CHAT_MODEL'),
      maxTokensField:
        e.AI_CHAT_MAX_TOKENS_FIELD === 'max_tokens' ||
        e.AI_CHAT_MAX_TOKENS_FIELD === 'max_completion_tokens'
          ? e.AI_CHAT_MAX_TOKENS_FIELD
          : 'max_tokens',
      timeoutMs: positiveInt(e.AI_CHAT_TIMEOUT_MS, 60_000),
    },
    speechAi,
    transcriptionAi: {
      apiKey: required('AI_ASR_API_KEY'),
      upstreamUrl: requiredWssUrl(
        'AI_ASR_WS_URL',
        'openspeech.bytedance.com'
      ),
      resourceId: asrResourceId,
      enableNonstream: booleanValue(e.AI_ASR_ENABLE_NONSTREAM, true),
      vadSilenceMs: boundedInt(
        'AI_ASR_VAD_SILENCE_MS',
        e.AI_ASR_VAD_SILENCE_MS,
        800,
        200,
        3_000
      ),
      packetMs: boundedInt(
        'AI_ASR_PACKET_MS',
        e.AI_ASR_PACKET_MS,
        200,
        100,
        500
      ),
      pricePerAudioHour: asrPricePerHour,
      billingCurrency: e.AI_BILLING_CURRENCY || 'CNY',
    },
    pricing: {
      chat:
        chatInputPrice !== undefined || chatOutputPrice !== undefined
          ? {
              unit: 'tokens',
              inputPerMillion: chatInputPrice,
              outputPerMillion: chatOutputPrice,
            }
          : undefined,
      speech:
        speechInputPrice !== undefined || speechOutputPrice !== undefined
          ? {
              unit:
                speechAdapter === 'volcengine-v3-http'
                  ? 'characters'
                  : 'tokens',
              inputPerMillion: speechInputPrice,
              outputPerMillion: speechOutputPrice,
            }
          : undefined,
      currency: e.AI_BILLING_CURRENCY || 'CNY',
    },
    aiCrypto: parseAiCryptoConfig({
      activeKeyId: required('AI_IDEMPOTENCY_ACTIVE_KEY_ID'),
      keyRingJson: required('AI_IDEMPOTENCY_KEY_RING'),
      activeHmacKeyId: required('AI_IDEMPOTENCY_HMAC_ACTIVE_KEY_ID'),
      hmacKeyRingJson: required('AI_IDEMPOTENCY_HMAC_KEY_RING'),
    }),
    aiRecoveryFenceCutoff: parseAiRecoveryFenceCutoff(
      e.AI_IDEMPOTENCY_RECOVERY_FENCE_CUTOFF
    ),
    legalAiProviderName: required('AI_PROVIDER_DISPLAY_NAME'),
    legalAiProviderUrl: requiredHttpsUrl('AI_PROVIDER_PRIVACY_URL'),
    legalDiagnosticsRegion: required('SENTRY_DATA_REGION'),
    legalDiagnosticsRetentionDays: positiveInt(
      required('SENTRY_RETENTION_DAYS'),
      30
    ),
    appleStore: {
      appAppleId,
      rootCertificatePaths,
      enableOnlineChecks: booleanValue(e.APPLE_IAP_ONLINE_CHECKS, true),
    },
  };
}

const env = readEnv();
const startedAt = new Date();
const textProvider = new OpenAiCompatibleTextProvider(env.textAi);
const speechProvider: SpeechAiProvider =
  env.speechAi.adapter === 'volcengine-v3-http'
    ? new VolcengineTtsProvider(env.speechAi.config)
    : new ChatCompletionsSpeechProvider(env.speechAi.config);
const transcriptionProvider = new VolcengineAsrProvider(env.transcriptionAi);
const aiGateway = new AiGateway(
  textProvider,
  speechProvider,
  undefined,
  env.pricing
);
const aiOperationStore = new PostgresAiOperationStore();
const aiRequestHasher = new AiRequestHasher(
  env.aiCrypto.activeHmacKeyId,
  env.aiCrypto.hmacKeys
);
await aiOperationStore.assertRequestHashKeysAvailable(
  aiRequestHasher.configuredRequestHashKeyIds()
);
const aiOperations = new AiOperationService(
  aiOperationStore,
  aiRequestHasher,
  new AiResultVault(env.aiCrypto),
  { recoveryFenceCutoff: env.aiRecoveryFenceCutoff }
);
const aiOrchestrator = new AiOrchestrator({
  gateway: aiGateway,
  operations: aiOperations,
  freeDailyCostLimitMicros: env.AI_FREE_DAILY_COST_LIMIT_MICROS,
  plusDailyCostLimitMicros: env.AI_PLUS_DAILY_COST_LIMIT_MICROS,
});
const appleStore = new AppleStoreService({
  bundleId: env.APPLE_BUNDLE_ID,
  ...env.appleStore,
});
const app = new Hono<{ Variables: AuthVars }>();

// No CORS middleware on purpose. The only client today is React
// Native, whose fetch doesn't enforce same-origin policy, and the
// public HTML pages (/privacy, /terms) are reached via direct
// browser navigation rather than cross-origin XHR. If a Web client
// (see optimization.md Q6) materializes, add `cors({ origin: [...] })`
// here scoped to known frontend origins — never wildcard.
//
// Public product page. Liveness remains on /health so the public root can be
// used as the stable App Store marketing URL.
app.get('/', (c) => c.html(landingHtml()));
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    started_at: startedAt.toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  })
);
app.get('/ready', async (c) => {
  try {
    await checkDatabase();
    return c.json({
      status: 'ready',
      checks: {
        database: 'ok',
        auth: jwtPublicConfig(),
        ai: aiGateway.readiness,
        idempotencyRecoveryFence:
          env.aiRecoveryFenceCutoff?.toISOString() ?? 'inactive',
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'readiness.failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return c.json(
      { status: 'not_ready', checks: { database: 'failed' } },
      503
    );
  }
});

// Public legal pages — App Store Connect submission requires stable,
// independently reachable privacy-policy and terms URLs.
const legalProvider = {
  aiProviderName: env.legalAiProviderName,
  aiProviderUrl: env.legalAiProviderUrl,
  diagnosticsRegion: env.legalDiagnosticsRegion,
  diagnosticsRetentionDays: env.legalDiagnosticsRetentionDays,
};
app.get('/privacy', (c) => c.html(privacyHtml(legalProvider)));
app.get('/terms', (c) => c.html(termsHtml()));
app.get('/support', (c) => c.html(supportHtml()));

// Once a migration intentionally retires an incompatible beta protocol, set
// platform minimums so old binaries fail clearly instead of corrupting auth
// state. Public health/legal pages remain available to stores and operators.
const supportedClient = requireSupportedClient({
  iosMinimumBuild: env.MIN_IOS_CLIENT_BUILD,
  androidMinimumBuild: env.MIN_ANDROID_CLIENT_BUILD,
});
app.use('/auth/*', supportedClient);
app.use('/api/*', supportedClient);
app.use('/subscriptions/me', supportedClient);
app.use('/subscriptions/apple/transactions', supportedClient);

// /auth/* — public (login flows don't need auth themselves; logout/me
// have their own requireUser middleware).
app.route(
  '/auth',
  createAuthRouter({
    appleBundleId: env.APPLE_BUNDLE_ID,
    phoneLoginEnabled: env.PHONE_LOGIN_ENABLED,
    appReviewAccess: env.appReviewAccess,
    trustProxy: env.TRUST_PROXY,
  })
);

// /api/transcribe/* — issue a one-use ticket for our constrained WebSocket
// relay. The provider key and provider protocol remain server-side.
app.route(
  '/api/transcribe',
  createTranscribeRouter({})
);

// /api/* — provider-neutral business AI endpoints. The mobile client cannot
// choose models, prompts, voices, or arbitrary chat messages.
app.route(
  '/api',
  createAiRouter({
    orchestrator: aiOrchestrator,
    globalConcurrency: env.AI_GLOBAL_CONCURRENCY,
    requestsPerMinute: env.AI_REQUESTS_PER_MINUTE,
    freeDailySafetyLimit: env.AI_FREE_DAILY_SAFETY_LIMIT,
    plusDailySafetyLimit: env.AI_PLUS_DAILY_SAFETY_LIMIT,
  })
);

// StoreKit transaction verification is authenticated; Apple's notification
// endpoint is authenticated by its signed payload and remains reachable
// without mobile-version headers.
app.route('/subscriptions', createSubscriptionRouter(appleStore));

// Catch unhandled errors thrown from route handlers.
// HTTPException (e.g. zValidator failures) keeps its original 4xx
// response. Everything else is a real internal error — log a
// structured line and return a generic 500 (don't leak internals).
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'error',
      path: c.req.path,
      method: c.req.method,
      userRef: safeLogReference('user', c.get('userId')),
      message: err.message,
      stack: (err.stack || '').slice(0, 2000),
    })
  );
  return c.json({ error: 'internal server error' }, 500);
});

// Process-level guards. We deliberately do NOT swallow these — the
// process state may be corrupted, so we log and exit. PM2 restarts.
process.on('uncaughtException', (err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'fatal',
      kind: 'uncaughtException',
      message: err.message,
      stack: (err.stack || '').slice(0, 2000),
    })
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : null;
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'fatal',
      kind: 'unhandledRejection',
      message: err ? err.message : String(reason),
      stack: err ? (err.stack || '').slice(0, 2000) : '',
    })
  );
  process.exit(1);
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port });
// @hono/node-server's return type also includes HTTP/2 variants, but with no
// createServer override above it constructs Node's ordinary HTTP Server.
const httpServer = server as import('node:http').Server;
const transcriptionRelay = attachTranscriptionRelay(
  httpServer,
  {
    provider: transcriptionProvider,
    maxConcurrent: env.TRANSCRIBE_MAX_CONCURRENCY,
    maxConcurrentPerUser: 1,
  }
);
console.log(`[photospeak-api] listening on :${port}`);

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = performShutdown(signal);
  return shutdownPromise;
}

async function performShutdown(signal: string): Promise<void> {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'shutdown.started',
      signal,
    })
  );
  const result = await drainForShutdown({
    server: httpServer,
    closeRelay: () => transcriptionRelay.close(),
    closeDatabase,
    timeoutMs: 75_000,
    log: (record) => console.error(JSON.stringify(record)),
  });
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'shutdown.completed',
      signal,
      forced: result.forced,
      errors: result.errors,
    })
  );
  process.exit(result.forced || result.errors.length > 0 ? 1 : 0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
