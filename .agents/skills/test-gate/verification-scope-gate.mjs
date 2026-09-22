#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 64 * 1024;

const ALLOWED_CHECKS = new Set([
  'DIFF_HYGIENE',
  'DOCS_CONSISTENCY',
  'TARGETED_SELFTEST',
  'FORMAT',
  'LINT',
  'TYPECHECK',
  'TARGETED_FRONTEND_TEST',
  'FRONTEND_BUILD',
  'FRONTEND_FULL_TEST',
  'TARGETED_BACKEND_TEST',
  'BACKEND_BUILD',
  'BACKEND_FULL_TEST',
  'MIGRATION_TEST',
  'DEPENDENCY_AUDIT',
  'REAL_DEVICE_OBJECTIVE',
  'FULL_REPOSITORY_SUITE',
]);

const ESCALATION_REASONS = new Set([
  'REPOSITORY_POLICY',
  'BASE_CHANGED',
  'PREEXISTING_FAILURE_TRIAGE',
  'CROSS_CUTTING_UNCERTAINTY',
  'RELEASE_GATE',
]);

const DOC_RE = /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|txt|rst)$/i;
const GOVERNANCE_RE = /(^|\/)\.agents\/|(^|\/)templates\/\.claude\/skills\/|(^|\/)(AGENTS(?:\.local)?\.md|OPERATIONS\.md|CORE\.md|PROJECT_COMPLETION\.md|PROJECT_CONTEXT\.json|CURRENT_STATUS\.md|STATUS\.md|CHANGELOG\.md|VERSION)$|(^|\/)tools\/portfolio-governance-audit(?:-selftest)?\.mjs$/i;
const DEPENDENCY_RE = /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.(?:toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|go\.(?:mod|sum)|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile)$/i;
const FRONTEND_DEPENDENCY_RE = /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;
const BACKEND_DEPENDENCY_RE = /(^|\/)(Cargo\.(?:toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|go\.(?:mod|sum)|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile)$/i;
const MIGRATION_RE = /(^|\/)(migrations?|schema|database|db)(\/|$)|\.sql$/i;
const FRONTEND_RE = /(^|\/)(src|app|web|frontend|ui|components?|pages?|views?|styles?)(\/|$).+\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|css|scss|sass|less|html)$/i;
const BACKEND_RE = /(^|\/)(src-tauri|backend|server|api|services?|domain|repositories?)(\/|$)|\.(rs|go|py|java|kt|cs|rb|php)$/i;

function unique(values) {
  return [...new Set(values)];
}

function validRepoPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some(part => part === '' || part === '.' || part === '..');
}

export function classifyFiles(changedFiles) {
  const flags = {
    docs: false,
    governance: false,
    dependency: false,
    migration: false,
    frontend: false,
    backend: false,
    unknown: false,
  };

  for (const file of changedFiles) {
    if (DEPENDENCY_RE.test(file)) {
      flags.dependency = true;
      if (FRONTEND_DEPENDENCY_RE.test(file)) flags.frontend = true;
      if (BACKEND_DEPENDENCY_RE.test(file)) flags.backend = true;
      continue;
    }
    if (MIGRATION_RE.test(file)) {
      flags.migration = true;
      flags.backend = true;
      continue;
    }
    if (GOVERNANCE_RE.test(file)) {
      flags.governance = true;
      continue;
    }
    if (DOC_RE.test(file)) {
      flags.docs = true;
      continue;
    }
    if (BACKEND_RE.test(file)) {
      flags.backend = true;
      continue;
    }
    if (FRONTEND_RE.test(file)) {
      flags.frontend = true;
      continue;
    }
    flags.unknown = true;
  }

  if (flags.unknown) return { profile: 'UNKNOWN', flags };
  if (flags.dependency) return { profile: 'DEPENDENCY_CHANGE', flags };
  if (flags.migration) return { profile: 'DB_MIGRATION', flags };
  if (flags.backend && flags.frontend) return { profile: 'MIXED_RUNTIME', flags };
  if (flags.backend) return { profile: 'BACKEND_ONLY', flags };
  if (flags.frontend) return { profile: 'FRONTEND_ONLY', flags };
  if (flags.governance) return { profile: 'GOVERNANCE_ONLY', flags };
  if (flags.docs) return { profile: 'DOCS_ONLY', flags };
  return { profile: 'UNKNOWN', flags };
}

function minimumChecksFor(flags) {
  const checks = ['DIFF_HYGIENE'];

  if (flags.governance) {
    checks.push('TARGETED_SELFTEST', 'DOCS_CONSISTENCY');
  } else if (flags.docs) {
    checks.push('DOCS_CONSISTENCY');
  }

  if (flags.frontend) {
    checks.push('TARGETED_SELFTEST', 'FRONTEND_BUILD');
  }

  if (flags.backend) {
    checks.push('BACKEND_FULL_TEST');
  }

  if (flags.migration) {
    checks.push('MIGRATION_TEST');
  }

  if (flags.dependency) {
    checks.push('DEPENDENCY_AUDIT');
  }

  return unique(checks);
}

function excessiveChecksFor(flags, plannedChecks) {
  const excessive = [];

  for (const check of plannedChecks) {
    if (check === 'FULL_REPOSITORY_SUITE') excessive.push(check);
    if (check === 'FRONTEND_FULL_TEST') excessive.push(check);
    if (check === 'BACKEND_FULL_TEST' && !flags.backend) excessive.push(check);
    if (check === 'FRONTEND_BUILD' && !flags.frontend) excessive.push(check);
    if (check === 'BACKEND_BUILD' && !flags.backend) excessive.push(check);
    if (check === 'TARGETED_FRONTEND_TEST' && !flags.frontend) excessive.push(check);
    if (check === 'TARGETED_BACKEND_TEST' && !flags.backend) excessive.push(check);
    if (check === 'MIGRATION_TEST' && !flags.migration) excessive.push(check);
    if (check === 'DEPENDENCY_AUDIT' && !flags.dependency) excessive.push(check);
    if (check === 'REAL_DEVICE_OBJECTIVE' && !flags.frontend) excessive.push(check);
  }

  return unique(excessive);
}

export function evaluate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { decision: 'STOP', code: 'INPUT_INVALID' };
  }

  const {
    changedFiles,
    plannedChecks,
    escalationReason = null,
  } = input;

  if (!Array.isArray(changedFiles)
    || changedFiles.length === 0
    || changedFiles.some(path => !validRepoPath(path))
    || unique(changedFiles).length !== changedFiles.length) {
    return { decision: 'STOP', code: 'CHANGED_FILES_INVALID' };
  }

  if (!Array.isArray(plannedChecks)
    || plannedChecks.length === 0
    || plannedChecks.some(check => !ALLOWED_CHECKS.has(check))
    || unique(plannedChecks).length !== plannedChecks.length) {
    return { decision: 'STOP', code: 'PLANNED_CHECKS_INVALID' };
  }

  if (escalationReason !== null && !ESCALATION_REASONS.has(escalationReason)) {
    return { decision: 'STOP', code: 'ESCALATION_REASON_INVALID' };
  }

  const classified = classifyFiles(changedFiles);
  const minimumChecks = minimumChecksFor(classified.flags);

  if (classified.profile === 'UNKNOWN') {
    return {
      decision: 'STOP',
      code: 'CHANGE_SCOPE_UNKNOWN',
      profile: classified.profile,
      flags: classified.flags,
      minimumChecks,
      excessiveChecks: [],
    };
  }

  const excessiveChecks = excessiveChecksFor(classified.flags, plannedChecks);
  const missingMinimumChecks = minimumChecks.filter(check => !plannedChecks.includes(check));

  if (missingMinimumChecks.length > 0) {
    return {
      decision: 'STOP',
      code: 'REQUIRED_CHECK_MISSING',
      profile: classified.profile,
      flags: classified.flags,
      minimumChecks,
      missingMinimumChecks,
      excessiveChecks,
    };
  }

  if (excessiveChecks.length > 0 && escalationReason === null) {
    return {
      decision: 'STOP',
      code: 'EXCESSIVE_CHECKS_UNJUSTIFIED',
      profile: classified.profile,
      flags: classified.flags,
      minimumChecks,
      missingMinimumChecks: [],
      excessiveChecks,
    };
  }

  return {
    decision: excessiveChecks.length > 0 ? 'PROCEED_ESCALATED' : 'PROCEED',
    code: excessiveChecks.length > 0 ? 'ESCALATION_ACCEPTED' : 'SCOPE_PROPORTIONAL',
    profile: classified.profile,
    flags: classified.flags,
    minimumChecks,
    missingMinimumChecks: [],
    excessiveChecks,
    escalationReason,
  };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) return { error: 'INPUT_TOO_LARGE' };
    chunks.push(chunk);
  }

  try {
    return { value: JSON.parse(chunks.join('')) };
  } catch {
    return { error: 'INPUT_JSON_INVALID' };
  }
}

async function main() {
  const input = await readStdin();
  const result = input.error
    ? { decision: 'STOP', code: input.error }
    : evaluate(input.value);

  console.log(JSON.stringify(result));
  console.error(`VERIFICATION_SCOPE_GATE=${result.decision}`);
  if (!result.decision.startsWith('PROCEED')) process.exitCode = 2;
}

const isCli = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await main();
