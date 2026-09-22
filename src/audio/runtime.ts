export interface AudioRuntimeLease {
  readonly kind: 'recording' | 'playback';
  readonly token: symbol;
}

export interface AudioRecoveryQuarantine {
  readonly token: symbol;
}

let activeLease: AudioRuntimeLease | null = null;
const audioRecoveryQuarantines = new Set<symbol>();

/** Recording never preempts playback or another recorder. */
export function acquireRecordingAudioLease(): AudioRuntimeLease | null {
  if (activeLease || audioRecoveryQuarantines.size > 0) return null;
  const lease: AudioRuntimeLease = {
    kind: 'recording',
    token: Symbol('recording-audio-lease'),
  };
  activeLease = lease;
  return lease;
}

/** A new queue may replace older playback, but never a live recorder. */
export function acquirePlaybackAudioLease(): AudioRuntimeLease | null {
  if (
    activeLease?.kind === 'recording' ||
    audioRecoveryQuarantines.size > 0
  ) {
    return null;
  }
  const lease: AudioRuntimeLease = {
    kind: 'playback',
    token: Symbol('playback-audio-lease'),
  };
  activeLease = lease;
  return lease;
}

export function isAudioLeaseCurrent(lease: AudioRuntimeLease): boolean {
  return activeLease?.token === lease.token;
}

export function releaseAudioLease(lease: AudioRuntimeLease): void {
  if (isAudioLeaseCurrent(lease)) activeLease = null;
}

/**
 * An indeterminate native recorder/player is more dangerous than an ordinary
 * lease: it can become active after its React owner has gone away. Quarantine
 * the whole runtime until native silence is confirmed, so no other audio
 * operation can overlap a late microphone start or remotely resumed queue.
 */
export function beginAudioRecoveryQuarantine(): AudioRecoveryQuarantine {
  const quarantine = {
    token: Symbol('audio-recovery-quarantine'),
  };
  audioRecoveryQuarantines.add(quarantine.token);
  return quarantine;
}

export function endAudioRecoveryQuarantine(
  quarantine: AudioRecoveryQuarantine
): void {
  audioRecoveryQuarantines.delete(quarantine.token);
}

/** Account transitions invalidate playback without disturbing a recorder. */
export function invalidatePlaybackAudioLease(): void {
  if (activeLease?.kind === 'playback') activeLease = null;
}
