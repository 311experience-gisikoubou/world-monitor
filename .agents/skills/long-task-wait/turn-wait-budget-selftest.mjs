#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateTurnWaitBudget, turnWaitBudgetLimits } from './turn-wait-budget.mjs';

const start = 1_000_000;
let out = evaluateTurnWaitBudget({ turnWaitStartedAtMs: start, nowMs: start });
assert.equal(out.decision, 'WAIT_ALLOWED');
assert.equal(out.allowedWaitMs, 6000);
assert.equal(out.remainingMs, 15000);

out = evaluateTurnWaitBudget({ turnWaitStartedAtMs: start, nowMs: start + 6_000 });
assert.equal(out.decision, 'WAIT_ALLOWED');
assert.equal(out.allowedWaitMs, 6000);

out = evaluateTurnWaitBudget({ turnWaitStartedAtMs: start, nowMs: start + 12_000 });
assert.equal(out.decision, 'CHECKPOINT_AND_END_TURN');
assert.equal(out.allowedWaitMs, 0);
assert.equal(out.next, 'SAVE_PLATFORM_TURN_CHECKPOINT');

out = evaluateTurnWaitBudget({ turnWaitStartedAtMs: start, nowMs: start + 10_000 });
assert.equal(out.decision, 'WAIT_ALLOWED');
assert.equal(out.allowedWaitMs, 2000);

for (const bad of [
  { turnWaitStartedAtMs: start, nowMs: start - 1 },
  { turnWaitStartedAtMs: start, nowMs: start, requestedWaitMs: 8000 },
  { turnWaitStartedAtMs: start, nowMs: start, turnBudgetMs: 31_000 },
  { turnWaitStartedAtMs: start, nowMs: start, checkpointReserveMs: 1000 },
]) {
  assert.throws(() => evaluateTurnWaitBudget(bad));
}

const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./turn-wait-budget.mjs', import.meta.url))], {
  input: JSON.stringify({ turnWaitStartedAtMs: start, nowMs: start + 12_000 }),
  encoding: 'utf8',
});
assert.equal(cli.status, 3);
assert.equal(JSON.parse(cli.stdout).decision, 'CHECKPOINT_AND_END_TURN');

assert.deepEqual(turnWaitBudgetLimits, {
  defaultTurnBudgetMs: 15000,
  maxTurnBudgetMs: 30000,
  defaultCheckpointReserveMs: 3000,
  minCheckpointReserveMs: 2000,
  maxCheckpointReserveMs: 7000,
  minUsefulWaitMs: 1000,
});

console.log('turn-wait-budget selftest: PASS');
