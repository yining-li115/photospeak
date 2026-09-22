export type DeletionStartDecision =
  | 'begin'
  | 'resume'
  | 'takeover'
  | 'recent_auth_required'
  | 'invalid';

export function decideDeletionStart(input: {
  deletionState: string;
  deleted: boolean;
  authorizedSessionId: string | null;
  currentSessionId: string;
  recentAuthentication: boolean;
}): DeletionStartDecision {
  if (input.deleted || input.deletionState === 'deleted') return 'invalid';
  if (input.deletionState === 'deleting') {
    if (input.authorizedSessionId === input.currentSessionId) return 'resume';
    return input.recentAuthentication ? 'takeover' : 'recent_auth_required';
  }
  if (input.deletionState !== 'active') return 'invalid';
  return input.recentAuthentication ? 'begin' : 'recent_auth_required';
}

export type AppleDeletionOutcome =
  | 'revoked'
  | 'manual_required'
  | 'not_applicable';

export function appleDeletionOutcome(
  appleUserId: string | null,
  durableCredentialCount: number
): AppleDeletionOutcome {
  if (!appleUserId) return 'not_applicable';
  return durableCredentialCount > 0 ? 'revoked' : 'manual_required';
}
