import {
  assertAuthSessionEpoch,
  getAuthSessionEpoch,
} from '../api/backend';
import { requireCurrentOwner } from '../db/owner';

/**
 * Immutable identity boundary for work that can outlive the event that started
 * it (photo manipulation, recorder shutdown, TTS generation, and so on).
 *
 * Owner ids alone are insufficient: logging out and back into the same account
 * must also invalidate callbacks from the previous authenticated session.
 */
export interface AccountOperationScope {
  readonly owner: string;
  readonly authEpoch: number;
}

export function captureAccountOperationScope(): AccountOperationScope {
  const authEpoch = getAuthSessionEpoch();
  const owner = requireCurrentOwner();
  assertAuthSessionEpoch(authEpoch);
  return { owner, authEpoch };
}

export function assertAccountOperationScope(
  scope: AccountOperationScope
): void {
  assertAuthSessionEpoch(scope.authEpoch);
  if (requireCurrentOwner() !== scope.owner) {
    throw new Error('The signed-in account changed while the operation was running');
  }
}

export function isAccountOperationScopeCurrent(
  scope: AccountOperationScope
): boolean {
  try {
    assertAccountOperationScope(scope);
    return true;
  } catch {
    return false;
  }
}
