#!/usr/bin/env node
await import('./bounded-task-wait-selftest.mjs');
await import('./turn-wait-budget-selftest.mjs');
console.log('long-task-wait selftest: PASS');
