#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const visibility = argValue('--visibility', 'unknown').toLowerCase(); // public | private | unknown
const jsonOnly = args.includes('--json');

const findings = [];
function add(status, code, detail = {}) { findings.push({ status, code, ...detail }); }
function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

let root = '';
try { root = git('rev-parse', '--show-toplevel'); }
catch {
  console.error(JSON.stringify({ result: 'STOP', reason: 'NOT_GIT_REPOSITORY' }));
  process.exit(2);
}
process.chdir(root);

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
const reviewNamePatterns = [
  /(?:patient|patients|clinic|clinics|customer|customers|order|orders|invoice|billing|sales|price|pricing|export|backup|report|session|pairing)/i,
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
  if ((ext === '.json' || ext === '.html' || ext === '.htm') && reviewNamePatterns.some((r) => r.test(path))) return 'review';
  return 'normal';
}

let objectLines = [];
try { objectLines = git('rev-list', '--objects', '--all').split(/\r?\n/).filter(Boolean); }
catch {
  console.error(JSON.stringify({ result: 'STOP', reason: 'GIT_HISTORY_ENUMERATION_FAILED' }));
  process.exit(2);
}

const objects = [];
for (const line of objectLines) {
  const space = line.indexOf(' ');
  if (space < 0) continue;
  const oid = line.slice(0, space);
  const path = line.slice(space + 1);
  if (!oid || !path) continue;
  objects.push({ oid, path });
}

const hard = [];
const review = [];
const htmlCandidates = [];
for (const item of objects) {
  const c = classifyPath(item.path);
  if (c === 'hard') hard.push(item);
  else if (c === 'review') review.push(item);
  if (/\.html?$/i.test(item.path)) htmlCandidates.push(item);
}

function uniquePaths(items) {
  return [...new Set(items.map((x) => x.path))];
}
const hardPaths = uniquePaths(hard);
const reviewPaths = uniquePaths(review);
if (hardPaths.length) {
  add(visibility === 'public' ? 'STOP' : 'NEEDS_CHECK', 'HISTORICAL_HIGH_RISK_PATH', {
    count: hardPaths.length,
  });
}
if (reviewPaths.length) {
  add('NEEDS_CHECK', 'HISTORICAL_DATA_OR_MEDIA_PATH', {
    count: reviewPaths.length,
  });
}

// Size-check historical HTML without reading content. Raw paths are never printed.
const largeHtmlByPath = new Map();
for (const item of htmlCandidates) {
  try {
    const raw = execFileSync('git', ['cat-file', '-s', item.oid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const size = Number(raw);
    if (Number.isFinite(size) && size >= 512 * 1024) {
      const prev = largeHtmlByPath.get(item.path);
      if (!prev || size > prev) largeHtmlByPath.set(item.path, size);
    }
  } catch {}
}
if (largeHtmlByPath.size) {
  const sizes = [...largeHtmlByPath.values()];
  add('NEEDS_CHECK', 'LARGE_HISTORICAL_HTML', {
    count: largeHtmlByPath.size,
    maxSize: Math.max(...sizes),
  });
}

let refs = [];
try { refs = git('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags').split(/\r?\n/).filter(Boolean); }
catch {}
add('SAFE_CONFIRMED', 'HISTORY_ENUMERATED_WITHOUT_CONTENT_READ', { objects: objects.length, refs: refs.length });

if (!hardPaths.length && !reviewPaths.length && !largeHtmlByPath.size) {
  add('SAFE_CONFIRMED', 'NO_FILENAME_OR_SIZE_HISTORY_RISK_FOUND');
}

const hasStop = findings.some((f) => f.status === 'STOP');
const hasUnknown = findings.some((f) => f.status === 'UNKNOWN');
const hasNeeds = findings.some((f) => f.status === 'NEEDS_CHECK');
const result = hasStop ? 'STOP' : (hasUnknown || hasNeeds ? 'NEEDS_CHECK' : 'PROCEED');
console.log(JSON.stringify({ result, visibility, findings }, null, jsonOnly ? 0 : 2));
process.exit(result === 'PROCEED' ? 0 : 2);
