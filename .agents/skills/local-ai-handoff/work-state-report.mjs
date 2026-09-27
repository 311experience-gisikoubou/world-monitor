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
        return { stage: 'REVIEW', outcome: 'PASS', human: { required: true, reason: 'final merge authorization is a human decision' } };
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
    case 'REVIEW': return 'Human: review the PR/diff and decide on final merge authorization.';
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
  if (job.orchestrator?.result) out.push(`orchestrator: ${job.orchestrator.result}${job.orchestrator.code ? ` (${job.orchestrator.code})` : ''}`);
  return out;
}

export function buildWorkState({ repository, issue, job = null, git = null }) {
  const cls = classifyLifecycle(issue, job);
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

export function discoverJob(repoRoot, issueNumber) {
  const jobsRoot = path.join(repoRoot, '.ai-jobs');
  if (!existsSync(jobsRoot)) return null;
  const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
  const dirs = readdirSync(jobsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  for (const name of dirs) {
    const dir = path.join(jobsRoot, name);
    const status = readJson(path.join(dir, 'status.json'));
    if (status && status.task === `issue-${issueNumber}`) {
      return { jobId: status.job_id ?? name, dir, status, result: readJson(path.join(dir, 'result.json')), orchestrator: readJson(path.join(dir, 'orchestrator.json')) };
    }
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
