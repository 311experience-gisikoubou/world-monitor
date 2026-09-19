#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  boundedTaskWait,
  boundedTaskWaitLimits,
  parseBoundedWaitArgs,
} from './bounded-task-wait.mjs';

function expectCode(fn, code) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code);
  }
}

assert.deepEqual(
  parseBoundedWaitArgs(['wait', 'task-1', '--until', 'ready', '--timeout-ms', '6000']),
  { taskId: 'task-1', until: 'ready', timeoutMs: 6000 },
);
assert.deepEqual(
  parseBoundedWaitArgs(['wait', 'task-1', '--until', 'completed']),
  { taskId: 'task-1', until: 'completed', timeoutMs: 6000 },
);
expectCode(
  () => parseBoundedWaitArgs(['wait', 'task-1', '--until', 'completed', '--timeout-ms', '8000']),
  'TASK_WAIT_TIMEOUT_EXCEEDS_BOUND',
);
expectCode(() => parseBoundedWaitArgs(['wait', 'task-1', '--until', 'maybe']), 'TASK_WAIT_UNTIL_INVALID');

const ready = await boundedTaskWait({
  taskId: 'task-ready', until: 'ready', timeoutMs: 1000, pollIntervalMs: 250,
  readStatus: () => ({ result: 'RUNNING', pid: 101, cdpReady: true }),
});
assert.equal(ready.schemaVersion, 1);
assert.equal(ready.state, 'READY');
assert.equal(ready.timedOut, false);
assert.equal(ready.pidAlive, true);
assert.equal(ready.next, 'RESULT');

let completedReads = 0;
const completed = await boundedTaskWait({
  taskId: 'task-completed', until: 'completed', timeoutMs: 1000, pollIntervalMs: 250,
  readStatus: () => {
    completedReads += 1;
    return completedReads === 1
      ? { result: 'RUNNING', pid: 102 }
      : { result: 'COMPLETED', pid: 102, exitCode: 0 };
  },
});
assert.equal(completed.schemaVersion, 1);
assert.equal(completed.state, 'COMPLETED');
assert.equal(completed.timedOut, false);
assert.equal(completed.pidAlive, false);
assert.equal(completed.next, 'RESULT');
assert.equal(completedReads, 2);

const failed = await boundedTaskWait({
  taskId: 'task-failed', until: 'completed', timeoutMs: 1000, pollIntervalMs: 250,
  readStatus: () => ({ result: 'FAILED', pid: 103, code: 'WORKER_EXITED_WITHOUT_RECEIPT' }),
});
assert.equal(failed.schemaVersion, 1);
assert.equal(failed.state, 'FAILED');
assert.equal(failed.timedOut, false);
assert.equal(failed.pidAlive, false);
assert.equal(failed.next, 'INVESTIGATE');

const timedOut = await boundedTaskWait({
  taskId: 'task-running', until: 'completed', timeoutMs: 300, pollIntervalMs: 250,
  readStatus: () => ({ result: 'RUNNING', pid: 104 }),
});
assert.equal(timedOut.schemaVersion, 1);
assert.equal(timedOut.state, 'RUNNING');
assert.equal(timedOut.timedOut, true);
assert.equal(timedOut.pidAlive, true);
assert.equal(timedOut.next, 'WAIT_AGAIN');
assert.ok(timedOut.elapsedMs >= 300);
assert.ok(timedOut.elapsedMs < 1000);

await assert.rejects(
  boundedTaskWait({
    taskId: 'task-unknown', until: 'completed', timeoutMs: 1000, pollIntervalMs: 250,
    readStatus: () => ({ result: 'MYSTERY' }),
  }),
  (error) => error.code === 'TASK_WAIT_STATE_INVALID',
);

assert.deepEqual(boundedTaskWaitLimits, {
  defaultTimeoutMs: 6000,
  maxTimeoutMs: 7000,
  defaultPollIntervalMs: 1000,
  minPollIntervalMs: 250,
  maxPollIntervalMs: 2000,
});

console.log('bounded-task-wait selftest: PASS');
