#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const UI_BROWSER_OWNER = 'ai-dev-foundation-ui-verification-v1';
export const UI_BROWSER_RECEIPT = 'UI_BROWSER_CLEANUP_V1';
export const ORPHAN_WARNING_MS = 60 * 60 * 1000;
export const ORPHAN_ABNORMAL_MS = 24 * 60 * 60 * 1000;
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STATE_ID_RE = /^(?:git|remote):[0-9a-f]{40}$|^(?:worktree|artifact):[0-9a-f]{64}$/;
const CHROME_RE = /^chrome(?:\.exe)?$/i;
const CHROME_CHILD_RE = /^(?:chrome(?:\.exe)?|chrome_crashpad_handler(?:\.exe)?|crashpad_handler(?:\.exe)?)$/i;
const LOCK_NAMES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function canon(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function inside(child, parent) {
  const c = canon(child); const p = canon(parent);
  return c === p || c.startsWith(p + path.sep);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
}
function nowIso(nowMs = Date.now()) { return new Date(nowMs).toISOString(); }
function metadataPath(runDir) { return path.join(runDir, 'browser-run.json'); }
function ownerPath(runDir) { return path.join(runDir, 'owner.json'); }
function heartbeatPath(runDir) { return path.join(runDir, 'heartbeat.json'); }
function receiptPath(runDir) { return path.join(runDir, 'cleanup-receipt.json'); }

export function defaultManagedRoot() {
  return path.join(os.tmpdir(), 'ai-ui-verification');
}

function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
function validateRecord(record, runDir, managedRoot) {
  if (!record || record.schemaVersion !== 1 || record.owner !== UI_BROWSER_OWNER) return false;
  if (!RUN_ID_RE.test(record.runId || '') || !validRepository(record.repository)) return false;
  if (!Number.isInteger(record.browserPid) || record.browserPid <= 0) return false;
  if (!Number.isInteger(record.launcherPid) || record.launcherPid <= 0) return false;
  if (!Number.isInteger(record.cdpPort) || record.cdpPort < 1024 || record.cdpPort > 65535) return false;
  if (!inside(runDir, managedRoot) || canon(record.runDir) !== canon(runDir)) return false;
  if (canon(record.userDataDir) !== canon(path.join(runDir, 'profile'))) return false;
  return inside(record.userDataDir, managedRoot);
}
function validateOwnerMarker(marker, record) {
  return marker?.owner === UI_BROWSER_OWNER && marker?.runId === record.runId &&
    marker?.userDataDir && canon(marker.userDataDir) === canon(record.userDataDir);
}
function commandArg(commandLine, flag) {
  const source = String(commandLine || '');
  const escaped = flag.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const re = new RegExp("(?:^|\\s)" + escaped + "(?:=|\\s+)(?:\"([^\"]+)\"|'([^']+)'|(\\S+))", 'i');
  const match = re.exec(source);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}
function rootMatchesRecord(proc, record) {
  if (!proc || proc.pid !== record.browserPid || !CHROME_RE.test(proc.name || '')) return false;
  const profile = commandArg(proc.commandLine, '--user-data-dir');
  const port = commandArg(proc.commandLine, '--remote-debugging-port');
  if (!profile || !port) return false;
  return canon(profile) === canon(record.userDataDir) && Number(port) === record.cdpPort;
}
function processMap(processes) {
  return new Map(processes.map(p => [Number(p.pid), { ...p, pid: Number(p.pid), ppid: Number(p.ppid) }]));
}
function descendants(processes, rootPid) {
  const byParent = new Map();
  for (const p of processes) {
    const list = byParent.get(Number(p.ppid)) ?? [];
    list.push(p);
    byParent.set(Number(p.ppid), list);
  }
  const out = [];
  const seen = new Set();
  function walk(pid) {
    if (seen.has(pid)) return;
    seen.add(pid);
    const own = processes.find(p => Number(p.pid) === pid);
    if (own) out.push(own);
    for (const child of byParent.get(pid) ?? []) walk(Number(child.pid));
  }
  walk(Number(rootPid));
  return out;
}
function heartbeatFresh(record, nowMs) {
  const value = Date.parse(record.heartbeatAt || '');
  return Number.isFinite(value) && nowMs - value < HEARTBEAT_STALE_MS;
}
function runAgeMs(record, nowMs) {
  const value = Date.parse(record.startedAt || '');
  return Number.isFinite(value) ? Math.max(0, nowMs - value) : Number.POSITIVE_INFINITY;
}
function lockFilesPresent(userDataDir) {
  return LOCK_NAMES.some(name => fs.existsSync(path.join(userDataDir, name)));
}

export async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export async function isLoopbackPortFree(port) {
  return await new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export function listSystemProcesses() {
  if (process.platform === 'win32') {
    const script = '$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine; @($p) | ConvertTo-Json -Compress -Depth 3';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('PROCESS_ENUMERATION_FAILED');
    const parsed = JSON.parse(result.stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId),
      name: String(p.Name || ''),
      commandLine: String(p.CommandLine || ''),
    }));
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error('PROCESS_ENUMERATION_FAILED');
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), name: path.basename(match[3]), commandLine: match[4] } : null;
  }).filter(Boolean);
}

export function killExactPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 'SIGTERM'); return true; } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function defaultDeps() {
  return {
    now: () => Date.now(),
    listProcesses: () => listSystemProcesses(),
    killPid: pid => killExactPid(pid),
    portFree: port => isLoopbackPortFree(port),
    sleep,
  };
}

export function initializeManagedRun({
  managedRoot = defaultManagedRoot(), runId = randomUUID(), repository, browserPid, launcherPid = process.pid,
  cdpPort, startedAt = nowIso(), heartbeatAt = startedAt,
}) {
  if (!RUN_ID_RE.test(runId) || !validRepository(repository)) throw new Error('RUN_ID_OR_REPOSITORY_INVALID');
  if (![browserPid, launcherPid, cdpPort].every(Number.isInteger)) throw new Error('RUN_PROCESS_METADATA_INVALID');
  const runDir = path.join(managedRoot, runId);
  const userDataDir = path.join(runDir, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  const record = {
    schemaVersion: 1, owner: UI_BROWSER_OWNER, runId, repository,
    runDir, userDataDir, browserPid, launcherPid, cdpPort, startedAt, heartbeatAt, status: 'ACTIVE',
  };
  writeJson(ownerPath(runDir), { owner: UI_BROWSER_OWNER, runId, userDataDir });
  writeJson(metadataPath(runDir), record);
  writeJson(heartbeatPath(runDir), { owner: UI_BROWSER_OWNER, runId, launcherPid, heartbeatAt });
  return record;
}

export async function launchManagedBrowser({
  chromePath, repository, runId = randomUUID(), managedRoot = defaultManagedRoot(), extraArgs = [], url = 'about:blank',
}) {
  if (typeof chromePath !== 'string' || chromePath.trim() === '') throw new Error('CHROME_PATH_REQUIRED');
  const cdpPort = await allocateLoopbackPort();
  const runDir = path.join(managedRoot, runId);
  const userDataDir = path.join(runDir, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + userDataDir, ...extraArgs, url,
  ];
  const child = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
  if (!child.pid) throw new Error('BROWSER_START_FAILED');
  try {
    const record = initializeManagedRun({ managedRoot, runId, repository, browserPid: child.pid, launcherPid: process.pid, cdpPort });
    return { ...record, child };
  } catch (error) {
    try { child.kill(); } catch {}
    throw error;
  }
}

export function touchRunHeartbeat(runDir, nowMs = Date.now()) {
  const record = readJson(metadataPath(runDir));
  const marker = readJson(ownerPath(runDir));
  if (!validateOwnerMarker(marker, record)) throw new Error('RUN_OWNERSHIP_INVALID');
  record.heartbeatAt = nowIso(nowMs);
  writeJson(metadataPath(runDir), record);
  writeJson(heartbeatPath(runDir), { owner: UI_BROWSER_OWNER, runId: record.runId, launcherPid: record.launcherPid, heartbeatAt: record.heartbeatAt });
  return record;
}

function safeReadRun(runDir, managedRoot) {
  try {
    const record = readJson(metadataPath(runDir));
    const marker = readJson(ownerPath(runDir));
    if (!validateRecord(record, runDir, managedRoot) || !validateOwnerMarker(marker, record)) return null;
    return record;
  } catch { return null; }
}

function activeRun(record, processes, nowMs, currentRunId = null) {
  if (currentRunId && record.runId === currentRunId) return true;
  const pids = processMap(processes);
  const launcherAlive = pids.has(record.launcherPid);
  return launcherAlive || (record.status === 'ACTIVE' && heartbeatFresh(record, nowMs));
}

async function waitForTreeGone(rootPid, deps) {
  for (let i = 0; i < 30; i += 1) {
    const current = deps.listProcesses();
    const tree = descendants(current, rootPid);
    if (tree.length === 0) return true;
    await deps.sleep(100);
  }
  return false;
}

function cleanupReceiptBase(record, stateId, nowMs) {
  return {
    schemaVersion: 1,
    receiptType: UI_BROWSER_RECEIPT,
    runId: record.runId,
    repository: record.repository,
    stateId,
    browserPid: record.browserPid,
    launcherPid: record.launcherPid,
    cdpPort: record.cdpPort,
    userDataDir: record.userDataDir,
    cleanupAt: nowIso(nowMs),
  };
}

export async function cleanupManagedBrowser(runDir, {
  managedRoot = defaultManagedRoot(), expectedRunId = null, allowActive = false, stateId = null, deps = defaultDeps(),
} = {}) {
  const record = safeReadRun(runDir, managedRoot);
  const nowMs = deps.now();
  if (!record || (expectedRunId && record.runId !== expectedRunId)) {
    return { schemaVersion: 1, receiptType: UI_BROWSER_RECEIPT, result: 'FAIL', code: 'BROWSER_CLEANUP_FAILED', reason: 'OWNERSHIP_NOT_PROVEN' };
  }
  const base = cleanupReceiptBase(record, stateId, nowMs);
  const before = deps.listProcesses();
  const active = activeRun(record, before, nowMs);
  if (active && !allowActive) {
    return { ...base, result: 'FAIL', code: 'BROWSER_CLEANUP_FAILED', reason: 'ACTIVE_RUN_PROTECTED', ownershipValidated: true };
  }

  const beforeMap = processMap(before);
  const root = beforeMap.get(record.browserPid);
  const launcherAlive = beforeMap.has(record.launcherPid);
  if (root && !rootMatchesRecord(root, record)) {
    return { ...base, result: 'FAIL', code: 'BROWSER_CLEANUP_FAILED', reason: 'ROOT_PROCESS_OWNERSHIP_MISMATCH', ownershipValidated: false };
  }
  if (!root && !allowActive && (launcherAlive || heartbeatFresh(record, nowMs))) {
    return { ...base, result: 'FAIL', code: 'BROWSER_CLEANUP_FAILED', reason: 'ORPHAN_STATE_NOT_PROVEN', ownershipValidated: true };
  }

  let owned = descendants(before, record.browserPid);
  if (owned.some(p => !CHROME_CHILD_RE.test(p.name || ''))) {
    return { ...base, result: 'FAIL', code: 'BROWSER_CLEANUP_FAILED', reason: 'NON_CHROME_DESCENDANT_REFUSED', ownershipValidated: false };
  }
  const ownedPids = new Set(owned.map(p => Number(p.pid)));

  for (let pass = 0; pass < 3; pass += 1) {
    owned = descendants(deps.listProcesses(), record.browserPid);
    if (owned.some(p => !CHROME_CHILD_RE.test(p.name || ''))) {
      return { ...base, result: 'FAIL', code: 'BROWSER_CLEANUP_FAILED', reason: 'NON_CHROME_DESCENDANT_REFUSED', ownershipValidated: false };
    }
    for (const proc of owned) ownedPids.add(Number(proc.pid));
    if (owned.length === 0) break;
    for (const proc of [...owned].reverse()) deps.killPid(Number(proc.pid));
    await deps.sleep(100);
  }

  const after = deps.listProcesses();
  const afterMap = processMap(after);
  const rootPidGone = !afterMap.has(record.browserPid);
  const childProcessesGone = [...ownedPids].filter(pid => pid !== record.browserPid).every(pid => !afterMap.has(pid));
  const cdpPortReleased = await deps.portFree(record.cdpPort);

  let profileLocksGone = false;
  if (rootPidGone && childProcessesGone && cdpPortReleased) {
    try {
      fs.rmSync(record.userDataDir, { recursive: true, force: true });
      profileLocksGone = !fs.existsSync(record.userDataDir) || !lockFilesPresent(record.userDataDir);
    } catch { profileLocksGone = false; }
  } else {
    profileLocksGone = !lockFilesPresent(record.userDataDir);
  }

  const ok = rootPidGone && childProcessesGone && cdpPortReleased && profileLocksGone;
  record.status = ok ? 'CLEANED' : 'CLEANUP_FAILED';
  record.cleanupAt = nowIso(deps.now());
  writeJson(metadataPath(runDir), record);
  const receipt = {
    ...base,
    result: ok ? 'PASS' : 'FAIL',
    code: ok ? 'BROWSER_CLEANUP_OK' : 'BROWSER_CLEANUP_FAILED',
    ownershipValidated: true,
    rootPidGone,
    childProcessesGone,
    cdpPortReleased,
    profileLocksGone,
  };
  writeJson(receiptPath(runDir), receipt);
  return receipt;
}

export async function runWithManagedBrowserLifecycle({ session, work, cleanup }) {
  let value;
  let workError = null;
  let cleanupError = null;
  try {
    value = await work(session);
  } catch (error) {
    workError = error;
  }
  try {
    await cleanup(session);
  } catch (error) {
    cleanupError = error;
  }
  if (workError) {
    if (cleanupError) workError.cleanupError = cleanupError;
    throw workError;
  }
  if (cleanupError) throw cleanupError;
  return value;
}

export async function withManagedBrowser(options, work, { stateId = null } = {}) {
  const session = await launchManagedBrowser(options);
  let value;
  let workError = null;
  let cleanupReceipt = null;
  try {
    value = await work(session);
  } catch (error) {
    workError = error;
  } finally {
    try {
      cleanupReceipt = await cleanupManagedBrowser(session.runDir, {
        managedRoot: options.managedRoot ?? defaultManagedRoot(),
        expectedRunId: session.runId,
        allowActive: true,
        stateId,
      });
    } catch (error) {
      cleanupReceipt = {
        schemaVersion: 1,
        receiptType: UI_BROWSER_RECEIPT,
        result: 'FAIL',
        code: 'BROWSER_CLEANUP_FAILED',
        reason: error?.message || 'CLEANUP_EXCEPTION',
        runId: session.runId,
        stateId,
      };
    }
  }
  if (workError) {
    workError.cleanupReceipt = cleanupReceipt;
    throw workError;
  }
  if (cleanupReceipt.result !== 'PASS') {
    const error = new Error('UI_BROWSER_CLEANUP_FAILED');
    error.cleanupReceipt = cleanupReceipt;
    throw error;
  }
  return value;
}

export async function scanManagedOrphans({
  managedRoot = defaultManagedRoot(), currentRunId = null, stateId = null, deps = defaultDeps(),
} = {}) {
  if (!fs.existsSync(managedRoot)) return { result: 'PASS', events: [] };
  const events = [];
  for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(managedRoot, entry.name);
    const record = safeReadRun(runDir, managedRoot);
    if (!record || record.status === 'CLEANED') continue;
    const nowMs = deps.now();
    const processes = deps.listProcesses();
    if (activeRun(record, processes, nowMs, currentRunId)) continue;
    const currentMap = processMap(processes);
    const launcherAlive = currentMap.has(record.launcherPid);
    if (launcherAlive || heartbeatFresh(record, nowMs)) continue;
    const root = currentMap.get(record.browserPid);
    const tree = descendants(processes, record.browserPid);
    if (root && !rootMatchesRecord(root, record)) continue;
    if (tree.some(p => !CHROME_CHILD_RE.test(p.name || ''))) continue;
    if (!root && tree.length === 0 && !(await deps.portFree(record.cdpPort))) continue;
    const ageMs = runAgeMs(record, nowMs);
    const ageState = ageMs >= ORPHAN_ABNORMAL_MS ? 'ABNORMAL_24H' : ageMs >= ORPHAN_WARNING_MS ? 'WARNING_1H' : 'RECENT_ORPHAN';
    events.push({ code: 'ORPHAN_BROWSER_FOUND', runId: record.runId, ageState });
    const receipt = await cleanupManagedBrowser(runDir, {
      managedRoot, expectedRunId: record.runId, allowActive: false, stateId, deps,
    });
    events.push({
      code: receipt.result === 'PASS' ? 'ORPHAN_BROWSER_REMOVED' : 'BROWSER_CLEANUP_FAILED',
      runId: record.runId,
      receipt,
    });
  }
  return { result: events.some(e => e.code === 'BROWSER_CLEANUP_FAILED') ? 'FAIL' : 'PASS', events };
}

export function verifyCleanupReceipt(receipt, expectedStateId = null) {
  if (!receipt || receipt.receiptType !== UI_BROWSER_RECEIPT) return { ok: false, code: 'UI_BROWSER_CLEANUP_FAILED', reason: 'RECEIPT_TYPE_INVALID' };
  if (receipt.result !== 'PASS' || receipt.code !== 'BROWSER_CLEANUP_OK') return { ok: false, code: 'UI_BROWSER_CLEANUP_FAILED', reason: receipt?.code || 'CLEANUP_NOT_PASS' };
  if (expectedStateId && (!STATE_ID_RE.test(receipt.stateId || '') || receipt.stateId !== expectedStateId)) {
    return { ok: false, code: 'UI_BROWSER_CLEANUP_FAILED', reason: 'STATE_ID_MISMATCH' };
  }
  const checks = ['ownershipValidated', 'rootPidGone', 'childProcessesGone', 'cdpPortReleased', 'profileLocksGone'];
  if (checks.some(key => receipt[key] !== true)) return { ok: false, code: 'UI_BROWSER_CLEANUP_FAILED', reason: 'CLEANUP_PROOF_INCOMPLETE' };
  return { ok: true, code: 'BROWSER_CLEANUP_OK', runId: receipt.runId };
}

function parseArgs(argv) {
  const out = { command: argv[0] ?? null, pretty: false, managedRoot: defaultManagedRoot(), currentRunId: null, runDir: null, runId: null, stateId: null, receipt: null, valid: true };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pretty') out.pretty = true;
    else if (a === '--managed-root' && argv[i + 1]) out.managedRoot = path.resolve(argv[++i]);
    else if (a === '--current-run-id' && argv[i + 1]) out.currentRunId = argv[++i];
    else if (a === '--run-dir' && argv[i + 1]) out.runDir = path.resolve(argv[++i]);
    else if (a === '--run-id' && argv[i + 1]) out.runId = argv[++i];
    else if (a === '--state-id' && argv[i + 1]) out.stateId = argv[++i];
    else if (a === '--receipt' && argv[i + 1]) out.receipt = path.resolve(argv[++i]);
    else out.valid = false;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try {
    if (!args.valid) result = { result: 'FAIL', code: 'ARGUMENT_INVALID' };
    else if (args.command === 'orphan-cleanup') {
      result = await scanManagedOrphans({ managedRoot: args.managedRoot, currentRunId: args.currentRunId, stateId: args.stateId });
    } else if (args.command === 'cleanup' && args.runDir && args.runId) {
      result = await cleanupManagedBrowser(args.runDir, { managedRoot: args.managedRoot, expectedRunId: args.runId, stateId: args.stateId });
    } else if (args.command === 'gate' && args.receipt) {
      const receipt = readJson(args.receipt);
      const checked = verifyCleanupReceipt(receipt, args.stateId);
      result = checked.ok ? { result: 'PASS', code: checked.code, runId: checked.runId } : { result: 'FAIL', code: checked.code, reason: checked.reason };
    } else result = { result: 'FAIL', code: 'ARGUMENT_INVALID' };
  } catch (error) {
    result = { result: 'FAIL', code: 'UI_BROWSER_CLEANUP_FAILED', reason: error?.message || 'UNKNOWN' };
  }
  process.stdout.write(JSON.stringify(result, null, args.pretty ? 2 : 0) + '\n');
  if (result.result !== 'PASS') process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();