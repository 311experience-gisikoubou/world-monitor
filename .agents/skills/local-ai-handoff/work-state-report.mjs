#!/usr/bin/env node
// Read-only work-state view for one GitHub Issue (local-ai-handoff skill).
//
// Generates the current view at read time from existing sources only:
//   - GitHub Issue + existing ai-job labels (via the already-authenticated gh CLI)
//   - local .ai-jobs/<job>/{status,result,orchestrator}.json
//   - Git branch/HEAD/status of the recorded worktree
// It never writes, labels, commits, or persists a second copy of the state.
//
// Usage: node work-state-report.mjs --repo <root> --issue <n> [--format json|markdown|handoff]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIFECYCLE_LABELS = ['ai-job', 'ai-running', 'ai-review', 'ai-failed'];
const TRANSPORT_PREFIX = '.ai-handoff/runtime/';

// ---------- pure helpers ----------

export function parseIssueSections(body) {
  const sections = {};
  let current = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { current = m[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();
  return sections;
}

export function parseRepositoryFromRemote(url) {
  const m = /[:/]([^/:]+)\/([^/]+?)(\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// Escape a literal string for safe interpolation into a RegExp source. Used
// anywhere a repository/owner string (which may contain regex metacharacters,
// though GitHub names rarely do) is embedded in a pattern that must match it
// literally, so an unescaped value can never widen the match.
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Canonical job-to-Issue identity classification.
//
// Historically this reporter bound a local job directory to an Issue by a
// loose/legacy check of `status.task === 'issue-<N>'`. That alone is prone to
// false-positive binding (a wrong job silently reported as evidence for an
// Issue), which can in turn produce a false human-gate or false DONE state.
// `status.target_issue_number` is the newer, authoritative identity field.
// Precedence, deliberately asymmetric so a malformed/contradictory record can
// never be "rescued" by falling back to the legacy field:
//   1. target_issue_number present and a positive safe integer -> that value
//      is the sole canonical identity. The legacy status.task shape is still
//      read only to detect an internal contradiction (case 3 below); once
//      target_issue_number is present it is NEVER itself replaced by legacy.
//   2. target_issue_number missing, null, or 0 -> no canonical identity was
//      recorded; fall back to the legacy strict `issue-<N>` shape of
//      status.task (exact digits, no leading zero, positive integer).
//   3. Anything else -- non-integer, fraction, negative number, string, or a
//      canonical value that contradicts a parseable legacy status.task --
//      is REJECTed: the job carries no usable identity for matching, rather
//      than silently matching the wrong Issue or guessing via the other field.
export function classifyTargetIssueNumber(raw) {
  const status = raw && typeof raw === 'object' ? raw : {};
  const value = status.target_issue_number;
  const legacyMatch = typeof status.task === 'string' ? /^issue-([0-9]+)$/.exec(status.task) : null;
  const legacyNumber = legacyMatch ? Number(legacyMatch[1]) : null;
  const legacyValid = legacyMatch !== null && Number.isSafeInteger(legacyNumber) && legacyNumber > 0 && String(legacyNumber) === legacyMatch[1];

  if (value === undefined || value === null || value === 0) {
    return legacyValid ? { kind: 'legacy', value: legacyNumber } : { kind: 'reject' };
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return { kind: 'reject' };
  }
  if (legacyValid && legacyNumber !== value) {
    return { kind: 'reject' };
  }
  return { kind: 'canonical', value };
}

export function executorFromOrchestrator(orch) {
  if (!orch || typeof orch !== 'object') return null;
  const sel = orch.routing?.selectedExecutor;
  const rec = orch.preImplementationReceipt?.executor;
  const id = sel?.id ?? rec?.id ?? null;
  const provider = sel?.provider ?? rec?.provider ?? null;
  return id || provider ? { id, provider } : null;
}

function hasReadyEvidence(job) {
  if (!job) return false;
  const { status, result } = job;
  if (result?.final_state !== 'READY_FOR_REVIEW' || status?.state !== 'READY_FOR_REVIEW') return false;
  if (result.job_id && status.job_id && result.job_id !== status.job_id) return false;
  return true;
}

export const HUMAN_GATE_CODES = ['HUMAN_GATE_REQUIRED', 'WAITING_AT_VALID_HUMAN_GATE', 'HUMAN_CONFIRMATION_REQUIRED'];

// Recursive search for exact canonical machine codes (string values or keys); no prose inference.
function findHumanGateCode(node, depth = 0) {
  if (depth > 8 || node === null || node === undefined) return null;
  if (typeof node === 'string') return HUMAN_GATE_CODES.includes(node) ? node : null;
  if (typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (HUMAN_GATE_CODES.includes(k)) return k;
    const hit = findHumanGateCode(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function explicitHumanGate(job) {
  for (const src of [job?.result, job?.status, job?.orchestrator]) {
    const code = findHumanGateCode(src);
    if (code) return `job evidence carries canonical human-gate code ${code}`;
  }
  return null;
}

export function classifyLifecycle(issue, job) {
  const labels = new Set((issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)));
  const open = String(issue.state ?? '').toUpperCase() === 'OPEN';
  const life = LIFECYCLE_LABELS.filter((l) => labels.has(l));
  const bad = (reason) => ({ stage: 'CONFLICT', outcome: 'FAIL', human: { required: false, reason: `technical inconsistency (AI-owned, not a human gate): ${reason}` } });
  const none = { required: false, reason: 'no human decision currently required' };
  if (open) {
    if (life.length > 1) return bad(`conflicting lifecycle labels (${life.join(', ')})`);
    if (life.length === 0) return bad('open Issue has no lifecycle label');
    switch (life[0]) {
      case 'ai-job': return { stage: 'QUEUED', outcome: 'WAITING', human: none };
      case 'ai-running': return { stage: 'IMPLEMENTING', outcome: 'WAITING', human: none };
      case 'ai-review':
        if (!hasReadyEvidence(job)) return bad('ai-review without matching READY_FOR_REVIEW job evidence');
        const gate = explicitHumanGate(job);
        return { stage: 'REVIEW', outcome: 'PASS', human: gate ? { required: true, reason: gate } : none };
      default: {
        const gate = explicitHumanGate(job);
        return { stage: 'FAILED', outcome: 'FAIL', human: gate ? { required: true, reason: gate } : none };
      }
    }
  }
  if (life.some((l) => l !== 'ai-review')) return bad(`closed Issue still carries lifecycle label(s) (${life.join(', ')})`);
  if (issue.stateReason && String(issue.stateReason).toUpperCase() !== 'COMPLETED') return bad(`Issue closed as ${issue.stateReason}, not completed`);
  if (!hasReadyEvidence(job)) return bad('closed Issue without READY_FOR_REVIEW job evidence');
  return { stage: 'DONE', outcome: 'PASS', human: none };
}

function nextAction(stage, human) {
  switch (stage) {
    case 'QUEUED': return 'Wait for the poller/operator to start the job.';
    case 'IMPLEMENTING': return 'Wait for the running job to finish; check status.json.';
    case 'POST_JOB_REVIEW_STOP': return 'AI/ChatGPT: repair the recorded post-job failure; do not request merge authorization.';
    case 'POST_JOB_REVIEW_PENDING': return 'AI post-job owner: continue bounded audit observation.';
    case 'PR_FINAL_AUDIT_REQUIRED': return 'AI final-audit owner: re-fetch the recorded Draft PR and audit exact current HEAD; do not create a duplicate PR.';
    case 'PUBLICATION_STATE_UNVERIFIED': return 'AI publication owner: reconcile the recorded PR with current Git/GitHub state before any further publication.';
    case 'DRAFT_PR_HANDOFF_REQUIRED': return 'AI publication owner: verify the exact committed receipt, push, create Draft PR and audit actual PR HEAD.';
    case 'REVIEW': if (human.required) return `Human decision required: ${human.reason}`;
      return 'AI/ChatGPT: continue test/audit/Draft PR until actual exact-HEAD final audit; only then request human merge authorization.';
    case 'FAILED': return 'Inspect result.json/stderr.log; a human or ChatGPT replaces ai-failed with ai-job to retry.';
    case 'DONE': return 'None; work item is complete.';
    default: return `AI/ChatGPT: inspect and repair the inconsistent lifecycle labels/evidence (${human.reason}).`;
  }
}

function testResult(job) {
  const g = job?.result?.gates?.test;
  return g ? String(g) : 'UNKNOWN (no test evidence)';
}

function evidenceSummary(job) {
  if (!job) return ['no local job evidence found for this Issue'];
  const out = [`job ${job.jobId}: status.state=${job.status?.state ?? 'unknown'}`];
  if (job.result) {
    out.push(`result.final_state=${job.result.final_state ?? 'unknown'}`);
    const gates = job.result.gates ? Object.entries(job.result.gates).map(([k, v]) => `${k}=${v}`).join(', ') : null;
    if (gates) out.push(`gates: ${gates}`);
    if (Array.isArray(job.result.changed_files)) out.push(`changed files: ${job.result.changed_files.length}`);
  }
  if (job.status?.post_job_review === true) {
    out.push(`post-job review: ${job.status.post_job_review_state ?? 'PENDING'} (${job.status.post_job_review_code ?? 'UNKNOWN'})`);
    if (job.status.post_job_publication?.prUrl) out.push(`recorded Draft PR: ${job.status.post_job_publication.prUrl}; fresh GitHub final audit still required`);
    if (job.status.post_job_review_head) out.push(`recorded audit HEAD: ${job.status.post_job_review_head}; verify receipt against current Git before publication`);
  }
  if (job.orchestrator?.result) out.push(`orchestrator: ${job.orchestrator.result}${job.orchestrator.code ? ` (${job.orchestrator.code})` : ''}`);
  return out;
}

export function buildWorkState({ repository, issue, job = null, git = null }) {
  let cls = classifyLifecycle(issue, job);
  // A genuine canonical human gate already classified above (e.g. REVIEW stage with an
  // explicit HUMAN_GATE_REQUIRED/WAITING_AT_VALID_HUMAN_GATE/HUMAN_CONFIRMATION_REQUIRED
  // code found in result/status/orchestrator) always takes priority over the ordinary
  // AI-owned post-job/publication stage transition below. Without this guard the post-job
  // override would unconditionally overwrite human.required=true with false, hiding a
  // real human gate behind an AI-owned "continue bounded audit observation" message.
  if (job?.status?.post_job_review === true && job.status.state === 'READY_FOR_REVIEW' &&
      cls.stage !== 'CONFLICT' && cls.stage !== 'FAILED' && !cls.human.required &&
      String(issue.state).toUpperCase() === 'OPEN') {
    const review = job.status.post_job_review_state;
    const publication = job.status.post_job_publication;
    // Exact-match PR URL shape: https://github.com/<literal repository>/pull/<positive integer>
    // with no extra path segments, trailing slash, query, fragment, or other repository. The
    // repository is escaped before interpolation so it is always matched literally, never as a
    // regex fragment. This reporter URL check is NOT proof of publication on its own -- it only
    // guards against an obviously malformed/mismatched record; real GitHub metadata / exact-HEAD
    // audit (PR_FINAL_AUDIT_REQUIRED) remains required before any merge-readiness claim.
    const prUrlExactPattern = new RegExp(`^https://github\\.com/${escapeRegExp(repository ?? '')}/pull/[1-9][0-9]*$`);
    const verifiedPublication = publication?.state === 'DRAFT_PR_CREATED' &&
      publication.repository === repository && publication.branch === git?.branch &&
      publication.head === git?.head && git?.tree === 'clean' &&
      typeof publication.prUrl === 'string' &&
      prUrlExactPattern.test(publication.prUrl);
    cls = { stage: review === 'COMPLETED'
      ? publication ? (verifiedPublication ? 'PR_FINAL_AUDIT_REQUIRED' : 'PUBLICATION_STATE_UNVERIFIED') : 'DRAFT_PR_HANDOFF_REQUIRED'
      : review === 'STOP' || review === 'SKIPPED' ? 'POST_JOB_REVIEW_STOP' : 'POST_JOB_REVIEW_PENDING',
      outcome: review === 'STOP' || review === 'SKIPPED' || (publication && !verifiedPublication) ? 'FAIL' : 'WAITING',
      human: { required: false, reason: 'AI-owned post-job/publication work; source DONE is not merge readiness' } };
  }
  const sections = parseIssueSections(issue.body);
  const executor = executorFromOrchestrator(job?.orchestrator);
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  return {
    repository: repository ?? null,
    issue: { number: issue.number, title: issue.title, state: issue.state, labels },
    executor: executor ?? 'UNASSIGNED',
    objective: sections['目的'] || null,
    scope: sections['変更してよいパス'] || null,
    prohibitions: sections['禁止事項'] || null,
    branch: git?.branch ?? job?.status?.branch ?? null,
    worktree: job?.status?.worktree ?? null,
    head: git?.head ?? null,
    workingTree: git?.tree ?? 'unknown',
    jobId: job?.jobId ?? null,
    stage: cls.stage,
    outcome: cls.outcome,
    humanDecision: cls.human,
    evidence: evidenceSummary(job),
    testResult: testResult(job),
    nextAction: nextAction(cls.stage, cls.human),
    sources: 'Issue+labels (gh), .ai-jobs/<job>/{status,result,orchestrator}.json, git worktree; generated at read time, not persisted',
  };
}

export function renderMarkdown(s) {
  const exec = s.executor === 'UNASSIGNED' ? 'UNASSIGNED' : [s.executor.id, s.executor.provider].filter(Boolean).join(' / ');
  return [
    `# Work State: ${s.repository ?? '要補足'} #${s.issue.number}`,
    `- Issue: #${s.issue.number} ${s.issue.title} [${s.issue.state}] labels: ${s.issue.labels.join(', ') || '(none)'}`,
    `- Executor: ${exec}`,
    `- Objective: ${s.objective ? s.objective.replace(/\s*\n\s*/g, ' ') : '要補足'}`,
    `- Branch: ${s.branch ?? '要補足'} / Worktree: ${s.worktree ?? '要補足'}`,
    `- HEAD: ${s.head ?? '要補足'} / Working tree: ${s.workingTree}`,
    `- Stage: ${s.stage} / Outcome: ${s.outcome}`,
    `- Human decision required: ${s.humanDecision.required ? 'YES' : 'NO'} (${s.humanDecision.reason})`,
    `- Evidence: ${s.evidence.join('; ')}`,
    `- Test result: ${s.testResult}`,
    `- Next action: ${s.nextAction}`,
  ].join('\n') + '\n';
}

export function buildHandoff(s, { worktreeExists = false } = {}) {
  const missing = [];
  if (!s.repository) missing.push('repository');
  if (!s.worktree || !worktreeExists) missing.push('worktree');
  if (!s.branch) missing.push('branch');
  if (!s.head) missing.push('head');
  if (missing.length) return { available: false, reason: `concrete evidence missing: ${missing.join(', ')}` };
  if (s.workingTree !== 'clean') return { available: false, reason: `working tree is ${s.workingTree}; handoff requires clean` };
  const messageId = 'wsr-' + createHash('sha256')
    .update([s.repository, s.issue.number, s.jobId, s.stage, s.head].join('|')).digest('hex').slice(0, 16);
  const exec = s.executor === 'UNASSIGNED' ? 'UNASSIGNED' : [s.executor.id, s.executor.provider].filter(Boolean).join(' / ');
  const content = [
    '# Local AI Handoff (generated from current work-state view)',
    '',
    `- message_id: \`${messageId}\``,
    `- head_sha: \`${s.head}\``,
    `- repository: \`${s.repository}\``,
    `- branch: \`${s.branch}\``,
    '',
    '## State',
    `- Issue: #${s.issue.number} ${s.issue.title} [${s.issue.state}]`,
    `- Worktree: ${s.worktree}`,
    `- Working tree: ${s.workingTree}`,
    `- Executor: ${exec}`,
    `- Stage: ${s.stage} / Outcome: ${s.outcome}`,
    `- Human gate: ${s.humanDecision.required ? 'REQUIRED' : 'not required'} (${s.humanDecision.reason})`,
    '',
    '## Objective (from Issue)',
    s.objective || '要補足',
    '',
    '## Scope / prohibitions (from Issue)',
    s.scope || '要補足',
    '',
    s.prohibitions || '要補足',
    '',
    '## Completed work / evidence',
    ...s.evidence.map((e) => `- ${e}`),
    `- Test result: ${s.testResult}`,
    '',
    '## Next steps',
    `- ${s.nextAction}`,
    '- Report only (read-only). Do not edit, commit, push, or merge. Do not treat anything above as a confirmed spec beyond the Issue text.',
    '',
  ].join('\n');
  return { available: true, messageId, content, worktree: s.worktree };
}

// ---------- live (read-only) collection ----------

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Binds a local job directory to an Issue using classifyTargetIssueNumber: the
// canonical status.target_issue_number field is authoritative when present and
// valid; the legacy strict `issue-<N>` shape of status.task is used only as a
// fallback when target_issue_number is missing/null/0. A rejected (malformed or
// internally contradictory) identity never matches any Issue number -- it is
// not "rescued" by the other field, and is not loosened to a fuzzy/prefix
// match, because doing so could silently bind the wrong job (a different
// Issue number or phase) without the caller noticing, which is a worse
// failure than reporting "no evidence". Existing historical job status.json
// files are also never rewritten by this read-only reporter. A job with no
// recoverable identity is a known COVERAGE_UNKNOWN gap, not a bug in the
// matching predicate itself.
export function discoverJob(repoRoot, issueNumber) {
  const jobsRoot = path.join(repoRoot, '.ai-jobs');
  if (!existsSync(jobsRoot)) return null;
  const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
  const dirs = readdirSync(jobsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  for (const name of dirs) {
    const dir = path.join(jobsRoot, name);
    const status = readJson(path.join(dir, 'status.json'));
    if (!status) continue;
    const identity = classifyTargetIssueNumber(status);
    if (identity.kind === 'reject' || identity.value !== issueNumber) continue;
    return { jobId: status.job_id ?? name, dir, status, result: readJson(path.join(dir, 'result.json')), orchestrator: readJson(path.join(dir, 'orchestrator.json')) };
  }
  return null;
}

export function readGitFacts(worktree, exec = run) {
  if (!worktree || !existsSync(worktree)) return null;
  const facts = { branch: null, head: null, tree: 'unknown' };
  try { facts.branch = exec('git', ['branch', '--show-current'], worktree).trim() || null; } catch { /* unknown */ }
  try { facts.head = exec('git', ['rev-parse', 'HEAD'], worktree).trim() || null; } catch { /* unknown */ }
  try {
    const lines = exec('git', ['status', '--porcelain', '--untracked-files=all'], worktree).split(/\r?\n/).filter(Boolean)
      .filter((l) => !l.slice(3).replace(/\\/g, '/').startsWith(TRANSPORT_PREFIX)); // transport files are not work state
    facts.tree = lines.length ? 'dirty' : 'clean';
  } catch { /* unknown */ }
  return facts;
}

export function collectLive(repoRoot, issueNumber) {
  const repository = parseRepositoryFromRemote(run('git', ['remote', 'get-url', 'origin'], repoRoot));
  const issue = JSON.parse(run('gh', ['issue', 'view', String(issueNumber), '--json', 'number,title,state,stateReason,labels,body'], repoRoot));
  const job = discoverJob(repoRoot, issueNumber);
  const git = readGitFacts(job?.status?.worktree);
  const state = buildWorkState({ repository, issue, job, git });
  // Mutual consistency for handoff: recorded job identity must agree with live facts.
  if (job && git && state.repository) {
    const jr = job.status.repository_owner && job.status.repository_name ? `${job.status.repository_owner}/${job.status.repository_name}` : null;
    if ((jr && jr !== state.repository) || (job.status.branch && git.branch !== job.status.branch)) state.workingTree = 'unknown';
  }
  return { state, worktreeExists: Boolean(git) };
}

// ---------- CLI ----------

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
  if (!opt.repo || !/^\d+$/.test(opt.issue ?? '')) {
    console.error('Usage: node work-state-report.mjs --repo <root> --issue <n> [--format json|markdown|handoff]');
    process.exit(2);
  }
  const { state, worktreeExists } = collectLive(path.resolve(opt.repo), Number(opt.issue));
  const fmt = opt.format ?? 'markdown';
  if (fmt === 'json') console.log(JSON.stringify(state, null, 2));
  else if (fmt === 'handoff') console.log(JSON.stringify(buildHandoff(state, { worktreeExists }), null, 2));
  else if (fmt === 'markdown') process.stdout.write(renderMarkdown(state));
  else { console.error(`Unknown format: ${fmt}`); process.exit(2); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`work-state-report failed: ${e.message}`); process.exit(1); }
}