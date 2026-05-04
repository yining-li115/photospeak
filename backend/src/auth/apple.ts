import { createRemoteJWKSet, jwtVerify } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys')
);

export interface AppleIdentity {
  /** Stable per-app Apple user identifier. Use this as the join key. */
  sub: string;
  /** Email if user chose to share. May be a "private relay" address. */
  email?: string;
  emailVerified?: boolean;
  /** Real-name flag set by Apple — informational, don't gate on it. */
  isPrivateEmail?: boolean;
}

/**
 * Verify an `identityToken` returned by Sign In with Apple on iOS.
 * Returns the decoded user identity if the token is genuinely from
 * Apple, addressed to our app, and not expired. Throws otherwise.
 *
 * `audience` MUST match the iOS app's bundle identifier, since Apple
 * signs identity tokens with the bundle id as the `aud` claim.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  audience: string
): Promise<AppleIdentity> {
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience,
  });

  if (typeof payload.sub !== 'string') {
    throw new Error('Apple token missing sub claim');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified:
      payload.email_verified === true || payload.email_verified === 'true',
    isPrivateEmail:
      payload.is_private_email === true || payload.is_private_email === 'true',
  };
}
