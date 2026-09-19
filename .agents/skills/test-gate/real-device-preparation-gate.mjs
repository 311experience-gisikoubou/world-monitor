#!/usr/bin/env node
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const manualVerification = argValue('--manual-verification').toLowerCase();
const verificationBasis = argValue('--verification-basis').toLowerCase();
const verificationOwner = argValue('--verification-owner').toLowerCase();
const sampleData = argValue('--sample-data').toLowerCase();
const sampleDataPrepared = argValue('--sample-data-prepared').toLowerCase();
const sampleDataPreparer = argValue('--sample-data-preparer').toLowerCase();
const sampleDataSource = argValue('--sample-data-source').toLowerCase();
const approvedTestEnvironment = argValue('--approved-test-environment').toLowerCase();
const humanSampleDataEntry = argValue('--human-sample-data-entry').toLowerCase();
const uiPathVerified = argValue('--ui-path-verified').toLowerCase();
const manualStarted = argValue('--manual-started', 'no').toLowerCase();
const jsonOnly = args.includes('--json');

const findings = [];
function add(status, code, detail = {}) { findings.push({ status, code, ...detail }); }

const requiredNotRequired = new Set(['required', 'not-required']);
const yesNoNa = new Set(['yes', 'no', 'na']);
const yesNo = new Set(['yes', 'no']);
const preparers = new Set(['ai-workflow', 'system', 'provider', 'user', 'none', 'unknown']);
const sources = new Set(['seed', 'fixture', 'dev-preload', 'existing-test-data', 'none', 'unknown']);
const envStates = new Set(['yes', 'no', 'not-applicable', 'unknown']);
const verificationBases = new Set(['objective', 'subjective', 'not-applicable']);
const verificationOwners = new Set(['ai-workflow', 'system', 'provider', 'user', 'none', 'unknown']);

if (!requiredNotRequired.has(manualVerification)) add('STOP', 'MANUAL_VERIFICATION_STATUS_REQUIRED');
if (!verificationBases.has(verificationBasis)) add('STOP', 'VERIFICATION_BASIS_REQUIRED');
if (!verificationOwners.has(verificationOwner)) add('STOP', 'VERIFICATION_OWNER_REQUIRED');
if (!requiredNotRequired.has(sampleData)) add('STOP', 'SAMPLE_DATA_STATUS_REQUIRED');
if (!yesNoNa.has(sampleDataPrepared)) add('STOP', 'SAMPLE_DATA_PREPARED_STATUS_REQUIRED');
if (!preparers.has(sampleDataPreparer)) add('STOP', 'SAMPLE_DATA_PREPARER_REQUIRED');
if (!sources.has(sampleDataSource)) add('STOP', 'SAMPLE_DATA_SOURCE_REQUIRED');
if (!envStates.has(approvedTestEnvironment)) add('STOP', 'TEST_ENVIRONMENT_STATUS_REQUIRED');
if (!yesNoNa.has(humanSampleDataEntry)) add('STOP', 'HUMAN_SAMPLE_DATA_ENTRY_STATUS_REQUIRED');
if (!yesNoNa.has(uiPathVerified)) add('STOP', 'UI_PATH_STATUS_REQUIRED');
if (!yesNo.has(manualStarted)) add('STOP', 'MANUAL_STARTED_STATUS_REQUIRED');

const manualRequired = manualVerification === 'required';
const sampleRequired = sampleData === 'required';

if (manualRequired) {
  if (approvedTestEnvironment === 'no' || approvedTestEnvironment === 'unknown') {
    add('STOP', 'TEST_ENVIRONMENT_NOT_CONFIRMED', { approvedTestEnvironment });
  }
  if (uiPathVerified !== 'yes') add('STOP', 'UI_PATH_NOT_VERIFIED');
}

if (manualRequired) {
  if (verificationBasis === 'not-applicable') add('STOP', 'VERIFICATION_BASIS_INCONSISTENT');
  if (verificationOwner === 'none' || verificationOwner === 'unknown') {
    add('STOP', 'VERIFICATION_OWNER_UNSAFE_OR_UNKNOWN', { verificationOwner });
  }
  if (verificationBasis === 'objective' && verificationOwner === 'user') {
    add('STOP', 'UNNECESSARY_HUMAN_CONFIRMATION');
  }
  if (verificationBasis === 'subjective' && verificationOwner !== 'user') {
    add('STOP', 'SUBJECTIVE_CONFIRMATION_REQUIRES_HUMAN');
  }
} else if (verificationBasis !== 'not-applicable' || verificationOwner !== 'none') {
  add('STOP', 'VERIFICATION_NOT_REQUIRED_CONFLICT', { verificationBasis, verificationOwner });
}

if (sampleRequired) {
  if (sampleDataPrepared !== 'yes') add('STOP', 'SAMPLE_DATA_NOT_PREPARED');
  if (sampleDataPreparer === 'user') add('STOP', 'HUMAN_ASSIGNED_SAMPLE_DATA_CREATION');
  if (sampleDataPreparer === 'none' || sampleDataPreparer === 'unknown') {
    add('STOP', 'SAMPLE_DATA_PREPARER_UNSAFE_OR_UNKNOWN', { sampleDataPreparer });
  }
  if (sampleDataSource === 'none' || sampleDataSource === 'unknown') {
    add('STOP', 'SAMPLE_DATA_SOURCE_UNSAFE_OR_UNKNOWN', { sampleDataSource });
  }
  if (humanSampleDataEntry !== 'no') add('STOP', 'HUMAN_SAMPLE_DATA_ENTRY_FORBIDDEN');
}

if (humanSampleDataEntry === 'yes') add('STOP', 'HUMAN_SAMPLE_DATA_ENTRY_FORBIDDEN');

const preparationIncomplete = findings.some((f) => [
  'SAMPLE_DATA_NOT_PREPARED',
  'HUMAN_ASSIGNED_SAMPLE_DATA_CREATION',
  'SAMPLE_DATA_PREPARER_UNSAFE_OR_UNKNOWN',
  'SAMPLE_DATA_SOURCE_UNSAFE_OR_UNKNOWN',
  'HUMAN_SAMPLE_DATA_ENTRY_FORBIDDEN',
  'TEST_ENVIRONMENT_NOT_CONFIRMED',
  'UI_PATH_NOT_VERIFIED',
].includes(f.code));

if (manualRequired && manualStarted === 'yes' && preparationIncomplete) {
  add('STOP', 'MANUAL_STARTED_BEFORE_PREPARATION_COMPLETE');
}

if (!findings.some((f) => f.status === 'STOP')) {
  add('READY', 'REAL_DEVICE_PREPARATION_READY', {
    manualRequired,
    verificationBasis,
    verificationOwner,
    sampleRequired,
    sampleDataPrepared,
    sampleDataPreparer,
    sampleDataSource,
    approvedTestEnvironment,
    humanSampleDataEntry,
    uiPathVerified,
    manualStarted,
  });
}

const result = findings.some((f) => f.status === 'STOP') ? 'STOP' : 'PROCEED';
const output = {
  result,
  manualVerification: manualVerification || '(missing)',
  verificationBasis: verificationBasis || '(missing)',
  verificationOwner: verificationOwner || '(missing)',
  sampleData: sampleData || '(missing)',
  sampleDataPrepared: sampleDataPrepared || '(missing)',
  sampleDataPreparer: sampleDataPreparer || '(missing)',
  sampleDataSource: sampleDataSource || '(missing)',
  approvedTestEnvironment: approvedTestEnvironment || '(missing)',
  humanSampleDataEntry: humanSampleDataEntry || '(missing)',
  uiPathVerified: uiPathVerified || '(missing)',
  manualStarted: manualStarted || '(missing)',
  findings,
};

console.log(JSON.stringify(output, null, jsonOnly ? 0 : 2));
process.exit(result === 'PROCEED' ? 0 : 2);
