import * as SecureStore from 'expo-secure-store';

const RECONCILIATION_KEY = 'account_deletion_reconciliation_v2';
const LEGACY_RECONCILIATION_KEY = 'account_deletion_reconciliation_v1';
const MAX_RECORDS = 8;
let mutationTail: Promise<void> = Promise.resolve();

export interface DeletionReconciliationRecord {
  owner: string;
  receipt: string;
  createdAt: string;
  expiresAt: string;
}

interface StoredBundle {
  version: 2;
  records: DeletionReconciliationRecord[];
}

/**
 * Keep a purpose-bound deletion receipt separate from the ordinary login
 * bundle. It grants access only to deletion status, survives logout/session
 * expiry, and is signed by an independently rotatable long-lived key ring.
 */
export async function saveDeletionReconciliationReceipt(
  owner: string,
  receipt: string,
  expiresAt: string
): Promise<void> {
  assertRecord(owner, receipt, expiresAt);
  await runMutation(async () => {
    const records = (await readBundle()).filter(
      (item) => item.owner !== owner
    );
    if (records.length >= MAX_RECORDS) {
      throw new Error('Too many unresolved account-deletion operations');
    }
    records.push({
      owner,
      receipt,
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    await writeBundle(records);
  });
}

export async function listDeletionReconciliationReceipts(): Promise<
  DeletionReconciliationRecord[]
> {
  await mutationTail;
  return readBundle();
}

export async function clearDeletionReconciliationReceipt(
  owner: string
): Promise<void> {
  if (!owner.trim()) return;
  await runMutation(async () => {
    const records = (await readBundle()).filter(
      (item) => item.owner !== owner
    );
    if (records.length === 0) {
      await SecureStore.deleteItemAsync(RECONCILIATION_KEY).catch(() => {});
      return;
    }
    await writeBundle(records);
  });
}

function runMutation(operation: () => Promise<void>): Promise<void> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.catch(() => {});
  return result;
}

async function readBundle(): Promise<DeletionReconciliationRecord[]> {
  try {
    // v1 stored an ordinary access-token snapshot and is intentionally not
    // accepted by the new purpose-bound endpoint. Erase that obsolete secret.
    await SecureStore.deleteItemAsync(LEGACY_RECONCILIATION_KEY).catch(
      () => {}
    );
    const raw = await SecureStore.getItemAsync(RECONCILIATION_KEY);
    if (!raw) return [];
    const bundle = JSON.parse(raw) as Partial<StoredBundle>;
    if (bundle.version !== 2 || !Array.isArray(bundle.records)) return [];
    return bundle.records
      .filter(
        (record): record is DeletionReconciliationRecord =>
          Boolean(record) &&
          typeof record.owner === 'string' &&
          record.owner.length > 0 &&
          record.owner.length <= 128 &&
          typeof record.receipt === 'string' &&
          record.receipt.length >= 32 &&
          record.receipt.length <= 8_192 &&
          typeof record.createdAt === 'string' &&
          Number.isFinite(new Date(record.createdAt).getTime()) &&
          typeof record.expiresAt === 'string' &&
          Number.isFinite(new Date(record.expiresAt).getTime())
      )
      .slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

async function writeBundle(
  records: DeletionReconciliationRecord[]
): Promise<void> {
  await SecureStore.setItemAsync(
    RECONCILIATION_KEY,
    JSON.stringify({ version: 2, records } satisfies StoredBundle)
  );
}

function assertRecord(owner: string, receipt: string, expiresAt: string): void {
  if (!owner.trim() || owner.length > 128) {
    throw new Error('Invalid account-deletion owner');
  }
  if (receipt.length < 32 || receipt.length > 8_192) {
    throw new Error('Invalid account-deletion reconciliation credential');
  }
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('Invalid account-deletion receipt expiry');
  }
}
