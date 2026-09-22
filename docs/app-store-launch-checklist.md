# PhotoSpeak App Store launch checklist

Last updated: 2026-09-22

## Completed in App Store Connect

- App name: `PhotoSpeak Daily`
- Subtitle: `Speak English from photos`
- Primary category: Education
- Version metadata: promotional text, description, keywords, copyright
- Content rights declaration
- Age rating: 4+
- App price: free, with China mainland (CNY) as the base territory
- Availability: public distribution in all 175 territories
- Release mode: manual release
- China mainland ICP filing: `津ICP备2026003241号-2A`
- App Privacy questionnaire completed and published
- App Store Server Notifications V2 production and sandbox URLs:
  `https://api.dailyphotospeak.cn/subscriptions/apple/notifications`
- Billing grace period: 16 days, all renewals, production and sandbox
- PhotoSpeak Plus subscription group and US English group localization
- Monthly subscription:
  - Product ID: `com.yining.photospeak.plus.monthly`
  - Available in all 175 storefronts and future storefronts
  - US reference price: USD 9.99/month
  - China mainland price: CNY 18/month
  - US English display name and description
- Annual subscription:
  - Product ID: `com.yining.photospeak.plus.annual`
  - Available in all 175 storefronts and future storefronts
  - US reference price: USD 99.99/year
  - China mainland price: CNY 128/year
  - US English display name and description

## Completed in the repository

- Next iOS build number: 10
- Export-compliance declaration: `ITSAppUsesNonExemptEncryption = false`
- Explicit privacy-policy/user-agreement consent gate before sign-in
- Optional diagnostics are off by default
- Public landing, privacy, terms, and support routes are implemented
- Root and backend environment examples document mobile, Ark, speech, auth,
  backup, safety-limit, and retention configuration
- TypeScript, lint, mobile policy tests, backend tests, and backend build pass
- Production landing, health, readiness, privacy, terms, and support routes all
  return HTTP 200
- Build 10 completed a signed native Xcode archive successfully
- An Apple Distribution certificate was created for the Yiru Li team
- Xcode Organizer uploaded build 10 to App Store Connect successfully on
  2026-09-22; Apple processing completed and the build is available in
  TestFlight
- Build 10 is assigned to the internal testing group; the account-owner tester
  installed `1.0.0 (10)` on 2026-09-22
- Paid Apps Agreement is active, the configured bank account is available, and
  the existing US tax forms are active
- The account holder confirmed completion of the China mainland compliance
  information required by State Council Decree No. 810 on 2026-09-22. No
  identity or tax identifier is retained in the repository.
- Production Volcengine connectivity verified on 2026-09-22 without exposing
  credentials or retaining probe media:
  - Ark accepted a bounded multimodal image-and-text request
  - Seed ASR accepted the streaming WebSocket handshake
  - Seed TTS returned a valid non-empty MP3 response
- Repository commit `f16c594` was deployed to production on 2026-09-22. The
  post-deploy smoke test passed for health, readiness, public legal/support
  pages, and the unauthenticated transcription guard; the public health route
  stayed healthy after the PM2 rolling restart.
- The production dependency audit reports zero known vulnerabilities. The four
  moderate audit findings shown by a full install are confined to development
  tooling and are not present in the production dependency graph.
- The post-deploy bounded Volcengine verification passed again for Ark
  multimodal chat, Seed TTS, and the Seed ASR WebSocket handshake.
- A validated same-host PostgreSQL backup was created on the production server,
  and `/etc/cron.d/photospeak-backup` now runs a daily local backup at 04:17
  server time with seven-day retention. Its log is rotated weekly. This is an
  interim recovery path only and does not satisfy the off-host launch gate.
- At the final pre-release check the server root volume was 17% used; PM2 logs
  occupied about 164 KiB and the local backup directory about 72 KiB. Capacity
  was not a current storage blocker, but alerts and off-host backups remain
  required before accepting paid users.

## Required before selecting a build

- Run the real-device checks in
  [`release-functional-test-plan.md`](./release-functional-test-plan.md).
- Complete the real-device plan against internal TestFlight build 10. The
  optional TestFlight testing notes are still blank. Do not select any older
  App Store build for review.

## Required operational launch gates

- Choose and enable a production content-safety path. The current gateway
  validates request and response shapes but reports `moderation:
  not_configured`; Volcengine's AIGC content-safety service and large-model
  application firewall are separate commercial products. Do not describe
  content as safety-approved until one of them is provisioned and integrated.
- Enable independent off-host backups. The prepared backup job supports a
  private OSS bucket with SSE-KMS, but OSS is not enabled on the account yet.
- Run and record one restore drill from the off-host backup before accepting
  paid users.
- Configure alerts for API unavailability, process restarts, disk pressure,
  backup failure, provider spend, and AI error/rate-limit spikes.
- Keep the initial rollout controlled. The current 2-vCPU/3.4-GiB server is
  appropriate for roughly 100–300 DAU and 5–10 simultaneous AI workflows, not
  an unbounded launch spike; measure real latency and provider concurrency
  before increasing traffic.

## App Store Connect items still intentionally pending

- App Review contact information and review notes: require the owner's final
  contact details and a verified reviewer login path.
- Screenshots/app previews: paused until requested; use real app UI captures.
- Accessibility declarations: do not claim support before VoiceOver, Dynamic
  Type, contrast, and reduced-motion testing.
- Subscription review screenshots remain required before the subscription
  products can be added to the first app-version submission.
- Submission for review: intentionally not performed.
- Any future identity, tax-declaration, or bank-detail changes remain owner
  tasks and are intentionally never inferred or submitted by automation.

## Product decisions to resolve

- Decide whether the iPad build is supported and tested. The current target
  includes iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`).
- Decide whether the iPhone/iPad app should also be available on Apple-silicon
  Macs. App Store Connect currently permits it, but it has not been certified.
- Decide whether Simplified Chinese subscription product and subscription-group
  localizations should be added in addition to the configured US English
  localizations.
- “Unlimited” Plus should be marketed as no visible session/follow-up quota,
  while retaining abuse, concurrency, and daily cost safety limits in the
  backend.

## Non-blocking build warning

The build 10 upload completed with missing-dSYM warnings for the precompiled
`React.framework`, `ReactNativeDependencies.framework`, and `hermes.framework`.
This does not block TestFlight or App Store processing, but crashes inside those
frameworks may be less completely symbolicated. Recheck the Expo/React Native
release artifacts when upgrading the native dependency set; do not make a
last-minute framework replacement solely to silence this warning.
