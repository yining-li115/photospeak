# PhotoSpeak Backend

Hono/Node API for identity, AI orchestration, usage accounting, and a
constrained streaming-ASR relay. Mobile clients never receive provider keys
and cannot choose arbitrary models, prompts, voices, or upstream endpoints.

## Architecture

```text
Mobile app -- PhotoSpeak JWT --> Hono business API
                                  |-- PostgreSQL: users, sessions, consent,
                                  |               entitlement, usage ledger
                                  |-- AiGateway --> provider adapter --> AI API
                                  `-- one-use relay ticket --> ASR WebSocket
```

`src/ai/types.ts` is the provider boundary. Business routes depend on separate
`TextAiProvider` and `SpeechAiProvider` interfaces. Ark vision/text can use
`OpenAiCompatibleTextProvider`; chat-completions speech and Volcengine TTS 2.0
have separate adapters. Streaming ASR uses the same boundary: the relay owns
limits and accounting, while `VolcengineAsrProvider` owns the vendor handshake
and binary protocol. Vendor payloads never belong in business routes.

Content moderation is an optional `ModerationProvider` hook. No moderation
provider is configured today; startup and `/ready` report that fact explicitly.

## API

Every `/api/*` route requires `Authorization: Bearer <access JWT>`.
`APP_SHARED_TOKEN` and the legacy shared-bearer path have been removed.

Authentication endpoints:

- `POST /auth/apple`
  - Requires `{ identity_token, authorization_code, consent_version,
    consent_accepted_at, full_name? }`.
  - The server independently verifies the supplied identity token, exchanges
    the single-use authorization code with Apple's `/auth/token`, verifies the
    returned ID token, and requires both Apple subjects to match.
- `DELETE /auth/me`
  - Requires recent authentication. For Apple accounts with a stored refresh
    token, Apple's `/auth/revoke` must succeed before local deletion commits.
- `POST /auth/deletion-receipt`
  - Requires an ordinary access JWT. Before sending `DELETE /auth/me`, the
    client must durably store the returned `{ deletion_receipt, expires_at }`.
    This preflight is what makes a lost `DELETE` response recoverable.
- `GET /auth/deletion-status`
  - Reconciles a lost `DELETE` response using the dedicated receipt as its
    bearer. Ordinary access JWTs are not accepted. It returns deletion/
    revocation state only—never profile data or general authentication.

- `POST /api/analyze`
  - Session analysis DTO:
    `{ operation: "session_analysis", photo_data_url, transcript, mode }`
  - Follow-up DTO:
    `{ operation: "follow_up", photo_data_url, transcript, analysis, history, question }`
  - Models and prompts are selected server-side.
  - Requires a persisted `Idempotency-Key` (16–128 safe ASCII characters).
- `POST /api/tts`
  - DTO: `{ text, style? }`
  - Model, voice, and output format are selected server-side.
  - Requires the same persisted-key protocol; each generated sentence is a
    separate logical operation.
- `POST /api/transcribe/session`
  - Returns a one-use PhotoSpeak relay ticket valid for 15 seconds.
- `WS /api/transcribe/stream`
  - Accepts only PCM16/16 kHz/mono binary frames plus one `{ "type":
    "finish" }` command. Audio is capped at 70 seconds; the 105-second socket
    lifetime leaves bounded room for task startup, provider finalization and
    network jitter without expanding the audio allowance.
- `GET /health`
  - Process liveness only.
- `GET /ready`
  - Database reachability and non-secret AI configuration status.

Provider authentication failures are returned as 503, never 401. A 401 is
reserved for PhotoSpeak access-token expiry and carries
`code: "AUTH_ACCESS_EXPIRED"`, except explicit credential endpoints: refresh,
Apple identity-token, and SMS-code failures return their own `AUTH_*` code and
must not trigger an access-token refresh loop.

## Configuration

Required:

- `DATABASE_URL`
- `JWT_SECRET` (at least 32 characters)
- `DELETION_RECEIPT_CURRENT_KID` (the active key ID, for example `2026-09`)
- `DELETION_RECEIPT_KEYS` (JSON object mapping every accepted `kid` to an
  exactly 32-byte standard-base64 key; generate each with
  `openssl rand -base64 32`)
- `APPLE_BUNDLE_ID`
- `APPLE_TEAM_ID` (the 10-character Apple Developer Team ID)
- `APPLE_KEY_ID` (the 10-character Sign in with Apple private-key ID)
- `APPLE_PRIVATE_KEY_PEM` (the downloaded `.p8` PKCS#8 key; literal `\\n`
  separators are accepted)
- `APPLE_TOKEN_ENCRYPTION_KEY` (exactly 32 random bytes, standard base64;
  generate once with `openssl rand -base64 32`)
- `AI_ASR_PROVIDER=volcengine-seed`, `AI_ASR_API_KEY`, and the pinned
  `AI_ASR_WS_URL`; the API key comes from Volcengine Speech, not Ark
- `AI_CHAT_PROVIDER`, `AI_CHAT_BASE_URL`, `AI_CHAT_API_KEY`, `AI_CHAT_MODEL`
- `AI_TTS_PROVIDER`, `AI_TTS_ADAPTER`, `AI_TTS_API_KEY`, `AI_TTS_VOICE`; add
  `AI_TTS_RESOURCE_ID` for Volcengine or `AI_TTS_BASE_URL`/`AI_TTS_MODEL` for
  chat-completions speech
- `AI_PROVIDER_DISPLAY_NAME`, `AI_PROVIDER_PRIVACY_URL`
- `SENTRY_DATA_REGION`, `SENTRY_RETENTION_DAYS` (must match the mobile
  Sentry project and App Store privacy disclosures)
- `AI_IDEMPOTENCY_ACTIVE_KEY_ID`
- `AI_IDEMPOTENCY_KEY_RING` (JSON object mapping key IDs to exactly 32-byte
  standard-base64 AES keys)
- `AI_IDEMPOTENCY_HMAC_ACTIVE_KEY_ID`
- `AI_IDEMPOTENCY_HMAC_KEY_RING` (JSON object mapping key IDs to independent,
  exactly 32-byte standard-base64 request-HMAC keys)
- `AI_IDEMPOTENCY_RECOVERY_FENCE_CUTOFF` is normally empty. After a database
  restore, set it permanently to the conservative UTC traffic-stop timestamp;
  follow [the disaster-recovery runbook](../docs/disaster-recovery.md). The
  effective fence includes the protocol's ten-minute mobile-clock allowance.

JWT/session policy:

- `JWT_ISSUER` (default `photospeak-api`)
- `JWT_AUDIENCE` (default `photospeak-mobile`)
- `JWT_EXPIRES_IN` (default `15m`, allowed 5 minutes–1 hour)
- `JWT_REFRESH_EXPIRES_IN` (default `30d`, allowed 1–90 days)
- `AUTH_RECENT_MAX_AGE_SECONDS` (default `600`, allowed 60–3600)

JWT verification is pinned to HS256 and validates issuer, audience, kind,
session id, `iat`, `exp`, maximum TTL, and authentication time.

Deletion receipts use a separate HS256 audience and key ring, not
`JWT_SECRET`. Add the new key to `DELETION_RECEIPT_KEYS`, switch
`DELETION_RECEIPT_CURRENT_KID`, and keep every retired verification key for at
least 400 days after its last issued receipt. Removing one sooner makes an
offline device unable to reconcile a previously requested deletion. Never log
the JSON key ring.

Sign in with Apple server integration:

- `APPLE_CLIENT_ID` defaults to `APPLE_BUNDLE_ID`; set it only when the
  authorization flow actually uses a different configured App ID/Services ID.
- `APPLE_REDIRECT_URI` is optional and must be the same HTTPS redirect URI
  used by the original authorization request. Native flows that didn't send
  one must leave it unset.
- `APPLE_HTTP_TIMEOUT_MS` defaults to `10000` and accepts 1000–30000.
- `APPLE_TOKEN_ENCRYPTION_KEY_ID` identifies the current encryption key in
  new credential envelopes (default `primary`).
- `APPLE_TOKEN_DECRYPTION_KEYS` is an optional JSON object whose keys are old
  key IDs and whose values are 32-byte standard-base64 keys. Keep old keys in
  this ring until every credential using them has been revoked or re-encrypted.

The Apple client secret is generated per request as a five-minute ES256 JWT
with the configured Team ID, key ID, client ID, and Apple's audience. Apple
refresh tokens are never logged or stored in plaintext: `apple_credentials`
contains one versioned AES-256-GCM envelope per issued token, bound to the
Apple subject and key ID as authenticated additional data. Multiple logins do
not overwrite an older still-revocable token. Back up the current key and old
key ring separately from the database; losing all keys for an envelope prevents
programmatic revocation of that credential.

Provider selection (there are no MiMo defaults or credential fallbacks):

- `AI_CHAT_PROVIDER`, `AI_CHAT_BASE_URL`, `AI_CHAT_MODEL`,
  `AI_CHAT_AUTH_STYLE`
- `AI_CHAT_MAX_TOKENS_FIELD` (`max_tokens` or `max_completion_tokens`)
- `AI_TTS_PROVIDER`, `AI_TTS_ADAPTER` (`volcengine-v3-http` or
  `chat-completions`)
- For Volcengine V3: `AI_TTS_API_KEY`, `AI_TTS_RESOURCE_ID` (default
  `seed-tts-2.0`), and an authorized `AI_TTS_VOICE`; output is fixed to MP3
  24 kHz. The adapter parses bounded HTTP Chunked NDJSON and never treats the
  provider request ID as native idempotency.
- For chat-completions speech only: `AI_TTS_BASE_URL`, `AI_TTS_MODEL`, and
  `AI_TTS_AUTH_STYLE`; `AI_TTS_FORMAT` defaults to `mp3`.
- For Seed ASR 2.0: `AI_ASR_API_KEY`, resource
  `volc.seedasr.sauc.duration`, optimized duplex endpoint
  `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`, 200 ms packets,
  and second-pass correction enabled by default. `AI_ASR_VAD_SILENCE_MS`
  controls end-of-sentence detection; the mobile app never sees this key.
- `AI_CHAT_TIMEOUT_MS`, `AI_TTS_TIMEOUT_MS`

AI operation idempotency:

- The mobile client commits an owner-scoped intent to SQLite before calling a
  billable endpoint. Token refresh, HTTP retry and process restart reuse the
  same key. New clients issue `v2.<unix-seconds>.<uuid-v4>` keys; the server
  rejects one older than 400 days before any database lookup or provider call.
- PostgreSQL stores only a domain-separated lookup digest of the random client
  key, a keyed payload hash plus its key ID, lease metadata, accounting IDs and
  a short-lived AES-256-GCM response envelope. It never stores the photo,
  transcript, prompt or request body in the idempotency table.
- Analysis/follow-up responses expire after 72 hours; speech responses after
  24 hours. A versioned-key tombstone remains through its 400-day rejection
  horizon plus a seven-day cleanup margin. After deletion, the embedded time
  still makes the server return `410 IDEMPOTENCY_KEY_EXPIRED` before lookup,
  so ordinary retention cleanup cannot make the key executable again. A
  database rollback can also erase unexpired rows, so every restore must
  install the recovery cutoff below before traffic resumes. UUID-only beta
  keys are accepted as legacy keys and keep their tombstones until account
  deletion. Any expired result/key is regenerated only after explicit user
  confirmation and a new key.
- Add a new AES key to `AI_IDEMPOTENCY_KEY_RING`, switch
  `AI_IDEMPOTENCY_ACTIVE_KEY_ID`, and retain old keys through the longest
  response TTL before removing them. To rotate request-HMAC keys, add the key
  to `AI_IDEMPOTENCY_HMAC_KEY_RING` and switch
  `AI_IDEMPOTENCY_HMAC_ACTIVE_KEY_ID`. Every old request-HMAC key must remain
  configured while any `ai_operations` row references it (up to tombstone
  cleanup for v2 keys and normally account deletion for legacy keys); startup
  fails closed if one is missing. Never log either key ring.
- Provider adapters explicitly declare `none`, `native_replay`, or
  `queryable_job`. OpenAI-compatible syntax alone does not prove idempotency;
  current generic adapters deliberately declare `none`. If a request times
  out after dispatch, PhotoSpeak returns `AI_OPERATION_UNCERTAIN` and will not
  automatically call that provider again. Exactly-once recovery requires a
  documented provider idempotency key or result-query API.
- `X-Request-ID` identifies one HTTP attempt. `X-Operation-ID` identifies the
  stable billable operation; cached replay does not add a usage event.
- After a database restore, the configured recovery cutoff atomically turns an
  otherwise unknown key at or before cutoff plus ten minutes into a
  non-executable `recovery_fenced` tombstone. The allowance covers a key
  accepted just before the incident from a fast mobile clock. It returns `410
  IDEMPOTENCY_RECOVERY_FENCE`; only explicit user confirmation and a key after
  the effective cutoff can start new work. Unknown legacy UUIDs also fail
  closed while the fence is active.

Guardrails and accounting:

- `AI_REQUESTS_PER_MINUTE`
- `AI_GLOBAL_CONCURRENCY` (default `4` for the current small host)
- `AI_FREE_DAILY_SAFETY_LIMIT`, `AI_PLUS_DAILY_SAFETY_LIMIT`
- `AI_FREE_DAILY_COST_LIMIT`, `AI_PLUS_DAILY_COST_LIMIT` in billing-currency
  units; omitted means the cost breaker is disabled
- `AI_CHAT_INPUT_PRICE_PER_MILLION`, `AI_CHAT_OUTPUT_PRICE_PER_MILLION`
- `AI_TTS_INPUT_PRICE_PER_MILLION`, `AI_TTS_OUTPUT_PRICE_PER_MILLION`; the
  unit is enforced by the selected adapter (Unicode characters for Volcengine
  V3, tokens for chat-completions) so unlike units cannot be silently mixed
- `AI_ASR_PRICE_PER_HOUR` estimates duration-billed transcription cost
- `AI_BILLING_CURRENCY` (default `CNY`)
- `DB_POOL_MAX` (default `5` connections per API process)
- `AI_PROVIDER_DISPLAY_NAME`, `AI_PROVIDER_PRIVACY_URL` keep the public privacy
  policy accurate when the processor changes
- `MIN_IOS_CLIENT_BUILD`, `MIN_ANDROID_CLIENT_BUILD` reject incompatible old
  binaries with HTTP 426. The checked-in deployment example requires iOS build
  `4` and leaves Android at `0` until its first confirmed release.

The customer-facing Plus plan can be described as unlimited while these high
soft/hard safety ceilings, per-user concurrency locks, and the cost breaker
stop leaked credentials and automated abuse. Before running multiple Node
processes, replace the in-memory rate/concurrency stores with Redis.

Set `TRUST_PROXY=true` only when the Node port is inaccessible from the public
internet and all traffic passes through a proxy that overwrites forwarding
headers.

## Development and verification

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run db:migrate
npm run dev
```

Tests do not call an external provider. Run the operational smoke test against
a running server:

```bash
./scripts/smoke-test.sh --base http://localhost:3000
```

## Authentication and retention

- Access JWT lifetime defaults to 15 minutes.
- Refresh tokens are SHA-256 fingerprinted at rest, belong to a login-session
  family, and are rotated exactly once. Reuse of an old/missing family token
  revokes the entire family, including access tokens already issued from it.
  Rotation preserves the family's original absolute expiry; it does not create
  an indefinitely sliding session.
- `POST /auth/refresh` accepts an `Idempotency-Key` header containing a
  16–128-character high-entropy value (mobile uses UUID v4). The client stores
  that key atomically beside the current refresh token until the new token pair
  is durably committed. A retry with the same old token and key returns the
  same child refresh token plus a newly issued access token; a different key is
  treated as reuse. The encrypted replay survives beyond seven days until the
  session's absolute expiry, but is erased as soon as the child refresh token
  successfully rotates.
- Every authenticated request checks both the active user and active session.
  Logout and account deletion therefore invalidate access JWTs immediately.
- `DELETE /auth/me` requires authentication within the previous 10 minutes by
  default. Older sessions receive `403 AUTH_RECENT_LOGIN_REQUIRED`; the client
  must perform Apple/phone login again before retrying deletion.
- Deletion first commits `deletion_state='deleting'`, which blocks ordinary
  API use, refresh, and new logins. It then revokes every stored Apple
  credential before committing local deletion. An Apple network/configuration
  failure returns `503 APPLE_REVOCATION_UNAVAILABLE`; the account stays in the
  durable deleting state and the recovery job retries safely after a crash or
  session expiry. The same-session request may retry, and a different recently
  authenticated session can take over the deletion intent.
- Apple login uses short reservation/CAS transactions. Apple `/auth/token` and
  ID-token/JWKS verification run with no database transaction or pooled
  connection held. Deletion clears the reservation first, so a late exchange
  cannot reactivate an account behind a completed deletion. A newly issued
  token is persisted as `pending_login` before ID-token verification; crashes
  and failed compensation are therefore recoverable as credential outbox work.
  Alert on `AUTH_APPLE_COMPENSATION_REQUIRED`, especially when logs show that
  durable cleanup could not be queued.
- No database can atomically commit with Apple's token endpoint. The remaining
  crash window is exchange-response-to-first-pending-row. Expired reservations
  from that window are durably marked for manual review and emit the high-
  severity `auth.apple.exchange_persistence_gap_detected` event. Failed first-
  login placeholders are deleted immediately when compensation is known safe;
  uncertain, sessionless `provisioning` PII is rechecked and purged after a
  bounded seven-day retention period.
- Apple accounts created before migration `0005` have no server refresh token.
  Following Apple's TN3194 compatibility path, local deletion still completes,
  records `apple_manual_revoke_required_at`, and returns
  `APPLE_MANUAL_REVOKE_REQUIRED` with instructions to revoke access in Apple
  account settings.
- Login requires the current `consent_version` and a valid
  `consent_accepted_at`; future client timestamps are replaced with server
  time and every accepted version is recorded once per user.
- Account deletion is recoverable for seven days. The same idempotent job also
  resumes pending Apple deletion sagas and orphaned-login compensation. Run it
frequently (and use a non-overlapping scheduler); the retention checks make
frequent execution safe:

```cron
*/5 * * * * cd /opt/photospeak/backend && flock -n /tmp/photospeak-accounts-purge.lock npm run accounts:purge
```

The purge entry point loads the backend `.env` itself when the variables are
not already supplied by the process manager. Keep that file mode `0600` and
owned by the service account; the job never logs `DATABASE_URL` or other
secrets.
Recovery workers claim ordered batches with `FOR UPDATE SKIP LOCKED`, a
time-bounded lease, and exponential `next_attempt_at` backoff. A permanently
failing credential is moved behind newly eligible work instead of starving the
first batch, and multiple workers can run without intentionally processing the
same claim. Token-specific permanent rejection or an undecryptable envelope is
recorded as `manual_required`, its ciphertext is removed, and local deletion
can finish with explicit Apple instructions. Transient failures have bounded
attempt/age retries. Global Apple client/configuration rejection retains every
ciphertext, raises `auth.apple.revocation_configuration_blocked`, and stops the
worker batch so one bad deployment cannot terminalize all accounts.

Future server-side user content must have a cascading user foreign key, and
future object storage must add cleanup to `purgeDeletedAccounts`.
The same daily job removes expired auth sessions/refresh-token rows and detailed
AI usage events older than `AI_USAGE_RETENTION_DAYS` (default 400, minimum 90),
clears expired encrypted AI response envelopes, quarantines impossibly old
leases, and batch-deletes only non-running v2 tombstones after the 400-day key
horizon plus seven days. UUID-only beta tombstones have no age expiry and are
removed only by the account foreign-key cascade. Before relying on bounded v2
growth, ship this client with a new platform build number and raise
`MIN_IOS_CLIENT_BUILD`/`MIN_ANDROID_CLIENT_BUILD`; an updated app can still
replay legacy intents stored by an earlier build, while the gate stops the old
binary from creating new legacy rows. Partition `ai_operations` before
high-volume horizontal scale.

Daily dumps alone can lose billable-operation rows created after the dump.
Paid production therefore requires tested PostgreSQL PITR or continuous WAL
archiving as an external launch gate. Any actual restore must follow
[the recovery-fence runbook](../docs/disaster-recovery.md); do not reopen
traffic with the fence unset.

## Deployment

Run `scripts/deploy.sh` from a clean production checkout. It installs and
builds before downtime, then uses a short maintenance window: stop the old
process, run forward migrations, start only the new process, and exercise
`/health`, `/ready`, the legal page, and authenticated-route gates. It does not
use rolling reload for auth-protocol migrations.

Migrations are not automatically reversible. Before migration starts the
script can restore the previous code. Once migration execution begins it fails
closed and requires a forward fix; it will not automatically start an
auth-incompatible old process against new token semantics.

Migration `0004_lush_micromacro` is structurally expand-only: it preserves
legacy refresh rows, keeps their `revoked` column, and adds nullable
session-family columns. The old and new processes are nevertheless behaviorally
incompatible: new code has no raw-token fallback and only accepts JWT refresh
tokens whose `sid` matches a non-null session row. Do not mix them. Set the
minimum client build, schedule the maintenance cutover, and expect old beta
sessions to sign in again. Remove compatibility columns only in a later
contract release.

Migration `0005_unusual_spot` adds the expand-only deletion state,
login-reservation, recovery lease/backoff columns, refresh-idempotency replay
columns, and the independent `apple_credentials` vault/outbox table. Existing
Apple users have no stored server refresh credential, so they enter the
explicit TN3194 legacy/manual-revocation path until a later login supplies a
new authorization code.

Migration `0006_ai_operations` adds durable AI operation leases, encrypted
short-lived result replay, the versioned 400-day key protocol, bounded
tombstone cleanup metadata, and a stable `operation_id` in the usage ledger.
It backfills old usage rows from their historical request ID before enforcing
the new non-null column. Deploy the migration before requiring the newly
incremented client build that emits v2 AI idempotency keys.

SIGTERM/SIGINT first stop new HTTP accepts, reject/close transcription relays,
and wait for in-flight HTTP plus relay usage writes before closing PostgreSQL.
After 75 seconds the process logs `shutdown.force_timeout`, force-closes
connections, and exits non-zero; deployment tooling must treat that as a
failed drain rather than a successful zero-downtime restart. Keep PM2
`kill_timeout` above this bound (the committed ecosystem file uses 80 seconds)
or PM2 will send SIGKILL before the application can finish the drain.

Terminate TLS at nginx (or another trusted proxy) and expose only HTTPS to
mobile clients. The Node port should listen on a private interface/firewall.
The `/api/transcribe/stream` location must forward WebSocket `Upgrade` and
`Connection` headers and use HTTP/1.1; otherwise recording will obtain a ticket
but fail during the socket handshake.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 130s;
    client_max_body_size 4m;
}
```

## Backups

`scripts/backup.sh` creates a mode-0600 atomic PostgreSQL dump under a mode-0700
directory, validates it with `gzip` and `pg_restore`, uploads it to
`BACKUP_OFFSITE_URI`, requests private ACL plus OSS SSE-KMS, and verifies the
remote object with `ossutil stat` before pruning local copies. Off-host backup is
required by default; set `BACKUP_REQUIRE_OFFSITE=0` only for local development.
Configure `BACKUP_FAILURE_WEBHOOK_URL` so cron failures page an operator, and
enforce remote retention/versioning with an OSS lifecycle policy.

Run `scripts/restore-drill.sh` on a schedule against a selected OSS object. It
always downloads and structurally verifies the archive. For a full drill, point
`RESTORE_DRILL_DATABASE_URL` only at a disposable empty PostgreSQL database and
set `RESTORE_DRILL_CONFIRM_EMPTY_DATABASE=YES`; the script intentionally uses a
clean restore and must never target staging or production.
