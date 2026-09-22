# PhotoSpeak

PhotoSpeak is a local-first Expo/React Native English-practice app. A learner
chooses a photo, describes it for up to 60 seconds (with a 10-second grace
period), receives corrections and a polished version, then generates listening
audio and review cards.

The mobile app owns recording, playback and owner-scoped local learning data.
The Hono/PostgreSQL backend owns authentication, provider credentials, prompts,
model selection, response validation, usage accounting and the constrained ASR
WebSocket relay. No AI key belongs in the mobile bundle.

Billable analysis and TTS calls use owner-scoped mobile intents plus a durable
server operation record. Lost responses and App restarts replay encrypted,
short-lived results instead of invoking the provider again; an upstream with
no documented idempotency/query API fails closed when its outcome is unknown.

## Repository layout

- `app/` — Expo Router screens.
- `src/api/` — provider-neutral mobile API clients.
- `src/db/` and `src/storage/` — owner-scoped SQLite rows and managed media.
- `src/hooks/useAudioRecorder.ts` — microphone/ASR state machine.
- `backend/src/ai/` — text and speech provider boundaries.
- `backend/src/auth/` — Apple/phone auth and session families.
- `docs/` — product, subscription, provider and historical architecture notes.

## Local verification

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

Copy the committed `.env.example` files for local configuration. Never commit
real environment files and never expose provider credentials through
`EXPO_PUBLIC_*`. See [backend/README.md](backend/README.md) for the backend
contract and deployment requirements.

## Current release gates

- Provision and evaluate the chosen production AI/speech providers.
- The dedicated Volcengine TTS v3 and streaming-ASR 2.0 adapters are
  implemented and protocol-tested; complete staging voice, accuracy and
  latency evaluation before production traffic.
- Implement and sandbox-test StoreKit/Google Play entitlement lifecycles before
  selling Plus.
- Configure the private SSE-KMS OSS backup target, failure alert and lifecycle;
  complete a disposable-database restore drill.
- Rehearse forward migrations, WebSocket proxying and the non-rolling auth
  cutover in staging.
- Match the Sentry region/retention disclosure and in-app opt-out to App Store
  privacy labels, then obtain final legal review of the policy and terms.
