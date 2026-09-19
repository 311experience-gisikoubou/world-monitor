#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const RECEIPT_HEADER = 'MERGE_AUTHORIZATION_V1';
const MAX_RECEIPT_AGE_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_EVIDENCE_FUTURE_SKEW_MS = 2 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10 * 1000;
const CLI_VALUE_ARGUMENTS = new Set(['repo', 'pr', 'base', 'base-sha', 'author', 'evidence-file']);
const CLI_FLAG_ARGUMENTS = new Set(['evidence-stdin']);
const RECEIPT_SOURCES = new Set(['EXPLICIT_HUMAN', 'PERSISTED_AFTER_AUDIT']);
const NO_EVIDENCE = Symbol('NO_EVIDENCE');

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length;) {
    const key = argv[i];
    if (!key?.startsWith('--')) throw new Error(`Invalid arguments near: ${key ?? '<end>'}`);
    const name = key.slice(2);
    if (Object.hasOwn(out, name)) throw new Error(`Duplicate argument: --${name}`);
    if (CLI_FLAG_ARGUMENTS.has(name)) { out[name] = true; i += 1; continue; }
    if (!CLI_VALUE_ARGUMENTS.has(name)) throw new Error(`Unknown argument: --${name}`);
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`Invalid arguments near: ${key}`);
    out[name] = value;
    i += 2;
  }
  return out;
}

function requireArg(args, name) {
  const value = args[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
function parseRepo(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) throw new Error('Invalid --repo; expected owner/name');
  return { owner: match[1], repo: match[2] };
}

export function parseAuthorizationReceipt(body) {
  const lines = String(body ?? '').replace(/\r/g, '').trim().split('\n');
  if (lines.length !== 5 || lines[0] !== RECEIPT_HEADER) return null;
  const values = {};
  for (const line of lines.slice(1)) {
    const match = /^([A-Z_]+): ([^\n]+)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) return null;
    values[match[1]] = match[2];
  }
  const keys = Object.keys(values).sort().join(',');
  if (keys !== 'AUTHORIZED,HEAD,PR,SOURCE') return null;
  if (!/^\d+$/.test(values.PR)) return null;
  if (!/^[0-9a-f]{40}$/i.test(values.HEAD)) return null;
  if (values.AUTHORIZED !== 'YES' || !RECEIPT_SOURCES.has(values.SOURCE)) return null;
  return {
    prNumber: Number(values.PR),
    headSha: values.HEAD.toLowerCase(),
    source: values.SOURCE,
  };
}
function evidenceFailure(code, prNumber, baseBranch, expectedBaseSha) {
  return {
    pass: false,
    checks: { evidence: false, prNumber: false, prOpen: false, notDraft: false, baseBranch: false, baseSha: false, headSha: false, authorizationReceipt: false },
    finding: code,
    prNumber,
    baseBranch,
    actualBaseSha: '(unverified)',
    expectedBaseSha,
    reportedPrBaseSha: '(unverified)',
    actualHeadSha: '(unverified)',
    expectedHeadSha: null,
    authorizationCommentId: null,
    authorizationSource: null,
  };
}

export function parseEvidenceJson(raw) {
  const text = String(raw ?? '');
  const jsonText = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { throw new Error('Invalid evidence JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid evidence JSON');
  return parsed;
}

export async function readBoundedEvidenceInput(stream = process.stdin) {
  if (stream?.isTTY === true) throw new Error('Evidence stdin must be piped');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buffer.length;
    if (bytes > MAX_EVIDENCE_BYTES) throw new Error('Evidence input too large');
    chunks.push(buffer);
  }
  if (!chunks.length) throw new Error('Evidence stdin is empty');
  return Buffer.concat(chunks).toString('utf8');
}

export function validateMergeEvidence(evidence, { repo, prNumber, nowMs }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (evidence.schemaVersion !== 3) return { ok: false, code: 'EVIDENCE_SCHEMA_UNSUPPORTED' };
  if (evidence.repository !== repo) return { ok: false, code: 'EVIDENCE_REPOSITORY_MISMATCH' };
  const fetchedMs = Date.parse(evidence.fetchedAt ?? '');
  if (!Number.isFinite(fetchedMs)) return { ok: false, code: 'EVIDENCE_FETCH_TIME_INVALID' };
  const age = nowMs - fetchedMs;
  if (age < -MAX_EVIDENCE_FUTURE_SKEW_MS) return { ok: false, code: 'EVIDENCE_FROM_FUTURE' };
  if (age > MAX_EVIDENCE_AGE_MS) return { ok: false, code: 'EVIDENCE_STALE' };
  if (!evidence.pr || typeof evidence.pr !== 'object' || Array.isArray(evidence.pr)) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (Number(evidence.pr.number) !== prNumber) return { ok: false, code: 'EVIDENCE_PR_MISMATCH' };
  if (!evidence.pr.base || typeof evidence.pr.base !== 'object' || Array.isArray(evidence.pr.base)) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (typeof evidence.pr.base.ref !== 'string' || !/^[0-9a-f]{40}$/i.test(String(evidence.pr.base.sha ?? ''))) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (!evidence.pr.head || typeof evidence.pr.head !== 'object' || Array.isArray(evidence.pr.head) || !/^[0-9a-f]{40}$/i.test(String(evidence.pr.head.sha ?? ''))) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (!evidence.liveBase || typeof evidence.liveBase !== 'object' || Array.isArray(evidence.liveBase)) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (typeof evidence.liveBase.ref !== 'string' || !/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(evidence.liveBase.ref) || !/^[0-9a-f]{40}$/i.test(String(evidence.liveBase.sha ?? ''))) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (!Array.isArray(evidence.authorizationComments) || evidence.authorizationComments.length > 1000) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  for (const comment of evidence.authorizationComments) {
    if (!comment || typeof comment !== 'object' || typeof comment.body !== 'string' || comment.body.length > 2048) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
    if (typeof comment.created_at !== 'string' || !comment.user || typeof comment.user.login !== 'string') return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  }
  return { ok: true, pr: evidence.pr, liveBase: evidence.liveBase, comments: evidence.authorizationComments };
}

export async function loadEvidenceFromCli(args, { readFileImpl = readFile, stdin = process.stdin } = {}) {
  const hasFile = Object.hasOwn(args, 'evidence-file');
  const hasStdin = args['evidence-stdin'] === true;
  if (hasFile && hasStdin) throw new Error('Use only one of --evidence-file or --evidence-stdin');
  if (hasFile) {
    const raw = await readFileImpl(args['evidence-file'], 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_EVIDENCE_BYTES) throw new Error('Evidence file too large');
    return parseEvidenceJson(raw);
  }
  if (hasStdin) return parseEvidenceJson(await readBoundedEvidenceInput(stdin));
  return NO_EVIDENCE;
}

export async function fetchJson(url, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid fetch timeout');
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-dev-foundation-merge-execution-gate',
      },
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllComments(apiBase, prNumber, fetchImpl) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await fetchJson(
      `${apiBase}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      fetchImpl,
    );
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub comments response');
    all.push(...batch);
    if (batch.length < 100) break;
    if (page === 10) throw new Error('Too many PR comments to audit safely');
  }
  return all;
}
function encodeRefPath(ref) {
  return ref.split('/').map(part => encodeURIComponent(part)).join('/');
}
function classifyReceipt(comments, { author, prNumber, headSha, nowMs }) {
  const parsed = comments.map(comment => ({
    comment,
    receipt: parseAuthorizationReceipt(comment.body),
  })).filter(item => item.receipt);
  if (!parsed.length) return { code: 'AUTHORIZATION_RECEIPT_REQUIRED' };

  const byAuthor = parsed.filter(item => item.comment?.user?.login === author);
  if (!byAuthor.length) return { code: 'AUTHORIZATION_AUTHOR_MISMATCH' };
  const byPr = byAuthor.filter(item => item.receipt.prNumber === prNumber);
  if (!byPr.length) return { code: 'AUTHORIZATION_PR_MISMATCH' };
  const byHead = byPr.filter(item => item.receipt.headSha === headSha);
  if (!byHead.length) return { code: 'AUTHORIZATION_HEAD_MISMATCH' };

  const fresh = byHead.filter(item => {
    const createdMs = Date.parse(item.comment.created_at ?? '');
    if (!Number.isFinite(createdMs)) return false;
    const age = nowMs - createdMs;
    return age >= -MAX_FUTURE_SKEW_MS && age <= MAX_RECEIPT_AGE_MS;
  }).sort((a, b) => Date.parse(b.comment.created_at) - Date.parse(a.comment.created_at));
  if (!fresh.length) return { code: 'AUTHORIZATION_RECEIPT_EXPIRED' };
  return { code: 'AUTHORIZATION_RECEIPT_VALID', item: fresh[0] };
}

export function classifyAuthorizationReceipt(comments, options) {
  return classifyReceipt(comments, options);
}

export async function runMergeExecutionGate({ repo, prNumber, baseBranch, expectedBaseSha, author, nowMs = null, nowFn = Date.now, fetchImpl = fetch, evidence = NO_EVIDENCE }) {
  const { owner, repo: repoName } = parseRepo(repo);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('Invalid PR number');
  if (!/^[A-Za-z0-9_.-]+$/.test(author)) throw new Error('Invalid author');
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch)) throw new Error('Invalid base branch');
  const normalizedExpectedBaseSha = String(expectedBaseSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedExpectedBaseSha)) throw new Error('Invalid expected base SHA');
  if (nowMs !== null && !Number.isFinite(nowMs)) throw new Error('Invalid nowMs');
  if (typeof nowFn !== 'function') throw new Error('Invalid nowFn');

  let pr;
  let comments;
  let liveBase;
  let effectiveNowMs;
  if (evidence !== NO_EVIDENCE) {
    effectiveNowMs = nowMs ?? nowFn();
    const validated = validateMergeEvidence(evidence, { repo, prNumber, nowMs: effectiveNowMs });
    if (!validated.ok) return evidenceFailure(validated.code, prNumber, baseBranch, normalizedExpectedBaseSha);
    pr = validated.pr;
    liveBase = validated.liveBase;
    comments = validated.comments;
  } else {
    const apiBase = `https://api.github.com/repos/${owner}/${repoName}`;
    comments = await fetchAllComments(apiBase, prNumber, fetchImpl);
    pr = await fetchJson(`${apiBase}/pulls/${prNumber}`, fetchImpl);
    // Fetch the live target-branch ref last. PR base.sha can lag behind the actual branch head.
    const liveRef = await fetchJson(`${apiBase}/git/ref/heads/${encodeRefPath(baseBranch)}`, fetchImpl);
    liveBase = { ref: liveRef?.ref, sha: liveRef?.object?.sha };
    effectiveNowMs = nowMs ?? nowFn();
  }

  const headSha = String(pr?.head?.sha ?? '').toLowerCase();
  const actualBaseSha = String(liveBase?.sha ?? '').toLowerCase();
  const reportedPrBaseSha = String(pr?.base?.sha ?? '').toLowerCase();
  return classifyAndBuild({ pr, liveBase, comments, author, prNumber, baseBranch, expectedBaseSha: normalizedExpectedBaseSha, actualBaseSha, reportedPrBaseSha, headSha, nowMs: effectiveNowMs });
}

function classifyAndBuild({ pr, liveBase, comments, author, prNumber, baseBranch, expectedBaseSha, actualBaseSha, reportedPrBaseSha, headSha, nowMs }) {
  const receipt = classifyReceipt(comments, { author, prNumber, headSha, nowMs });
  const checks = {
    evidence: true,
    prNumber: Number(pr?.number) === prNumber,
    prOpen: pr?.state === 'open' && !pr?.merged_at,
    notDraft: pr?.draft === false,
    baseBranch: pr?.base?.ref === baseBranch && liveBase?.ref === `refs/heads/${baseBranch}`,
    baseSha: /^[0-9a-f]{40}$/.test(actualBaseSha) && actualBaseSha === expectedBaseSha,
    headSha: /^[0-9a-f]{40}$/.test(headSha),
    authorizationReceipt: receipt.code === 'AUTHORIZATION_RECEIPT_VALID',
  };
  const pass = Object.values(checks).every(Boolean);
  let finding = receipt.code;
  if (!checks.prNumber) finding = 'PR_NUMBER_MISMATCH';
  else if (!checks.prOpen) finding = 'PR_NOT_OPEN';
  else if (!checks.notDraft) finding = 'PR_DRAFT';
  else if (!checks.baseBranch) finding = 'BASE_BRANCH_MISMATCH';
  else if (!checks.baseSha) finding = 'BASE_SHA_MISMATCH';
  else if (!checks.headSha) finding = 'HEAD_SHA_INVALID';
  return {
    pass, checks, finding, prNumber, baseBranch,
    actualBaseSha: actualBaseSha || '(missing)',
    expectedBaseSha,
    reportedPrBaseSha: reportedPrBaseSha || '(missing)',
    actualHeadSha: headSha || '(missing)',
    expectedHeadSha: pass ? headSha : null,
    authorizationCommentId: pass ? receipt.item.comment.id : null,
    authorizationSource: pass ? receipt.item.receipt.source : null,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = await loadEvidenceFromCli(args);
    const result = await runMergeExecutionGate({
      repo: requireArg(args, 'repo'),
      prNumber: Number(requireArg(args, 'pr')),
      baseBranch: requireArg(args, 'base'),
      expectedBaseSha: requireArg(args, 'base-sha'),
      author: requireArg(args, 'author'),
      evidence,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) { console.error('MERGE_EXECUTION_GATE=FAIL'); process.exitCode = 2; return; }
    console.log('MERGE_EXECUTION_GATE=PASS');
    console.log(`EXPECTED_HEAD_SHA=${result.expectedHeadSha}`);
    console.log(`EXPECTED_BASE_SHA=${result.expectedBaseSha}`);
    console.log(`AUTHORIZATION_COMMENT_ID=${result.authorizationCommentId}`);
    console.log(`AUTHORIZATION_SOURCE=${result.authorizationSource}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('MERGE_EXECUTION_GATE=FAIL');
    console.error(message.replace(/https?:\/\/\S+/g, '<redacted-url>'));
    process.exitCode = 2;
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await main();
