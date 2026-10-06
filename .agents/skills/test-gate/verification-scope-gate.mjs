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
const GOVERNANCE_RE = /(^|\/)\.agents\/|(^|\/)templates\/(?:AGENTS\.index\.md\.template$|\.claude\/skills\/|ui-reference\/reproduction\/)|(^|\/)(AGENTS(?:\.local)?\.md|OPERATIONS\.md|CORE\.md|PROJECT_COMPLETION\.md|PROJECT_CONTEXT\.json|CURRENT_STATUS\.md|STATUS\.md|CHANGELOG\.md|VERSION)$|(^|\/)tools\/portfolio-governance-audit(?:-selftest)?\.mjs$/i;
const DEPENDENCY_RE = /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.(?:toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|go\.(?:mod|sum)|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile)$/i;
const FRONTEND_DEPENDENCY_RE = /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;
const BACKEND_DEPENDENCY_RE = /(^|\/)(Cargo\.(?:toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|go\.(?:mod|sum)|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile)$/i;
const MIGRATION_RE = /(^|\/)(migrations?|schema|database|db)(\/|$)|\.sql$/i;
const FRONTEND_RE = /(^|\/)(src|app|web|frontend|ui|components?|pages?|views?|styles?)(\/|$).+\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|css|scss|sass|less|html)$/i;
const ROOT_INDEX_HTML_RE = /^index\.html$/i;
const FRONTEND_VERIFICATION_SCRIPT_RE = /^scripts\/(?=[^/]*\.(?:ts|js|mjs)$)(?=[^/]*(?:frontend|ui|browser|render|layout|visual|home-stage|home-invoice))(?=[^/]*(?:verify|verification|selftest|test|smoke|check|scale))[^/]+\.(?:ts|js|mjs)$/i;
const ROOT_FRONTEND_JS_COMPANION_RE = /^(?!.*(?:^|[._-])(?:server|backend|api|build|config|test|tests|spec|tool|tools|script|scripts|webpack|vite|rollup|eslint|jest|playwright|cypress)(?:[._-]|$))[^/]+\.(?:js|mjs|cjs)$/i;
const BACKEND_RE = /(^|\/)(src-tauri|backend|server|api|services?|domain|repositories?|gateway)(\/|$)|\.(rs|go|py|java|kt|cs|rb|php)$/i;

// Narrow, reusable predicate for a dedicated gateway test/selftest/spec living
// directly under scripts/ (not under a gateway/ directory). The filename
// (before its final .js|.ts|.mjs extension) must contain a delimited
// "gateway" segment AND a delimited test-semantic segment ("test",
// "selftest", or "spec"), where segments are split on "-", "_", and ".".
// This intentionally rejects substring matches such as "gatewayish" or
// "contest" that merely contain the letters without being their own segment.
const GATEWAY_SCRIPT_TEST_FILE_RE = /^scripts\/([A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*)\.(?:js|ts|mjs)$/i;
const GATEWAY_TEST_SEMANTIC_SEGMENTS = new Set(['test', 'selftest', 'spec']);

function isGatewayDedicatedScriptTest(file) {
  const match = GATEWAY_SCRIPT_TEST_FILE_RE.exec(file);
  if (!match) return false;
  const segments = match[1].split(/[-_.]/).filter(Boolean).map(part => part.toLowerCase());
  const hasGatewaySegment = segments.includes('gateway');
  const hasTestSemanticSegment = segments.some(segment => GATEWAY_TEST_SEMANTIC_SEGMENTS.has(segment));
  return hasGatewaySegment && hasTestSemanticSegment;
}

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
  // Anchor candidates exclude anything already resolved as backend (a
  // dedicated gateway script test, or any BACKEND_RE path such as a
  // frontend-looking gateway subdirectory like gateway/ui/render.js) so a
  // backend-classified file can never manufacture a frontend companion
  // anchor for an otherwise-unrelated root JS file.
  const hasStrongFrontendAnchor = changedFiles.some(file => {
    if (isGatewayDedicatedScriptTest(file) || BACKEND_RE.test(file)) return false;
    return ROOT_INDEX_HTML_RE.test(file) || FRONTEND_VERIFICATION_SCRIPT_RE.test(file) || FRONTEND_RE.test(file);
  });

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
    if (BACKEND_RE.test(file) || isGatewayDedicatedScriptTest(file)) {
      flags.backend = true;
      continue;
    }
    if (ROOT_INDEX_HTML_RE.test(file) || FRONTEND_VERIFICATION_SCRIPT_RE.test(file) || FRONTEND_RE.test(file)) {
      flags.frontend = true;
      continue;
    }
    if (hasStrongFrontendAnchor && ROOT_FRONTEND_JS_COMPANION_RE.test(file)) {
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

  // Normal runtime changes start with the narrowest directly relevant test.
  // Broad build/full-suite work is an escalation, not the default.
  if (flags.frontend) {
    checks.push('TARGETED_FRONTEND_TEST');
  }

  if (flags.backend) {
    checks.push('TARGETED_BACKEND_TEST');
  }

  // Migrations and dependency changes are explicitly high-coupling. They keep
  // broader coverage because failures can escape the changed module.
  if (flags.migration) {
    checks.push('BACKEND_FULL_TEST', 'MIGRATION_TEST', 'FULL_REPOSITORY_SUITE');
  }

  if (flags.dependency) {
    checks.push('DEPENDENCY_AUDIT', 'FULL_REPOSITORY_SUITE');
  }

  return unique(checks);
}

function verificationLevelFor(flags, escalationReason) {
  if (flags.migration || flags.dependency || escalationReason === 'RELEASE_GATE') return 'FULL';
  if (flags.frontend && flags.backend) return 'AFFECTED';
  if (flags.governance || flags.frontend || flags.backend) return 'TARGETED';
  return 'MINIMAL';
}

function excessiveChecksFor(flags, plannedChecks) {
  const excessive = [];
  const highCoupling = flags.migration || flags.dependency;

  for (const check of plannedChecks) {
    if (check === 'FULL_REPOSITORY_SUITE' && !highCoupling) excessive.push(check);
    if (check === 'FRONTEND_FULL_TEST' && !flags.dependency) excessive.push(check);
    if (check === 'BACKEND_FULL_TEST' && !flags.migration) excessive.push(check);
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
  const verificationLevel = verificationLevelFor(classified.flags, escalationReason);

  if (classified.profile === 'UNKNOWN') {
    return {
      decision: 'STOP',
      code: 'CHANGE_SCOPE_UNKNOWN',
      profile: classified.profile,
      flags: classified.flags,
      verificationLevel,
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
      verificationLevel,
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
      verificationLevel,
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
    verificationLevel,
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
