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

## Completed in the repository

- Next iOS build number: 9
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
- Archive and upload build 9, then test it through TestFlight. Do not select any
  older App Store build for review.

## App Store Connect items still intentionally pending

- App privacy questionnaire: complete only after the deployed provider regions,
  retention, and diagnostics configuration are verified.
- Privacy, support, and marketing URLs: enter only after the public routes above
  are deployed and reachable.
- App Review contact information and review notes: require the owner's final
  contact details and a verified reviewer login path.
- Screenshots/app previews: paused until requested; use real app UI captures.
- Accessibility declarations: do not claim support before VoiceOver, Dynamic
  Type, contrast, and reduced-motion testing.
- Subscription products: do not create until StoreKit 2 entitlements, server
  transaction verification, App Store Server Notifications, restore purchases,
  and paywall/legal copy are implemented and tested.
- Submission for review: intentionally not performed.

## Product decisions to resolve

- Decide whether the iPad build is supported and tested. The current target
  includes iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`).
- Decide whether the iPhone/iPad app should also be available on Apple-silicon
  Macs. App Store Connect currently permits it, but it has not been certified.
- Finalize Plus regional prices. Avoid using the same numeric value for every
  currency; use purchasing-power tiers or Apple's automatic equivalents.
- “Unlimited” Plus should be marketed as no visible session/follow-up quota,
  while retaining abuse, concurrency, and daily cost safety limits in the
  backend.
