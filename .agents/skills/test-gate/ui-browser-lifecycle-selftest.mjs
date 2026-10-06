#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initializeManagedRun,
  cleanupManagedBrowser,
  scanManagedOrphans,
  runWithManagedBrowserLifecycle,
  verifyCleanupReceipt,
  UI_BROWSER_OWNER,
  ORPHAN_ABNORMAL_MS,
} from './ui-browser-lifecycle.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-browser-lifecycle-selftest-'));
const stateId = 'worktree:' + 'a'.repeat(64);
const baseNow = Date.parse('2026-10-05T00:00:00.000Z');

function proc(pid, ppid, name, commandLine = '') {
  return { pid, ppid, name, commandLine };
}
function chromeLine(record) {
  return 'chrome.exe --headless=new --remote-debugging-port=' + record.cdpPort +
    ' --user-data-dir="' + record.userDataDir + '"';
}
function fakeDeps(processes, { now = baseNow, portFree = true, ignoreKill = new Set(), reparentOnKill = false } = {}) {
  const list = processes;
  const kills = [];
  return {
    kills,
    now: () => now,
    listProcesses: () => list.map(item => ({ ...item })),
    killPid: pid => {
      kills.push(pid);
      if (!ignoreKill.has(pid)) {
        if (reparentOnKill) for (const child of list) if (child.ppid === pid) child.ppid = 1;
        const index = list.findIndex(p => p.pid === pid);
        if (index >= 0) list.splice(index, 1);
      }
      return true;
    },
    portFree: async () => portFree,
    sleep: async () => {},
  };
}
function makeRun(runId, {
  browserPid = 100, launcherPid = 90, port = 9222,
  startedAt = new Date(baseNow - 2 * 60 * 60 * 1000).toISOString(),
  heartbeatAt = new Date(baseNow - 10 * 60 * 1000).toISOString(),
} = {}) {
  return initializeManagedRun({
    managedRoot: root,
    runId,
    repository: 'acme/app',
    browserPid,
    launcherPid,
    cdpPort: port,
    startedAt,
    heartbeatAt,
  });
}

try {
  {
    const record = makeRun('normal', { browserPid: 101, launcherPid: 91, port: 9301 });
    fs.writeFileSync(path.join(record.userDataDir, 'SingletonLock'), 'lock', 'utf8');
    const processes = [
      proc(91, 1, 'node.exe', 'launcher'),
      proc(101, 91, 'chrome.exe', chromeLine(record)),
      proc(102, 101, 'chrome.exe', 'chrome.exe --type=renderer'),
      proc(103, 101, 'chrome.exe', 'chrome.exe --type=gpu-process'),
      proc(104, 101, 'chrome_crashpad_handler.exe', 'chrome_crashpad_handler.exe'),
    ];
    const deps = fakeDeps(processes);
    const receipt = await cleanupManagedBrowser(record.runDir, {
      managedRoot: root, expectedRunId: record.runId, allowActive: true, stateId, deps,
    });
    assert.equal(receipt.result, 'PASS');
    assert.equal(receipt.code, 'BROWSER_CLEANUP_OK');
    assert.equal(receipt.rootPidGone, true);
    assert.equal(receipt.childProcessesGone, true);
    assert.equal(receipt.cdpPortReleased, true);
    assert.equal(receipt.profileLocksGone, true);
    assert.equal(fs.existsSync(record.userDataDir), false);
    assert.equal(verifyCleanupReceipt(receipt, stateId).ok, true);
  }

  {
    let cleanupCalls = 0;
    await assert.rejects(
      runWithManagedBrowserLifecycle({
        session: { runId: 'failed-verification' },
        work: async () => { throw new Error('VERIFY_FAIL'); },
        cleanup: async () => { cleanupCalls += 1; },
      }),
      /VERIFY_FAIL/,
    );
    assert.equal(cleanupCalls, 1);
  }

  {
    let observed = null;
    try {
      await runWithManagedBrowserLifecycle({
        session: { runId: 'verification-and-cleanup-fail' },
        work: async () => { throw new Error('VERIFY_FAIL'); },
        cleanup: async () => { throw new Error('CLEANUP_FAIL'); },
      });
    } catch (error) {
      observed = error;
    }
    assert.equal(observed?.message, 'VERIFY_FAIL');
    assert.equal(observed?.cleanupError?.message, 'CLEANUP_FAIL');
  }

  {
    let cleanupCalls = 0;
    await assert.rejects(
      runWithManagedBrowserLifecycle({
        session: { runId: 'timeout' },
        work: async () => { const e = new Error('TIMEOUT'); e.code = 'ETIMEDOUT'; throw e; },
        cleanup: async () => { cleanupCalls += 1; },
      }),
      /TIMEOUT/,
    );
    assert.equal(cleanupCalls, 1);
  }

  {
    const record = makeRun('orphan', {
      browserPid: 201, launcherPid: 191, port: 9302,
      startedAt: new Date(baseNow - ORPHAN_ABNORMAL_MS - 1000).toISOString(),
      heartbeatAt: new Date(baseNow - 10 * 60 * 1000).toISOString(),
    });
    const processes = [
      proc(201, 191, 'chrome.exe', chromeLine(record)),
      proc(202, 201, 'chrome.exe', 'chrome.exe --type=utility'),
      proc(250, 1, 'chrome.exe', 'chrome.exe --remote-debugging-port=9999 --user-data-dir=playwright-temp-profile'),
    ];
    const deps = fakeDeps(processes);
    const result = await scanManagedOrphans({ managedRoot: root, stateId, deps });
    assert.equal(result.result, 'PASS');
    assert(result.events.some(e => e.code === 'ORPHAN_BROWSER_FOUND' && e.ageState === 'ABNORMAL_24H'));
    assert(result.events.some(e => e.code === 'ORPHAN_BROWSER_REMOVED'));
    assert(deps.kills.includes(201));
    assert(deps.kills.includes(202));
    assert.equal(deps.kills.includes(250), false);
    assert(processes.some(p => p.pid === 250));
  }

  {
    const record = makeRun('normal-chrome-protection', { browserPid: 301, launcherPid: 291, port: 9303 });
    const processes = [
      proc(301, 999, 'chrome.exe', 'chrome.exe --remote-debugging-port=9303 --user-data-dir="C:\\Users\\user\\ChromeProfile"'),
    ];
    const deps = fakeDeps(processes);
    const receipt = await cleanupManagedBrowser(record.runDir, {
      managedRoot: root, expectedRunId: record.runId, allowActive: true, stateId, deps,
    });
    assert.equal(receipt.result, 'FAIL');
    assert.equal(receipt.reason, 'ROOT_PROCESS_OWNERSHIP_MISMATCH');
    assert.equal(deps.kills.length, 0);
    assert.equal(processes.length, 1);
    fs.rmSync(record.runDir, { recursive: true, force: true });
  }

  {
    const record = makeRun('active-other-run', {
      browserPid: 401, launcherPid: 391, port: 9304,
      heartbeatAt: new Date(baseNow - 60 * 1000).toISOString(),
    });
    const processes = [
      proc(391, 1, 'node.exe', 'launcher'),
      proc(401, 391, 'chrome.exe', chromeLine(record)),
    ];
    const deps = fakeDeps(processes);
    const result = await scanManagedOrphans({ managedRoot: root, currentRunId: 'different-run', stateId, deps });
    assert.equal(result.events.some(e => e.runId === record.runId), false);
    assert.equal(deps.kills.length, 0);
  }

  {
    const record = makeRun('current-run', { browserPid: 501, launcherPid: 491, port: 9305 });
    const processes = [proc(501, 491, 'chrome.exe', chromeLine(record))];
    const deps = fakeDeps(processes);
    const result = await scanManagedOrphans({ managedRoot: root, currentRunId: record.runId, stateId, deps });
    assert.equal(result.events.length, 0);
    assert.equal(deps.kills.length, 0);
  }

  {
    const record = makeRun('port-failure', { browserPid: 601, launcherPid: 591, port: 9306 });
    const processes = [proc(601, 591, 'chrome.exe', chromeLine(record))];
    const deps = fakeDeps(processes, { portFree: false });
    const receipt = await cleanupManagedBrowser(record.runDir, {
      managedRoot: root, expectedRunId: record.runId, allowActive: true, stateId, deps,
    });
    assert.equal(receipt.result, 'FAIL');
    assert.equal(receipt.code, 'BROWSER_CLEANUP_FAILED');
    assert.equal(receipt.cdpPortReleased, false);
    assert.equal(verifyCleanupReceipt(receipt, stateId).code, 'UI_BROWSER_CLEANUP_FAILED');
  }

  {
    const record = makeRun('child-residue', { browserPid: 701, launcherPid: 691, port: 9307 });
    const processes = [
      proc(701, 691, 'chrome.exe', chromeLine(record)),
      proc(702, 701, 'chrome.exe', 'chrome.exe --type=renderer'),
    ];
    const deps = fakeDeps(processes, { ignoreKill: new Set([702]), reparentOnKill: true });
    const receipt = await cleanupManagedBrowser(record.runDir, {
      managedRoot: root, expectedRunId: record.runId, allowActive: true, stateId, deps,
    });
    assert.equal(receipt.result, 'FAIL');
    assert.equal(receipt.rootPidGone, true);
    assert.equal(receipt.childProcessesGone, false);
  }

  {
    const runDir = path.join(root, 'unowned');
    fs.mkdirSync(path.join(runDir, 'profile'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'browser-run.json'), JSON.stringify({
      schemaVersion: 1, owner: UI_BROWSER_OWNER, runId: 'unowned', repository: 'acme/app',
      runDir, userDataDir: path.join(runDir, 'profile'), browserPid: 801, launcherPid: 791,
      cdpPort: 9308, startedAt: new Date(baseNow - ORPHAN_ABNORMAL_MS).toISOString(),
      heartbeatAt: new Date(baseNow - 10 * 60 * 1000).toISOString(), status: 'ACTIVE',
    }), 'utf8');
    const processes = [proc(801, 791, 'chrome.exe', 'chrome.exe --remote-debugging-port=9308')];
    const deps = fakeDeps(processes);
    const result = await scanManagedOrphans({ managedRoot: root, stateId, deps });
    assert.equal(result.events.some(e => e.runId === 'unowned'), false);
    assert.equal(deps.kills.length, 0);
  }

  {
    const receipt = {
      schemaVersion: 1, receiptType: 'UI_BROWSER_CLEANUP_V1', result: 'PASS', code: 'BROWSER_CLEANUP_OK',
      runId: 'receipt', stateId, ownershipValidated: true, rootPidGone: true,
      childProcessesGone: true, cdpPortReleased: true, profileLocksGone: true,
    };
    assert.equal(verifyCleanupReceipt(receipt, stateId).ok, true);
    assert.equal(verifyCleanupReceipt(receipt, 'git:' + 'b'.repeat(40)).reason, 'STATE_ID_MISMATCH');
  }

  console.log('ui-browser-lifecycle selftest: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}