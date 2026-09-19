#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const mode = argValue('--mode', 'change'); // audit | change
const dataMode = argValue('--data-mode', 'source-only'); // source-only | real
const jsonOnly = args.includes('--json');

const findings = [];
function add(status, code, detail = {}) { findings.push({ status, code, ...detail }); }
function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commandExists(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

let root = '';
try {
  root = git('rev-parse', '--show-toplevel');
} catch {
  console.error(JSON.stringify({ result: 'STOP', reason: 'NOT_GIT_REPOSITORY' }));
  process.exit(2);
}
process.chdir(root);

let branch = '';
try { branch = git('branch', '--show-current'); } catch { branch = ''; }
if (mode === 'change' && (!branch || branch === 'main' || branch === 'master')) {
  add('STOP', 'UNSAFE_BRANCH', { branch: branch || '(detached)' });
}

let statusLines = [];
try { statusLines = git('status', '--porcelain=v1', '--untracked-files=all').split(/\r?\n/).filter(Boolean); } catch {}
if (mode === 'change' && statusLines.length > 0) {
  add('STOP', 'WORKTREE_NOT_CLEAN', { count: statusLines.length });
}

const hardExtensions = new Set([
  '.db', '.sqlite', '.sqlite3', '.accdb', '.mdb', '.bak', '.backup', '.dump',
  '.pcap', '.pcapng', '.etl', '.pem', '.pfx', '.p12', '.key'
]);
const reviewExtensions = new Set([
  '.csv', '.tsv', '.xlsx', '.xls', '.pdf', '.png', '.jpg', '.jpeg', '.heic', '.jsonl'
]);
const hardNamePatterns = [
  /(^|\/|\\)\.env(?:\.|$)/i,
  /(^|\/|\\)(?:backup|backups|exports?|reports?|logs?|temp|tmp|sessions?|pairing)(\/|\\)/i,
  /(^|\/|\\)(?:state|session|pairing)\.json$/i,
];
function extOf(path) {
  const name = path.toLowerCase().split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}
function classifyPath(path) {
  const ext = extOf(path);
  if (hardExtensions.has(ext) || hardNamePatterns.some((r) => r.test(path))) return 'hard';
  if (reviewExtensions.has(ext)) return 'review';
  return 'normal';
}

let tracked = [];
try { tracked = git('ls-files', '-z').split('\0').filter(Boolean); } catch {}
const trackedHard = tracked.filter((p) => classifyPath(p) === 'hard');
if (trackedHard.length) add('STOP', 'TRACKED_HIGH_RISK_FILE', { count: trackedHard.length });

const changedPaths = [];
for (const line of statusLines) {
  let p = line.slice(3).trim();
  const arrow = p.indexOf(' -> ');
  if (arrow >= 0) p = p.slice(arrow + 4);
  if (p) changedPaths.push(p);
}
const changedHard = [...new Set(changedPaths.filter((p) => classifyPath(p) === 'hard'))];
const changedReview = [...new Set(changedPaths.filter((p) => classifyPath(p) === 'review'))];
if (changedHard.length) add('STOP', 'CHANGED_HIGH_RISK_FILE', { count: changedHard.length });
if (changedReview.length) add('NEEDS_CHECK', 'CHANGED_DATA_OR_MEDIA_FILE', { count: changedReview.length });

// Scan only added diff lines. Never print matching content or raw paths.
let diffText = '';
try {
  const a = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0'], { encoding: 'utf8' });
  const b = execFileSync('git', ['diff', '--cached', '--no-ext-diff', '--unified=0'], { encoding: 'utf8' });
  diffText = `${a}\n${b}`;
} catch {}
const externalPatterns = [
  /https?:\/\//i, /\bfetch\s*\(/i, /\bXMLHttpRequest\b/i, /\bWebSocket\b/i,
  /\bfirebase\b/i, /\baxios\b/i, /\breqwest\b/i, /\btelemetry\b/i,
  /\banalytics\b/i, /\bposthog\b/i, /\bsentry\b/i
];
const secretAssignment = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|private[_-]?key)\b\s*[:=]\s*["'][^"']{8,}["']/i;
const lockLike = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)$/i;
const gateSelf = /(^|\/)\.agents\/skills\/preflight-audit\/security-preflight(?:-selftest)?\.mjs$/i;
let currentFile = '';
const externalFiles = new Map();
let secretCount = 0;
for (const line of diffText.split(/\r?\n/)) {
  if (line.startsWith('+++ b/')) { currentFile = line.slice(6); continue; }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (secretAssignment.test(line)) secretCount += 1;
  if (currentFile && !lockLike.test(currentFile) && !gateSelf.test(currentFile) && externalPatterns.some((r) => r.test(line))) {
    externalFiles.set(currentFile, (externalFiles.get(currentFile) || 0) + 1);
  }
}
if (secretCount) add('STOP', 'POTENTIAL_SECRET_IN_DIFF', { count: secretCount });
if (externalFiles.size) {
  const markerCount = [...externalFiles.values()].reduce((sum, count) => sum + count, 0);
  add('STOP', 'NEW_EXTERNAL_COMMUNICATION_MARKER', {
    fileCount: externalFiles.size,
    markerCount,
  });
}

// GitHub visibility. Read-only check; never changes GitHub state.
let origin = '';
try { origin = git('remote', 'get-url', 'origin'); } catch {}
if (/github\.com[:/]/i.test(origin)) {
  if (commandExists('gh')) {
    try {
      const visibility = execFileSync('gh', ['repo', 'view', '--json', 'visibility', '--jq', '.visibility'], { encoding: 'utf8' }).trim().toUpperCase();
      add('SAFE_CONFIRMED', 'GITHUB_VISIBILITY', { visibility });
      if (dataMode === 'real' && visibility === 'PUBLIC') add('STOP', 'REAL_DATA_WITH_PUBLIC_REPOSITORY');
    } catch {
      add(dataMode === 'real' ? 'STOP' : 'UNKNOWN', 'GITHUB_VISIBILITY_UNKNOWN');
    }
  } else {
    add(dataMode === 'real' ? 'STOP' : 'UNKNOWN', 'GH_CLI_NOT_AVAILABLE_FOR_VISIBILITY_CHECK');
  }
}

if (!trackedHard.length && !changedHard.length && !secretCount && !externalFiles.size) {
  add('SAFE_CONFIRMED', 'NO_MACHINE_DETECTED_HIGH_RISK_GIT_CHANGE');
}

const hasStop = findings.some((f) => f.status === 'STOP');
const hasUnknown = findings.some((f) => f.status === 'UNKNOWN');
const hasNeeds = findings.some((f) => f.status === 'NEEDS_CHECK');
const result = hasStop || (dataMode === 'real' && (hasUnknown || hasNeeds)) ? 'STOP' : (hasUnknown || hasNeeds ? 'NEEDS_CHECK' : 'PROCEED');
const output = { result, mode, dataMode, branch, findings };
console.log(JSON.stringify(output, null, jsonOnly ? 0 : 2));
process.exit(result === 'PROCEED' ? 0 : 2);
