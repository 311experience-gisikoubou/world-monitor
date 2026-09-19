#!/usr/bin/env node
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_TIMEOUT_MS = 7_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 2_000;
const ALLOWED_UNTIL = new Set(['ready', 'completed']);
const ALLOWED_STATES = new Set(['RUNNING', 'READY', 'COMPLETED', 'FAILED']);

function stop(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parsePositiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw stop(code);
  return parsed;
}

function normalizedState(status) {
  const raw = String(status?.state ?? status?.result ?? '').toUpperCase();
  if (!ALLOWED_STATES.has(raw)) throw stop('TASK_WAIT_STATE_INVALID');
  if (raw === 'RUNNING' && status?.cdpReady === true) return 'READY';
  return raw;
}

function pidAliveFrom(status, state) {
  if (typeof status?.pidAlive === 'boolean') return status.pidAlive;
  if (state === 'RUNNING' || state === 'READY') return true;
  if (state === 'COMPLETED') return false;
  if (state === 'FAILED') return false;
  return null;
}

function nextFor(state, timedOut, until) {
  if (timedOut) return 'WAIT_AGAIN';
  if (state === 'FAILED') return 'INVESTIGATE';
  if (state === 'COMPLETED' || (until === 'ready' && state === 'READY')) return 'RESULT';
  return 'WAIT_AGAIN';
}

function resultFor(taskId, status, state, timedOut, elapsedMs, until) {
  return {
    schemaVersion: 1,
    taskId,
    state,
    timedOut,
    elapsedMs,
    pidAlive: pidAliveFrom(status, state),
    next: nextFor(state, timedOut, until),
    status,
  };
}

export function parseBoundedWaitArgs(args) {
  if (!Array.isArray(args) || args[0] !== 'wait' || !args[1]) throw stop('TASK_WAIT_USAGE');
  const taskId = args[1];
  let until = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === '--until' && i + 1 < args.length) {
      until = String(args[++i]).toLowerCase();
    } else if (args[i] === '--timeout-ms' && i + 1 < args.length) {
      timeoutMs = parsePositiveInteger(args[++i], 'TASK_WAIT_TIMEOUT_INVALID');
    } else {
      throw stop('TASK_WAIT_USAGE');
    }
  }

  if (!ALLOWED_UNTIL.has(until)) throw stop('TASK_WAIT_UNTIL_INVALID');
  if (timeoutMs > MAX_TIMEOUT_MS) throw stop('TASK_WAIT_TIMEOUT_EXCEEDS_BOUND');
  return { taskId, until, timeoutMs };
}

export async function boundedTaskWait({
  taskId,
  until,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  readStatus,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  if (typeof taskId !== 'string' || !taskId) throw stop('TASK_WAIT_TASK_ID_REQUIRED');
  if (!ALLOWED_UNTIL.has(until)) throw stop('TASK_WAIT_UNTIL_INVALID');
  if (typeof readStatus !== 'function') throw stop('TASK_WAIT_STATUS_READER_REQUIRED');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw stop('TASK_WAIT_TIMEOUT_INVALID');
  if (timeoutMs > MAX_TIMEOUT_MS) throw stop('TASK_WAIT_TIMEOUT_EXCEEDS_BOUND');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw stop('TASK_WAIT_POLL_INTERVAL_INVALID');
  }

  const startedAt = Date.now();
  while (true) {
    const status = await readStatus(taskId);
    if (!status || typeof status !== 'object') throw stop('TASK_WAIT_STATUS_INVALID');
    const state = normalizedState(status);
    const elapsedMs = Date.now() - startedAt;

    if (state === 'FAILED' || state === 'COMPLETED' || (until === 'ready' && state === 'READY')) {
      return resultFor(taskId, status, state, false, elapsedMs, until);
    }

    if (elapsedMs >= timeoutMs) {
      return resultFor(taskId, status, state, true, elapsedMs, until);
    }

    const remainingMs = timeoutMs - elapsedMs;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
}

export const boundedTaskWaitLimits = Object.freeze({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  defaultPollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  minPollIntervalMs: MIN_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
});

if (process.argv[1]?.endsWith('bounded-task-wait.mjs')) {
  process.stderr.write('This module is a read-only helper. Import it from a task runner; it does not execute arbitrary commands.\n');
  process.exitCode = 2;
}
