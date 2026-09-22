# PhotoSpeak database disaster-recovery runbook

## Launch gate

Daily logical dumps are useful for long-term backup, but they are not a safe
recovery-point objective for the billable AI operation ledger. Before paid
launch at scale, enable and test either managed PostgreSQL point-in-time
recovery or continuous WAL archiving to independent storage. Alert on backup,
WAL archive, and restore-drill failures. Keep the existing offsite dump as a
second recovery path, not as the only one.

No backup mechanism can make a non-idempotent AI provider exactly-once after
the database has been rolled back. The recovery fence below converts that
uncertainty into an explicit user decision instead of a silent second charge.

## Restore procedure

1. Stop every API process and block inbound app traffic. Record a conservative
   UTC cutoff at or after the time traffic became impossible. Do **not** use the
   older dump/PITR target as the cutoff: operations accepted between that point
   and traffic shutdown are exactly the rows that may be missing after restore.
2. Restore PostgreSQL using PITR/WAL when available; otherwise restore the most
   recent verified offsite dump. Run migrations before accepting traffic.
3. Set `AI_IDEMPOTENCY_RECOVERY_FENCE_CUTOFF` on every API instance to the
   recorded ISO-8601 UTC timestamp, for example
   `2026-09-19T14:32:00Z`. If a fence already exists, move it forward to the
   later cutoff—never backward.
4. Start the API and verify `/ready` reports the expected
   `idempotencyRecoveryFence` value. Do not reopen traffic if it is `inactive`
   or differs across instances.
5. Reopen traffic gradually and monitor 410 responses with code
   `IDEMPOTENCY_RECOVERY_FENCE`, provider spend, and operation/usage-ledger
   counts. Never log request bodies, idempotency keys, or key-ring material.

With the fence active:

- an operation row present in the restored database follows its normal replay,
  expiry, conflict, lease, or uncertain state;
- a missing v2 key timestamped at or before the cutoff plus ten minutes is
  atomically recorded as `recovery_fenced` and returns 410 before a provider
  call. The extra window matches the maximum client clock lead accepted by the
  v2 protocol, so a fast device cannot make a pre-incident operation appear
  safely new;
- a missing legacy UUID also fails closed because it has no trustworthy issue
  time;
- only a new v2 key timestamped after that effective cutoff may create
  executable work.

The app already treats this 410 as a high-risk restart boundary: it asks the
user to confirm, then rotates to a new key. Because client timestamps cannot
prove whether work happened before the rollback, this creates a deliberate
fail-closed embargo lasting at most ten minutes after the traffic-stop cutoff.
Wait until that window has passed before reopening billable AI traffic. If a
device remains fenced afterward, correct its automatic date/time before
retrying.

## Keeping or changing the fence

Keep the fence configured permanently after a restore. Static old cutoffs do
not affect normal new keys, and retaining the fence is the only safe treatment
for an unknown legacy UUID restored years later from an offline device backup.
For a later restore, replace it only with a newer cutoff.

Choosing a cutoff too late is fail-closed, extends the ten-minute embargo, and
may ask more users to confirm.
Choosing it too early can leave a duplicate-charge window; immediately stop
traffic, move it forward, and audit provider and usage records. Never clear the
fence merely to reduce 410 volume.

After recovery, perform a restore drill against an isolated database and verify
all four cases: known old replay, missing old v2 rejection, missing legacy
rejection, and post-cutoff execution. Record the recovery point, cutoff,
operator, restored backup/WAL identity, and verification results outside the
application database.
