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

## Required before selecting a build

- Deploy the current backend and verify:
  - `https://api.dailyphotospeak.cn/`
  - `https://api.dailyphotospeak.cn/privacy`
  - `https://api.dailyphotospeak.cn/terms`
  - `https://api.dailyphotospeak.cn/support`
- Configure real production environment values on the server without exposing
  them in the mobile bundle or repository.
- Fund/authorize Volcengine resources and run the Ark, streaming ASR, and TTS
  verification scripts.
- Run a real-device end-to-end test: sign-in, photo selection, recording,
  transcription, AI feedback, TTS playback, follow-up, history, and account
  deletion.
- Archive and upload build 10, then test it through TestFlight. Do not select any
  older App Store build for review.

## App Store Connect items still intentionally pending

- App Review contact information and review notes: require the owner's final
  contact details and a verified reviewer login path.
- Screenshots/app previews: paused until requested; use real app UI captures.
- Accessibility declarations: do not claim support before VoiceOver, Dynamic
  Type, contrast, and reduced-motion testing.
- Subscription review screenshots remain required before the subscription
  products can be added to the first app-version submission.
- Submission for review: intentionally not performed.

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
