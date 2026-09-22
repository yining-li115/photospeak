# PhotoSpeak subscription policy

## Product promise

Plus can be sold without a monthly session or follow-up counter. The user-facing
promise should be **“unlimited practice for normal personal use”**, not a hidden
small quota. A learner who records several sessions every day should never hit a
paywall or see a remaining-count badge.

This is not the same as operating without controls. AI calls have variable cost
and a public mobile client can be automated. Safety controls exist to distinguish
human practice from credential sharing, resale, scraping and denial-of-service;
they are not a monthly product quota.

## Launch price experiment

| Plan | Recommended public test | Entitlement |
| --- | --- | --- |
| Free | ¥0 | Five completed sessions per calendar month, one follow-up per session |
| Plus monthly (Mainland China) | ¥18 | Unlimited personal sessions and follow-ups; local listening/cards/history |
| Plus annual (Mainland China) | ¥128 | Same entitlement; highlight annual on the paywall |
| Plus monthly (United States baseline) | US$9.99 | Local App Store price points vary by storefront |
| Plus annual (United States baseline) | US$99.99 | Local App Store price points vary by storefront |

Do not add a free trial while the free tier already demonstrates the complete
workflow. If acquisition needs a stronger launch hook, test a ¥9.9 first month
as a time-bounded introductory or offer-code price for eligible users, rather
than establishing it as the permanent renewal price. Do not sell a lifetime
unlock while every practice continues to incur AI cost.

The public speech list prices make low permanent prices operationally fragile. A rough
70-second session with ASR, analysis and 600–1,200 synthesized characters can
cost approximately ¥0.45–¥0.75 before hosting, support, failed calls and store
commission. At ten sessions per month that is already ¥4.5–¥7.5; at thirty it
is ¥13.5–¥22.5. Treat these as planning bounds and replace them with measured
usage-ledger data before the price is finalized.

Do not advertise multi-device sync until encrypted cloud learning-content
storage, deletion and restore are actually implemented. It is not part of the
current local-first build.

“Unlimited” means no billing counter, not unlimited physical device storage.
The local-first app preserves completed history and never silently evicts it;
at 1 GB of managed media (or low device free space), it asks the learner to
delete old sessions before creating another. Cloud media plus a bounded local
cache is the long-term way to remove that device constraint.

The exact price is an experiment, not a constant embedded in the app. Keep it
in App Store Connect/server product configuration, never in entitlement logic.
Review it after four to six weeks using conversion, D7/D30 retention, sessions
per paid user and P50/P95 variable AI cost.

## Fair-use controls

Normal Plus users see no counters. Enforce these controls server-side:

- one active analysis job and one synthesis pipeline per user;
- 70-second maximum source recording;
- idempotency keys backed by a short-lived encrypted response cache plus a
  durable digest tombstone: v2 rows remain through a 400-day rejection horizon
  and seven-day cleanup margin, while undated legacy-beta UUID rows remain
  until account deletion. A configured disaster-recovery fence rejects
  restored-but-unknown keys through the recovery cutoff plus the accepted
  ten-minute mobile-clock skew before provider dispatch. Refresh and AI
  operations have separate state machines; a provider without native
  replay/query support fails closed as `AI_OPERATION_UNCERTAIN` after an
  ambiguous dispatch;
- bounded photo, transcript, question and output sizes;
- short rolling-window rate limits for accidental double taps;
- anomaly detection across account, device and trustworthy source IP;
- a deliberately generous daily safety ceiling, reviewed manually rather than
  treated as a subscription allowance;
- account and global cost circuit breakers;
- no API resale, batch automation or credential sharing in the terms.

When the anomaly threshold is reached, stop new expensive jobs, preserve all
existing data, explain that unusual activity was detected, and provide a support
path. Do not silently downgrade output quality or unexpectedly delete history.

## Cost guardrail

Track each accepted operation in a usage ledger with user, subscription,
provider, model, input/output tokens, audio seconds, result, latency, estimated
cost and idempotency key. The operational target is:

> P95 paid-user variable AI cost <= 20% of net subscription revenue.

If the target is exceeded, optimize routing, audio format, context reuse and
provider pricing before changing the customer promise.

## Store implementation

Entitlement state is server-authoritative. Store signed transactions,
notifications and entitlements separately from the user profile, and keep an
idempotent notification log. Support purchase restoration, refunds, billing
retry, grace periods and account transfer rules. Use StoreKit 2 plus App Store
Server API/Notifications V2 on Apple and an equivalent provider adapter for
Google Play.

This repository implements StoreKit products, server-side transaction
verification, App Store Server Notifications V2, restore purchases and the
paywall. Paid launch remains blocked until the complete entitlement lifecycle
is tested in Apple sandbox and production.
