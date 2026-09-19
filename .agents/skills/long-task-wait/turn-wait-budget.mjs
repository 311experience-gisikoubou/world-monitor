#!/usr/bin/env node
import process from 'node:process';
import { boundedTaskWaitLimits } from './bounded-task-wait.mjs';

const DEFAULT_TURN_BUDGET_MS = 15_000;
const MAX_TURN_BUDGET_MS = 30_000;
const DEFAULT_CHECKPOINT_RESERVE_MS = 3_000;
const MIN_CHECKPOINT_RESERVE_MS = 2_000;
const MAX_CHECKPOINT_RESERVE_MS = 7_000;
const MIN_USEFUL_WAIT_MS = 1_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function integer(value, code) {
  if (!Number.isInteger(value) || value < 0) throw fail(code);
  return value;
}

export function evaluateTurnWaitBudget({
  turnWaitStartedAtMs,
  nowMs = Date.now(),
  requestedWaitMs = boundedTaskWaitLimits.defaultTimeoutMs,
  turnBudgetMs = DEFAULT_TURN_BUDGET_MS,
  checkpointReserveMs = DEFAULT_CHECKPOINT_RESERVE_MS,
} = {}) {
  integer(turnWaitStartedAtMs, 'TURN_WAIT_STARTED_AT_INVALID');
  integer(nowMs, 'TURN_WAIT_NOW_INVALID');
  integer(requestedWaitMs, 'TURN_WAIT_REQUEST_INVALID');
  integer(turnBudgetMs, 'TURN_WAIT_BUDGET_INVALID');
  integer(checkpointReserveMs, 'TURN_WAIT_RESERVE_INVALID');
  if (nowMs < turnWaitStartedAtMs) throw fail('TURN_WAIT_CLOCK_INVALID');
  if (requestedWaitMs <= 0 || requestedWaitMs > boundedTaskWaitLimits.maxTimeoutMs) throw fail('TURN_WAIT_REQUEST_OUT_OF_RANGE');
  if (turnBudgetMs <= checkpointReserveMs || turnBudgetMs > MAX_TURN_BUDGET_MS) throw fail('TURN_WAIT_BUDGET_OUT_OF_RANGE');
  if (checkpointReserveMs < MIN_CHECKPOINT_RESERVE_MS || checkpointReserveMs > MAX_CHECKPOINT_RESERVE_MS) throw fail('TURN_WAIT_RESERVE_OUT_OF_RANGE');

  const elapsedMs = nowMs - turnWaitStartedAtMs;
  const remainingMs = Math.max(0, turnBudgetMs - elapsedMs);
  const safeWaitWindowMs = Math.max(0, remainingMs - checkpointReserveMs);
  const allowedWaitMs = Math.min(requestedWaitMs, safeWaitWindowMs);
  const boundary = allowedWaitMs < MIN_USEFUL_WAIT_MS;

  return {
    schemaVersion: 1,
    decision: boundary ? 'CHECKPOINT_AND_END_TURN' : 'WAIT_ALLOWED',
    turnWaitStartedAtMs,
    nowMs,
    elapsedMs,
    turnBudgetMs,
    checkpointReserveMs,
    remainingMs,
    requestedWaitMs,
    allowedWaitMs: boundary ? 0 : allowedWaitMs,
    next: boundary ? 'SAVE_PLATFORM_TURN_CHECKPOINT' : 'BOUNDED_WAIT',
  };
}

export const turnWaitBudgetLimits = Object.freeze({
  defaultTurnBudgetMs: DEFAULT_TURN_BUDGET_MS,
  maxTurnBudgetMs: MAX_TURN_BUDGET_MS,
  defaultCheckpointReserveMs: DEFAULT_CHECKPOINT_RESERVE_MS,
  minCheckpointReserveMs: MIN_CHECKPOINT_RESERVE_MS,
  maxCheckpointReserveMs: MAX_CHECKPOINT_RESERVE_MS,
  minUsefulWaitMs: MIN_USEFUL_WAIT_MS,
});
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join('');
}

if (process.argv[1]?.endsWith('turn-wait-budget.mjs')) {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw || '{}');
    const output = evaluateTurnWaitBudget(input);
    console.log(JSON.stringify(output));
    if (output.decision === 'CHECKPOINT_AND_END_TURN') process.exitCode = 3;
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, decision: 'STOP', code: error?.code || error?.message || 'TURN_WAIT_BUDGET_FAILED' }));
    process.exitCode = 2;
  }
}
