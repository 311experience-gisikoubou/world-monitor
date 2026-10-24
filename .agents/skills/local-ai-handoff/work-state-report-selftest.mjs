import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHandoff, buildWorkState, classifyTargetIssueNumber, discoverJob, escapeRegExp, executorFromOrchestrator, parseIssueSections, parseRepositoryFromRemote, readGitFacts, renderMarkdown } from './work-state-report.mjs';

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
t('ai-review with ready evidence -> REVIEW/PASS/AI-owned', () => {
  const s = view(['ai-review'], ready, clean);
  assert.deepEqual([s.stage, s.outcome, s.humanDecision.required], ['REVIEW', 'PASS', false]);
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
  for (const k of ['o/r', '#5', 'Executor', 'Objective: Do X', 'job/x', 'clean', 'REVIEW', 'PASS', 'Human decision required: NO', 'Test result: PASS', 'Next action']) assert.ok(md.includes(k), k);
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


t('opted-in post-job pending/STOP/completed stays AI-owned', () => {
  for (const [state,stage,outcome] of [[undefined,'POST_JOB_REVIEW_PENDING','WAITING'],['PENDING','POST_JOB_REVIEW_PENDING','WAITING'],['STOP','POST_JOB_REVIEW_STOP','FAIL'],['SKIPPED','POST_JOB_REVIEW_STOP','FAIL'],['COMPLETED','DRAFT_PR_HANDOFF_REQUIRED','WAITING']]) {
    const job = {...ready, status:{...ready.status,post_job_review:true,post_job_review_state:state}};
    const s = view(['ai-review'],job,clean);
    assert.deepEqual([s.stage,s.outcome,s.humanDecision.required],[stage,outcome,false]);
    assert.doesNotMatch(s.nextAction,/Human: review/);
  }
});

t('completed post-job with recorded exact Draft progresses to final audit; no duplicate PR', () => {
  const job={...ready,status:{...ready.status,post_job_review:true,post_job_review_state:'COMPLETED',post_job_publication:{state:'DRAFT_PR_CREATED',repository:'o/r',branch:clean.branch,head:clean.head,prUrl:'https://github.com/o/r/pull/10'}}};
  const s=view(['ai-review'],job,clean);
  assert.deepEqual([s.stage,s.humanDecision.required],['PR_FINAL_AUDIT_REQUIRED',false]);
  assert.match(s.nextAction,/do not create a duplicate PR/);
  assert.equal(view(['ai-review'],job,{...clean,head:'b'.repeat(40)}).stage,'PUBLICATION_STATE_UNVERIFIED');
  const failed=view(['ai-failed'],job,clean);
  assert.deepEqual([failed.stage,failed.outcome,failed.humanDecision.required],['FAILED','FAIL',false]);
});
t('classifyTargetIssueNumber: canonical target_issue_number is authoritative', () => {
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: 283, task: 'issue-283' }), { kind: 'canonical', value: 283 });
  // Canonical wins even when there is no legacy task to agree with it.
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: 7 }), { kind: 'canonical', value: 7 });
  // Canonical wins even when status.task is some unrelated/non-legacy shape.
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: 7, task: 'issue283phase2' }), { kind: 'canonical', value: 7 });
});
t('classifyTargetIssueNumber: legacy issue-<N> fallback ONLY for missing/null/zero target_issue_number', () => {
  assert.deepEqual(classifyTargetIssueNumber({ task: 'issue-5' }), { kind: 'legacy', value: 5 });
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: null, task: 'issue-5' }), { kind: 'legacy', value: 5 });
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: 0, task: 'issue-5' }), { kind: 'legacy', value: 5 });
  // No parseable legacy task and no canonical value -> no identity at all.
  assert.deepEqual(classifyTargetIssueNumber({}), { kind: 'reject' });
  assert.deepEqual(classifyTargetIssueNumber(null), { kind: 'reject' });
  assert.deepEqual(classifyTargetIssueNumber({ task: 'issue283phase2' }), { kind: 'reject' });
  // Non-canonical legacy shapes (leading zero, non-digit suffix) are rejected, not loosely accepted.
  assert.deepEqual(classifyTargetIssueNumber({ task: 'issue-05' }), { kind: 'reject' });
});
t('classifyTargetIssueNumber: malformed/contradictory target_issue_number always REJECTs (never falls back to legacy)', () => {
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: 5.5, task: 'issue-5' }), { kind: 'reject' }); // fraction
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: -5, task: 'issue-5' }), { kind: 'reject' }); // negative
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: '5', task: 'issue-5' }), { kind: 'reject' }); // string
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: 7, task: 'issue-9' }), { kind: 'reject' }); // contradiction
  assert.deepEqual(classifyTargetIssueNumber({ target_issue_number: Number.MAX_SAFE_INTEGER + 2 }), { kind: 'reject' }); // not a safe integer
});
t('discoverJob binds via classifyTargetIssueNumber; contradictory/malformed/mismatched records never falsely bind (no false human gate)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wsr-selftest-'));
  try {
    const jobsRoot = path.join(root, '.ai-jobs');
    mkdirSync(jobsRoot, { recursive: true });
    const makeJob = (name, status) => {
      const dir = path.join(jobsRoot, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
    };
    makeJob('20260101-010', { job_id: '20260101-010', target_issue_number: 42, task: 'issue-42' }); // canonical
    makeJob('20260101-011', { job_id: '20260101-011', task: 'issue-43' }); // legacy fallback (no target_issue_number)
    makeJob('20260101-012', { job_id: '20260101-012', target_issue_number: 44, task: 'issue-45' }); // contradiction
    makeJob('20260101-013', { job_id: '20260101-013', target_issue_number: '46', task: 'issue-46' }); // malformed (string)
    makeJob('20260101-014', { job_id: '20260101-014', target_issue_number: 47 }); // canonical, mismatched below

    assert.equal(discoverJob(root, 42)?.jobId, '20260101-010');
    assert.equal(discoverJob(root, 43)?.jobId, '20260101-011');
    assert.equal(discoverJob(root, 44), null); // contradiction: never bound, not even via legacy 45
    assert.equal(discoverJob(root, 45), null);
    assert.equal(discoverJob(root, 46), null); // malformed canonical: never bound, not even via legacy 46
    assert.equal(discoverJob(root, 47)?.jobId, '20260101-014');
    assert.equal(discoverJob(root, 999), null); // canonical present but mismatched requested issue -> no binding
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
t('escapeRegExp neutralizes regex metacharacters for literal interpolation', () => {
  assert.equal(escapeRegExp('o/r'), 'o/r');
  assert.ok(new RegExp(`^${escapeRegExp('o.r+1')}$`).test('o.r+1'));
  assert.ok(!new RegExp(`^${escapeRegExp('o.r+1')}$`).test('oXr+1'));
});
t('verifiedPublication requires an exact PR URL shape; adversarial URLs stay unverified (no false merge-readiness)', () => {
  const makeState = (prUrl) => {
    const job = { ...ready, status: { ...ready.status, post_job_review: true, post_job_review_state: 'COMPLETED',
      post_job_publication: { state: 'DRAFT_PR_CREATED', repository: 'o/r', branch: clean.branch, head: clean.head, prUrl } } };
    return view(['ai-review'], job, clean);
  };
  const adversarial = [
    'https://github.com/o/r/pull/not-a-pr/123',
    'https://github.com/o/r/pull/123/extra/45',
    'https://github.com/o/r/pull//4',
    'https://github.com/o/r/pull/10/',
    'https://github.com/o/r/pull/10?x=1',
    'https://github.com/o/r/pull/10#frag',
    'https://github.com/o/other/pull/10',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/01',
    'https://github.com/o/r/pull/',
    'http://github.com/o/r/pull/10',
  ];
  for (const prUrl of adversarial) assert.equal(makeState(prUrl).stage, 'PUBLICATION_STATE_UNVERIFIED', prUrl);
  assert.equal(makeState('https://github.com/o/r/pull/10').stage, 'PR_FINAL_AUDIT_REQUIRED');
});

t('postjob override never hides a genuine canonical human gate (PENDING/COMPLETED+published/STOP)', () => {
  const gateCodes = ['HUMAN_GATE_REQUIRED', 'WAITING_AT_VALID_HUMAN_GATE', 'HUMAN_CONFIRMATION_REQUIRED'];
  for (const code of gateCodes) {
    // Canonical code nested inside an array inside a key, deep in orchestrator evidence.
    const gatedOrchestrator = { ...ready, orchestrator: { result: 'STOPPED', detail: { nested: [{ inner: { code } }] } } };
    for (const [postState, publication] of [
      [undefined, undefined],
      ['PENDING', undefined],
      ['COMPLETED', { state: 'DRAFT_PR_CREATED', repository: 'o/r', branch: clean.branch, head: clean.head, prUrl: 'https://github.com/o/r/pull/10' }],
      ['STOP', undefined],
    ]) {
      const job = { ...gatedOrchestrator, status: { ...gatedOrchestrator.status, post_job_review: true, post_job_review_state: postState,
        ...(publication ? { post_job_publication: publication } : {}) } };
      const s = view(['ai-review'], job, clean);
      assert.equal(s.stage, 'REVIEW', `stage must stay REVIEW for ${code}/${postState}`);
      assert.equal(s.outcome, 'PASS');
      assert.equal(s.humanDecision.required, true, `${code}/${postState} must keep the genuine human gate`);
      assert.ok(s.humanDecision.reason.includes(code), s.humanDecision.reason);
      assert.match(s.nextAction, /Human decision required/);
    }
  }
});
t('genuine human gate found in result or status (nested keys/arrays) also survives the postjob override', () => {
  const inResult = { ...ready,
    result: { ...ready.result, details: { list: [{ code: 'HUMAN_CONFIRMATION_REQUIRED' }] } },
    status: { ...ready.status, post_job_review: true, post_job_review_state: 'COMPLETED' } };
  const s1 = view(['ai-review'], inResult, clean);
  assert.deepEqual([s1.stage, s1.outcome, s1.humanDecision.required], ['REVIEW', 'PASS', true]);
  assert.match(s1.nextAction, /Human decision required/);

  const inStatus = { ...ready,
    status: { ...ready.status, post_job_review: true, post_job_review_state: 'PENDING', nested: { arr: ['x', 'WAITING_AT_VALID_HUMAN_GATE'] } } };
  const s2 = view(['ai-review'], inStatus, clean);
  assert.deepEqual([s2.stage, s2.outcome, s2.humanDecision.required], ['REVIEW', 'PASS', true]);
  assert.match(s2.nextAction, /Human decision required/);
});
t('incidental prose-only human mentions during postjob review never trigger a gate; ordinary postjob stays human.required=false', () => {
  const prose = { ...ready,
    result: { ...ready.result, note: 'a human should eventually confirm merge', detail: { nested: ['human gate required', 'waiting at valid human gate'] } },
    orchestrator: { ...ready.orchestrator, message: 'HUMAN_CONFIRMATION required (not exact)' } };
  for (const [state, expectedStage] of [[undefined, 'POST_JOB_REVIEW_PENDING'], ['PENDING', 'POST_JOB_REVIEW_PENDING'], ['STOP', 'POST_JOB_REVIEW_STOP'], ['COMPLETED', 'DRAFT_PR_HANDOFF_REQUIRED']]) {
    const job = { ...prose, status: { ...prose.status, post_job_review: true, post_job_review_state: state } };
    const s = view(['ai-review'], job, clean);
    assert.equal(s.stage, expectedStage);
    assert.equal(s.outcome, state === 'STOP' ? 'FAIL' : 'WAITING');
    assert.equal(s.humanDecision.required, false);
    assert.doesNotMatch(s.nextAction, /Human decision required/);
  }
});

console.log(`${n} tests passed`);