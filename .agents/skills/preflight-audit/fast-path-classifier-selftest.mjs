#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const classifierArg = process.argv[2];
if (!classifierArg) throw new Error('classifier path required');
const classifierPath = resolve(classifierArg);
const classifier = await import(pathToFileURL(classifierPath).href);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const impactKeys = [
  'production', 'network', 'realDevice', 'installOrAdoption',
  'dependency', 'securitySensitive', 'authOrCredential', 'mergeAuthority',
  'workflowOrDeployment', 'databaseOrMigration', 'externalDataRoute',
  'recurringCost', 'lifecycle', 'businessPolicy', 'architecture',
];

function impacts(overrides = {}) {
  return Object.fromEntries(impactKeys.map(key => [key, overrides[key] ?? false]));
}
const originalCwd = process.cwd();
const live = classifier.observeLiveProjectContext();
assert(live.result === 'PROCEED', 'selftest requires live project context evidence');
process.env.AI_ACTIVE_TASK_REPOSITORY = live.actualRepository;
process.env.AI_ACTIVE_PROJECT_CONTEXT_ID = live.projectContextId;
process.env.AI_ACTIVE_PROJECT_CONTEXT_FINGERPRINT = live.contextFingerprint;
function projectGuard(overrides = {}) {
  const base = {
    expectedRepository: live.actualRepository,
    expectedProjectIdentifier: live.projectContextId,
    expectedContextFingerprint: live.contextFingerprint,
    referenceRepository: null,
    targetIssueRepository: null,
    targetPrRepository: null,
    operationType: 'product-implementation',
    route: { selection:'not-applicable', selectedPathId:null, alternateReasonCode:null, alternateReason:null },
  };
  return { ...base, ...overrides, route:{ ...base.route, ...(overrides.route ?? {}) } };
}
function fixture(overrides = {}) {
  return {
    schemaVersion: 3, evidenceComplete: true, changeClass: 'routine', dataMode: 'source-only', executionScope: 'local-dev',
    impacts: impacts(), changedFiles: ['src/ui/label.ts'],
    wipReview: { decision:'CONTINUE', evidenceFetchedAt:new Date(Date.now()-1000).toISOString() },
    projectGuard: projectGuard(), ...overrides,
  };
}
function expectDecision(evidence, decision, reason = null) {
  const report = classifier.classifyChange(evidence);
  assert(report.decision === decision, decision + ' expected, got ' + report.decision + ' reasons=' + report.reasons.join(','));
  if (reason) assert(report.reasons.includes(reason), 'missing reason ' + reason + ': ' + report.reasons.join(','));
  return report;
}
function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding:'utf8' });
  assert(result.status === 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
  return result.stdout.trim();
}
function makeRepo(repository, projectContextId, registry = null) {
  const repo = mkdtempSync(join(tmpdir(), 'project-guard-selftest-'));
  assert(spawnSync('git', ['init', repo], { encoding:'utf8' }).status === 0, 'temp git init');
  git(repo, ['config','user.email','selftest@example.invalid']); git(repo, ['config','user.name','Selftest']);
  git(repo, ['remote','add','origin','https://github.com/' + repository + '.git']);
  const manifest={
    schemaVersion:1,projectContextId,projectName:'Selftest Project',projectRootRepository:repository,
    finalObjective:'Exercise Project Guard with synthetic local Git evidence only.',thisRepository:repository,repositoryRole:'ROOT',
    canonicalContract:{
      schemaVersion:1,contractId:`${projectContextId}-contract`,contractVersion:'1',approved:true,
      artifacts:[{id:`${projectContextId}-baseline`,kind:'GOVERNANCE',slot:'project-baseline',status:'CURRENT',sources:['PROJECT_CONTEXT.json']}],
      protectedDecisions:[],requiredValidation:['canonical-contract-gate'],
    },
  };
  writeFileSync(join(repo,'PROJECT_CONTEXT.json'),JSON.stringify(manifest,null,2));
  if (registry !== null) { mkdirSync(join(repo,'.agents'),{recursive:true}); writeFileSync(join(repo,'.agents','known-good-paths.json'),JSON.stringify(registry,null,2)); }
  git(repo,['add','.']); git(repo,['commit','-m','selftest fixture']); git(repo,['branch','-M','fixture-main']); return repo;
}
function withRepo(repo, action) {
  process.chdir(repo);
  try { return action(); } finally { process.chdir(originalCwd); }
}
function observeRepo(repo) { return withRepo(repo, () => classifier.observeLiveProjectContext()); }
function withAuthority(obs, action) {
  const prior=[process.env.AI_ACTIVE_TASK_REPOSITORY,process.env.AI_ACTIVE_PROJECT_CONTEXT_ID,process.env.AI_ACTIVE_PROJECT_CONTEXT_FINGERPRINT];
  process.env.AI_ACTIVE_TASK_REPOSITORY=obs.actualRepository;
  process.env.AI_ACTIVE_PROJECT_CONTEXT_ID=obs.projectContextId;
  process.env.AI_ACTIVE_PROJECT_CONTEXT_FINGERPRINT=obs.contextFingerprint;
  try { return action(); } finally {
    const keys=['AI_ACTIVE_TASK_REPOSITORY','AI_ACTIVE_PROJECT_CONTEXT_ID','AI_ACTIVE_PROJECT_CONTEXT_FINGERPRINT'];
    keys.forEach((k,i)=> prior[i] === undefined ? delete process.env[k] : process.env[k]=prior[i]);
  }
}
function guardFor(obs, overrides={}) { return projectGuard({ expectedRepository:obs.actualRepository, expectedProjectIdentifier:obs.projectContextId, expectedContextFingerprint:obs.contextFingerprint, ...overrides }); }
const fast = expectDecision(fixture(), 'FAST_PATH', 'ALL_FAST_PATH_CONDITIONS_MET');
assert(fast.evidenceValid === true, 'fast evidence should be valid');
assert(fast.requiredChecks.includes('SECURITY_PREFLIGHT'), 'fast path must retain security preflight');
assert(fast.requiredChecks.includes('TARGETED_TESTS'), 'fast path must retain targeted tests');
assert(fast.requiredChecks.includes('GIT_DIFF_CHECK'), 'fast path must retain diff check');
assert(fast.requiredChecks.includes('MERGE_AUTHORIZATION_IF_MERGING'), 'merge authorization must remain');
assert(fast.skippedChecks.includes('FULL_SELFTEST_SUITE_HEAVY_FLOW_ONLY'), 'fast path should skip only heavy-flow-only full suite');
assert(!fast.skippedChecks.includes('FULL_SELFTEST_SUITE'), 'generic full-suite requirement must not be waived');
assert(fast.skippedChecks.includes('OPERATION_PREFLIGHT_MULTI_STEP_ONLY'), 'fast path should skip only multi-step-only operation preflight');
assert(!fast.skippedChecks.includes('OSS_PRIOR_ART_SCAN'), 'OSS review must retain its own trigger');
assert(!fast.skippedChecks.includes('INDEPENDENT_REVIEW'), 'independent review must retain its own trigger');
assert(!fast.skippedChecks.includes('HISTORICAL_GIT_AUDIT'), 'history audit must retain its own trigger');

const foreignRepository = live.actualRepository === '311experience-gisikoubou/digital-work-order'
  ? '311experience-gisikoubou/dental-delivery-billing'
  : '311experience-gisikoubou/digital-work-order';
const foreignProjectId = foreignRepository.endsWith('/digital-work-order') ? 'digital-work-order-v1' : 'dental-delivery-billing-v1';
const substituted = projectGuard({ expectedRepository:foreignRepository, expectedProjectIdentifier:foreignProjectId, expectedContextFingerprint:'b'.repeat(64) });
assert(classifier.validateProjectGuard(substituted) === 'PROJECT_GUARD_EXPECTED_AUTHORITY_MISMATCH', 'caller cannot substitute the expected active project identity');

const foreignRepo = makeRepo(foreignRepository, foreignProjectId);
try {
  const wrongExpected = projectGuard();
  assert(withRepo(foreignRepo, () => classifier.validateProjectGuard(wrongExpected)) === 'EXPECTED_REPOSITORY_MISMATCH', 'expected active project / actual different repository must stop');
} finally { rmSync(foreignRepo, { recursive:true, force:true }); }

const dwoAuthorityRepo = makeRepo('311experience-gisikoubou/digital-work-order', 'digital-work-order-v1');
const ddbRepo = makeRepo('311experience-gisikoubou/dental-delivery-billing', 'dental-delivery-billing-v1');
try {
  const dwoObs=observeRepo(dwoAuthorityRepo); assert(dwoObs.result==='PROCEED','DWO authority observation required');
  for (const operationType of ['write','real-device']) {
    const dwoGuard=guardFor(dwoObs,{operationType});
    const result=withAuthority(dwoObs,()=>withRepo(ddbRepo,()=>classifier.validateProjectGuard(dwoGuard)));
    assert(result === 'EXPECTED_REPOSITORY_MISMATCH', 'DWO project must stop DDB ' + operationType);
  }
} finally { rmSync(dwoAuthorityRepo,{recursive:true,force:true}); rmSync(ddbRepo,{recursive:true,force:true}); }

const readOnlyGuard = projectGuard({ operationType:'read-only-reference', referenceRepository:foreignRepository });
assert(classifier.validateProjectGuard(readOnlyGuard) === null, 'cross-repository read-only reference should pass direct Project Guard');
assert(classifier.loadKnownGoodRoutes === undefined, 'committed route loader must not be public override surface');

const probeName = process.platform === 'win32' ? 'node.exe' : 'node';
const probeMarker = 'project-guard-live-selftest-' + process.pid;
const liveRequirement = (kind,subject) => ({ kind, subject, processName:probeName, commandContains:[probeMarker] });
const routeRegistry = { schemaVersion:1, routes:[
  { id:'quick-tunnel', operationType:'real-device', status:'known-good', runtimeRequirements:[liveRequirement('preview-server','dwo-preview'),liveRequirement('tunnel','dwo-tunnel'),liveRequirement('device-session','ipad-session')] },
  { id:'lan-direct', operationType:'real-device', status:'known-failed', runtimeRequirements:[liveRequirement('device-session','ipad-session')] },
  { id:'alternate-tunnel', operationType:'real-device', status:'candidate', runtimeRequirements:[liveRequirement('device-session','ipad-session')] },
  { id:'fresh-process', operationType:'write', status:'candidate', runtimeRequirements:[liveRequirement('process','preview-process')] },
] };
function bindingMarker(obs) {
  return 'ai-bind-' + createHash('sha256').update(obs.actualRepository + '\n' + obs.contextFingerprint).digest('hex');
}
function startProbe(binding, marker=probeMarker, extraBindings=[]) {
  return spawn(process.execPath,['-e','setInterval(()=>{},1000)','--',binding,marker,...extraBindings],{stdio:'ignore',windowsHide:true});
}
function stopProbe(child) { try { child.kill(); } catch {} }
if (process.platform === 'win32') {
  const routedRepo=makeRepo(live.actualRepository,live.projectContextId,routeRegistry);
  let wrongProbe=null, goodProbe=null; const shadowDir=mkdtempSync(join(tmpdir(),'project-guard-shadow-')); const oldPath=process.env.PATH;
  try {
    const routedObs=observeRepo(routedRepo); assert(routedObs.result==='PROCEED','routed repo observation required');
    const knownGood=guardFor(routedObs,{operationType:'real-device',route:{selection:'known-good',selectedPathId:'quick-tunnel',alternateReasonCode:null,alternateReason:null}});
    wrongProbe=startProbe('ai-bind-'+'b'.repeat(64)); const wrongResult=withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(knownGood)));
    assert(wrongResult==='RUNTIME_STATE_NOT_READY','same-name process with another repository/context binding must not authorize route; got '+wrongResult); stopProbe(wrongProbe); wrongProbe=null;
    goodProbe=startProbe(bindingMarker(routedObs));
    copyFileSync(process.env.ComSpec || 'C:/Windows/System32/cmd.exe',join(shadowDir,'powershell.exe')); process.env.PATH=shadowDir+';'+oldPath;
    const oldPsModulePath=process.env.PSModulePath; const shadowModuleDir=join(shadowDir,'CimCmdlets'); const shadowSentinel=join(shadowDir,'shadow-module-loaded.txt'); mkdirSync(shadowModuleDir,{recursive:true}); writeFileSync(join(shadowModuleDir,'CimCmdlets.psm1'),`[IO.File]::WriteAllText('${shadowSentinel.replace(/'/g,"''")}', 'loaded')\nfunction Get-CimInstance { throw 'shadow module must never load' }`); process.env.PSModulePath=shadowDir;
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(knownGood)))===null,'system PowerShell/module boundary and exact project-bound process must pass despite PATH/PSModulePath shadow');
    assert(!existsSync(shadowSentinel),'PSModulePath shadow module must never execute');
    oldPsModulePath===undefined ? delete process.env.PSModulePath : process.env.PSModulePath=oldPsModulePath;
    stopProbe(goodProbe); goodProbe=startProbe(bindingMarker(routedObs),probeMarker,['ai-bind-'+'b'.repeat(64)]);
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(knownGood)))==='RUNTIME_STATE_NOT_READY','duplicate conflicting project binding markers must fail closed');
    stopProbe(goodProbe); goodProbe=startProbe(bindingMarker(routedObs));
    const bypass=guardFor(routedObs,{operationType:'real-device',route:{selection:'new',selectedPathId:'lan-direct',alternateReasonCode:null,alternateReason:null}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(bypass)))==='KNOWN_FAILED_ROUTE_BLOCKED','known-failed route must stay blocked by default');
    const alternate=guardFor(routedObs,{operationType:'real-device',route:{selection:'alternate',selectedPathId:'alternate-tunnel',alternateReasonCode:'purpose-mismatch',alternateReason:'Known-good route cannot exercise the required isolated LAN boundary.'}});
    const alternateResult=withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(alternate)));
    assert(alternateResult===null,'committed alternate with reason should pass; got '+alternateResult);
    const failedUnderTest=guardFor(routedObs,{operationType:'real-device',route:{selection:'known-failed-under-test',selectedPathId:'lan-direct',alternateReasonCode:'route-under-test',alternateReason:'LAN-direct itself is the explicit behavior under test.'}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(failedUnderTest)))===null,'known-failed route may run only when that route itself is under test');
    const underTestWrongRoute=guardFor(routedObs,{operationType:'real-device',route:{selection:'known-failed-under-test',selectedPathId:'quick-tunnel',alternateReasonCode:'route-under-test',alternateReason:'This is not actually the known-failed route.'}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(underTestWrongRoute)))==='KNOWN_FAILED_ROUTE_UNDER_TEST_INVALID','known-failed-under-test must target an actual known-failed route');
    const underTestNoReason=guardFor(routedObs,{operationType:'real-device',route:{selection:'known-failed-under-test',selectedPathId:'lan-direct',alternateReasonCode:null,alternateReason:null}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(underTestNoReason)))==='KNOWN_FAILED_ROUTE_UNDER_TEST_INVALID','known-failed-under-test without reason code/text must fail closed');
    const underTestWrongReason=guardFor(routedObs,{operationType:'real-device',route:{selection:'known-failed-under-test',selectedPathId:'lan-direct',alternateReasonCode:'purpose-mismatch',alternateReason:'LAN-direct is intentionally selected for this isolated test.'}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(underTestWrongReason)))==='KNOWN_FAILED_ROUTE_UNDER_TEST_INVALID','known-failed-under-test must require route-under-test reason code');
    const unregisteredRoute=guardFor(routedObs,{operationType:'real-device',route:{selection:'new',selectedPathId:'never-committed-route',alternateReasonCode:null,alternateReason:null}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(unregisteredRoute)))==='UNRECORDED_ROUTE_SELECTION','a route id absent from the committed registry must not authorize work');
    const processGuard=guardFor(routedObs,{operationType:'write',route:{selection:'new',selectedPathId:'fresh-process',alternateReasonCode:null,alternateReason:null}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(processGuard)))===null,'fresh project-bound process probe should pass');
    const unregisteredProcessRoute=guardFor(routedObs,{operationType:'write',route:{selection:'new',selectedPathId:'never-committed-route',alternateReasonCode:null,alternateReason:null}});
    assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(unregisteredProcessRoute)))==='UNRECORDED_ROUTE_SELECTION','a route id absent from the committed registry must not authorize work even with only candidates present');
    const injected={...knownGood,runtimeEvidence:[{kind:'tunnel',subject:'dwo-tunnel',state:'running'}]}; assert(withAuthority(routedObs,()=>withRepo(routedRepo,()=>classifier.validateProjectGuard(injected)))==='PROJECT_GUARD_INVALID','caller runtime assertions must not be accepted');
  } finally { process.env.PATH=oldPath; stopProbe(wrongProbe); stopProbe(goodProbe); rmSync(shadowDir,{recursive:true,force:true}); rmSync(routedRepo,{recursive:true,force:true}); }
  const stoppedRegistry={schemaVersion:1,routes:[{id:'stopped-tunnel',operationType:'write',status:'candidate',runtimeRequirements:[{kind:'tunnel',subject:'stopped-tunnel',processName:probeName,commandContains:['definitely-not-running-project-guard-marker']}]}]};
  const stoppedRepo=makeRepo(live.actualRepository,live.projectContextId,stoppedRegistry);
  try { const obs=observeRepo(stoppedRepo); const guard=guardFor(obs,{operationType:'write',route:{selection:'new',selectedPathId:'stopped-tunnel',alternateReasonCode:null,alternateReason:null}}); assert(withAuthority(obs,()=>withRepo(stoppedRepo,()=>classifier.validateProjectGuard(guard)))==='RUNTIME_STATE_NOT_READY','stopped/old tunnel state must not be reused'); }
  finally { rmSync(stoppedRepo,{recursive:true,force:true}); }
}
const originDriftRepo=makeRepo(live.actualRepository,live.projectContextId);
try { const obs=observeRepo(originDriftRepo); git(originDriftRepo,['remote','set-url','origin','https://github.com/' + foreignRepository + '.git']); const guard=guardFor(obs); assert(withAuthority(obs,()=>withRepo(originDriftRepo,()=>classifier.validateProjectGuard(guard)))==='PROJECT_CONTEXT_REPOSITORY_DRIFT','origin drift must stop Project Guard'); }
finally { rmSync(originDriftRepo,{recursive:true,force:true}); }
const noRegistryRepo=makeRepo(live.actualRepository,live.projectContextId);
try { const obs=observeRepo(noRegistryRepo); const real=guardFor(obs,{operationType:'real-device'}); assert(withAuthority(obs,()=>withRepo(noRegistryRepo,()=>classifier.validateProjectGuard(real)))==='KNOWN_GOOD_REGISTRY_REQUIRED_FOR_REAL_DEVICE','REAL_DEVICE requires committed registry'); mkdirSync(join(noRegistryRepo,'.agents'),{recursive:true}); writeFileSync(join(noRegistryRepo,'.agents','known-good-paths.json'),JSON.stringify(routeRegistry)); assert(withAuthority(obs,()=>withRepo(noRegistryRepo,()=>classifier.validateProjectGuard(real)))==='KNOWN_GOOD_REGISTRY_REQUIRED_FOR_REAL_DEVICE','uncommitted registry cannot authorize REAL_DEVICE'); }
finally { rmSync(noRegistryRepo,{recursive:true,force:true}); }
const badRegistryRepo=makeRepo(live.actualRepository,live.projectContextId,{schemaVersion:1,routes:[{id:'bad-device',operationType:'real-device',status:'candidate',runtimeRequirements:[]}]});
try { const obs=observeRepo(badRegistryRepo); const bad=guardFor(obs,{operationType:'real-device',route:{selection:'new',selectedPathId:'bad-device',alternateReasonCode:null,alternateReason:null}}); assert(withAuthority(obs,()=>withRepo(badRegistryRepo,()=>classifier.validateProjectGuard(bad)))==='KNOWN_GOOD_REGISTRY_REAL_DEVICE_RUNTIME_REQUIRED','REAL_DEVICE route requires live runtime probe'); }
finally { rmSync(badRegistryRepo,{recursive:true,force:true}); }

const readOnlyChange = fixture({ projectGuard:readOnlyGuard });
let guardBlocked = expectDecision(readOnlyChange, 'FULL_GATE', 'READ_ONLY_REFERENCE_NOT_CHANGE_AUTHORITY');
assert(guardBlocked.workStartAllowed === false, 'read-only reference cannot authorize implementation work');
const noProjectGuard = fixture(); delete noProjectGuard.projectGuard;
guardBlocked = expectDecision(noProjectGuard, 'FULL_GATE', 'PROJECT_GUARD_REQUIRED');
assert(guardBlocked.workStartAllowed === false, 'missing Project Guard evidence must block work start');
const noRegistryChange = fixture();
for (let i = 0; i < 3; i++) {
  const repeated = expectDecision(noRegistryChange, 'FAST_PATH', 'ALL_FAST_PATH_CONDITIONS_MET');
  assert(repeated.workStartAllowed === true, 'repeated no-registry route selection=not-applicable must not falsely block, run ' + i);
}

expectDecision(fixture({ changeClass: 'implementation' }), 'FAST_PATH');
expectDecision(fixture({ changeClass: 'configuration' }), 'FAST_PATH');
expectDecision(fixture({ dataMode: 'synthetic' }), 'FAST_PATH');
expectDecision(fixture({ dataMode: 'public' }), 'FAST_PATH');
expectDecision(fixture({ evidenceComplete: false }), 'FULL_GATE', 'EVIDENCE_INCOMPLETE');
expectDecision(fixture({ changeClass: 'architecture' }), 'FULL_GATE', 'CHANGE_CLASS_REQUIRES_FULL_GATE');
expectDecision(fixture({ dataMode: 'real' }), 'FULL_GATE', 'DATA_MODE_REQUIRES_FULL_GATE');
expectDecision(fixture({ executionScope: 'network' }), 'FULL_GATE', 'EXECUTION_SCOPE_REQUIRES_FULL_GATE');
const impactReasons = {
  production: 'PRODUCTION_IMPACT', network: 'NETWORK_IMPACT', realDevice: 'REAL_DEVICE_IMPACT',
  installOrAdoption: 'INSTALL_OR_ADOPTION_IMPACT', dependency: 'DEPENDENCY_IMPACT',
  securitySensitive: 'SECURITY_SENSITIVE_IMPACT', authOrCredential: 'AUTH_OR_CREDENTIAL_IMPACT',
  mergeAuthority: 'MERGE_AUTHORITY_IMPACT', workflowOrDeployment: 'WORKFLOW_OR_DEPLOYMENT_IMPACT',
  databaseOrMigration: 'DATABASE_OR_MIGRATION_IMPACT', externalDataRoute: 'EXTERNAL_DATA_ROUTE_IMPACT',
  recurringCost: 'RECURRING_COST_IMPACT', lifecycle: 'LIFECYCLE_IMPACT',
  businessPolicy: 'BUSINESS_POLICY_IMPACT', architecture: 'ARCHITECTURE_IMPACT',
};
for (const key of impactKeys) {
  expectDecision(fixture({ impacts: impacts({ [key]: true }) }), 'FULL_GATE', impactReasons[key]);
}

const sensitivePaths = [
  ['src/auth/login.ts', 'SENSITIVE_PATH_SECURITY'],
  ['src/authentication/login.ts', 'SENSITIVE_PATH_SECURITY'],
  ['src/authorization/policy.ts', 'SENSITIVE_PATH_SECURITY'],
  ['src/security.ts', 'SENSITIVE_PATH_SECURITY'],
  ['src/db/query.ts', 'SENSITIVE_PATH_DATABASE'],
  ['src/db.ts', 'SENSITIVE_PATH_DATABASE'],
  ['.github/workflows/test.yml', 'SENSITIVE_PATH_WORKFLOW'],
  ['.gitlab-ci.yml', 'SENSITIVE_PATH_WORKFLOW'],
  ['deploy.yml', 'SENSITIVE_PATH_WORKFLOW'],
  ['Dockerfile.prod', 'SENSITIVE_PATH_WORKFLOW'],
  ['compose.yaml', 'SENSITIVE_PATH_WORKFLOW'],
  ['.agents/skills/final-pr-audit/gate.mjs', 'SENSITIVE_PATH_MERGE_GATE'],
  ['.agents/skills/preflight-audit/fast-path-classifier.mjs', 'SENSITIVE_PATH_GOVERNANCE_GATE'],
  ['.agents/skills/preflight-audit/SKILL.md', 'SENSITIVE_PATH_GOVERNANCE_GATE'],
  ['.agents/skills/preflight-audit/nested/gate.mjs', 'SENSITIVE_PATH_GOVERNANCE_GATE'],
  ['package-lock.json', 'SENSITIVE_PATH_DEPENDENCY'],
  ['bun.lock', 'SENSITIVE_PATH_DEPENDENCY'],
  ['Pipfile.lock', 'SENSITIVE_PATH_DEPENDENCY'],
  ['src/App.csproj', 'SENSITIVE_PATH_DEPENDENCY'],
  ['setup.py', 'SENSITIVE_PATH_DEPENDENCY'],
  ['pubspec.yaml', 'SENSITIVE_PATH_DEPENDENCY'],
];
for (const [path, reason] of sensitivePaths) {
  expectDecision(fixture({ changedFiles: [path] }), 'FULL_GATE', reason);
}

const invalidMissingImpact = fixture();
delete invalidMissingImpact.impacts.network;
let invalid = expectDecision(invalidMissingImpact, 'FULL_GATE', 'IMPACTS_INCOMPLETE');
assert(invalid.evidenceValid === false, 'missing impact must invalidate evidence');
invalid = expectDecision({ ...fixture(), unexpected: true }, 'FULL_GATE', 'EVIDENCE_UNKNOWN_FIELD');
assert(invalid.evidenceValid === false, 'unknown top field must invalidate evidence');
invalid = expectDecision(fixture({ impacts: { ...impacts(), unexpected: false } }), 'FULL_GATE', 'IMPACTS_UNKNOWN_FIELD');
assert(invalid.evidenceValid === false, 'unknown impact field must invalidate evidence');
invalid = expectDecision(fixture({ changedFiles: ['src/a.ts', 'src/a.ts'] }), 'FULL_GATE', 'CHANGED_FILES_DUPLICATE');
assert(invalid.evidenceValid === false, 'duplicate files must invalidate evidence');
invalid = expectDecision(fixture({ changedFiles: ['../outside.ts'] }), 'FULL_GATE', 'CHANGED_FILE_PATH_INVALID');
assert(invalid.evidenceValid === false, 'parent traversal must invalidate evidence');
invalid = expectDecision(fixture({ changedFiles: [] }), 'FULL_GATE', 'CHANGED_FILES_INVALID');
assert(invalid.evidenceValid === false, 'empty changed files must invalidate evidence');
const noWip = fixture(); delete noWip.wipReview;
invalid = expectDecision(noWip, 'FULL_GATE', 'WIP_REVIEW_REQUIRED');
assert(invalid.workStartAllowed === false, 'missing WIP review must block work start');
invalid = expectDecision(fixture({ wipReview: { decision: 'STOP_NEW_WORK', evidenceFetchedAt: new Date(Date.now() - 1000).toISOString() } }), 'FULL_GATE', 'WIP_REVIEW_BLOCKED');
invalid = expectDecision(fixture({ wipReview: { decision: 'CONTINUE', evidenceFetchedAt: new Date(Date.now() - classifier.WIP_REVIEW_MAX_AGE_MS - 1000).toISOString() } }), 'FULL_GATE', 'WIP_REVIEW_STALE');
invalid = expectDecision(fixture({ wipReview: { decision: 'CONTINUE', evidenceFetchedAt: new Date(Date.now() + 10000).toISOString() } }), 'FULL_GATE', 'WIP_REVIEW_FROM_FUTURE');

const manyNormalFiles = Array.from({ length: 250 }, (_, i) => `src/ui/file-${i}.ts`);
expectDecision(fixture({ changedFiles: manyNormalFiles }), 'FAST_PATH');
invalid = expectDecision(fixture({ changedFiles: ['./src/a.ts'] }), 'FULL_GATE', 'CHANGED_FILE_PATH_INVALID');
assert(invalid.evidenceValid === false, 'non-canonical dot path must invalidate evidence');

const parsedBom = classifier.parseInput(`\uFEFF${JSON.stringify(fixture())}`);
assert(parsedBom.value?.schemaVersion === 3, 'BOM JSON should parse');
assert(classifier.parseInput('{bad').error === 'INPUT_JSON_INVALID', 'malformed JSON must fail closed');
assert(classifier.parseInput('x'.repeat(classifier.MAX_INPUT_BYTES + 1)).error === 'INPUT_TOO_LARGE', 'oversized input must fail closed');
function runCli(payload) {
  return spawnSync(process.execPath, [classifierPath], {
    encoding: 'utf8', input: payload, maxBuffer: 1024 * 1024,
  });
}

let cli = runCli(JSON.stringify(fixture()));
assert(cli.status === 0, `fast CLI should exit 0: ${cli.stdout} ${cli.stderr}`);
assert(cli.stderr.includes('FAST_PATH_CLASSIFIER=FAST_PATH'), 'fast CLI status line missing');
assert(JSON.parse(cli.stdout).decision === 'FAST_PATH', 'fast CLI JSON mismatch');

cli = runCli(JSON.stringify(fixture({ changedFiles: ['src/security/policy.ts'] })));
assert(cli.status === 0, `valid full-gate CLI should exit 0: ${cli.stderr}`);
assert(cli.stderr.includes('FAST_PATH_CLASSIFIER=FULL_GATE'), 'full CLI status line missing');
assert(JSON.parse(cli.stdout).decision === 'FULL_GATE', 'full CLI JSON mismatch');

cli = spawnSync(process.execPath, [classifierPath, '--unknown'], { encoding: 'utf8', input: JSON.stringify(fixture()), maxBuffer: 1024 * 1024 });
assert(cli.status === 2, 'unknown CLI option must fail closed');
assert(JSON.parse(cli.stdout).reasons[0] === 'CLI_ARGUMENT_INVALID', 'unknown CLI reason mismatch');

cli = spawnSync(process.execPath, [classifierPath, 'positional'], { encoding: 'utf8', input: JSON.stringify(fixture()), maxBuffer: 1024 * 1024 });
assert(cli.status === 2, 'positional CLI arg must fail closed');

cli = runCli('{bad');
assert(cli.status === 2, 'invalid CLI evidence must exit 2');
assert(cli.stderr.includes('FAST_PATH_CLASSIFIER=FULL_GATE'), 'invalid CLI must identify full gate');
const invalidCliReport = JSON.parse(cli.stdout);
assert(invalidCliReport.evidenceValid === false, 'invalid CLI evidenceValid mismatch');
assert(invalidCliReport.reasons[0] === 'INPUT_JSON_INVALID', 'invalid CLI reason mismatch');

console.log('fast-path-classifier selftest: PASS');
