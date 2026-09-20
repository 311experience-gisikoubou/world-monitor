#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const STATUSES = new Set(['CURRENT','SUPERSEDED','HISTORICAL','DRAFT']);
const KINDS = new Set(['PROJECT','BUSINESS','DESIGN','SECURITY','WORKFLOW','GOVERNANCE']);
const BASELINES = new Set(['MACHINE_READABLE','REFERENCE_IMAGE']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isObject(v){return Boolean(v)&&typeof v==='object'&&!Array.isArray(v);}
function cleanText(v,max=500){return typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v)?v:null;}
function cleanId(v){const s=cleanText(v,160);return s&&ID_RE.test(s)?s:null;}
function cleanRepo(v){const s=cleanText(v,300);return s&&REPO_RE.test(s)?s.toLowerCase():null;}
function stop(code,message,detail={}){return {result:'STOP',contractGate:'FAIL',code,message,...detail};}
function pass(detail){return {result:'PROCEED',contractGate:'PASS',code:'CANONICAL_CONTRACT_ALIGNED',...detail};}
function exactKeys(obj,allowed){return isObject(obj)&&Object.keys(obj).every(k=>allowed.includes(k));}
function stringList(v,{max=50,ids=false}={}){if(!Array.isArray(v)||v.length>max)return null;const out=[];for(const x of v){const s=ids?cleanId(x):cleanText(x,500);if(!s||out.includes(s))return null;out.push(s);}return out;}
function cleanSource(v){const s=cleanText(v,500);if(!s||s.startsWith('/')||s.startsWith('\\')||s.includes('\\')||s.split('/').includes('..')||/^[A-Za-z]:/u.test(s))return null;return s;}

function normalizeVisual(value,artifactId){
  if(!exactKeys(value,['designId','version','scope','baseline']))return null;
  const designId=cleanId(value.designId),version=cleanText(value.version,80),scope=stringList(value.scope,{max:50}),baseline=BASELINES.has(value.baseline)?value.baseline:null;
  if(!designId||designId!==artifactId||!version||!scope?.length||!baseline)return null;
  return {designId,version,scope:[...scope].sort(),baseline};
}

function normalizeArtifact(value){
  if(!exactKeys(value,['id','kind','slot','status','sources','supersededBy','visual']))return null;
  const id=cleanId(value.id),kind=KINDS.has(value.kind)?value.kind:null,slot=cleanId(value.slot),status=STATUSES.has(value.status)?value.status:null;
  if(!id||!kind||!slot||!status)return null;
  if(!Array.isArray(value.sources)||value.sources.length<1||value.sources.length>20)return null;
  const sources=[];
  for(const raw of value.sources){const s=cleanSource(raw);if(!s||sources.includes(s))return null;sources.push(s);}
  const supersededBy=value.supersededBy===undefined?null:cleanId(value.supersededBy);
  if(status==='SUPERSEDED'&&!supersededBy)return null;
  if(status!=='SUPERSEDED'&&value.supersededBy!==undefined)return null;
  let visual=null;
  if(kind==='DESIGN'){visual=normalizeVisual(value.visual,id);if(!visual)return null;}
  else if(value.visual!==undefined)return null;
  return {id,kind,slot,status,sources:[...sources].sort(),...(supersededBy?{supersededBy}:{}),...(visual?{visual}:{})};
}

export function normalizeCanonicalContract(manifest){
  if(!isObject(manifest))return {error:stop('CANONICAL_CONTRACT_CONTEXT_INVALID','Project context must be an object.')};
  const repository=cleanRepo(manifest.thisRepository);
  if(!repository)return {error:stop('CANONICAL_CONTRACT_REPOSITORY_INVALID','Project context thisRepository is missing or invalid.')};
  const c=manifest.canonicalContract;
  if(!exactKeys(c,['schemaVersion','contractId','contractVersion','approved','artifacts','protectedDecisions','requiredValidation'])||c.schemaVersion!==1)
    return {error:stop('CANONICAL_CONTRACT_MISSING','PROJECT_CONTEXT.json canonicalContract schemaVersion=1 is required.')};
  const contractId=cleanId(c.contractId),contractVersion=cleanText(c.contractVersion,80);
  const protectedDecisions=stringList(c.protectedDecisions,{max:100,ids:true});
  const requiredValidation=stringList(c.requiredValidation,{max:50,ids:true});
  if(!contractId||!contractVersion||c.approved!==true||!protectedDecisions||!requiredValidation||!requiredValidation.includes('canonical-contract-gate'))
    return {error:stop('CANONICAL_CONTRACT_INVALID','Canonical contract metadata is incomplete, unapproved, or missing canonical-contract-gate validation.')};
  if(!Array.isArray(c.artifacts)||c.artifacts.length<1||c.artifacts.length>200)return {error:stop('CANONICAL_CONTRACT_INVALID','Canonical contract artifacts must be a non-empty bounded array.')};
  const artifacts=[],byId=new Map(),currentBySlot=new Map();
  for(const raw of c.artifacts){const a=normalizeArtifact(raw);if(!a)return {error:stop('CANONICAL_ARTIFACT_INVALID','Canonical contract contains an invalid artifact.')};if(byId.has(a.id))return {error:stop('CANONICAL_ARTIFACT_DUPLICATE','Canonical artifact IDs must be unique.',{artifactId:a.id})};byId.set(a.id,a);artifacts.push(a);if(a.status==='CURRENT'){if(currentBySlot.has(a.slot))return {error:stop('CANONICAL_SPEC_CONFLICT','More than one CURRENT artifact exists for the same canonical slot.',{slot:a.slot,artifactIds:[currentBySlot.get(a.slot).id,a.id]})};currentBySlot.set(a.slot,a);}}
  if(currentBySlot.size===0)return {error:stop('CANONICAL_CONTRACT_NO_CURRENT','At least one CURRENT canonical artifact is required.')};
  for(const a of artifacts){if(a.status!=='SUPERSEDED')continue;const next=byId.get(a.supersededBy);if(!next||next.status!=='CURRENT'||next.slot!==a.slot)return {error:stop('CANONICAL_SUPERSESSION_INVALID','SUPERSEDED artifacts must point to the CURRENT artifact in the same slot.',{artifactId:a.id,supersededBy:a.supersededBy})};}
  const value={schemaVersion:1,repository,contractId,contractVersion,approved:true,artifacts:[...artifacts].sort((a,b)=>a.id.localeCompare(b.id)),protectedDecisions:[...protectedDecisions].sort(),requiredValidation:[...requiredValidation].sort()};
  return {value,byId,currentBySlot};
}

export function canonicalContractFingerprint(contract){
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function validateCanonicalContract(manifest,stateInput=null){
  const normalized=normalizeCanonicalContract(manifest);if(normalized.error)return normalized.error;
  const {value:c,byId,currentBySlot}=normalized;
  const summary={repository:c.repository,contractId:c.contractId,contractVersion:c.contractVersion,contractFingerprint:canonicalContractFingerprint(c),canonicalTargets:[...currentBySlot.values()].map(a=>({slot:a.slot,artifactId:a.id,kind:a.kind,sources:a.sources})).sort((a,b)=>a.slot.localeCompare(b.slot)),supersededSpecUsed:false};
  if(stateInput===null||stateInput===undefined)return pass(summary);
  const allowed=['schemaVersion','repository','contractId','contractVersion','targetSelection','usedSpecIds','functionalGate'];
  if(!exactKeys(stateInput,allowed)||stateInput.schemaVersion!==1||Object.keys(stateInput).length!==allowed.length)return stop('CANONICAL_WORK_STATE_INVALID','Contract conformance state must use the closed schemaVersion=1 shape.');
  const repository=cleanRepo(stateInput.repository),contractId=cleanId(stateInput.contractId),contractVersion=cleanText(stateInput.contractVersion,80);
  if(repository!==c.repository)return stop('CANONICAL_CONTRACT_REPOSITORY_MISMATCH','Work state references a different repository contract.',{expectedRepository:c.repository,actualRepository:repository});
  if(contractId!==c.contractId||contractVersion!==c.contractVersion)return stop('CANONICAL_CONTRACT_VERSION_MISMATCH','Work state contract ID/version is not current.',{expectedContractId:c.contractId,expectedContractVersion:c.contractVersion});
  if(!['PASS','FAIL','UNNEEDED'].includes(stateInput.functionalGate))return stop('CANONICAL_WORK_STATE_INVALID','functionalGate must be PASS, FAIL, or UNNEEDED.');
  if(!Array.isArray(stateInput.targetSelection)||stateInput.targetSelection.length<1||stateInput.targetSelection.length>50)return stop('CANONICAL_WORK_STATE_INVALID','At least one targetSelection entry is required.');
  const selections=[];
  for(const row of stateInput.targetSelection){if(!exactKeys(row,['slot','artifactId'])||Object.keys(row).length!==2)return stop('CANONICAL_WORK_STATE_INVALID','Each targetSelection must contain only slot and artifactId.');const slot=cleanId(row.slot),artifactId=cleanId(row.artifactId);if(!slot||!artifactId||selections.some(x=>x.slot===slot))return stop('CANONICAL_WORK_STATE_INVALID','Target selections must have unique valid slots.');selections.push({slot,artifactId});}
  const used=stringList(stateInput.usedSpecIds,{max:100,ids:true});
  if(!used)return stop('CANONICAL_WORK_STATE_INVALID','usedSpecIds must be a unique bounded artifact ID list.');
  for(const {slot,artifactId} of selections){const current=currentBySlot.get(slot);if(!current||current.id!==artifactId)return stop('CANONICAL_TARGET_MISMATCH','Implementation target does not match the CURRENT canonical artifact.',{slot,expectedArtifactId:current?.id??null,implementationArtifactId:artifactId,functionalGate:stateInput.functionalGate});if(!used.includes(artifactId))return stop('CANONICAL_SPEC_NOT_USED','The selected CURRENT canonical artifact is not present in usedSpecIds.',{slot,artifactId});}
  for(const id of used){const a=byId.get(id);if(!a)return stop('CANONICAL_SPEC_UNKNOWN','Work state references an artifact that is not in the canonical contract.',{artifactId:id});if(a.status==='SUPERSEDED')return stop('SUPERSEDED_SPEC_USED','A SUPERSEDED artifact cannot be used as implementation authority.',{artifactId:id,supersededBy:a.supersededBy,functionalGate:stateInput.functionalGate});if(a.status!=='CURRENT')return stop('NONCURRENT_SPEC_USED','Only CURRENT artifacts may be used as implementation authority.',{artifactId:id,status:a.status,functionalGate:stateInput.functionalGate});}
  if(stateInput.functionalGate==='FAIL')return stop('FUNCTIONAL_GATE_FAIL','Functional Gate is not PASS/UNNEEDED; merge preparation cannot proceed.');
  return pass({...summary,functionalGate:stateInput.functionalGate,targetSelection:selections,usedSpecIds:used});
}

export function verifyCanonicalSources(contextFile,manifest){
  const n=normalizeCanonicalContract(manifest);if(n.error)return n.error;
  const root=dirname(resolve(contextFile));
  for(const a of n.value.artifacts.filter(x=>x.status==='CURRENT'))for(const source of a.sources){
    const r=spawnSync('git',['-C',root,'ls-tree','-z','HEAD','--',source],{encoding:'utf8',windowsHide:true,timeout:5000});
    if(r.error||r.status!==0||!String(r.stdout??'').includes('\t'+source+'\0'))return stop('CANONICAL_SOURCE_MISSING','A CURRENT canonical source is not present as a file in Git HEAD.',{artifactId:a.id,source});
  }
  return pass({repository:n.value.repository,contractId:n.value.contractId,contractVersion:n.value.contractVersion,contractFingerprint:canonicalContractFingerprint(n.value)});
}

function readArg(args,name){const i=args.indexOf(name);if(i<0)return null;if(!args[i+1])throw new Error(name+'_VALUE_REQUIRED');return args[i+1];}
async function main(){
  try{
    const args=process.argv.slice(2),contextFile=readArg(args,'--context-file'),stateJson=readArg(args,'--state-json'),stateFile=readArg(args,'--state-file'),pretty=args.includes('--pretty');
    const allowed=new Set(['--context-file','--state-json','--state-file','--pretty']);for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new Error('ARGUMENT_INVALID');if(args[i]!=='--pretty')i++;}
    if(!contextFile||(stateJson&&stateFile))throw new Error('ARGUMENT_INVALID');
    const manifest=JSON.parse(readFileSync(resolve(contextFile),'utf8'));const sources=verifyCanonicalSources(contextFile,manifest);if(sources.result==='STOP'){console.log(JSON.stringify(sources,null,pretty?2:0));process.exitCode=2;return;}
    const state=stateJson?JSON.parse(stateJson):stateFile?JSON.parse(readFileSync(resolve(stateFile),'utf8')):null;
    const result=validateCanonicalContract(manifest,state);console.log(JSON.stringify(result,null,pretty?2:0));if(result.result==='STOP')process.exitCode=2;
  }catch(e){console.log(JSON.stringify(stop('CANONICAL_CONTRACT_GATE_ERROR',e?.message||'unknown error'),null,2));process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
