export const HARD_APP_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const MIN_DEVICE_FREE_STORAGE_BYTES = 250 * 1024 * 1024;
const MIN_DATABASE_WRITE_RESERVE_BYTES = 64 * 1024;
const DATABASE_WRITE_AMPLIFICATION = 3;

export interface AppWriteCapacityInput {
  appStorageBytes: number;
  availableBytes: number;
  incomingBytes: number;
}

export type AppWriteCapacityFailure =
  | 'app_limit'
  | 'device_free_limit'
  | 'invalid_size';

/** Pure policy kept separate from Expo APIs so boundary cases are unit-testable. */
export function appWriteCapacityFailure(
  input: AppWriteCapacityInput
): AppWriteCapacityFailure | null {
  const { appStorageBytes, availableBytes, incomingBytes } = input;
  if (
    !Number.isSafeInteger(incomingBytes) ||
    incomingBytes <= 0 ||
    !Number.isFinite(appStorageBytes) ||
    appStorageBytes < 0 ||
    !Number.isFinite(availableBytes) ||
    availableBytes < 0
  ) {
    return 'invalid_size';
  }
  if (appStorageBytes > HARD_APP_STORAGE_LIMIT_BYTES - incomingBytes) {
    return 'app_limit';
  }
  if (availableBytes < MIN_DEVICE_FREE_STORAGE_BYTES + incomingBytes) {
    return 'device_free_limit';
  }
  return null;
}

/** Conservative table/index/WAL growth estimate for one logical DB write. */
export function estimateDatabaseGrowthBytes(
  values: readonly unknown[]
): number {
  let payloadBytes = 0;
  for (const value of values) payloadBytes += serializedByteLength(value);
  return Math.max(
    MIN_DATABASE_WRITE_RESERVE_BYTES,
    Math.ceil(payloadBytes * DATABASE_WRITE_AMPLIFICATION)
  );
}

function serializedByteLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return utf8ByteLength(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return utf8ByteLength(String(value));
  }
  try {
    return utf8ByteLength(JSON.stringify(value));
  } catch {
    return MIN_DATABASE_WRITE_RESERVE_BYTES;
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
