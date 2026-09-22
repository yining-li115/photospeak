# PhotoSpeak App Review access

PhotoSpeak uses a dedicated review-only phone credential so Apple can exercise
the authenticated product without receiving an SMS or using anyone's personal
Apple Account.

## Security properties

- The fixed identifier is `10000000000`, a non-routable sentinel rejected by
  the ordinary mainland mobile-number validator.
- The six-digit code is generated on the production host. Only a keyed HMAC is
  stored in the API environment; the plaintext is written to a root-only file
  outside the repository.
- The normal per-IP and per-account verification limits still apply.
- The account receives the same product and cost safeguards as an ordinary
  free account. It is not an administrator and has no access to other users.
- Access is disabled unless `APP_REVIEW_ACCESS_ENABLED=true` is explicitly set.

## Configure or rotate

Run from the backend directory on the production host:

```sh
sudo node scripts/configure-app-review-access.mjs \
  --env /root/photospeak/backend/.env \
  --output /root/photospeak-app-review-credential.txt
```

The output file is created exclusively and the command refuses to overwrite an
existing credential. To rotate, first move the old root-only credential into a
protected archive or securely remove it, then run the command again. Restart
the API with its updated environment and verify the review path before saving
the credentials in App Store Connect.

## App Store Connect fields

- Select **Sign-in required**.
- Username: the `phone` value from the root-only credential file.
- Password: the `code` value from the root-only credential file.
- Explain in Review Notes that the reviewer should accept the legal agreements,
  choose phone login, enter the demo number, tap **Get verification code**, and
  enter the fixed code. No SMS is sent for this account.

Never enter a personal Apple Account, developer password, real customer's phone
number, production API key, or server credential in the review fields.

## Disable after review

Set `APP_REVIEW_ACCESS_ENABLED=false` in the production backend environment and
restart the API. Retain or rotate the HMAC only according to the release team's
credential-retention policy. Disabling the flag immediately prevents the
sentinel number from being accepted by either authentication endpoint.
