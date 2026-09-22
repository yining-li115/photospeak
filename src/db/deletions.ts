import { getDB } from './schema';

export type LocalDeletionPhase = 'intent' | 'server_committed';

export async function markOwnerDeletionIntent(owner: string): Promise<void> {
  assertOwner(owner);
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO local_deletion_tombstones (
       owner_user_id, created_at, phase
     ) VALUES (?, ?, 'intent')
     ON CONFLICT(owner_user_id) DO UPDATE SET
       created_at = excluded.created_at,
       phase = 'intent'`,
    [owner, new Date().toISOString()]
  );
}

/** Advance only after the server proved deletion was accepted or completed. */
export async function markOwnerDeletionServerCommitted(
  owner: string
): Promise<void> {
  assertOwner(owner);
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO local_deletion_tombstones (
       owner_user_id, created_at, phase
     ) VALUES (?, ?, 'server_committed')
     ON CONFLICT(owner_user_id) DO UPDATE SET
       phase = 'server_committed'`,
    [owner, new Date().toISOString()]
  );
}

export async function clearOwnerDeletionPending(owner: string): Promise<void> {
  assertOwner(owner);
  const db = await getDB();
  await db.runAsync(
    'DELETE FROM local_deletion_tombstones WHERE owner_user_id = ?',
    [owner]
  );
}

export async function getOwnerDeletionPhase(
  owner: string
): Promise<LocalDeletionPhase | null> {
  assertOwner(owner);
  const db = await getDB();
  const row = await db.getFirstAsync<{ phase: string }>(
    `SELECT phase FROM local_deletion_tombstones
     WHERE owner_user_id = ?`,
    [owner]
  );
  return row?.phase === 'intent' || row?.phase === 'server_committed'
    ? row.phase
    : null;
}

export async function listCommittedOwnerDeletions(): Promise<string[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM local_deletion_tombstones
     WHERE phase = 'server_committed'
     ORDER BY created_at ASC`
  );
  return rows.map((row) => row.owner_user_id);
}

function assertOwner(owner: string): void {
  if (!owner.trim() || owner === '__legacy__' || owner.length > 128) {
    throw new Error('Invalid owner for local deletion');
  }
}
