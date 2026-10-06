#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const moduleArg = process.argv[2];
if (!moduleArg) throw new Error('environment-lifecycle-audit path required');
const moduleUrl = pathToFileURL(path.resolve(moduleArg)).href;
const {
  evaluateEnvironmentGrowth, evaluateCleanupAudit,
  CLEANUP_CATEGORIES, CLEANUP_CLASSIFICATIONS, ENVIRONMENT_ADDITION_KEYS,
  ENVIRONMENT_NECESSITY_VALUES,
} = await import(moduleUrl);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function addition(overrides = {}) {
  return {
    item: 'example-cli-tool',
    need: 'Required to run the bounded local build step.',
    alternative: 'No existing in-repo tool covers this; evaluated and rejected manual scripting as too error-prone.',
    residency: 'Installed locally only; no data leaves the machine.',
    egress: 'No network egress required after install.',
    autoUpdate: false,
    permissions: 'SAFE',
    permissionDetails: 'Local filesystem read/write under the project build directory only; no network, no credentials, no elevated/admin rights.',
    size: '12 MB',
    remove: 'Uninstall via the package manager; no residual service.',
    stop: 'No background process to stop.',
    ...overrides,
  };
}

// --- environment growth ---
{
  const result = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [] });
  assert(result.result === 'PROCEED' && result.code === 'NO_ENVIRONMENT_GROWTH', 'empty additions must PROCEED with no growth');
}
{
  const result = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition()] });
  assert(result.result === 'PROCEED' && result.code === 'ENVIRONMENT_GROWTH_RECORDED', `safe addition must PROCEED: ${JSON.stringify(result)}`);
  assert(result.additions[0].item === 'example-cli-tool', 'recorded addition must preserve the item field');
}
{
  const unknown = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition({ permissions: 'UNKNOWN' })] });
  assert(unknown.result === 'STOP' && unknown.code === 'ENVIRONMENT_GROWTH_UNSAFE_OR_UNKNOWN_PERMISSIONS',
    `UNKNOWN permissions must be rejected, never silently accepted: ${JSON.stringify(unknown)}`);
  const unsafe = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition({ permissions: 'UNSAFE' })] });
  assert(unsafe.result === 'STOP' && unsafe.code === 'ENVIRONMENT_GROWTH_UNSAFE_OR_UNKNOWN_PERMISSIONS',
    `UNSAFE permissions must be rejected: ${JSON.stringify(unsafe)}`);
}
{
  const missingField = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition({ remove: undefined })] });
  assert(missingField.result === 'STOP' && missingField.code === 'ENVIRONMENT_GROWTH_INVALID', 'a missing required field must fail schema-closed');
  const extraField = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [{ ...addition(), extra: 'x' }] });
  assert(extraField.result === 'STOP' && extraField.code === 'ENVIRONMENT_GROWTH_INVALID', 'an unknown field must fail schema-closed');
  assert(ENVIRONMENT_ADDITION_KEYS.length === 12, 'closed field list must stay exactly the 12 fields (11 required + optional necessityClassification)');
  const missing = evaluateEnvironmentGrowth(null);
  assert(missing.result === 'STOP' && missing.code === 'ENVIRONMENT_GROWTH_MISSING', 'a missing payload must STOP');
  const badSchema = evaluateEnvironmentGrowth({ schemaVersion: 2, additions: [] });
  assert(badSchema.result === 'STOP' && badSchema.code === 'SCHEMA_INVALID', 'wrong schema version must STOP');
}
// `permissions: SAFE` alone records no actual requested rights; `permissionDetails`
// is required and nonempty so the operational audit records the real privilege
// footprint, not only the safety verdict.
{
  const missingDetails = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition({ permissionDetails: undefined })] });
  assert(missingDetails.result === 'STOP' && missingDetails.code === 'ENVIRONMENT_GROWTH_INVALID',
    `a SAFE addition with no permissionDetails must still fail closed, never rely on the verdict alone: ${JSON.stringify(missingDetails)}`);
  const blankDetails = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition({ permissionDetails: '   ' })] });
  assert(blankDetails.result === 'STOP' && blankDetails.code === 'ENVIRONMENT_GROWTH_INVALID', 'a blank permissionDetails must fail closed, not count as recorded');
  const recorded = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition()] });
  assert(recorded.result === 'PROCEED' && recorded.additions[0].permissionDetails === addition().permissionDetails,
    'a valid permissionDetails is recorded verbatim alongside the SAFE verdict');
}
// `necessityClassification` is OPTIONAL and backwards compatible: omitting it
// (as every test above does) preserves prior behavior exactly.
{
  assert(ENVIRONMENT_NECESSITY_VALUES.size === 2, 'exactly two closed necessity classification values');
  const omitted = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition()] });
  assert(omitted.result === 'PROCEED', 'omitting necessityClassification must behave exactly as before (backwards compatible)');
  const explicitRequired = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition({ necessityClassification: 'REQUIRED' })] });
  assert(explicitRequired.result === 'PROCEED', 'an explicit REQUIRED classification must still PROCEED like the default');
  const unnecessary = evaluateEnvironmentGrowth({
    schemaVersion: 1,
    additions: [addition({ necessityClassification: 'EXISTING_ALTERNATIVE_SUFFICES', alternative: 'The existing stdlib csv module already covers this exact need; no new dependency is actually necessary.' })],
  });
  assert(unnecessary.result === 'STOP' && unnecessary.code === 'ENVIRONMENT_GROWTH_UNNECESSARY_EXISTING_ALTERNATIVE_SUFFICES',
    `an addition explicitly classified as unnecessary (existing alternative suffices) must STOP, not silently PROCEED: ${JSON.stringify(unnecessary)}`);
  assert(unnecessary.unnecessary[0].item === 'example-cli-tool', 'the STOP response names the actual unnecessary item');
  const badNecessity = evaluateEnvironmentGrowth({ schemaVersion: 1, additions: [addition({ necessityClassification: 'MAYBE' })] });
  assert(badNecessity.result === 'STOP' && badNecessity.code === 'ENVIRONMENT_GROWTH_INVALID', 'an unknown necessityClassification value must fail schema-closed');
}

// --- PoC cleanup audit ---
function fullCategories(overrideMap = {}) {
  const out = {};
  for (const category of CLEANUP_CATEGORIES) {
    out[category] = overrideMap[category] ?? 'NONE_FOUND';
  }
  return out;
}

{
  const missing = evaluateCleanupAudit(undefined);
  assert(missing.result === 'STOP' && missing.code === 'CLEANUP_AUDIT_MISSING', 'a missing inventory must STOP');
  const missingObject = evaluateCleanupAudit({ schemaVersion: 1 });
  assert(missingObject.result === 'STOP' && missingObject.code === 'CLEANUP_AUDIT_MISSING', 'a missing categories object must STOP');
}
{
  const result = evaluateCleanupAudit({ schemaVersion: 1, categories: fullCategories() });
  assert(result.result === 'PROCEED' && result.code === 'CLEANUP_AUDIT_RECORDED', `an honestly-empty full inventory must PROCEED: ${JSON.stringify(result)}`);
  assert(result.rows.length === 0, 'an all-NONE_FOUND inventory must have zero rows');
}
{
  const incomplete = evaluateCleanupAudit({
    schemaVersion: 1,
    categories: (() => { const c = fullCategories(); delete c.worktrees; return c; })(),
  });
  assert(incomplete.result === 'STOP' && incomplete.code === 'CLEANUP_AUDIT_INVALID' &&
    incomplete.errors.some((e) => e === 'category_worktrees_missing'),
    `omitting a category (vs. declaring it NONE_FOUND) must fail closed: ${JSON.stringify(incomplete)}`);
}
{
  const withRows = evaluateCleanupAudit({
    schemaVersion: 1,
    categories: fullCategories({
      worktrees: [{ item: 'C:\\w\\foo.ai-worktrees\\20261004-001', classification: 'HUMAN_DECISION_REQUIRED', rationale: 'Still referenced by an open job; human must confirm before any removal.' }],
      tokens: [{ item: 'synthetic test OAuth token (expired)', classification: 'DELETE_CANDIDATE', rationale: 'Expired synthetic credential with no further use; no real secret value recorded here.' }],
      cloudResources: [{ item: 'synthetic test bucket', classification: 'KEEP', rationale: 'Still in active use by a running integration test.' }],
    }),
  });
  assert(withRows.result === 'PROCEED', `a valid mixed inventory must PROCEED: ${JSON.stringify(withRows)}`);
  assert(withRows.summary.HUMAN_DECISION_REQUIRED === 1 && withRows.summary.DELETE_CANDIDATE === 1 && withRows.summary.KEEP === 1,
    'summary must reflect the actual classifications recorded');
  assert(withRows.note.includes('never performs stop/delete/revoke'), 'the module must document it never performs side effects itself');
}
{
  const badClassification = evaluateCleanupAudit({
    schemaVersion: 1,
    categories: fullCategories({ temp: [{ item: 'tmp-folder', classification: 'DELETE_NOW', rationale: 'x' }] }),
  });
  assert(badClassification.result === 'STOP' && badClassification.code === 'CLEANUP_AUDIT_INVALID',
    `only KEEP/STOP/DELETE_CANDIDATE/HUMAN_DECISION_REQUIRED are valid classifications: ${JSON.stringify(badClassification)}`);
  assert(CLEANUP_CLASSIFICATIONS.size === 4, 'exactly four closed classification values');
  const unknownCategory = evaluateCleanupAudit({
    schemaVersion: 1,
    categories: { ...fullCategories(), notARealCategory: 'NONE_FOUND' },
  });
  assert(unknownCategory.result === 'STOP' && unknownCategory.code === 'CLEANUP_AUDIT_INVALID', 'an unknown category key must fail closed');
}

console.log('environment-lifecycle-audit selftest: PASS');
