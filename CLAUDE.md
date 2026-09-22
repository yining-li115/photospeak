# PhotoSpeak engineering guide

PhotoSpeak is a local-first Expo/React Native English-speaking practice app.
A learner chooses a photo, speaks for 60 seconds, gets a clearly signalled
10-second grace period, and is stopped at 70 seconds. The app transcribes the
speech, asks a multimodal model for corrections and a polished version, then
generates sentence audio and FSRS review cards after explicit confirmation.

Read this file before changing the project. Current operational details live in
[`backend/README.md`](backend/README.md); provider and product decisions live in
[`docs/ai-provider-selection.md`](docs/ai-provider-selection.md) and
[`docs/subscription-policy.md`](docs/subscription-policy.md). The older
[`docs/optimization.md`](docs/optimization.md) is a historical audit, not the
runtime contract.

## Architecture boundaries

```text
Expo app
  |-- recorder state machine + owner-scoped SQLite/media
  |-- provider-neutral domain requests
  `-- PhotoSpeak access JWT / one-use ASR relay ticket
                         |
Hono backend            |-- session families + deletion sagas
  |-- business DTOs -----|-- provider adapters + prompt/model policy
  |-- usage/cost ledger  |-- constrained streaming-ASR relay
  `-- PostgreSQL --------`-- recovery/retention jobs
```

- The phone never receives an AI, speech, Apple-server, SMS, or database key.
- Mobile callers submit domain operations; they cannot choose arbitrary model
  IDs, prompts, voices, upstream URLs, or provider payloads.
- AI text and speech are separate backend interfaces. Ark text/vision uses the
  OpenAI-compatible adapter; Doubao TTS 2.0 uses its dedicated v3 HTTP adapter.
- Production ASR audio goes through PhotoSpeak's constrained WebSocket relay.
  A 15-second one-use ticket cannot be used against any other provider route.
- Learning content is local-first. Request photos, recordings, transcripts and
  prompts are not written to server tables. Encrypted AI responses are retained
  only for the documented 24/72-hour retry window; longer-lived rows contain
  hashes and operational metadata, not learning content.

## Important paths

- `app/` — Expo Router screens and UI orchestration.
- `src/hooks/useAudioRecorder.ts` — microphone/streaming-ASR lifecycle.
- `src/recording/policy.ts` — the 60s target, 10s grace and 70s hard limit.
- `src/audio/runtime.ts` — process-wide playback/recording exclusion.
- `src/api/ai.ts`, `src/api/tts.ts` — provider-neutral mobile requests.
- `src/api/backend.ts` — HTTPS client, atomic token storage, refresh/retry.
- `src/context/auth.tsx` — identity and account-deletion orchestration.
- `src/db/`, `src/storage/` — owner-scoped SQLite and managed media.
- `src/services/generate.ts` — confirmation, TTS, persistence and card flow.
- `backend/src/ai/` — provider contracts, validation and usage accounting.
- `backend/src/auth/`, `backend/src/routes/auth.ts` — auth/session/deletion.
- `backend/src/transcription/` — ticket and bounded WebSocket relay.
- `backend/drizzle/` — append-only forward PostgreSQL migrations.

Mobile code imports only the provider-neutral `ai.ts` and `tts.ts` clients.
Vendor model IDs, prompts, voices, and credentials stay behind backend
adapters.

## Recording and generation invariants

1. Recording and playback require process-wide leases and can never overlap.
   An indeterminate native recorder quarantines the entire audio runtime until
   stop is confirmed; late callbacks from an old operation cannot revive it.
2. The recorder stops on background, screen loss, interruption or the 70-second
   hard limit. Timing uses a monotonic clock, not render cadence.
3. Source audio is PCM16, 16 kHz, mono. The relay enforces exactly 70 seconds by
   byte count; its longer socket lifetime exists only for startup/finalization.
4. `polished_sentences` stays an array. Each sentence maps by index to one TTS
   audio file and one player item.
5. TTS runs only after the user confirms the analysis. Partial generation is
   retryable and bounded; persistence is owner- and account-epoch checked.
6. Photos are compressed for analysis/storage. Do not put base64 media, audio
   bytes or unbounded chat histories in SQLite or React state.

## Local data invariants

- Every session, card, stat and generated artifact belongs to an explicit
  owner. Never infer ownership from a mutable global after an `await`.
- Persist managed paths relative to the Expo document root and resolve them at
  the read boundary; absolute iOS container paths do not survive reinstalls.
- Account deletion writes a durable tombstone before erasing files/rows. File
  deletion is strict for account purge and retryable after a crash.
- Ordinary session deletion may remove DB rows first and let the orphan janitor
  finish best-effort media cleanup.
- Completed history is never silently evicted. New writes stop at the managed
  storage/free-space guard; cloud storage plus a bounded cache is future work.
- List queries are paginated and decoded JSON is normalized/capped at the DB
  boundary.

## Authentication invariants

- Access and refresh tokens live in one atomic SecureStore bundle. A logged-out
  tombstone prevents old beta keys from resurrecting a session.
- Refresh tokens rotate once within a revocable session family. Before a
  refresh request leaves the phone, a UUID `Idempotency-Key` is persisted with
  that exact old token. It is cleared only when replacement tokens commit.
- Backend refresh replay is valid for the family's remaining absolute lifetime,
  returns the same child refresh token plus a freshly signed access token, and
  is removed after the child rotates successfully. A different key is reuse.
- Every authenticated request checks the user and session. Provider failures
  are 502/503, never an auth 401. Only `AUTH_ACCESS_EXPIRED` triggers refresh.
- Account deletion first persists a dedicated deletion receipt on the phone,
  then sends `DELETE /auth/me`. The receipt cannot access profile/AI routes and
  remains verifiable across ordinary JWT-secret rotation.
- Apple authorization codes are exchanged server-side. Every stored Apple
  refresh credential is encrypted, revocable, recoverable after crashes, and
  classified into transient, terminal-manual or completed deletion states.

## Backend and deployment invariants

- Validate bounded business DTOs at the route boundary. Never recreate a
  generic authenticated provider proxy.
- Do not hold a PostgreSQL transaction or pool connection across Apple/JWKS or
  AI-provider network calls. Reserve/claim in a short transaction, call the
  provider, then complete with compare-and-set state.
- Recovery jobs use ordered claims, leases, `SKIP LOCKED`, bounded exponential
  backoff and terminal states so poison work cannot starve newer rows.
- In-memory relay tickets/rate/concurrency state require a singleton process or
  sticky routing. Move them to Redis before horizontal API scaling.
- Auth-protocol/schema releases use a maintenance window: build, stop old code,
  migrate forward, start new code, smoke test. Never roll old/new auth semantics
  together or automatically roll old code back after migrations begin.
- Keep minimum iOS/Android build gates current before retiring a mobile
  protocol.

## Environment and secrets

Copy the committed `.env.example` files locally. Never commit, print or inspect
real `.env` files. Only public build configuration such as the backend base URL
or Sentry DSN may use `EXPO_PUBLIC_*`; those values are embedded in the app.

Provider/model/voice IDs and all credentials are backend configuration. There
are no MiMo defaults or credential fallbacks. Exact required variables and key
rotation procedures are documented in `backend/.env.example` and
`backend/README.md`.

## Verification

```bash
npm ci
npm run typecheck
npm run lint:ci
npm run test:db

cd backend
npm ci
npm run typecheck
npm test
npm run build
```

Tests must not call live AI/Apple/SMS services or load real environment files.
Run migrations and operational smoke tests only in an explicitly configured
staging environment.

## Release blockers that code structure alone does not satisfy

- Complete provider evaluation and privacy disclosure; staging-test the
  implemented Volcengine TTS adapter and add Volcengine streaming ASR only if
  that migration is chosen.
- Add and sandbox-test StoreKit/Google Play purchase verification, server
  notifications, restore, refund, grace-period and entitlement transitions.
- Configure moderation policy, monitoring, cost alarms and incident runbooks.
- Rehearse migrations, backup restore, nginx WebSocket timeouts and the
  non-rolling auth cutover in staging.
