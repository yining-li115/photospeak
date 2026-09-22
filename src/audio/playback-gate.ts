import * as SecureStore from 'expo-secure-store';

/**
 * The TrackPlayer service runs in a separate JavaScript context, so in-memory
 * React state and audio leases cannot protect lock-screen/Bluetooth commands.
 * This small durable gate is the shared source of truth between both contexts.
 * Absence, corruption and read errors all fail closed.
 */
const REMOTE_PLAYBACK_GATE_KEY = 'photospeak_remote_playback_gate_v1';
const ENABLED = 'enabled';
const DISABLED = 'disabled';
let gateWriteTail: Promise<void> = Promise.resolve();
let gateWriteFailed = false;
const GATE_WRITE_TIMEOUT_MS = 3_000;

export async function setRemotePlaybackEnabled(
  enabled: boolean
): Promise<void> {
  if (gateWriteFailed) {
    throw new Error('Remote playback gate requires an app restart');
  }
  const writeCurrentValue = () => {
    if (gateWriteFailed) {
      throw new Error('Remote playback gate requires an app restart');
    }
    return writeGateValue(enabled);
  };
  const write = gateWriteTail.then(
    writeCurrentValue,
    writeCurrentValue
  );
  gateWriteTail = write.catch(() => {
    gateWriteFailed = true;
  });
  await write;
}

async function writeGateValue(enabled: boolean): Promise<void> {
  const rawWrite = SecureStore.setItemAsync(
    REMOTE_PLAYBACK_GATE_KEY,
    enabled ? ENABLED : DISABLED
  );
  rawWrite.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('Remote playback gate timed out'))),
      GATE_WRITE_TIMEOUT_MS
    );
    rawWrite.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

export async function isRemotePlaybackEnabled(): Promise<boolean> {
  try {
    return (
      (await SecureStore.getItemAsync(REMOTE_PLAYBACK_GATE_KEY)) === ENABLED
    );
  } catch {
    return false;
  }
}
