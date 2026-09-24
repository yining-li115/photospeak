# PhotoSpeak release functional test plan

Last updated: 2026-09-23

This is the owner-facing release checklist. Automated checks cover code and
server behavior; the items below require a real iPhone, a human voice, Apple
account UI, or subjective product judgment. Test the exact TestFlight build
that will later be selected in App Store Connect.

Record the device model, iOS version, build number, network type, tester
account, and result for every run. A crash, data leak between accounts, lost
purchase, double charge, stuck recording, or inability to delete an account is
a release blocker.

## 1. Installation and consent

- Fresh-install build 13 on an iPhone, launch it, and confirm the welcome screen
  is usable on both light and dark system appearance.
- Try signing in without checking the agreement box. Sign-in must stay blocked
  and explain why.
- Open the full Privacy Policy and Terms, return to the app, check the box, and
  sign in. Returning from either document must not silently clear the consent
  state.
- Deny and later re-enable photo and microphone permissions in iOS Settings.
  Each path must show a useful recovery message and must not crash.

## 2. Authentication and account isolation

- Complete the supported sign-in methods on a real device, including Apple
  private-email relay if offered.
- Kill and relaunch the app; the session should restore without asking for a
  new code.
- Sign out, sign in as a different account, and confirm the previous account's
  photos, recordings, drafts, history, and playback never appear.
- Exercise wrong/expired verification codes and a temporarily unavailable
  network. Errors should be actionable and should not create duplicate users.

## 3. Core photo-to-feedback flow

- Test a camera photo, a library photo, a portrait image, a landscape image,
  and a large image. Confirm orientation and cropping are correct.
- Start recording and stop manually before one minute. Review, discard, and
  rerecord must all work.
- Let recording run continuously: the main timer must reach 1:00, show the
  10-second wrap-up phase with warning feedback, and stop automatically at
  1:10. It must then continue to transcription exactly once.
- While recording, send the app to the background, lock the phone, trigger an
  audio interruption, switch tabs, and unplug a headset. Recording must stop
  safely and must never continue invisibly.
- Confirm streaming transcription feels responsive, partial text does not
  duplicate or reorder itself, and the final transcript matches the recording.
- Generate feedback, play every TTS item, pause/resume/seek where available,
  and switch rapidly between items. Only one audio stream may play at a time.
- Ask several follow-up questions, background and foreground the app during a
  request, and retry after a network failure. A request must not be charged or
  inserted twice.
- Reopen the completed session from history and compare its photo, transcript,
  feedback, chat, and audio behavior with the original.

## 4. Subscription and entitlement

- Using an Apple sandbox tester, buy the monthly product
  `com.yining.photospeak.plus.monthly`. Confirm the app uses Apple's localized
  price and unlocks Plus only after StoreKit verification.
- Repeat with the annual product `com.yining.photospeak.plus.annual` on a clean
  tester account.
- Test cancel, accelerated sandbox renewal, billing retry/grace period,
  expiration, and refund/revocation. The backend and app must converge to the
  same entitlement.
- Delete/reinstall the app and use Restore Purchases. Also sign into the same
  app account on a second device and confirm entitlement recovery.
- Tap purchase repeatedly and interrupt the network during checkout. There
  must be no duplicate entitlement rows or misleading success state.
- Confirm Plus has no visible monthly session or follow-up counter, while
  abusive concurrency and cost-safety throttling produce a clear temporary
  message rather than data loss.

## 5. Storage, deletion, and recovery

- Create enough sessions to verify history remains fast and device storage does
  not grow unexpectedly. Confirm original temporary recordings are removed
  after processing and that thumbnails are used in list views.
- Test with the device nearly full. Photo/recording work should fail safely with
  an understandable storage message.
- Start a draft, force-quit, relaunch, and verify that recoverable state returns
  without orphaned audio or a duplicate session.
- Delete one session and confirm its photo/audio are removed from app storage.
- Request account deletion, verify the warning, complete deletion, and confirm
  sign-in no longer exposes the old account's data. Recheck after the documented
  retention window from an operator view before release.

## 6. Network and performance matrix

- Run the core flow on good Wi-Fi, cellular, high-latency/packet-loss network,
  airplane-mode transition, and a connection that drops mid-ASR and mid-AI
  response.
- Measure: time to first transcript, final transcript latency after stopping,
  AI-feedback latency, TTS start latency, peak device storage, and any thermal
  or battery warning.
- Test at least one older supported iPhone and the smallest supported screen.
  If iPad remains enabled, complete the entire checklist on iPad before release;
  otherwise remove iPad from the supported device family.

## 7. Release decision

- Retest every fixed blocker on the final TestFlight build rather than a local
  Expo development build.
- Capture App Store screenshots only after UI and copy are frozen.
- Add the reviewer contact/login path and subscription review screenshots.
- Select build 13 or a later fully tested build, then perform one final metadata,
  privacy-label, price, entitlement, and legal-link review before submission.
- Submission remains a deliberate owner action; this plan does not authorize
  submitting the app for review.
