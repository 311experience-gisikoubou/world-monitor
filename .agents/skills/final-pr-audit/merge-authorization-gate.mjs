#!/usr/bin/env node
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const approved = argValue('--approved').toLowerCase();
const samePr = argValue('--same-pr').toLowerCase();
const samePurpose = argValue('--same-purpose').toLowerCase();
const sameSpec = argValue('--same-spec').toLowerCase();
const sameSafetyBoundary = argValue('--same-safety-boundary').toLowerCase();
const sameRiskBoundary = argValue('--same-risk-boundary').toLowerCase();
const latestAudit = argValue('--latest-audit').toLowerCase();
const headChanged = argValue('--head-changed').toLowerCase();
const jsonOnly = args.includes('--json');

const findings = [];
function add(status, code, detail = {}) {
  findings.push({ status, code, ...detail });
}

const yesNo = new Set(['yes', 'no']);
const auditStates = new Set(['pass', 'fail', 'unknown']);

if (!yesNo.has(approved)) add('STOP', 'MERGE_APPROVAL_STATUS_REQUIRED');
if (!yesNo.has(samePr)) add('STOP', 'SAME_PR_STATUS_REQUIRED');
if (!yesNo.has(samePurpose)) add('STOP', 'SAME_PURPOSE_STATUS_REQUIRED');
if (!yesNo.has(sameSpec)) add('STOP', 'SAME_SPEC_STATUS_REQUIRED');
if (!yesNo.has(sameSafetyBoundary)) add('STOP', 'SAME_SAFETY_BOUNDARY_STATUS_REQUIRED');
if (!yesNo.has(sameRiskBoundary)) add('STOP', 'SAME_RISK_BOUNDARY_STATUS_REQUIRED');
if (!auditStates.has(latestAudit)) add('STOP', 'LATEST_AUDIT_STATUS_REQUIRED');
if (!yesNo.has(headChanged)) add('STOP', 'HEAD_CHANGED_STATUS_REQUIRED');

let result = 'STOP';

if (!findings.length) {
  if (approved !== 'yes') {
    add('REAUTHORIZE', 'MERGE_APPROVAL_NOT_PRESENT');
    result = 'REAUTHORIZE';
  } else if (
    samePr !== 'yes' ||
    samePurpose !== 'yes' ||
    sameSpec !== 'yes' ||
    sameSafetyBoundary !== 'yes' ||
    sameRiskBoundary !== 'yes'
  ) {
    add('REAUTHORIZE', 'MERGE_APPROVAL_SCOPE_CHANGED', {
      samePr,
      samePurpose,
      sameSpec,
      sameSafetyBoundary,
      sameRiskBoundary,
    });
    result = 'REAUTHORIZE';
  } else if (latestAudit !== 'pass') {
    add('STOP', latestAudit === 'unknown' ? 'LATEST_AUDIT_UNKNOWN' : 'LATEST_AUDIT_FAILED');
    result = 'STOP';
  } else {
    add('PERSIST', headChanged === 'yes' ? 'MERGE_APPROVAL_PERSISTS_AFTER_HEAD_CHANGE' : 'MERGE_APPROVAL_PERSISTS');
    result = 'PERSIST';
  }
}

const output = {
  result,
  approved: approved || '(missing)',
  headChanged: headChanged || '(missing)',
  samePr: samePr || '(missing)',
  samePurpose: samePurpose || '(missing)',
  sameSpec: sameSpec || '(missing)',
  sameSafetyBoundary: sameSafetyBoundary || '(missing)',
  sameRiskBoundary: sameRiskBoundary || '(missing)',
  latestAudit: latestAudit || '(missing)',
  findings,
};

console.log(JSON.stringify(output, null, jsonOnly ? 0 : 2));
process.exit(result === 'PERSIST' ? 0 : result === 'REAUTHORIZE' ? 3 : 2);
