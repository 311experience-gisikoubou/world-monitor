import assert from 'node:assert/strict';
import { buildHandoff, buildWorkState, executorFromOrchestrator, parseIssueSections, parseRepositoryFromRemote, readGitFacts, renderMarkdown } from './work-state-report.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

const body = '## 目的\nDo X\n\n## 変更してよいパス\n- a/**\n\n## 完了条件\n- done\n\n## テストコマンド\nnode t.mjs\n\n## 禁止事項\n- no merge\n';
const issue = (labels, extra = {}) => ({ number: 5, title: 'T', state: 'OPEN', labels: labels.map((name) => ({ name })), body, ...extra });
const ready = {
  jobId: '20260101-001',
  status: { job_id: '20260101-001', state: 'READY_FOR_REVIEW', branch: 'job/x', worktree: '/wt' },
  result: { job_id: '20260101-001', final_state: 'READY_FOR_REVIEW', gates: { test: 'PASS', scope: 'PASS' }, changed_files: ['a/b'] },
  orchestrator: { result: 'COMPLETED', routing: { selectedExecutor: { id: 'claude-implementation-write', provider: 'claude' } } },
};
const clean = { branch: 'job/x', head: 'a'.repeat(40), tree: 'clean' };
const view = (labels, job, git, extra) => buildWorkState({ repository: 'o/r', issue: issue(labels, extra), job, git });

t('sections and remote parsing', () => {
  assert.equal(parseIssueSections(body)['目的'], 'Do X');
  assert.equal(parseRepositoryFromRemote('git@github.com:o/r.git'), 'o/r');
  assert.equal(parseRepositoryFromRemote('https://github.com/o/r'), 'o/r');
});
t('ai-job -> QUEUED/WAITING/no human, UNASSIGNED', () => {
  const s = view(['ai-job'], null, null);
  assert.deepEqual([s.stage, s.outcome, s.humanDecision.required, s.executor], ['QUEUED', 'WAITING', false, 'UNASSIGNED']);
});
t('ai-running -> IMPLEMENTING/WAITING', () => {
  const s = view(['ai-running'], null, null);
  assert.deepEqual([s.stage, s.outcome, s.humanDecision.required], ['IMPLEMENTING', 'WAITING', false]);
});
t('ai-review with ready evidence -> REVIEW/PASS/human', () => {
  const s = view(['ai-review'], ready, clean);
  assert.deepEqual([s.stage, s.outcome, s.humanDecision.required], ['REVIEW', 'PASS', true]);
  assert.equal(s.executor.provider, 'claude');
  assert.equal(s.testResult, 'PASS');
});
t('ai-review without ready evidence fails closed', () => {
  for (const job of [null, { ...ready, result: { ...ready.result, final_state: 'GATE_FAILED' } }]) {
    const s = view(['ai-review'], job, clean);
    assert.deepEqual([s.stage, s.outcome, s.humanDecision.required], ['CONFLICT', 'FAIL', false]);
  }
});
t('ai-failed -> FAILED/FAIL; human only with canonical code', () => {
  assert.equal(view(['ai-failed'], ready, clean).humanDecision.required, false);
  const prose = { ...ready, result: { ...ready.result, human_gate: true, note: 'human gate required' } };
  assert.equal(view(['ai-failed'], prose, clean).humanDecision.required, false);
  const gated = { ...ready, orchestrator: { result: 'STOPPED', detail: { nested: [{ code: 'HUMAN_GATE_REQUIRED' }] } } };
  const s = view(['ai-failed'], gated, clean);
  assert.deepEqual([s.stage, s.outcome, s.humanDecision.required], ['FAILED', 'FAIL', true]);
  assert.ok(s.humanDecision.reason.includes('HUMAN_GATE_REQUIRED'));
});
t('conflicting labels fail closed, no human gate', () => {
  const s = view(['ai-job', 'ai-running'], null, null);
  assert.deepEqual([s.stage, s.outcome, s.humanDecision.required], ['CONFLICT', 'FAIL', false]);
  assert.match(s.nextAction, /AI\/ChatGPT/);
});
t('open Issue with no lifecycle label -> CONFLICT/FAIL/no human', () => {
  const s = view([], null, null);
  assert.deepEqual([s.stage, s.outcome, s.humanDecision.required], ['CONFLICT', 'FAIL', false]);
});
t('closed completed with evidence -> DONE/PASS; without -> fail closed', () => {
  assert.deepEqual([view(['ai-review'], ready, clean, { state: 'CLOSED', stateReason: 'COMPLETED' }).stage], ['DONE']);
  assert.equal(view([], null, null, { state: 'CLOSED', stateReason: 'COMPLETED' }).outcome, 'FAIL');
  assert.equal(view([], ready, clean, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }).outcome, 'FAIL');
});
t('markdown renders required items', () => {
  const md = renderMarkdown(view(['ai-review'], ready, clean));
  for (const k of ['o/r', '#5', 'Executor', 'Objective: Do X', 'job/x', 'clean', 'REVIEW', 'PASS', 'Human decision required: YES', 'Test result: PASS', 'Next action']) assert.ok(md.includes(k), k);
});
t('handoff available only when concrete and clean; deterministic id', () => {
  const s = view(['ai-review'], ready, clean);
  const a = buildHandoff(s, { worktreeExists: true });
  const b = buildHandoff(s, { worktreeExists: true });
  assert.ok(a.available);
  assert.equal(a.messageId, b.messageId);
  for (const f of ['message_id', 'head_sha', 'repository', 'branch']) assert.match(a.content, new RegExp(`^- ${f}: \`[^\`]+\``, 'm'));
  assert.notEqual(buildHandoff(view(['ai-review'], ready, { ...clean, head: 'b'.repeat(40) }), { worktreeExists: true }).messageId, a.messageId);
  assert.equal(buildHandoff(view(['ai-review'], ready, { ...clean, tree: 'dirty' }), { worktreeExists: true }).available, false);
  assert.equal(buildHandoff(view(['ai-review'], ready, { ...clean, tree: 'unknown' }), { worktreeExists: true }).available, false);
  assert.equal(buildHandoff(s, { worktreeExists: false }).available, false);
  assert.equal(buildHandoff(view(['ai-job'], null, null), { worktreeExists: false }).available, false);
});
t('executor from orchestrator structure', () => {
  assert.deepEqual(executorFromOrchestrator({ preImplementationReceipt: { executor: { id: 'e', provider: 'p' } } }), { id: 'e', provider: 'p' });
  assert.equal(executorFromOrchestrator({}), null);
});
t('git facts ignore transport files and report unknown on failure', () => {
  const ok = (out) => (cmd, args) => (args[0] === 'status' ? out : args[0] === 'rev-parse' ? 'abc\n' : 'br\n');
  assert.equal(readGitFacts(process.cwd(), ok('?? .ai-handoff/runtime/inbox/x.md\n')).tree, 'clean');
  assert.equal(readGitFacts(process.cwd(), ok(' M f.txt\n')).tree, 'dirty');
  assert.equal(readGitFacts(process.cwd(), () => { throw new Error('x'); }).tree, 'unknown');
  assert.equal(readGitFacts('/nonexistent-path-xyz'), null);
});

console.log(`${n} tests passed`);
