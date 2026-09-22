import assert from 'node:assert/strict';
import test from 'node:test';
import { RecorderRuntimeResetBarrier } from '../src/recording/runtime-reset.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('reset invalidates and waits for every overlapping start', async () => {
  const barrier = new RecorderRuntimeResetBarrier();
  const first = barrier.beginStart();
  const second = barrier.beginStart();
  assert.ok(first);
  assert.ok(second);

  const reset = barrier.beginReset();
  assert.equal(barrier.resetActive, true);
  assert.equal(barrier.isStartCurrent(first), false);
  assert.equal(barrier.isStartCurrent(second), false);
  assert.equal(barrier.beginStart(), null);

  let resetSettled = false;
  const waiting = reset.waitForOverlappingStarts(1_000).then((outcome) => {
    resetSettled = outcome === 'settled';
  });
  await Promise.resolve();
  assert.equal(resetSettled, false);

  first.finish();
  await Promise.resolve();
  assert.equal(resetSettled, false);

  second.finish();
  await waiting;
  assert.equal(resetSettled, true);

  reset.finish();
  assert.equal(barrier.resetActive, false);
});

test('a reset that wins the entry race refuses native start permits', () => {
  const barrier = new RecorderRuntimeResetBarrier();
  const reset = barrier.beginReset();

  assert.equal(barrier.beginStart(), null);
  reset.finish();

  const later = barrier.beginStart();
  assert.ok(later);
  assert.equal(barrier.isStartCurrent(later), true);
  later.finish();
  assert.equal(barrier.isStartCurrent(later), false);
});

test('queued resets keep the runtime closed until the last reset finishes', () => {
  const barrier = new RecorderRuntimeResetBarrier();
  const firstReset = barrier.beginReset();
  const secondReset = barrier.beginReset();

  firstReset.finish();
  assert.equal(barrier.resetActive, true);
  assert.equal(barrier.beginStart(), null);

  secondReset.finish();
  assert.equal(barrier.resetActive, false);
  const start = barrier.beginStart();
  assert.ok(start);
  start.finish();
});

test('a late native start is stopped before the reset barrier settles', async () => {
  const barrier = new RecorderRuntimeResetBarrier();
  const start = barrier.beginStart();
  assert.ok(start);
  const nativeStart = deferred();
  const nativeStop = deferred();
  let microphoneActive = false;

  const startTask = (async () => {
    try {
      await nativeStart.promise;
      microphoneActive = true;
      if (!barrier.isStartCurrent(start)) {
        await nativeStop.promise;
        microphoneActive = false;
      }
    } finally {
      start.finish();
    }
  })();

  const reset = barrier.beginReset();
  let resetSettled = false;
  const resetTask = reset.waitForOverlappingStarts(1_000).then((outcome) => {
    resetSettled = outcome === 'settled';
  });

  nativeStart.resolve();
  await Promise.resolve();
  assert.equal(microphoneActive, true);
  assert.equal(resetSettled, false);

  nativeStop.resolve();
  await startTask;
  await resetTask;
  assert.equal(microphoneActive, false);
  assert.equal(resetSettled, true);
  reset.finish();
});

test('a wedged start times out without opening the runtime', async () => {
  const barrier = new RecorderRuntimeResetBarrier();
  const start = barrier.beginStart();
  assert.ok(start);
  const reset = barrier.beginReset();

  assert.equal(await reset.waitForOverlappingStarts(1), 'timeout');
  assert.equal(barrier.resetActive, true);
  assert.equal(barrier.beginStart(), null);
  assert.equal(barrier.isStartCurrent(start), false);

  start.finish();
  assert.equal(await reset.waitForOverlappingStarts(1_000), 'settled');
  reset.finish();
});

test('permit completion is idempotent', async () => {
  const barrier = new RecorderRuntimeResetBarrier();
  const start = barrier.beginStart();
  assert.ok(start);
  const reset = barrier.beginReset();

  start.finish();
  start.finish();
  assert.equal(
    await reset.waitForOverlappingStarts(1_000),
    'settled'
  );
  reset.finish();
  reset.finish();
  assert.equal(barrier.resetActive, false);
});
