#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { observeProjectContextEvidence, parseJsonStrict } from './project-context-guard.mjs';

const SCHEMA_VERSION = 1;
const MEMORY_RELATIVE = '.ai/working/project-memory.json';
const EXCLUDE_LINE = '/.ai/working/';
const CLASSIFICATIONS = new Set(['VERIFIED','UNVERIFIED','INFERENCE','NEWLY_CREATED']);
const LOCATOR_KINDS = new Set(['REPO_PATH','EXTERNAL_REF','NONE']);
const DECISION_STATES = new Set(['CONFIRMED','UNRESOLVED']);
const GOAL_SOURCES = new Set(['EXPLICIT_HUMAN','CANONICAL_PROJECT']);
const BASIS = new Set(['FILE_EXISTS','UI_OBSERVED','CODE_OBSERVED','EXPLICIT_HUMAN','OTHER']);

function result(ok, code, detail = {}) { return { ok, code, ...detail }; }
function cleanText(value, max = 2000) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}
function cleanId(value) {
  const text = cleanText(value, 100);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text) ? text : null;
}
function closedObject(input, allowed) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => allowed.has(key));
}
function git(root, args, { allowFailure = false } = {}) {
  const out = spawnSync('git', ['-C', root, ...args], { encoding:'utf8', windowsHide:true, maxBuffer:1024 * 1024 });
  if (!allowFailure && (out.error || out.status !== 0)) throw new Error('GIT_EVIDENCE_FAILED');
  return out;
}
function repoRelativePath(value) {
  const text = cleanText(value, 1000);
  if (!text || isAbsolute(text)) return null;
  const normalized = normalize(text).replaceAll('\\','/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized.replace(/^\.\//,'');
}
async function exists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}
function memoryPath(root) { return join(root, '.ai', 'working', 'project-memory.json'); }
function emptyState(evidence, now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectContextId: evidence.projectContextId,
    contextFingerprint: evidence.contextFingerprint,
    repository: evidence.actualRepository,
    currentFocus: null,
    focusHistory: [],
    references: [],
    decisions: [],
    createdAt: now,
    updatedAt: now,
  };
}
function validateState(state, evidence) {
  if (!closedObject(state, new Set(['schemaVersion','projectContextId','contextFingerprint','repository','currentFocus','focusHistory','references','decisions','createdAt','updatedAt']))) return result(false,'WORKING_MEMORY_SCHEMA_INVALID');
  if (state.schemaVersion !== SCHEMA_VERSION) return result(false,'WORKING_MEMORY_SCHEMA_INVALID');
  if (state.projectContextId !== evidence.projectContextId || state.contextFingerprint !== evidence.contextFingerprint || state.repository !== evidence.actualRepository) {
    return result(false,'WORKING_MEMORY_PROJECT_DRIFT',{
      expectedProjectContextId:evidence.projectContextId,
      actualProjectContextId:state.projectContextId ?? null,
      expectedRepository:evidence.actualRepository,
      actualRepository:state.repository ?? null,
    });
  }
  if (!Array.isArray(state.focusHistory) || !Array.isArray(state.references) || !Array.isArray(state.decisions)) return result(false,'WORKING_MEMORY_SCHEMA_INVALID');
  return result(true,'WORKING_MEMORY_ALIGNED');
}
async function ensureLocalExclude(root) {
  const tracked = git(root, ['ls-files','--error-unmatch',MEMORY_RELATIVE], { allowFailure:true });
  if (tracked.status === 0) return result(false,'WORKING_MEMORY_MUST_NOT_BE_TRACKED');
  const gitPath = git(root, ['rev-parse','--git-path','info/exclude']).stdout.trim();
  if (!gitPath) return result(false,'WORKING_MEMORY_EXCLUDE_PATH_UNAVAILABLE');
  const excludePath = isAbsolute(gitPath) ? resolve(gitPath) : resolve(root, gitPath);
  await mkdir(dirname(excludePath), { recursive:true });
  let text = '';
  try { text = await readFile(excludePath,'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const lines = text.split(/\r?\n/);
  if (!lines.includes(EXCLUDE_LINE)) {
    const prefix = text && !text.endsWith('\n') ? text + '\n' : text;
    await writeFile(excludePath, prefix + EXCLUDE_LINE + '\n', 'utf8');
  }
  const ignored = git(root, ['check-ignore','-q',MEMORY_RELATIVE], { allowFailure:true });
  if (ignored.status !== 0) return result(false,'WORKING_MEMORY_EXCLUDE_NOT_EFFECTIVE');
  return result(true,'WORKING_MEMORY_GIT_EXCLUDED',{ excludePath });
}
async function observe(root, contextFile) {
  const top = resolve(git(root,['rev-parse','--show-toplevel']).stdout.trim());
  if (top.toLowerCase() !== resolve(root).toLowerCase()) return result(false,'WORKING_MEMORY_ROOT_INVALID');
  const evidence = observeProjectContextEvidence(contextFile);
  if (evidence?.result !== 'PROCEED') return result(false,'WORKING_MEMORY_CONTEXT_UNVERIFIED',{ contextCode:evidence?.code ?? null });
  return result(true,'WORKING_MEMORY_CONTEXT_ALIGNED',{ evidence });
}
async function loadMemory(root, evidence, { create = false, now = new Date().toISOString() } = {}) {
  const path = memoryPath(root);
  const present = await exists(path);
  if (!present) {
    if (!create) return result(false,'WORKING_MEMORY_MISSING',{ path });
    const excluded = await ensureLocalExclude(root);
    if (!excluded.ok) return excluded;
    await mkdir(dirname(path), { recursive:true });
    const state = emptyState(evidence, now);
    await writeFile(path, JSON.stringify(state,null,2) + '\n','utf8');
    return result(true,'WORKING_MEMORY_CREATED',{ path, state });
  }
  const excluded = await ensureLocalExclude(root);
  if (!excluded.ok) return excluded;
  let parsed;
  try { parsed = parseJsonStrict(await readFile(path,'utf8')); } catch { return result(false,'WORKING_MEMORY_INVALID_JSON',{ path }); }
  const valid = validateState(parsed,evidence);
  if (!valid.ok) return valid;
  return result(true,'WORKING_MEMORY_LOADED',{ path, state:parsed });
}
async function saveMemory(path, state, now) {
  const next = { ...state, updatedAt:now };
  await writeFile(path, JSON.stringify(next,null,2) + '\n','utf8');
  return next;
}
function normalizeReference(input) {
  const allowed = new Set(['id','label','classification','locatorKind','locator','verificationBasis','creationReason','supersedes']);
  if (!closedObject(input,allowed)) return result(false,'REFERENCE_SCHEMA_INVALID');
  const id = cleanId(input.id), label = cleanText(input.label,300);
  const classification = CLASSIFICATIONS.has(input.classification) ? input.classification : null;
  const locatorKind = LOCATOR_KINDS.has(input.locatorKind) ? input.locatorKind : null;
  const verificationBasis = BASIS.has(input.verificationBasis) ? input.verificationBasis : null;
  const creationReason = input.creationReason == null ? null : cleanText(input.creationReason,1000);
  const supersedes = input.supersedes == null ? null : cleanId(input.supersedes);
  let locator = input.locator == null ? null : cleanText(input.locator,1000);
  if (!id || !label || !classification || !locatorKind) return result(false,'REFERENCE_FIELDS_INVALID');
  if (locatorKind === 'REPO_PATH') locator = repoRelativePath(locator);
  if (locatorKind === 'NONE') locator = null;
  if (classification === 'VERIFIED' && (!locator || locatorKind === 'NONE' || !verificationBasis)) return result(false,'VERIFIED_REFERENCE_EVIDENCE_REQUIRED');
  if (classification === 'NEWLY_CREATED' && (!locator || locatorKind === 'NONE' || !creationReason)) return result(false,'NEW_REFERENCE_REASON_REQUIRED');
  if (classification === 'INFERENCE' && !verificationBasis) return result(false,'INFERENCE_BASIS_REQUIRED');
  return result(true,'REFERENCE_VALID',{ value:{ id,label,classification,locatorKind,locator,verificationBasis,creationReason,supersedes } });
}
function normalizeDecision(input) {
  const allowed = new Set(['id','state','summary','source','referenceIds','supersedes']);
  if (!closedObject(input,allowed)) return result(false,'DECISION_SCHEMA_INVALID');
  const id=cleanId(input.id), state=DECISION_STATES.has(input.state)?input.state:null, summary=cleanText(input.summary,1500);
  if (!id || !state || !summary || input.source !== 'EXPLICIT_HUMAN') return result(false,'DECISION_FIELDS_INVALID');
  if (!Array.isArray(input.referenceIds) || input.referenceIds.some(x=>!cleanId(x))) return result(false,'DECISION_REFERENCE_IDS_INVALID');
  const supersedes=input.supersedes==null?null:cleanId(input.supersedes);
  if (input.supersedes != null && !supersedes) return result(false,'DECISION_SUPERSEDES_INVALID');
  return result(true,'DECISION_VALID',{ value:{id,state,summary,source:'EXPLICIT_HUMAN',referenceIds:[...new Set(input.referenceIds)],supersedes} });
}
function currentDecision(state,id) {
  const item = state.decisions.find(d=>d.id===id);
  if (!item) return null;
  if (state.decisions.some(d=>d.supersedes===id)) return null;
  return item;
}
async function referenceAvailability(root, ref) {
  if (!ref) return { usable:false, reason:'REFERENCE_MISSING' };
  if (['UNVERIFIED','INFERENCE'].includes(ref.classification)) return { usable:false, reason:'REFERENCE_NOT_VERIFIED' };
  if (ref.locatorKind === 'REPO_PATH') {
    const path=resolve(root,ref.locator);
    const rel=relative(root,path).replaceAll('\\','/');
    if (rel.startsWith('../') || isAbsolute(rel)) return { usable:false, reason:'REFERENCE_PATH_OUTSIDE_REPO' };
    if (!await exists(path)) return { usable:false, reason:'REFERENCE_FILE_MISSING' };
  }
  return { usable:true, reason:null };
}
export async function evaluateArtifactRecall({ root, state, referenceIds, recreate = false, recreationReason = null }) {
  if (!Array.isArray(referenceIds) || referenceIds.length===0 || referenceIds.some(x=>!cleanId(x))) return result(false,'ARTIFACT_RECALL_REQUEST_INVALID');
  const requested=[]; const unresolved=[];
  for(const id of referenceIds){
    const ref=state.references.find(r=>r.id===id) ?? null;
    const availability=await referenceAvailability(root,ref);
    requested.push({ id, reference:ref, availability });
    if(!availability.usable) unresolved.push({ id, reason:availability.reason, classification:ref?.classification ?? null });
  }
  if(unresolved.length===0) return result(true,'PAST_ARTIFACTS_VERIFIED',{ action:'USE_EXISTING', requested });
  if(!recreate) return result(false,'PAST_ARTIFACTS_UNVERIFIED',{ action:'REPORT_MISSING', unresolved, requested });
  const reason=cleanText(recreationReason,1000);
  if(!reason) return result(false,'RECREATION_REASON_REQUIRED',{ unresolved });
  return result(true,'PAST_ARTIFACT_RECREATION_ALLOWED',{
    action:'RECREATE_AS_NEW',
    unresolved,
    recreationReason:reason,
    requiredClassification:'NEWLY_CREATED',
    requiredDisclosure:'元の実物が見つからないため、比較用として再現します',
  });
}
export function evaluateDecisionGate({ decisionClass, evidenceClassification, humanDecision = null, uncertaintyDisclosed = false }) {
  if (!['TECHNICAL','HUMAN_VALUE'].includes(decisionClass) || !CLASSIFICATIONS.has(evidenceClassification)) return result(false,'DECISION_GATE_INPUT_INVALID');
  if (decisionClass === 'TECHNICAL') {
    if (['UNVERIFIED','INFERENCE'].includes(evidenceClassification)) return result(false,'EVIDENCE_VERIFICATION_REQUIRED',{ requiredAction:'AI_VERIFY_FIRST' });
    return result(true,'TECHNICAL_DECISION_ALLOWED',{ requiredAction:'AI_CONTINUE' });
  }
  if (!humanDecision || humanDecision.state !== 'CONFIRMED' || humanDecision.source !== 'EXPLICIT_HUMAN') return result(false,'HUMAN_VALUE_DECISION_REQUIRED',{ requiredAction:'WAIT_HUMAN' });
  if (['UNVERIFIED','INFERENCE'].includes(evidenceClassification) && uncertaintyDisclosed !== true) return result(false,'UNCERTAINTY_DISCLOSURE_REQUIRED',{ requiredAction:'DISCLOSE_THEN_CONFIRM' });
  return result(true,'HUMAN_VALUE_DECISION_CONFIRMED',{ requiredAction:'AI_CONTINUE_WITHIN_DECISION' });
}
function normalizeFocus(input) {
  const allowed=new Set(['goalId','goal','goalSource','nextStep','approvedReferenceId','decisionId']);
  if(!closedObject(input,allowed)) return result(false,'FOCUS_SCHEMA_INVALID');
  const goalId=cleanId(input.goalId), goal=cleanText(input.goal,1200), nextStep=cleanText(input.nextStep,1200);
  const goalSource=GOAL_SOURCES.has(input.goalSource)?input.goalSource:null;
  const approvedReferenceId=input.approvedReferenceId==null?null:cleanId(input.approvedReferenceId);
  const decisionId=input.decisionId==null?null:cleanId(input.decisionId);
  if(!goalId||!goal||!nextStep||!goalSource) return result(false,'FOCUS_FIELDS_INVALID');
  if((input.approvedReferenceId!=null&&!approvedReferenceId)||(input.decisionId!=null&&!decisionId)) return result(false,'FOCUS_FIELDS_INVALID');
  return result(true,'FOCUS_VALID',{value:{goalId,goal,goalSource,nextStep,approvedReferenceId,decisionId}});
}
export async function evaluateFocusGate({ root, state, goalId, requireApprovedReference = false }) {
  if(!state.currentFocus) return result(false,'CURRENT_FOCUS_MISSING',{ requiredAction:'ESTABLISH_CURRENT_FOCUS' });
  if(state.currentFocus.goalId!==goalId) return result(false,'CURRENT_GOAL_MISMATCH',{ expectedGoalId:state.currentFocus.goalId, actualGoalId:goalId, requiredAction:'RESELECT_FROM_CURRENT_GOAL' });
  const focusDecisionId=state.currentFocus.decisionId;
  if(focusDecisionId&&!currentDecision(state,focusDecisionId)) return result(false,'CURRENT_FOCUS_DECISION_STALE',{ decisionId:focusDecisionId, requiredAction:'REANCHOR_FROM_LATEST_HUMAN_DECISION' });
  if(requireApprovedReference){
    const id=state.currentFocus.approvedReferenceId;
    if(!id) return result(false,'APPROVED_REFERENCE_REQUIRED',{ requiredAction:'FIND_OR_CONFIRM_REFERENCE' });
    const ref=state.references.find(r=>r.id===id);
    const available=await referenceAvailability(root,ref);
    if(!available.usable) return result(false,'APPROVED_REFERENCE_UNAVAILABLE',{ referenceId:id, reason:available.reason, requiredAction:'FIND_OR_CONFIRM_REFERENCE' });
    if(focusDecisionId){
      const dec=currentDecision(state,focusDecisionId);
      if(!dec||dec.state!=='CONFIRMED'||!dec.referenceIds.includes(id)) return result(false,'APPROVED_REFERENCE_DECISION_STALE',{ referenceId:id, decisionId:focusDecisionId, requiredAction:'REANCHOR_FROM_LATEST_HUMAN_DECISION' });
    }
  }
  return result(true,'CURRENT_FOCUS_ALIGNED',{ currentFocus:state.currentFocus });
}
function parseArgs(argv) {
  const out={ action:null, root:process.cwd(), contextFile:null, input:null, inputFile:null, pretty:false };
  for(let i=0;i<argv.length;i+=1){
    const arg=argv[i];
    if(arg==='--action'&&argv[i+1]) out.action=argv[++i];
    else if(arg==='--root'&&argv[i+1]) out.root=argv[++i];
    else if(arg==='--context-file'&&argv[i+1]) out.contextFile=argv[++i];
    else if(arg==='--input-json'&&argv[i+1]) { try{out.input=parseJsonStrict(argv[++i]);}catch{return result(false,'INPUT_JSON_INVALID');} }
    else if(arg==='--input-file'&&argv[i+1]) out.inputFile=argv[++i];
    else if(arg==='--pretty') out.pretty=true;
    else return result(false,'ARGUMENT_INVALID');
  }
  if(!out.action) return result(false,'ACTION_REQUIRED');
  if(out.input!==null && out.inputFile!==null) return result(false,'INPUT_SOURCE_CONFLICT');
  out.root=resolve(out.root);
  out.contextFile=resolve(out.contextFile ?? join(out.root,'PROJECT_CONTEXT.json'));
  if(out.inputFile!==null) out.inputFile=resolve(out.inputFile);
  return result(true,'ARGS_VALID',{value:out});
}
async function main(){
  const parsed=parseArgs(process.argv.slice(2));
  if(!parsed.ok){ console.log(JSON.stringify(parsed)); process.exitCode=2; return; }
  const {action,root,contextFile,pretty}=parsed.value;
  let input=parsed.value.input;
  if(parsed.value.inputFile!==null){
    try{ input=parseJsonStrict(await readFile(parsed.value.inputFile,'utf8')); }
    catch{ console.log(JSON.stringify(result(false,'INPUT_FILE_INVALID'),null,pretty?2:0)); process.exitCode=2; return; }
  }
  const observed=await observe(root,contextFile);
  if(!observed.ok){ console.log(JSON.stringify(observed,null,pretty?2:0)); process.exitCode=2; return; }
  const now=new Date().toISOString();
  const loaded=await loadMemory(root,observed.evidence,{create:action==='ensure',now});
  if(!loaded.ok){ console.log(JSON.stringify(loaded,null,pretty?2:0)); process.exitCode=2; return; }
  let state=loaded.state; const path=loaded.path; let out;
  if(action==='ensure') out=result(true,loaded.code,{ path, state });
  else if(action==='snapshot'){
    const last=[...state.decisions].reverse().find(d=>!state.decisions.some(n=>n.supersedes===d.id)) ?? null;
    const approvedId=state.currentFocus?.approvedReferenceId ?? null;
    out=result(true,'WORKING_MEMORY_SNAPSHOT',{
      project:{ projectContextId:state.projectContextId },
      repository:state.repository,
      currentGoal:state.currentFocus?.goal ?? null,
      currentGoalId:state.currentFocus?.goalId ?? null,
      approvedReference:approvedId ? state.references.find(r=>r.id===approvedId) ?? null : null,
      lastHumanDecision:last,
      nextStep:state.currentFocus?.nextStep ?? null,
      memoryPath:path,
    });
  } else if(action==='record-reference'){
    const n=normalizeReference(input); if(!n.ok) out=n;
    else if(state.references.some(r=>r.id===n.value.id)) out=result(false,'REFERENCE_ID_EXISTS');
    else if(n.value.supersedes && !state.references.some(r=>r.id===n.value.supersedes)) out=result(false,'REFERENCE_SUPERSEDES_NOT_FOUND');
    else {
      if(n.value.classification==='VERIFIED'&&n.value.locatorKind==='REPO_PATH'&&!await exists(resolve(root,n.value.locator))) out=result(false,'VERIFIED_REFERENCE_FILE_MISSING');
      else { state.references.push({...n.value,recordedAt:now}); state=await saveMemory(path,state,now); out=result(true,'REFERENCE_RECORDED',{reference:n.value}); }
    }
  } else if(action==='record-decision'){
    const n=normalizeDecision(input); if(!n.ok) out=n;
    else if(state.decisions.some(d=>d.id===n.value.id)) out=result(false,'DECISION_ID_EXISTS');
    else if(n.value.supersedes && !state.decisions.some(d=>d.id===n.value.supersedes)) out=result(false,'DECISION_SUPERSEDES_NOT_FOUND');
    else if(n.value.referenceIds.some(id=>!state.references.some(r=>r.id===id))) out=result(false,'DECISION_REFERENCE_NOT_FOUND');
    else { state.decisions.push({...n.value,recordedAt:now}); state=await saveMemory(path,state,now); out=result(true,'HUMAN_DECISION_RECORDED',{decision:n.value}); }
  } else if(action==='set-focus'){
    const n=normalizeFocus(input); if(!n.ok) out=n;
    else {
      const dec=n.value.decisionId?currentDecision(state,n.value.decisionId):null;
      if(n.value.decisionId&&!dec) out=result(false,'FOCUS_DECISION_NOT_CURRENT');
      else if(n.value.goalSource==='EXPLICIT_HUMAN'&&(!dec||dec.state!=='CONFIRMED')) out=result(false,'FOCUS_HUMAN_DECISION_REQUIRED');
      else if(n.value.approvedReferenceId){
        const ref=state.references.find(r=>r.id===n.value.approvedReferenceId);
        if(!ref) out=result(false,'FOCUS_REFERENCE_NOT_FOUND');
        else if(!dec.referenceIds.includes(ref.id)) out=result(false,'FOCUS_REFERENCE_NOT_HUMAN_APPROVED');
      }
      if(!out){
        const entry={...n.value,recordedAt:now};
        state.currentFocus=entry; state.focusHistory.push(entry); state=await saveMemory(path,state,now);
        out=result(true,'CURRENT_FOCUS_SET',{currentFocus:entry});
      }
    }
  } else if(action==='artifact-recall'){
    out=await evaluateArtifactRecall({root,state,referenceIds:input?.referenceIds,recreate:input?.recreate===true,recreationReason:input?.recreationReason??null});
  } else if(action==='decision-gate'){
    const humanDecision=input?.decisionId?currentDecision(state,input.decisionId):null;
    out=evaluateDecisionGate({decisionClass:input?.decisionClass,evidenceClassification:input?.evidenceClassification,humanDecision,uncertaintyDisclosed:input?.uncertaintyDisclosed===true});
  } else if(action==='focus-gate'){
    out=await evaluateFocusGate({root,state,goalId:input?.goalId,requireApprovedReference:input?.requireApprovedReference===true});
  } else out=result(false,'ACTION_INVALID');
  console.log(JSON.stringify(out,null,pretty?2:0));
  if(!out.ok) process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
