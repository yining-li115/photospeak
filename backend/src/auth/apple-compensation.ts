export type AppleCredentialCompensationResult =
  | 'revoked'
  | 'queued'
  | 'unrecoverable';

/**
 * Compensate an Apple code exchange whose local login did not commit.
 * Keeping this orchestration pure makes the critical double-failure behavior
 * testable without a database or live Apple endpoint.
 */
export async function compensateAppleCredential(input: {
  revoke: () => Promise<void>;
  enqueue?: () => Promise<void>;
}): Promise<AppleCredentialCompensationResult> {
  try {
    await input.revoke();
    return 'revoked';
  } catch {
    if (!input.enqueue) return 'unrecoverable';
    try {
      await input.enqueue();
      return 'queued';
    } catch {
      return 'unrecoverable';
    }
  }
}
