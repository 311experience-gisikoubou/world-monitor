#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizeCanonicalContract } from './canonical-contract-gate.mjs';

const STATUSES=new Set(['PROPOSED','CONFIRMED','DEPRECATED','UNRESOLVED']);
const SOURCES=new Set(['EXPLICIT_HUMAN','AI_PROPOSAL']);
const TYPES=new Set(['PROJECT','BUSINESS','DESIGN','SECURITY','WORKFLOW','GOVERNANCE']);
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/;
function isObject(v){return Boolean(v)&&typeof v==='object'&&!Array.isArray(v);}
function cleanText(v,max=2000){return typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v)?v:null;}
function cleanId(v){const s=cleanText(v,160);return s&&ID_RE.test(s)?s:null;}
function resolvedText(v,max=2000){const s=cleanText(v,max);if(!s||/^<[^>]+>$/u.test(s))return null;const key=s.replace(/[\s._:/-]+/gu,'').toUpperCase();return ['TODO','TBD','UNKNOWN','UNAVAILABLE','UNRESOLVED','NA','NOTAPPLICABLE','要補足','未確認','不明'].includes(key)?null:s;}
function exactKeys(obj,allowed){return isObject(obj)&&Object.keys(obj).every(k=>allowed.includes(k));}
function stop(code,message,detail={}){return {result:'STOP',decisionSync:'FAIL',code,message,...detail};}
function pass(detail={}){return {result:'PROCEED',decisionSync:'PASS',code:'HUMAN_DECISION_SYNC_ALIGNED',...detail};}
function uniqueIds(v,max=100){if(!Array.isArray(v)||v.length>max)return null;const out=[];for(const raw of v){const id=cleanId(raw);if(!id||out.includes(id))return null;out.push(id);}return out;}
export function requiresHumanDecisionSync(manifest){
  return Array.isArray(manifest?.canonicalContract?.requiredValidation)&&manifest.canonicalContract.requiredValidation.includes('human-decision-sync');
}
function normalizeDecision(value){
  const allowed=['id','topic','status','summary','decidedAt','source','type','replaces','artifactIds'];
  if(!exactKeys(value,allowed))return null;
  const id=cleanId(value.id),topic=cleanId(value.topic),status=STATUSES.has(value.status)?value.status:null;
  const summary=resolvedText(value.summary,2000),decidedAt=cleanText(value.decidedAt,40);
  const source=SOURCES.has(value.source)?value.source:null,type=TYPES.has(value.type)?value.type:null;
  const replaces=value.replaces==null?null:cleanId(value.replaces),artifactIds=uniqueIds(value.artifactIds??[],50);
  if(!id||!topic||!status||!summary||!decidedAt||!source||!type||!artifactIds)return null;
  if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.test(decidedAt))return null;
  if(status!=='PROPOSED'&&source!=='EXPLICIT_HUMAN')return null;
  return {id,topic,status,summary,decidedAt,source,type,replaces,artifactIds:[...artifactIds].sort()};
}
export function normalizeHumanDecisionSync(manifest){
  const required=requiresHumanDecisionSync(manifest);
  const raw=manifest?.humanDecisionSync;
  if(raw==null)return required?{error:stop('HUMAN_DECISION_SYNC_REQUIRED','PROJECT_CONTEXT.json must contain humanDecisionSync when requiredValidation enables it.')}:{value:null,required:false};
  if(!exactKeys(raw,['schemaVersion','decisions','currentState','nextAction'])||raw.schemaVersion!==1)
    return {error:stop('HUMAN_DECISION_SYNC_INVALID','humanDecisionSync must use the closed schemaVersion=1 shape.')};
  const currentState=resolvedText(raw.currentState,3000),nextAction=resolvedText(raw.nextAction,2000);
  if(!currentState||!nextAction||!Array.isArray(raw.decisions)||raw.decisions.length>200)
    return {error:stop('HUMAN_DECISION_SYNC_INVALID','Decision registry, currentState, or nextAction is invalid.')};
  const decisions=[],byId=new Map(),byTopic=new Map();
  for(const item of raw.decisions){const d=normalizeDecision(item);if(!d)return {error:stop('HUMAN_DECISION_INVALID','Decision registry contains an invalid decision.')};if(byId.has(d.id))return {error:stop('HUMAN_DECISION_DUPLICATE','Decision IDs must be unique.',{decisionId:d.id})};byId.set(d.id,d);decisions.push(d);const rows=byTopic.get(d.topic)??[];rows.push(d);byTopic.set(d.topic,rows);}
  for(const [topic,rows] of byTopic){
    const confirmed=rows.filter(x=>x.status==='CONFIRMED'),unresolved=rows.filter(x=>x.status==='UNRESOLVED');
    if(confirmed.length>1)return {error:stop('HUMAN_DECISION_CONFLICT','A topic cannot have more than one CONFIRMED decision.',{topic,decisionIds:confirmed.map(x=>x.id)})};
    if(unresolved.length>1)return {error:stop('HUMAN_DECISION_CONFLICT','A topic cannot have more than one UNRESOLVED decision.',{topic,decisionIds:unresolved.map(x=>x.id)})};
    if(confirmed.length&&unresolved.length)return {error:stop('HUMAN_DECISION_CONFLICT','A topic cannot be both CONFIRMED and UNRESOLVED.',{topic})};
  }
  for(const d of decisions){
    if(!d.replaces)continue;
    const old=byId.get(d.replaces);
    if(!old||!['CONFIRMED','DEPRECATED'].includes(d.status)||old.status!=='DEPRECATED'||old.topic!==d.topic||old.id===d.id)
      return {error:stop('HUMAN_DECISION_REPLACEMENT_INVALID','replaces must link an adopted decision to an older DEPRECATED decision in the same topic.',{decisionId:d.id,replaces:d.replaces})};
    const seen=new Set([d.id]);let cursor=old;
    while(cursor?.replaces){if(seen.has(cursor.id))return {error:stop('HUMAN_DECISION_REPLACEMENT_INVALID','Decision replacement chain contains a cycle.',{decisionId:d.id})};seen.add(cursor.id);cursor=byId.get(cursor.replaces);}
    if(cursor&&seen.has(cursor.id))return {error:stop('HUMAN_DECISION_REPLACEMENT_INVALID','Decision replacement chain contains a cycle.',{decisionId:d.id})};
  }
  const contract=normalizeCanonicalContract(manifest);
  if(contract.error)return {error:contract.error};
  for(const d of decisions){
    for(const artifactId of d.artifactIds){
      const artifact=contract.byId.get(artifactId);
      if(!artifact)return {error:stop('HUMAN_DECISION_ARTIFACT_UNKNOWN','Decision references an unknown canonical artifact.',{decisionId:d.id,artifactId})};
      if(d.status==='CONFIRMED'&&artifact.status!=='CURRENT')return {error:stop('HUMAN_DECISION_ARTIFACT_CONFLICT','CONFIRMED decision must reference only CURRENT canonical artifacts.',{decisionId:d.id,artifactId,artifactStatus:artifact.status})};
      if(d.status==='DEPRECATED'&&artifact.status==='CURRENT')return {error:stop('HUMAN_DECISION_ARTIFACT_CONFLICT','DEPRECATED decision cannot authorize a CURRENT canonical artifact.',{decisionId:d.id,artifactId})};
    }
  }
  return {value:{schemaVersion:1,decisions:[...decisions].sort((a,b)=>a.id.localeCompare(b.id)),currentState,nextAction},byId,required};
}
export function humanDecisionFingerprint(value){
  return value?createHash('sha256').update(JSON.stringify(value)).digest('hex'):null;
}
export function validateHumanDecisionSync(manifest,stateInput=null){
  const normalized=normalizeHumanDecisionSync(manifest);
  if(normalized.error)return normalized.error;
  if(!normalized.value)return pass({configured:false,required:false,humanDecisionFingerprint:null,activeDecisions:[],deprecatedDecisions:[],unresolvedItems:[],proposedDecisions:[],currentState:null,nextAction:null});
  const {value,byId}=normalized;
  const detail={
    configured:true,required:normalized.required,humanDecisionFingerprint:humanDecisionFingerprint(value),
    activeDecisions:value.decisions.filter(x=>x.status==='CONFIRMED'),
    deprecatedDecisions:value.decisions.filter(x=>x.status==='DEPRECATED'),
    unresolvedItems:value.decisions.filter(x=>x.status==='UNRESOLVED'),
    proposedDecisions:value.decisions.filter(x=>x.status==='PROPOSED'),
    currentState:value.currentState,nextAction:value.nextAction,
  };
  if(stateInput==null)return pass(detail);
  if(!exactKeys(stateInput,['schemaVersion','selectedDecisionIds'])||stateInput.schemaVersion!==1)
    return stop('HUMAN_DECISION_WORK_STATE_INVALID','Decision work state must use the closed schemaVersion=1 shape.');
  const selected=uniqueIds(stateInput.selectedDecisionIds,100);
  if(!selected)return stop('HUMAN_DECISION_WORK_STATE_INVALID','selectedDecisionIds must be a unique bounded decision ID list.');
  for(const id of selected){
    const d=byId.get(id);
    if(!d)return stop('HUMAN_DECISION_UNKNOWN','Work state references a decision not present in PROJECT_CONTEXT.json.',{decisionId:id});
    if(d.status==='DEPRECATED')return stop('DECISION_CONFLICT','A DEPRECATED human decision cannot be used as current authority.',{decisionId:id,topic:d.topic});
    if(d.status==='PROPOSED')return stop('PROPOSED_DECISION_USED','A PROPOSED decision cannot be used as confirmed authority.',{decisionId:id,topic:d.topic});
    if(d.status==='UNRESOLVED')return stop('UNRESOLVED_DECISION_USED','An UNRESOLVED item cannot be treated as a confirmed decision.',{decisionId:id,topic:d.topic});
  }
  return pass({...detail,selectedDecisionIds:selected});
}
function argValue(args,name){const i=args.indexOf(name);if(i<0)return null;if(!args[i+1])throw new Error(name+'_VALUE_REQUIRED');return args[i+1];}
async function main(){
  try{
    const args=process.argv.slice(2),contextFile=argValue(args,'--context-file'),stateJson=argValue(args,'--state-json'),stateFile=argValue(args,'--state-file'),pretty=args.includes('--pretty');
    const allowed=new Set(['--context-file','--state-json','--state-file','--pretty']);
    for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new Error('ARGUMENT_INVALID');if(args[i]!=='--pretty')i++;}
    if(!contextFile||(stateJson&&stateFile))throw new Error('ARGUMENT_INVALID');
    const manifest=JSON.parse(readFileSync(resolve(contextFile),'utf8'));
    const state=stateJson?JSON.parse(stateJson):stateFile?JSON.parse(readFileSync(resolve(stateFile),'utf8')):null;
    const result=validateHumanDecisionSync(manifest,state);
    process.stdout.write(JSON.stringify(result,null,pretty?2:0)+'\n');
    if(result.result==='STOP')process.exitCode=2;
  }catch(error){
    process.stdout.write(JSON.stringify(stop('HUMAN_DECISION_SYNC_ERROR',error?.message||'unknown error'),null,2)+'\n');
    process.exitCode=2;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
