#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const EXPECTED_SECTION_ORDER = ['projectRoot', 'currentState', 'relatedWork', 'nextAction'];
const REQUIRED_HEADINGS = ['## Project Root', '## Current State', '## Related Work', '## Next Action'];
const RESERVED_LABELS = ['Project Context ID','Project name','Root repository','Final objective','Current Task repository','Current Task classification','Forbidden scope','Data/security','Git rules','Real-device requirements','Additional-cost condition','Current Task related repository','Related repositories'];
const ROLE_VALUES = new Set(['ROOT', 'RELATED']);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONTEXT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/;

function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) { const code = text.charCodeAt(i); if (code >= 0xD800 && code <= 0xDBFF) { const next = text.charCodeAt(i + 1); if (!(next >= 0xDC00 && next <= 0xDFFF)) return true; i += 1; } else if (code >= 0xDC00 && code <= 0xDFFF) return true; }
  return false;
}
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  if (value !== value.trim()) return null;
  const text = value;
  if (!text || text.length > maxLength || hasUnpairedSurrogate(text) || /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(text)) return null;
  return text;
}
function cleanRepo(value) {
  const repo = cleanText(value, 200);
  if (!repo || !REPO_RE.test(repo)) return null;
  const [owner, name] = repo.split('/');
  const ownerOk = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && !owner.includes('--');
  const nameOk = name.length <= 100 && name !== '.' && name !== '..';
  if (!ownerOk || !nameOk) return null;
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}
function cleanContextId(value) {
  const id = cleanText(value, 120);
  return id && CONTEXT_ID_RE.test(id) ? id : null;
}
function cleanFingerprint(value) {
  const fingerprintValue = cleanText(value, 64);
  return fingerprintValue && /^[a-f0-9]{64}$/.test(fingerprintValue) ? fingerprintValue : null;
}
function stop(code, message, detail = {}) {
  return { result: 'STOP', contextHealth: 'SEVERE_DRIFT', severity: 'SEVERE', code, message, ...detail };
}
function decodeUtf8Fatal(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
function decodeGitSingleLine(result) {
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  let text; try { text = decodeUtf8Fatal(result.stdout); } catch { return null; }
  if (!text.endsWith('\n')) return null;
  text = text.endsWith('\r\n') ? text.slice(0, -2) : text.slice(0, -1);
  return text && !/[\r\n\u0000]/.test(text) ? text : null;
}

export function hasDuplicateObjectKeys(text) {
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let raw = '"';
      let escaped = false;
      for (; j < text.length; j += 1) {
        const ch = text[j]; raw += ch;
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') break;
      }
      if (j >= text.length) return false;
      const top = stack.at(-1);
      if (top?.type === 'object' && top.expectingKey) {
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k])) k += 1;
        if (text[k] === ':') {
          let key;
          try { key = JSON.parse(raw); } catch { key = null; }
          if (key !== null) {
            if (top.keys.has(key)) return true;
            top.keys.add(key);
            top.expectingKey = false;
          }
        }
      }
      i = j + 1; continue;
    }
    if (c === '{') stack.push({ type: 'object', keys: new Set(), expectingKey: true });
    else if (c === '[') stack.push({ type: 'array' });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const top = stack.at(-1);
      if (top?.type === 'object') top.expectingKey = true;
    }
    i += 1;
  }
  return false;
}
export function parseJsonStrict(text) {
  if (typeof text !== 'string' || hasDuplicateObjectKeys(text)) throw new Error('duplicate-or-invalid-json');
  return JSON.parse(text);
}

const UNRESOLVED_WORDS = new Set(['UNKNOWN','UNAVAILABLE','TBD','TODO','要補足','未確認','不明']);
function resolvedText(value, maxLength = 2000) {
  const text = cleanText(value, maxLength);
  if (!text || text === '<fill>' || /^<[^>]+>$/.test(text)) return null;
  const semantic = text.replace(/[\*_~\x60]/g, '').trim();
  const placeholderKey = semantic.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (['NA','NOTAPPLICABLE','該当なし'].includes(placeholderKey)) return null;
  const words = semantic.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0 || words.every((word) => UNRESOLVED_WORDS.has(word.toUpperCase()) || UNRESOLVED_WORDS.has(word))) return null;
  return text;
}

function resolvedRepo(value) {
  const repo = cleanRepo(value);
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  return resolvedText(owner, 100) && resolvedText(name, 100) ? repo : null;
}
function artifactRepresentableText(text) {
  if (typeof text !== 'string' || /[<>\[\]\\]/.test(text) || /&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/.test(text) || /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(text)) return false;
  const semantic = text.replace(/[\*_~\x60]/g, '').replace(/\s+/g, ' ').replace(/\s*:\s*/g, ': ').toLowerCase();
  return !RESERVED_LABELS.some((label) => semantic.includes(label.toLowerCase() + ':'));
}

function normalizeManifest(input) {
  const m = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!m || m.schemaVersion !== 1) return { error: stop('PROJECT_CONTEXT_MANIFEST_INVALID', 'PROJECT_CONTEXT.json schemaVersion=1 is required.') };
  const projectContextId = cleanContextId(m.projectContextId);
  const projectName = resolvedText(m.projectName, 200);
  const rootRepo = resolvedRepo(m.projectRootRepository);
  const finalObjective = resolvedText(m.finalObjective, 2000);
  const thisRepo = resolvedRepo(m.thisRepository);
  const repositoryRole = ROLE_VALUES.has(m.repositoryRole) ? m.repositoryRole : null;
  if (!projectContextId || !resolvedText(projectContextId, 120) || !projectName || !artifactRepresentableText(projectName) || !rootRepo || !resolvedText(rootRepo, 300) || !finalObjective || !artifactRepresentableText(finalObjective) || !thisRepo || !resolvedText(thisRepo, 300) || !repositoryRole) {
    return { error: stop('PROJECT_ROOT_EVIDENCE_INCOMPLETE', 'Project Root identity is incomplete or malformed.') };
  }
  if ((repositoryRole === 'ROOT' && thisRepo !== rootRepo) || (repositoryRole === 'RELATED' && thisRepo === rootRepo)) {
    return { error: stop('PROJECT_CONTEXT_ROLE_MISMATCH', 'repositoryRole conflicts with Project Root identity.') };
  }
  return { value: { projectContextId, projectName, rootRepo, finalObjective, thisRepo, repositoryRole } };
}
function fingerprint(m) {
  return createHash('sha256').update(JSON.stringify([m.projectContextId, m.projectName, m.rootRepo, m.finalObjective])).digest('hex');
}
function normalizeSafetyFacts(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const keys = ['forbiddenScope','dataSecurity','gitRules','realDeviceRequirements','additionalCostCondition'];
  if (!v) return { error: stop('HANDOFF_SAFETY_FACTS_MISSING', 'Repository safety facts are required.') };
  const out = {};
  for (const key of keys) { const text = resolvedText(v[key], 2000); if (!text || !artifactRepresentableText(text)) return { error: stop('HANDOFF_SAFETY_FACTS_MISSING', 'All repository safety fact categories must be resolved and representable in the restricted handoff artifact.') }; out[key] = text; }
  return { value: out };
}
function repoFromRemoteUrl(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw || raw !== raw.trim() || /\s/u.test(raw)) return null;
  let match = raw.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) match = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) match = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? resolvedRepo(match[1] + '/' + match[2]) : null;
}
function nulRecords(result) {
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  let text; try { text = decodeUtf8Fatal(result.stdout); } catch { return null; } if (!text.endsWith('\0')) return null;
  const records = text.split('\0'); records.pop(); return records;
}
function effectiveOrigin(configuredUrl, rules) {
  const matches = rules.filter((r) => configuredUrl.startsWith(r.prefix)); if (!matches.length) return configuredUrl;
  const max = Math.max(...matches.map((r) => r.prefix.length)); const values = [...new Set(matches.filter((r) => r.prefix.length === max).map((r) => r.base + configuredUrl.slice(r.prefix.length)))];
  return values.length === 1 ? values[0] : null;
}
function cleanGitEvidenceEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  return env;
}
function hasActiveGitEvidenceOverride() {
  const exact = new Set(['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CEILING_DIRECTORIES','GIT_NAMESPACE','GIT_CONFIG','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS']);
  return Object.keys(process.env).some((key) => { const upper = key.toUpperCase(); return exact.has(upper) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper); });
}
function actualRepoForContextFile(contextFile) {
  if (hasActiveGitEvidenceOverride()) return { error: stop('PROJECT_CONTEXT_GIT_ENV_OVERRIDE', 'Repository/configuration-changing Git environment overrides are not allowed during Project Context evidence verification.') };
  if (path.basename(path.resolve(contextFile)) !== 'PROJECT_CONTEXT.json') return { error: stop('PROJECT_CONTEXT_FILE_LOCATION_INVALID', 'Canonical project context file must be named PROJECT_CONTEXT.json at repository root.') };
  const resolvedContextFile = path.resolve(contextFile);
  try {
    const stat = lstatSync(resolvedContextFile);
    if (stat.isSymbolicLink() || realpathSync(resolvedContextFile) !== resolvedContextFile) return { error: stop('PROJECT_CONTEXT_FILE_LINK_INVALID', 'Canonical PROJECT_CONTEXT.json must be a real file at repository root, not a symlink or redirected path.') };
  } catch { return { error: stop('PROJECT_CONTEXT_FILE_REQUIRED', 'PROJECT_CONTEXT.json is missing or unreadable.') }; }
  const contextDir = path.dirname(resolvedContextFile);
  const gitEnv = cleanGitEvidenceEnv();
  const top = spawnSync('git', ['-C', contextDir, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 5000, env: gitEnv });
  const topText = decodeGitSingleLine(top);
  if (!topText) return { error: stop('PROJECT_CONTEXT_REPOSITORY_UNVERIFIED', 'Could not verify repository root for PROJECT_CONTEXT.json.') };
  const samePath = process.platform === 'win32' ? path.resolve(topText).toLowerCase() === contextDir.toLowerCase() : path.resolve(topText) === contextDir;
  if (!samePath) return { error: stop('PROJECT_CONTEXT_FILE_NOT_AT_REPO_ROOT', 'PROJECT_CONTEXT.json must be stored at repository root.') };
  const configured = spawnSync('git', ['-C', contextDir, 'config', '-z', '--get-all', 'remote.origin.url'], { windowsHide: true, timeout: 5000, env: gitEnv });
  const configuredUrls = nulRecords(configured);
  if (!configuredUrls || configuredUrls.length !== 1 || configuredUrls.some((x) => !x)) return { error: stop('PROJECT_CONTEXT_ORIGIN_AMBIGUOUS', 'Exactly one non-empty configured origin URL is required for Project Context evidence.') };
  const configuredRepository = repoFromRemoteUrl(configuredUrls[0]);
  if (!configuredRepository) return { error: stop('PROJECT_CONTEXT_REPOSITORY_UNVERIFIED', 'Configured origin is not an exact supported github.com repository URL.') };
  const rewriteProbe = spawnSync('git', ['-C', contextDir, 'config', '-z', '--get-regexp', '^url\..*\.insteadof$'], { windowsHide: true, timeout: 5000, env: gitEnv });
  const rules = [];
  if (!rewriteProbe.error && rewriteProbe.status === 0) {
    const records = nulRecords(rewriteProbe); if (!records) return { error: stop('PROJECT_CONTEXT_REPOSITORY_UNVERIFIED', 'Git insteadOf rewrite evidence is malformed.') };
    for (const record of records) { const cut = record.indexOf('\n'); if (cut <= 4 || cut === record.length - 1) return { error: stop('PROJECT_CONTEXT_REPOSITORY_UNVERIFIED', 'Git insteadOf rewrite evidence is malformed.') }; const key = record.slice(0, cut).toLowerCase(); const prefix = record.slice(cut + 1); if (!key.startsWith('url.') || !key.endsWith('.insteadof') || !prefix) return { error: stop('PROJECT_CONTEXT_REPOSITORY_UNVERIFIED', 'Git insteadOf rewrite evidence is malformed.') }; rules.push({ base: record.slice(4, cut - '.insteadof'.length), prefix }); }
  } else if (rewriteProbe.status !== 1) return { error: stop('PROJECT_CONTEXT_REPOSITORY_UNVERIFIED', 'Could not inspect Git insteadOf rewrite evidence.') };
  const effectiveUrl = effectiveOrigin(configuredUrls[0], rules);
  const effectiveRepository = effectiveUrl ? repoFromRemoteUrl(effectiveUrl) : null;
  if (!effectiveRepository || effectiveRepository !== configuredRepository) return { error: stop('PROJECT_CONTEXT_REPOSITORY_UNVERIFIED', 'Effective Git origin destination conflicts with configured github.com repository identity.') };
  return { repository: configuredRepository };
}

export function observeProjectContextEvidence(contextFile) {
  const resolvedContextFile = path.resolve(contextFile);
  if (path.basename(resolvedContextFile) !== 'PROJECT_CONTEXT.json') return stop('PROJECT_CONTEXT_FILE_LOCATION_INVALID', 'Canonical project context file must be named PROJECT_CONTEXT.json at repository root.');
  const contextDir = path.dirname(resolvedContextFile);
  const gitEnv = cleanGitEvidenceEnv();
  const startBranchResult = spawnSync('git', ['-C', contextDir, 'branch', '--show-current'], { windowsHide:true, timeout:5000, env:gitEnv });
  const startHeadResult = spawnSync('git', ['-C', contextDir, 'rev-parse', 'HEAD'], { windowsHide:true, timeout:5000, env:gitEnv });
  const currentBranch = decodeGitSingleLine(startBranchResult);
  const headSha = decodeGitSingleLine(startHeadResult);
  if (!currentBranch) return stop('PROJECT_CONTEXT_DETACHED_HEAD', 'Project Guard requires a named current branch.');
  if (!headSha || !/^[a-f0-9]{40}$/.test(headSha)) return stop('PROJECT_CONTEXT_HEAD_UNVERIFIED', 'Project Guard could not verify the current Git HEAD.');
  let workingManifest;
  try { workingManifest = parseJsonStrict(decodeUtf8Fatal(readFileSync(resolvedContextFile))); }
  catch { return stop('PROJECT_CONTEXT_FILE_INVALID', 'PROJECT_CONTEXT.json is missing, malformed, or contains duplicate keys.'); }
  const workingNormalized = normalizeManifest(workingManifest);
  if (workingNormalized.error) return workingNormalized.error;
  const repositoryEvidence = actualRepoForContextFile(resolvedContextFile);
  if (repositoryEvidence.error) return repositoryEvidence.error;
  const committedResult = spawnSync('git', ['-C', contextDir, 'show', headSha + ':PROJECT_CONTEXT.json'], { windowsHide:true, timeout:5000, env:gitEnv });
  let committedText;
  try { if (committedResult.error || committedResult.status !== 0 || !Buffer.isBuffer(committedResult.stdout)) throw new Error('unavailable'); committedText = decodeUtf8Fatal(committedResult.stdout); }
  catch { return stop('PROJECT_CONTEXT_COMMITTED_EVIDENCE_REQUIRED', 'Project Guard requires PROJECT_CONTEXT.json from the captured Git HEAD.'); }
  let committedManifest;
  try { committedManifest = parseJsonStrict(committedText); } catch { return stop('PROJECT_CONTEXT_COMMITTED_EVIDENCE_INVALID', 'Committed PROJECT_CONTEXT.json is malformed or contains duplicate keys.'); }
  const committedNormalized = normalizeManifest(committedManifest);
  if (committedNormalized.error) return stop('PROJECT_CONTEXT_COMMITTED_EVIDENCE_INVALID', 'Committed PROJECT_CONTEXT.json is invalid.');
  const working = workingNormalized.value;
  const m = committedNormalized.value;
  if (JSON.stringify(working) !== JSON.stringify(m)) return stop('PROJECT_CONTEXT_WORKTREE_DRIFT', 'Working PROJECT_CONTEXT.json differs from the committed project identity.');
  if (repositoryEvidence.repository !== m.thisRepo) return stop('PROJECT_CONTEXT_REPOSITORY_DRIFT', 'Committed PROJECT_CONTEXT.json thisRepository does not match the actual origin repository.');
  const endBranch = decodeGitSingleLine(spawnSync('git', ['-C', contextDir, 'branch', '--show-current'], { windowsHide:true, timeout:5000, env:gitEnv }));
  const endHead = decodeGitSingleLine(spawnSync('git', ['-C', contextDir, 'rev-parse', 'HEAD'], { windowsHide:true, timeout:5000, env:gitEnv }));
  if (endBranch !== currentBranch || endHead !== headSha) return stop('PROJECT_CONTEXT_CHANGED_DURING_OBSERVATION', 'Branch or HEAD changed while Project Guard was collecting evidence.');
  return {
    result:'PROCEED', projectContextId:m.projectContextId, projectRootRepository:m.rootRepo, thisRepository:m.thisRepo,
    contextFingerprint:fingerprint(m), actualRepository:repositoryEvidence.repository, worktreeRepository:repositoryEvidence.repository,
    currentBranch, headSha, observedAt:new Date().toISOString(),
  };
}

export function validateProjectContext(manifestInput, stateInput) {
  const normalized = normalizeManifest(manifestInput);
  if (normalized.error) return normalized.error;
  const m = normalized.value;
  if (m.repositoryRole !== 'ROOT') return stop('PROJECT_CONTEXT_CANONICAL_ROOT_REQUIRED', 'Handoff must use the canonical PROJECT_CONTEXT.json from the Project Root repository.');
  const state = stateInput && typeof stateInput === 'object' && !Array.isArray(stateInput) ? stateInput : null;
  if (!state) return stop('HANDOFF_STATE_INVALID', 'Machine-readable handoff state is required.');
  const safetyFacts = normalizeSafetyFacts(state.repositorySafetyFacts);
  if (safetyFacts.error) return safetyFacts.error;
  const currentTaskRepo = resolvedRepo(state.currentTaskRepository);
  const declaredRootRepo = resolvedRepo(state.declaredHandoffRootRepository);
  const establishedProjectContextId = cleanContextId(state.establishedProjectContextId);
  const establishedContextFingerprint = cleanText(state.establishedContextFingerprint, 64);
  if (!currentTaskRepo || !declaredRootRepo) return stop('HANDOFF_ROOT_OR_TASK_REPO_MISSING', 'Declared handoff root and Current Task repository are required.');
  if (!establishedProjectContextId) return stop('PROJECT_CONTEXT_ID_MISSING', 'Established Project Context ID is required and must come from the active project context.');
  if (!establishedContextFingerprint || !/^[a-f0-9]{64}$/.test(establishedContextFingerprint)) return stop('PROJECT_CONTEXT_FINGERPRINT_MISSING', 'Established Project Context fingerprint is required.');
  if (establishedContextFingerprint !== fingerprint(m)) return stop('PROJECT_CONTEXT_TRANSITION_MISMATCH', 'Established project fingerprint conflicts with the repository manifest.');
  if (establishedProjectContextId !== m.projectContextId) {
    return stop('PROJECT_CONTEXT_TRANSITION_MISMATCH', 'Established project identity conflicts with the repository manifest.');
  }
  if (declaredRootRepo !== m.rootRepo) return stop('PROJECT_ROOT_TAKEOVER_DETECTED', 'Current Task or another repository attempted to replace the canonical Project Root.', { canonicalProjectRootRepository: m.rootRepo, declaredHandoffRootRepository: declaredRootRepo });
  const order = Array.isArray(state.sectionOrder) ? state.sectionOrder : null;
  if (!order || order.length !== EXPECTED_SECTION_ORDER.length || order.some((value, i) => value !== EXPECTED_SECTION_ORDER[i])) return stop('HANDOFF_SECTION_ORDER_DRIFT', 'Handoff order must be Project Root -> Current State -> Related Work -> Next Action.', { expectedSectionOrder: [...EXPECTED_SECTION_ORDER] });

  const related = new Set();
  if (state.relatedRepositories !== undefined) {
    if (!Array.isArray(state.relatedRepositories)) return stop('RELATED_REPOSITORIES_INVALID', 'relatedRepositories must be an array.');
    for (const value of state.relatedRepositories) {
      const repo = resolvedRepo(value);
      if (!repo) return stop('RELATED_REPOSITORY_INVALID', 'A related repository identifier is malformed.');
      if (repo === m.rootRepo) return stop('PROJECT_ROOT_MISCLASSIFIED_AS_RELATED', 'Project Root must never be classified as Related Repo.');
      related.add(repo);
    }
  }
  const currentTaskClassification = currentTaskRepo === m.rootRepo ? 'PROJECT_ROOT_REPO' : 'RELATED_REPO';
  if (currentTaskClassification === 'RELATED_REPO') related.add(currentTaskRepo);
  return {
    result: 'PROCEED', contextHealth: 'CLEAR', severity: 'NONE', code: 'PROJECT_CONTEXT_ALIGNED',
    projectRoot: { projectContextId: m.projectContextId, projectName: m.projectName, repository: m.rootRepo, finalObjective: m.finalObjective, contextFingerprint: fingerprint(m) },
    currentTask: { repository: currentTaskRepo, classification: currentTaskClassification },
    relatedRepositories: [...related].sort(), sectionOrder: [...EXPECTED_SECTION_ORDER], repositorySafetyFacts: safetyFacts.value,
    rule: 'Recent work volume, last-touched repository, and task duration never change Project Root identity.',
  };
}

export function validateTurnContinuation(manifestInput, stateInput) {
  const normalized = normalizeManifest(manifestInput);
  if (normalized.error) return normalized.error;
  const m = normalized.value;
  if (m.repositoryRole !== 'ROOT') return stop('PROJECT_CONTEXT_CANONICAL_ROOT_REQUIRED', 'Turn-start continuation must use the canonical PROJECT_CONTEXT.json from the active Project Root repository.');

  const state = stateInput && typeof stateInput === 'object' && !Array.isArray(stateInput) ? stateInput : null;
  const allowedKeys = ['schemaVersion','activeProjectContextId','activeContextFingerprint','candidateProjectContextId','candidateContextFingerprint','continuationMode'];
  if (!state || state.schemaVersion !== 1 || Object.keys(state).some((key) => !allowedKeys.includes(key)) || Object.keys(state).length !== allowedKeys.length) {
    return stop('TURN_CONTEXT_STATE_INVALID', 'Turn-start continuation state must use the closed schemaVersion=1 shape.');
  }
  if (state.continuationMode !== 'IMPLICIT') return stop('TURN_CONTEXT_MODE_INVALID', 'Turn-start guard only validates implicit continuation. Explicit project changes remain a separate human/project-context decision.');

  const activeProjectContextId = cleanContextId(state.activeProjectContextId);
  const activeContextFingerprint = cleanFingerprint(state.activeContextFingerprint);
  const candidateProjectContextId = cleanContextId(state.candidateProjectContextId);
  const candidateContextFingerprint = cleanFingerprint(state.candidateContextFingerprint);
  if (!activeProjectContextId || !activeContextFingerprint) return stop('TURN_CONTEXT_ACTIVE_EVIDENCE_REQUIRED', 'Active Project Context ID and fingerprint are required.');
  if (!candidateProjectContextId || !candidateContextFingerprint) return stop('TURN_CONTEXT_CANDIDATE_EVIDENCE_REQUIRED', 'Implicit continuation requires retained candidate Project Context identity; do not guess it from recent repository activity.');

  const canonicalFingerprint = fingerprint(m);
  if (activeProjectContextId !== m.projectContextId || activeContextFingerprint !== canonicalFingerprint) {
    return stop('PROJECT_CONTEXT_TRANSITION_MISMATCH', 'Active project identity conflicts with the canonical Project Root manifest.');
  }
  if (candidateProjectContextId !== activeProjectContextId || candidateContextFingerprint !== activeContextFingerprint) {
    return stop('CROSS_PROJECT_CONTINUATION_BLOCKED', 'Implicit continuation candidate belongs to a different Project Context. Re-select work from the active Project Root instead of continuing stale cross-project context.', {
      activeProjectContextId,
      candidateProjectContextId,
      projectRootRepository: m.rootRepo,
      nextAction: 'RESELECT_FROM_ACTIVE_PROJECT',
    });
  }

  return {
    result: 'PROCEED',
    contextHealth: 'CLEAR',
    severity: 'NONE',
    code: 'TURN_CONTEXT_ALIGNED',
    projectContextId: m.projectContextId,
    projectRootRepository: m.rootRepo,
    contextFingerprint: canonicalFingerprint,
    nextAction: 'CONTINUE_WITHIN_ACTIVE_PROJECT',
  };
}

export function renderHandoffSkeleton(manifestInput, stateInput) {
  const v = validateProjectContext(manifestInput, stateInput);
  if (v.result === 'STOP') return v;
  const meta = {
    schemaVersion: 1, projectContextId: v.projectRoot.projectContextId, contextFingerprint: v.projectRoot.contextFingerprint,
    projectName: v.projectRoot.projectName, projectRootRepository: v.projectRoot.repository, finalObjective: v.projectRoot.finalObjective,
    currentTaskRepository: v.currentTask.repository, currentTaskClassification: v.currentTask.classification,
    relatedRepositories: v.relatedRepositories, sectionOrder: v.sectionOrder, repositorySafetyFacts: v.repositorySafetyFacts,
  };
  const relatedLine = v.currentTask.classification === 'RELATED_REPO' ? '- Current Task related repository: `' + v.currentTask.repository + '`' : '- Current Task related repository: `none`';
  const relatedInventoryLine = '- Related repositories: ' + (v.relatedRepositories.length ? v.relatedRepositories.map((repo) => '`' + repo + '`').join(', ') : 'none');
  const markdown = '<!-- AI_PROJECT_CONTEXT\n' + JSON.stringify(meta) + '\nAI_PROJECT_CONTEXT -->\n# Project Handoff\n\n## Project Root\n' +
    '- Project Context ID: `' + v.projectRoot.projectContextId + '`\n' + '- Project name: ' + v.projectRoot.projectName + '\n' + '- Root repository: `' + v.projectRoot.repository + '`\n' + '- Final objective: ' + v.projectRoot.finalObjective + '\n\n' +
    '## Current State\n- Current Task repository: `' + v.currentTask.repository + '`\n- Current Task classification: `' + v.currentTask.classification + '`\n- Overall project state: CONTEXT_ENVELOPE_ONLY\n\n### Repository Safety Facts\n' +
    '- Forbidden scope: ' + v.repositorySafetyFacts.forbiddenScope + '\n- Data/security: ' + v.repositorySafetyFacts.dataSecurity + '\n- Git rules: ' + v.repositorySafetyFacts.gitRules + '\n- Real-device requirements: ' + v.repositorySafetyFacts.realDeviceRequirements + '\n- Additional-cost condition: ' + v.repositorySafetyFacts.additionalCostCondition + '\n\n' +
    '## Related Work\n' + relatedLine + '\n' + relatedInventoryLine + '\n- Other related work: SEE_RELATED_REPOSITORIES\n\n## Next Action\n- Next safe action: READ_CANONICAL_CURRENT_STATE\n';
  return { ...v, markdown };
}
function exactGlobalField(allLines, sectionLines, prefix, expected) {
  const found = allLines.filter((line) => line.startsWith(prefix));
  return found.length === 1 && sectionLines.includes(expected);
}
function completedField(allLines, sectionLines, prefix) {
  const found = allLines.filter((line) => line.startsWith(prefix));
  if (found.length !== 1 || !sectionLines.includes(found[0])) return false;
  const value = found[0].slice(prefix.length).trim();
  return Boolean(resolvedText(value, 2000));
}
function sameStringArray(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);
}
function sameStringObject(a, b, keys) {
  return a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) && sameStringArray(Object.keys(a).sort(), [...keys].sort()) && keys.every((key) => a[key] === b[key]);
}

export function validateHandoffArtifact(manifestInput, markdown, stateInput) {
  const v = validateProjectContext(manifestInput, stateInput);
  if (v.result === 'STOP') return v;
  if (typeof markdown !== 'string' || markdown.length > 500_000) return stop('HANDOFF_ARTIFACT_INVALID', 'Completed handoff artifact is missing or too large.');
  const headerRe = /<!-- AI_PROJECT_CONTEXT\s*\n([\s\S]*?)\nAI_PROJECT_CONTEXT -->/g;
  const headers = [...markdown.matchAll(headerRe)];
  if (headers.length !== 1) return stop(headers.length === 0 ? 'HANDOFF_CONTEXT_HEADER_MISSING' : 'HANDOFF_CONTEXT_HEADER_DUPLICATE', 'Completed handoff must contain exactly one machine-readable project context header.');
  if (headers[0].index !== 0) return stop('HANDOFF_CONTEXT_HEADER_POSITION_INVALID', 'Machine-readable project context header must be the first artifact content.');
  let meta;
  try { meta = parseJsonStrict(headers[0][1]); } catch { return stop('HANDOFF_CONTEXT_HEADER_INVALID', 'Completed handoff project context is ambiguous or invalid.'); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.schemaVersion !== 1) return stop('HANDOFF_CONTEXT_HEADER_INVALID', 'Completed handoff project context schemaVersion=1 is required.');
  const allowedMetaKeys = ['schemaVersion','projectContextId','contextFingerprint','projectName','projectRootRepository','finalObjective','currentTaskRepository','currentTaskClassification','relatedRepositories','sectionOrder','repositorySafetyFacts'].sort();
  if (!sameStringArray(Object.keys(meta).sort(), allowedMetaKeys) || headers[0][1].includes('-->') || headers[0][1].includes('<!--')) return stop('HANDOFF_CONTEXT_HEADER_INVALID', 'Completed handoff project context contains unexpected fields or unsafe comment delimiters.');
  if (meta.projectContextId !== v.projectRoot.projectContextId || meta.projectRootRepository !== v.projectRoot.repository || meta.projectName !== v.projectRoot.projectName || meta.finalObjective !== v.projectRoot.finalObjective || meta.contextFingerprint !== v.projectRoot.contextFingerprint) return stop('PROJECT_CONTEXT_TRANSITION_MISMATCH', 'Completed handoff does not match the established Project Root identity.');
  if (meta.currentTaskRepository !== v.currentTask.repository || meta.currentTaskClassification !== v.currentTask.classification) return stop('HANDOFF_CURRENT_TASK_INVALID', 'Completed handoff metadata Current Task differs from established state.');
  const safetyKeys = ['forbiddenScope','dataSecurity','gitRules','realDeviceRequirements','additionalCostCondition'];
  if (!sameStringArray(meta.relatedRepositories, v.relatedRepositories) || !sameStringArray(meta.sectionOrder, v.sectionOrder) || !sameStringObject(meta.repositorySafetyFacts, v.repositorySafetyFacts, safetyKeys)) return stop('HANDOFF_CONTEXT_HEADER_INVALID', 'Completed handoff metadata differs from established state.');
  const afterHeader = markdown.slice(headers[0].index + headers[0][0].length);
  if (!(afterHeader.startsWith('\n') || afterHeader.startsWith('\r\n'))) return stop('HANDOFF_CONTEXT_HEADER_POSITION_INVALID', 'Machine-readable project context header must be followed by a line break.');
  if (/\r(?!\n)/.test(markdown)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Bare carriage returns are not allowed in handoff artifacts.');
  const body = afterHeader;
  if (body.includes('<fill>')) return stop('HANDOFF_ARTIFACT_INCOMPLETE', 'Completed handoff still contains fill placeholders.');
  if (/[<>]/.test(body)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Angle-bracket HTML/processing-instruction syntax is not allowed in handoff artifacts.');
  if (/[\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(body)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Invisible Unicode format/control characters are not allowed in handoff artifacts.');
  if (/&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/.test(body)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'HTML entities are not allowed in handoff artifacts.');
  if (/[\[\]]/.test(body)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Square brackets are not allowed in handoff artifacts.');
  if (/\\[\p{P}\p{S}]/u.test(body)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Markdown backslash escapes are not allowed in handoff artifacts.');
  const rawLines = body.split(/\r?\n/);
  const firstVisible = rawLines.filter((line) => line.length > 0).slice(0, 2);
  if (firstVisible.length < 2 || firstVisible[0] !== '# Project Handoff' || firstVisible[1] !== '## Project Root') return stop('HANDOFF_SECTION_ORDER_DRIFT', 'Project Handoff title must be followed directly by Project Root, with blank lines only between them.');
  if (rawLines.some((line) => line.length > 0 && !/^#{1,6}\s+\S/.test(line) && !/^- [\p{L}\p{N}]/u.test(line))) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Completed handoff body is restricted to headings and canonical dash-list lines whose content starts with a letter or number.');
  if (rawLines.some((line) => line.length > 0 && /^\s/u.test(line))) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Leading Unicode whitespace/indentation is not allowed in handoff artifacts.');
  if (/!?\[[^\]\r\n]*\]\([^\r\n)]*\)/.test(body)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Inline Markdown links/images are not allowed in handoff artifacts.');
  if (/!?\[[^\]\r\n]*\]\[[^\]\r\n]*\]/.test(body) || /(^|\n)\[[^\]\r\n]+\]:\s*\S+/m.test(body)) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Reference Markdown links/images are not allowed in handoff artifacts.');
  if (rawLines.some((line) => /^( {4,}|\t)/.test(line) || /^\s*>/.test(line) || /^\s*(`{3,}|~{3,})/.test(line) || (line.trim().length > 0 && /^[\s*_=-]+$/.test(line))) || body.includes('<!--') || body.includes('-->')) return stop('HANDOFF_MARKDOWN_UNSUPPORTED', 'Indented code, blockquotes, fenced code, HTML comments, setext headings, and horizontal-rule syntax are not allowed in handoff artifacts.');
  const lines = rawLines.map((line) => line.trim());
  const semanticBody = lines.map((line) => line.replace(/[\*_~\x60]/g, '')).join(' ').replace(/\s+/g, ' ').replace(/\s*:\s*/g, ': ').toLowerCase();
  for (const label of RESERVED_LABELS) { const token = (label + ':').toLowerCase(); if (semanticBody.split(token).length - 1 !== 1) return stop('HANDOFF_RESERVED_FIELD_SYNTAX_INVALID', 'Reserved handoff identity/safety labels must occur exactly once across the visible artifact, case-insensitively.'); }
  for (const line of lines) {
    const semanticLine = line.replace(/[\*_~\x60]/g, '').toLowerCase();
    for (const label of RESERVED_LABELS) if (semanticLine.includes(label.toLowerCase()) && !line.startsWith('- ' + label + ':')) return stop('HANDOFF_RESERVED_FIELD_SYNTAX_INVALID', 'Reserved handoff identity/safety fields must use the canonical dash-label syntax and casing only.');
  }
  if (lines.some((line) => /^#{1,6}\s*$/.test(line))) return stop('HANDOFF_SECTION_ORDER_DRIFT', 'Empty ATX headings are not allowed in handoff artifacts.');
  const h1 = lines.filter((line) => /^#(?:\s+|$)/.test(line)); if (h1.length !== 1 || h1[0] !== '# Project Handoff') return stop('HANDOFF_TITLE_DRIFT', 'Completed handoff must contain exactly one Project Handoff title.');
  const headings = lines.filter((line) => /^##(?:\s+|$)/.test(line));
  if (!sameStringArray(headings, REQUIRED_HEADINGS)) return stop('HANDOFF_SECTION_ORDER_DRIFT', 'Completed handoff must contain exactly the four required visible sections in order.');
  const idx = REQUIRED_HEADINGS.map((h) => lines.indexOf(h));
  const rootLines = lines.slice(idx[0] + 1, idx[1]); const currentLines = lines.slice(idx[1] + 1, idx[2]); const relatedLines = lines.slice(idx[2] + 1, idx[3]); const nextLines = lines.slice(idx[3] + 1);
  if (!exactGlobalField(lines, rootLines, '- Project Context ID:', '- Project Context ID: `' + v.projectRoot.projectContextId + '`') || !exactGlobalField(lines, rootLines, '- Project name:', '- Project name: ' + v.projectRoot.projectName) || !exactGlobalField(lines, rootLines, '- Root repository:', '- Root repository: `' + v.projectRoot.repository + '`') || !exactGlobalField(lines, rootLines, '- Final objective:', '- Final objective: ' + v.projectRoot.finalObjective)) return stop('PROJECT_ROOT_TAKEOVER_DETECTED', 'Completed handoff Project Root fields must be unique and exact across the artifact.');
  if (!exactGlobalField(lines, currentLines, '- Current Task repository:', '- Current Task repository: `' + v.currentTask.repository + '`') || !exactGlobalField(lines, currentLines, '- Current Task classification:', '- Current Task classification: `' + v.currentTask.classification + '`')) return stop('HANDOFF_CURRENT_TASK_BODY_DRIFT', 'Completed handoff Current Task fields must be unique and exact.');
  if (lines.filter((line) => line === '### Repository Safety Facts').length !== 1 || !currentLines.includes('### Repository Safety Facts')) return stop('HANDOFF_SAFETY_FACTS_MISSING', 'Repository Safety Facts subsection is required exactly once under Current State.');
  if (!exactGlobalField(lines, currentLines, '- Forbidden scope:', '- Forbidden scope: ' + v.repositorySafetyFacts.forbiddenScope) || !exactGlobalField(lines, currentLines, '- Data/security:', '- Data/security: ' + v.repositorySafetyFacts.dataSecurity) || !exactGlobalField(lines, currentLines, '- Git rules:', '- Git rules: ' + v.repositorySafetyFacts.gitRules) || !exactGlobalField(lines, currentLines, '- Real-device requirements:', '- Real-device requirements: ' + v.repositorySafetyFacts.realDeviceRequirements) || !exactGlobalField(lines, currentLines, '- Additional-cost condition:', '- Additional-cost condition: ' + v.repositorySafetyFacts.additionalCostCondition)) return stop('HANDOFF_SAFETY_FACTS_DRIFT', 'Repository safety facts must be unique, complete, and match established state.');
  const expectedRelated = v.currentTask.classification === 'RELATED_REPO' ? '- Current Task related repository: `' + v.currentTask.repository + '`' : '- Current Task related repository: `none`';
  const expectedRelatedInventory = '- Related repositories: ' + (v.relatedRepositories.length ? v.relatedRepositories.map((repo) => '`' + repo + '`').join(', ') : 'none');
  if (!exactGlobalField(lines, relatedLines, '- Current Task related repository:', expectedRelated) || !exactGlobalField(lines, relatedLines, '- Related repositories:', expectedRelatedInventory)) return stop('RELATED_REPO_NOT_CLASSIFIED', 'Related Work classification must be unique and exact.');
  if (!completedField(lines, currentLines, '- Overall project state:') || !completedField(lines, relatedLines, '- Other related work:') || !completedField(lines, nextLines, '- Next safe action:')) return stop('HANDOFF_ARTIFACT_INCOMPLETE', 'Completed handoff requires non-placeholder project state, related work, and next action.');
  const canonical = renderHandoffSkeleton(manifestInput, stateInput);
  if (canonical.result === 'STOP') return canonical;
  const normalizedArtifact = markdown.replace(/\r\n/g, '\n');
  if (normalizedArtifact !== canonical.markdown) return stop('HANDOFF_ARTIFACT_DRIFT', 'Completed handoff must exactly match the machine-rendered Project Context envelope; free-form additions or edits are not allowed.');
  return { result: 'PROCEED', contextHealth: 'CLEAR', severity: 'NONE', code: 'HANDOFF_ARTIFACT_ALIGNED', projectContextId: v.projectRoot.projectContextId, projectRootRepository: v.projectRoot.repository, contextFingerprint: v.projectRoot.contextFingerprint };
}
function parseArgs(argv) {
  const valued = new Map(); const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pretty' || a === '--render' || a === '--turn-start') { if (flags.has(a)) return { error: 'duplicate' }; flags.add(a); continue; }
    if (!['--context-file', '--state-file', '--state-json', '--handoff-file'].includes(a) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) return { error: 'invalid' };
    if (valued.has(a)) return { error: 'duplicate' };
    valued.set(a, argv[++i]);
  }
  return { valued, flags };
}
async function readUtf8FileFatal(file) { return decodeUtf8Fatal(await readFile(file)); }
async function readStrictJsonFile(file) { return parseJsonStrict(await readUtf8FileFatal(file)); }
async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) { process.stdout.write(`${JSON.stringify(stop(parsed.error === 'duplicate' ? 'PROJECT_CONTEXT_ARGUMENT_DUPLICATE' : 'PROJECT_CONTEXT_ARGUMENT_INVALID', 'Project context guard arguments are invalid or duplicated.'))}\n`); process.exitCode = 2; return; }
  const contextFile = parsed.valued.get('--context-file');
  if (!contextFile) { process.stdout.write(`${JSON.stringify(stop('PROJECT_CONTEXT_ARGUMENT_INVALID', '--context-file is required.'))}\n`); process.exitCode = 2; return; }
  let manifest;
  try { manifest = await readStrictJsonFile(contextFile); } catch { process.stdout.write(`${JSON.stringify(stop('PROJECT_CONTEXT_FILE_REQUIRED', 'PROJECT_CONTEXT.json is missing, ambiguous, or unreadable.'))}\n`); process.exitCode = 2; return; }
  const normalizedManifest = normalizeManifest(manifest);
  if (normalizedManifest.error) { process.stdout.write(JSON.stringify(normalizedManifest.error) + '\n'); process.exitCode = 2; return; }
  const repoEvidence = actualRepoForContextFile(contextFile);
  if (repoEvidence.error) { process.stdout.write(JSON.stringify(repoEvidence.error) + '\n'); process.exitCode = 2; return; }
  if (repoEvidence.repository !== normalizedManifest.value.thisRepo) {
    const mismatch = stop('PROJECT_CONTEXT_REPOSITORY_DRIFT', 'PROJECT_CONTEXT.json thisRepository does not match the actual origin repository.', { expectedThisRepository: normalizedManifest.value.thisRepo, actualRepository: repoEvidence.repository });
    process.stdout.write(JSON.stringify(mismatch) + '\n'); process.exitCode = 2; return;
  }
  const handoffFile = parsed.valued.get('--handoff-file');
  const stateFile = parsed.valued.get('--state-file'); const stateJson = parsed.valued.get('--state-json');
  if ((!stateFile && !stateJson) || (stateFile && stateJson)) { process.stdout.write(`${JSON.stringify(stop('PROJECT_CONTEXT_ARGUMENT_INVALID', 'Use exactly one of --state-file or --state-json.'))}\n`); process.exitCode = 2; return; }
  let state; try { state = stateFile ? await readStrictJsonFile(stateFile) : parseJsonStrict(stateJson); } catch { process.stdout.write(`${JSON.stringify(stop('HANDOFF_STATE_INVALID', 'Handoff state JSON is missing, ambiguous, or unreadable.'))}\n`); process.exitCode = 2; return; }
  if (handoffFile) {
    if (parsed.flags.has('--render') || parsed.flags.has('--turn-start')) { process.stdout.write(`${JSON.stringify(stop('PROJECT_CONTEXT_ARGUMENT_INVALID', 'Artifact validation cannot be combined with --render or --turn-start.'))}\n`); process.exitCode = 2; return; }
    let markdown; try { markdown = await readUtf8FileFatal(handoffFile); } catch { markdown = null; }
    const result = validateHandoffArtifact(manifest, markdown, state);
    process.stdout.write(`${JSON.stringify(result, null, parsed.flags.has('--pretty') ? 2 : 0)}\n`); if (result.result === 'STOP') process.exitCode = 2; return;
  }
  if (parsed.flags.has('--render') && parsed.flags.has('--turn-start')) { process.stdout.write(`${JSON.stringify(stop('PROJECT_CONTEXT_ARGUMENT_INVALID', '--render and --turn-start are mutually exclusive.'))}\n`); process.exitCode = 2; return; }
  const result = parsed.flags.has('--turn-start') ? validateTurnContinuation(manifest, state) : (parsed.flags.has('--render') ? renderHandoffSkeleton(manifest, state) : validateProjectContext(manifest, state));
  if (parsed.flags.has('--render') && result.result !== 'STOP') process.stdout.write(result.markdown);
  else process.stdout.write(`${JSON.stringify(result, null, parsed.flags.has('--pretty') ? 2 : 0)}\n`);
  if (result.result === 'STOP') process.exitCode = 2;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(() => { process.stdout.write(`${JSON.stringify(stop('PROJECT_CONTEXT_INTERNAL_ERROR', 'Project context guard failed closed.'))}\n`); process.exitCode = 2; });