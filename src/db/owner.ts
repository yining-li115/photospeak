import { getDB } from './schema';

const LEGACY_OWNER_ID = '__legacy__';

let currentOwnerId: string | null = null;

/** Activate a database scope after the backend authenticates the user. */
export async function setCurrentOwner(userId: string): Promise<void> {
  const normalized = userId.trim();
  if (!normalized || normalized === LEGACY_OWNER_ID) {
    throw new Error('A valid authenticated user is required for local data');
  }
  currentOwnerId = normalized;
}

/** Legacy beta rows stay quarantined until the UI gets explicit confirmation. */
export async function hasLegacyData(): Promise<boolean> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ present: number }>(
    `SELECT EXISTS(
       SELECT 1 FROM sessions WHERE owner_user_id = ?
       UNION ALL
       SELECT 1 FROM cards WHERE owner_user_id = ?
       UNION ALL
       SELECT 1 FROM stats WHERE owner_user_id = ?
     ) AS present`,
    [LEGACY_OWNER_ID, LEGACY_OWNER_ID, LEGACY_OWNER_ID]
  );
  return row?.present === 1;
}

/**
 * Explicitly import pre-account beta data into the currently authenticated
 * account. Call only after a user-facing confirmation.
 */
export async function claimLegacyData(expectedOwnerId: string): Promise<void> {
  const owner = requireCurrentOwner();
  if (owner !== expectedOwnerId) {
    throw new Error('账号已切换，请重新确认内测数据导入');
  }
  const db = await getDB();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync('PRAGMA defer_foreign_keys = ON');
    await txn.runAsync(
      'UPDATE sessions SET owner_user_id = ? WHERE owner_user_id = ?',
      [owner, LEGACY_OWNER_ID]
    );
    await txn.runAsync(
      'UPDATE cards SET owner_user_id = ? WHERE owner_user_id = ?',
      [owner, LEGACY_OWNER_ID]
    );
    await txn.runAsync(
      `UPDATE session_chat_messages
       SET owner_user_id = ? WHERE owner_user_id = ?`,
      [owner, LEGACY_OWNER_ID]
    );
    await txn.runAsync(
      `INSERT INTO stats (
         owner_user_id, date, session_count, listening_seconds, cards_reviewed
       )
       SELECT ?, date, session_count, listening_seconds, cards_reviewed
       FROM stats WHERE owner_user_id = ?
       ON CONFLICT(owner_user_id, date) DO UPDATE SET
         session_count = session_count + excluded.session_count,
         listening_seconds = listening_seconds + excluded.listening_seconds,
         cards_reviewed = cards_reviewed + excluded.cards_reviewed`,
      [owner, LEGACY_OWNER_ID]
    );
    await txn.runAsync('DELETE FROM stats WHERE owner_user_id = ?', [
      LEGACY_OWNER_ID,
    ]);
  });
}

export function clearCurrentOwner(): void {
  currentOwnerId = null;
}

export function requireCurrentOwner(): string {
  if (!currentOwnerId) {
    throw new Error('Local data is unavailable without an authenticated user');
  }
  return currentOwnerId;
}
