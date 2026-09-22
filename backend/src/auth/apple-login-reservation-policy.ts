export type AppleLoginReservationMode = 'active' | 'restore' | 'provision';

export function isAppleLoginReservationCurrent(input: {
  expectedId: string;
  actualId: string | null;
  expiresAt: Date | null;
  now: Date;
  mode: AppleLoginReservationMode;
  deletionState: string;
  deleted: boolean;
}): boolean {
  if (
    input.actualId !== input.expectedId ||
    !input.expiresAt ||
    input.expiresAt <= input.now ||
    input.deletionState === 'deleting'
  ) {
    return false;
  }
  if (input.mode === 'active') {
    return input.deletionState === 'active' && !input.deleted;
  }
  if (input.mode === 'restore') return input.deleted;
  return input.deletionState === 'provisioning' && !input.deleted;
}
