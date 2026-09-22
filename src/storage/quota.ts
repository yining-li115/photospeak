import { Paths } from 'expo-file-system';
import {
  appWriteCapacityFailure,
  estimateDatabaseGrowthBytes,
} from './capacity-policy';
import { getAppStorageUsage } from './inventory';

export class StorageCapacityError extends Error {
  constructor(
    message = '本机存储空间不足。请先在练习列表删除不需要的旧记录，再创建新练习。'
  ) {
    super(message);
    this.name = 'StorageCapacityError';
  }
}

/** Guard a media or database write against both the app cap and device floor. */
export function ensureAppStorageCapacityForWrite(incomingBytes: number): void {
  const usage = getAppStorageUsage();
  const failure = appWriteCapacityFailure({
    appStorageBytes: usage.totalBytes,
    availableBytes: Math.max(0, Paths.availableDiskSpace),
    incomingBytes,
  });
  if (failure) throw new StorageCapacityError();
}

/**
 * Reserve conservative SQLite/WAL growth before storing user- or AI-generated
 * text. This is intentionally an estimate; the filesystem-based hard check is
 * repeated for every logical write rather than trusting row counts.
 */
export function ensureDatabaseWriteCapacity(
  values: readonly unknown[]
): void {
  ensureAppStorageCapacityForWrite(estimateDatabaseGrowthBytes(values));
}
