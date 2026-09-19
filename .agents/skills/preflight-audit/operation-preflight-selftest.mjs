#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gate = resolve(gateArg);

function run(extra) {
  return spawnSync(process.execPath, [gate, '--json', ...extra], { encoding: 'utf8' });
}
function expectStop(extra, code) {
  const r = run(extra);
  if (r.status === 0) throw new Error(`expected STOP for ${code}`);
  if (!r.stdout.includes(code)) throw new Error(`missing ${code}: ${r.stdout}`);
}
function expectProceed(extra) {
  const r = run(extra);
  if (r.status !== 0 || !r.stdout.includes('PROCEED')) {
    throw new Error(`expected PROCEED: ${r.stdout} ${r.stderr}`);
  }
}

const nonEngineerSafe = [
  '--human-profile', 'non-engineer',
  '--human-role', 'operator',
  '--technical-judgment-owner', 'ai-workflow',
  '--instruction-mode', 'stepwise-ui',
];

const progressSingle = [
  '--ai-work-structure', 'single-step',
  '--progress-update-event', 'none',
];

const progressTaskStart = [
  '--ai-work-structure', 'multi-step',
  '--progress-update-event', 'task-start',
  '--progress-update-sent', 'yes',
  '--progress-current-stage-present', 'yes',
  '--progress-meaning-present', 'yes',
  '--progress-next-step-present', 'yes',
  '--progress-user-action-status-present', 'yes',
];

const routineBase = [
  '--scope', 'network',
  '--estimated-user-minutes', '5',
  '--estimated-user-steps', '3',
  '--alternatives-reviewed', 'yes',
  '--simplest-safe', 'yes',
  '--work-impact', 'low',
  '--safe-stop', 'yes',
  '--scheduled-window', 'no',
  '--change-class', 'routine',
  '--lifecycle-impact', 'no',
  '--repeated-manual-pattern', 'no',
  '--same-class-failure-count', '0',
  '--post-failure-action', 'not-applicable',
  ...nonEngineerSafe,
  ...progressSingle,
];

const aiOnlyBase = [
  '--operation-kind', 'ai-only',
  '--alternatives-reviewed', 'yes',
  '--simplest-safe', 'yes',
  '--safe-stop', 'yes',
  '--change-class', 'implementation',
  '--lifecycle-impact', 'no',
  '--repeated-manual-pattern', 'no',
  '--same-class-failure-count', '0',
  '--post-failure-action', 'not-applicable',
  ...progressSingle,
];

const aiOnlyComplexCompact = [
  ...aiOnlyBase.filter((v, i, a) => !(v === '--ai-work-structure' || a[i - 1] === '--ai-work-structure' || v === '--progress-update-event' || a[i - 1] === '--progress-update-event')),
  '--ai-work-structure', 'multi-step',
  '--progress-update-event', 'task-start',
  '--progress-update-complete', 'yes',
];

const lifecycleSafe = [
  '--lifecycle-impact', 'yes',
  '--maintenance-plan-reviewed', 'yes',
  '--maintenance-owner', 'system',
  '--recovery-owner', 'ai-workflow',
  '--removal-owner', 'ai-workflow',
  '--estimated-user-maintenance-minutes-month', '0',
];

const aiOnlyResult = run(aiOnlyBase);
if (aiOnlyResult.status !== 0) throw new Error(`expected AI-only PROCEED: ${aiOnlyResult.stdout} ${aiOnlyResult.stderr}`);
const aiOnlyOutput = JSON.parse(aiOnlyResult.stdout);
if (aiOnlyOutput.operationKind !== 'ai-only' || aiOnlyOutput.scope !== 'local-dev') throw new Error('AI-only defaults missing');
if (aiOnlyOutput.estimatedUserMinutes !== 0 || aiOnlyOutput.estimatedUserSteps !== 0) throw new Error('AI-only human burden must default to zero');
if (aiOnlyOutput.humanProfile !== null || aiOnlyOutput.humanRole !== null || aiOnlyOutput.instructionMode !== null) throw new Error('AI-only human fields must be non-applicable');
expectStop([...aiOnlyBase, '--estimated-user-minutes', '1'], 'AI_ONLY_HUMAN_OPERATION_CONFLICT');
expectStop([...aiOnlyBase, '--human-profile', 'non-engineer'], 'AI_ONLY_HUMAN_OPERATION_CONFLICT');
expectStop([...aiOnlyBase, '--scope', 'network'], 'AI_ONLY_HUMAN_OPERATION_CONFLICT');
expectStop([...routineBase, '--operation-kind', 'unsupported'], 'OPERATION_KIND_INVALID');
expectProceed(aiOnlyComplexCompact);
expectStop([...aiOnlyComplexCompact, '--progress-update-complete', 'no'], 'PROGRESS_UPDATE_INCOMPLETE');
expectStop([...aiOnlyComplexCompact, '--progress-update-sent', 'yes'], 'PROGRESS_ATTESTATION_CONFLICT');
expectStop([...aiOnlyBase, '--progress-update-complete', 'yes'], 'PROGRESS_ATTESTATION_WITHOUT_EVENT');
expectStop([...routineBase, '--progress-update-complete', 'yes'], 'COMPACT_PROGRESS_ATTESTATION_AI_ONLY');



const timeoutBase = [
  ...aiOnlyBase,
  '--same-class-failure-count', '1',
  '--post-failure-action', 'retry-same',
  '--execution-outcome', 'timeout',
  '--same-command-timeout-count', '1',
];
expectProceed([...timeoutBase, '--timed-out-process-state', 'running', '--recovery-scope', 'poll-existing', '--completed-evidence-present', 'yes']);
expectStop([...timeoutBase, '--timed-out-process-state', 'running', '--recovery-scope', 'whole-phase', '--completed-evidence-present', 'yes'], 'TIMEOUT_PROCESS_STILL_RUNNING_POLL_REQUIRED');
expectStop([...timeoutBase, '--same-command-timeout-count', '0', '--timed-out-process-state', 'exited', '--recovery-scope', 'failed-only', '--completed-evidence-present', 'no'], 'TIMEOUT_COUNT_REQUIRED');
expectStop([...timeoutBase, '--timed-out-process-state', 'exited', '--recovery-scope', 'poll-existing', '--completed-evidence-present', 'no'], 'TIMEOUT_POLL_REQUIRES_RUNNING_PROCESS');
expectStop([...timeoutBase, '--timed-out-process-state', 'unknown', '--recovery-scope', 'root-cause-analysis', '--completed-evidence-present', 'no'], 'TIMEOUT_PROCESS_STATE_UNKNOWN_INSPECT_REQUIRED');
expectStop([...timeoutBase, '--timed-out-process-state', 'exited', '--recovery-scope', 'whole-phase', '--completed-evidence-present', 'yes'], 'TIMEOUT_COMPLETED_EVIDENCE_REUSE_REQUIRED');
expectProceed([...timeoutBase, '--timed-out-process-state', 'exited', '--recovery-scope', 'failed-only', '--completed-evidence-present', 'yes']);
expectProceed([...timeoutBase, '--timed-out-process-state', 'exited', '--recovery-scope', 'whole-phase', '--completed-evidence-present', 'no']);
expectStop([...timeoutBase, '--same-command-timeout-count', '2', '--timed-out-process-state', 'exited', '--recovery-scope', 'failed-only', '--completed-evidence-present', 'yes'], 'TIMEOUT_REPEATED_RETRY_REQUIRES_SPLIT_OR_ROUTE_CHANGE');
expectProceed([...timeoutBase, '--same-command-timeout-count', '2', '--timed-out-process-state', 'exited', '--recovery-scope', 'split-command', '--completed-evidence-present', 'yes']);
expectStop([...aiOnlyBase, '--timed-out-process-state', 'exited'], 'TIMEOUT_RECOVERY_FIELDS_WITHOUT_TIMEOUT');

expectStop([
  '--scope', 'network',
], 'USER_TIME_ESTIMATE_REQUIRED');

expectStop([
  ...routineBase.filter((v, i, a) => !(v === '--ai-work-structure' || a[i - 1] === '--ai-work-structure')),
], 'AI_WORK_STRUCTURE_REQUIRED');

expectStop([
  ...routineBase.filter((v, i, a) => !(v === '--same-class-failure-count' || a[i - 1] === '--same-class-failure-count')),
], 'SAME_CLASS_FAILURE_COUNT_REQUIRED');

expectStop([
  ...routineBase.filter((v, i, a) => !(v === '--post-failure-action' || a[i - 1] === '--post-failure-action')),
], 'POST_FAILURE_ACTION_REQUIRED');

expectStop([
  ...routineBase,
  '--same-class-failure-count', '1',
  '--post-failure-action', 'not-applicable',
], 'POST_FAILURE_ACTION_REQUIRED_AFTER_FAILURE');

expectProceed([
  ...routineBase,
  '--same-class-failure-count', '1',
  '--post-failure-action', 'retry-same',
]);

expectStop([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'retry-same',
], 'LOOP_DETECTED_THIRD_SAME_METHOD_BLOCKED');

expectStop([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'retry-materially-changed',
], 'MATERIAL_CHANGE_REVIEW_STATUS_REQUIRED');

expectStop([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'retry-materially-changed',
  '--material-change-reviewed', 'yes',
], 'FORCED_REFLECTION_STATUS_REQUIRED');

expectStop([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'retry-materially-changed',
  '--material-change-reviewed', 'yes',
  '--forced-reflection-reviewed', 'no',
  '--reflection-recorded', 'yes',
  '--reflection-basis', 'new-observation',
], 'FORCED_REFLECTION_REQUIRED_BEFORE_THIRD_ATTEMPT');

expectStop([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'retry-materially-changed',
  '--material-change-reviewed', 'yes',
  '--forced-reflection-reviewed', 'yes',
  '--reflection-basis', 'new-observation',
], 'FORCED_REFLECTION_RECORD_STATUS_REQUIRED');

expectStop([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'retry-materially-changed',
  '--material-change-reviewed', 'yes',
  '--forced-reflection-reviewed', 'yes',
  '--reflection-recorded', 'yes',
  '--reflection-basis', 'insufficient-observation',
], 'OBSERVATION_INSUFFICIENT_RETURN_TO_INVESTIGATION');

expectProceed([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'retry-materially-changed',
  '--material-change-reviewed', 'yes',
  '--forced-reflection-reviewed', 'yes',
  '--reflection-recorded', 'yes',
  '--reflection-basis', 'new-observation',
]);

expectProceed([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'root-cause-analysis',
]);

expectProceed([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'hypothesis-reselection',
]);

expectProceed([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'route-reselection',
]);

expectProceed([
  ...routineBase,
  '--same-class-failure-count', '2',
  '--post-failure-action', 'independent-review',
]);

expectStop([
  ...routineBase,
  '--alternatives-reviewed', 'no',
], 'ALTERNATIVES_NOT_REVIEWED');

expectStop([
  ...routineBase,
  '--simplest-safe', 'no',
], 'CHOSEN_PATH_NOT_SIMPLEST_SAFE');

expectStop([
  ...routineBase,
  '--human-role', 'technical-decider',
], 'NON_ENGINEER_ASSIGNED_TECHNICAL_DECISION');

expectStop([
  ...routineBase,
  '--technical-judgment-owner', 'user',
], 'TECHNICAL_JUDGMENT_DELEGATED_TO_NON_ENGINEER');

expectStop([
  ...routineBase,
  '--instruction-mode', 'expert',
], 'EXPERT_INSTRUCTIONS_FOR_NON_ENGINEER');

expectStop([
  ...routineBase,
  '--human-decision', 'pending',
], 'UNNECESSARY_HUMAN_CONFIRMATION');

expectProceed([
  ...routineBase,
]);

expectProceed([
  ...routineBase,
  '--change-class', 'architecture',
]);

expectStop([
  ...routineBase,
  '--ai-work-structure', 'multi-step',
  '--progress-update-event', 'none',
], 'PROGRESS_UPDATE_REQUIRED_FOR_COMPLEX_WORK');

expectStop([
  ...routineBase,
  '--ai-work-structure', 'multi-step',
  '--progress-update-event', 'task-start',
  '--progress-update-sent', 'no',
  '--progress-current-stage-present', 'yes',
  '--progress-meaning-present', 'yes',
  '--progress-next-step-present', 'yes',
  '--progress-user-action-status-present', 'yes',
], 'PROGRESS_UPDATE_NOT_SENT');

expectStop([
  ...routineBase,
  '--ai-work-structure', 'multi-step',
  '--progress-update-event', 'task-start',
  '--progress-update-sent', 'yes',
  '--progress-current-stage-present', 'yes',
  '--progress-meaning-present', 'no',
  '--progress-next-step-present', 'yes',
  '--progress-user-action-status-present', 'yes',
], 'PROGRESS_MEANING_REQUIRED');

expectProceed([
  ...routineBase,
  ...progressTaskStart,
]);

expectProceed([
  ...routineBase,
  '--ai-work-structure', 'long-running',
  '--progress-update-event', 'phase-change',
  '--progress-update-sent', 'yes',
  '--progress-current-stage-present', 'yes',
  '--progress-meaning-present', 'yes',
  '--progress-next-step-present', 'yes',
  '--progress-user-action-status-present', 'yes',
]);

expectStop([
  ...routineBase,
  '--ai-work-structure', 'long-running',
  '--progress-update-event', 'user-action-change',
  '--progress-update-sent', 'yes',
  '--progress-current-stage-present', 'yes',
  '--progress-meaning-present', 'yes',
  '--progress-next-step-present', 'yes',
  '--progress-user-action-status-present', 'no',
], 'PROGRESS_USER_ACTION_STATUS_REQUIRED');

expectStop([
  ...routineBase,
  '--change-class', 'install-adoption',
], 'INSTALL_ADOPTION_REQUIRES_LIFECYCLE_REVIEW');

expectProceed([
  ...routineBase,
  '--scope', 'real-device',
  '--change-class', 'install-adoption',
  ...lifecycleSafe,
]);

expectStop([
  ...routineBase,
  '--scope', 'real-device',
  '--change-class', 'install-adoption',
  ...lifecycleSafe,
  '--maintenance-owner', 'user',
], 'USER_BECOMES_TECHNICAL_MAINTAINER');

expectStop([
  ...routineBase,
  '--change-class', 'external-data-route',
  '--human-decision', 'pending',
  '--nonengineer-explanation-ready', 'yes',
], 'IMPORTANT_CHOICE_HUMAN_APPROVAL_REQUIRED');

expectStop([
  ...routineBase,
  '--change-class', 'external-data-route',
  '--human-decision', 'approved',
  '--nonengineer-explanation-ready', 'no',
], 'IMPORTANT_CHOICE_EXPLANATION_REQUIRED');

expectProceed([
  ...routineBase,
  '--change-class', 'business-policy',
  '--human-role', 'value-decider',
  '--human-decision', 'approved',
  '--nonengineer-explanation-ready', 'yes',
]);

expectStop([
  ...routineBase,
  '--change-class', 'lifecycle-responsibility',
  '--human-role', 'value-decider',
  '--human-decision', 'approved',
  '--nonengineer-explanation-ready', 'yes',
], 'LIFECYCLE_RESPONSIBILITY_REQUIRES_LIFECYCLE_REVIEW');

expectProceed([
  ...routineBase,
  '--change-class', 'lifecycle-responsibility',
  '--human-role', 'value-decider',
  '--human-decision', 'approved',
  '--nonengineer-explanation-ready', 'yes',
  ...lifecycleSafe,
]);

expectStop([
  ...routineBase,
  '--repeated-manual-pattern', 'yes',
  '--structural-automation-reviewed', 'no',
], 'REPEATED_MANUAL_PATTERN_NOT_GENERALIZED');

expectProceed([
  ...routineBase,
  '--repeated-manual-pattern', 'yes',
  '--structural-automation-reviewed', 'yes',
]);

expectStop([
  ...routineBase,
  '--estimated-user-minutes', '30',
  '--scheduled-window', 'no',
], 'LONG_USER_OPERATION_NOT_SCHEDULED');

expectProceed([
  ...routineBase,
  '--estimated-user-minutes', '30',
  '--estimated-user-steps', '12',
  '--work-impact', 'medium',
  '--scheduled-window', 'yes',
]);

console.log('operation-preflight selftest: PASS');