#!/usr/bin/env node
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DESIGN_SCOPES = new Set(['COMPONENT','SECTION','SCREEN','WHOLE_APP']);
export const APPROVAL_TYPES = new Set(['DIRECTION_APPROVAL','COMPONENT_APPROVAL','LAYOUT_APPROVAL','WHOLE_SCREEN_APPROVAL','CANONICAL_PROMOTION_APPROVAL']);
export const DESIGN_STATES = new Set(['WIP','LOCKED_COMPONENTS','FINAL_CANDIDATE','HUMAN_APPROVED','CANONICAL']);
const SHA256_RE=/^[0-9a-f]{64}$/i;
const HEAD_RE=/^[0-9a-f]{40}$/i;
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/;
const AMBIGUOUS_ONLY=new Set(['ok','okay','いいと思う','これでいい','採用','採用します','これで進めて','よろしく','次へ','その案で','大丈夫']);

function obj(v){return Boolean(v)&&typeof v==='object'&&!Array.isArray(v);}
function text(v,max=1000){return typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v)?v:null;}
function id(v){const s=text(v,160);return s&&ID_RE.test(s)?s:null;}
function exact(v,keys){return obj(v)&&Object.keys(v).every(k=>keys.includes(k));}
function stop(code,message,detail={}){return {result:'STOP',approvalScopeGate:'FAIL',code,message,...detail};}
function pass(detail={}){return {result:'PROCEED',approvalScopeGate:'PASS',code:'APPROVAL_SCOPE_ALIGNED',...detail};}
function ambiguousOnly(v){const s=String(v??'').trim().toLowerCase().replace(/[。.!！?？\s]/gu,'');if(AMBIGUOUS_ONLY.has(s))return true;return /^(?:ok|okay|いいと思う|これでいい|採用|採用します|これで進めて|よろしく|次へ|その案で|大丈夫)+$/u.test(s);}

export function requiresApprovalScopeGate(manifest){
  const r=manifest?.canonicalContract?.requiredValidation;
  return Array.isArray(r)&&(r.includes('approval-scope-gate')||r.includes('canonical-promotion-gate'));
}

export function normalizeDesignApproval(value){
  if(value==null)return null;
  const keys=['artifactId','scope','approvalType','designState','evidenceText','approvedContentSha256','approvedHead'];
  if(!exact(value,keys)||Object.keys(value).length!==keys.length)return null;
  const artifactId=id(value.artifactId),scope=DESIGN_SCOPES.has(value.scope)?value.scope:null;
  const approvalType=APPROVAL_TYPES.has(value.approvalType)?value.approvalType:null;
  const designState=DESIGN_STATES.has(value.designState)?value.designState:null;
  const evidenceText=text(value.evidenceText,1000);
  const approvedContentSha256=SHA256_RE.test(value.approvedContentSha256??'')?String(value.approvedContentSha256).toLowerCase():null;
  const approvedHead=HEAD_RE.test(value.approvedHead??'')?String(value.approvedHead).toLowerCase():null;
  if(!artifactId||!scope||!approvalType||!designState||!evidenceText||!approvedContentSha256||!approvedHead)return null;
  if(approvalType==='COMPONENT_APPROVAL'&&(scope!=='COMPONENT'||designState!=='LOCKED_COMPONENTS'))return null;
  if(approvalType==='LAYOUT_APPROVAL'&&(!['SECTION','SCREEN'].includes(scope)||!['LOCKED_COMPONENTS','FINAL_CANDIDATE'].includes(designState)))return null;
  if(approvalType==='WHOLE_SCREEN_APPROVAL'&&(!['SCREEN','WHOLE_APP'].includes(scope)||designState!=='HUMAN_APPROVED'||ambiguousOnly(evidenceText)))return null;
  if(approvalType==='CANONICAL_PROMOTION_APPROVAL'&&(!['SCREEN','WHOLE_APP'].includes(scope)||designState!=='CANONICAL'||ambiguousOnly(evidenceText)))return null;
  if(approvalType==='DIRECTION_APPROVAL'&&!['WIP','LOCKED_COMPONENTS','FINAL_CANDIDATE'].includes(designState))return null;
  return {artifactId,scope,approvalType,designState,evidenceText,approvedContentSha256,approvedHead};
}

export function validateApprovalScopeGate(manifest){
  if(!requiresApprovalScopeGate(manifest))return pass({configured:false,approvals:[]});
  const decisions=manifest?.humanDecisionSync?.decisions;
  if(!Array.isArray(decisions))return stop('APPROVAL_SCOPE_DECISIONS_REQUIRED','Human Decision Sync decisions are required.');
  const artifacts=manifest?.canonicalContract?.artifacts;
  if(!Array.isArray(artifacts))return stop('APPROVAL_SCOPE_ARTIFACTS_REQUIRED','Canonical Contract artifacts are required.');
  const byArtifact=new Map(artifacts.map(a=>[a?.id,a]));
  const approvals=[];
  for(const d of decisions){
    if(d?.designApproval==null)continue;
    const a=normalizeDesignApproval(d.designApproval);
    if(!a)return stop('APPROVAL_SCOPE_RECORD_INVALID','A design approval record is malformed or violates scope/type rules.',{decisionId:d?.id??null});
    const target=byArtifact.get(a.artifactId);
    if(!target||target.kind!=='DESIGN')return stop('APPROVAL_SCOPE_ARTIFACT_INVALID','Design approval must target a DESIGN artifact in the Canonical Contract.',{decisionId:d?.id??null,artifactId:a.artifactId});
    if(d.type!=='DESIGN'||d.source!=='EXPLICIT_HUMAN')return stop('APPROVAL_SCOPE_SOURCE_INVALID','Design approvals must be DESIGN decisions from EXPLICIT_HUMAN.',{decisionId:d.id});
    if(d.status==='CONFIRMED')approvals.push({decisionId:d.id,decidedAt:d.decidedAt,...a});
  }
  return pass({configured:true,approvals});
}

function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:null;}
async function main(){
  try{
    const args=process.argv.slice(2),file=arg(args,'--context-file'),pretty=args.includes('--pretty');
    if(!file)throw new Error('CONTEXT_REQUIRED');
    const manifest=JSON.parse(readFileSync(resolve(file),'utf8'));
    const out=validateApprovalScopeGate(manifest);
    console.log(JSON.stringify(out,null,pretty?2:0));if(out.result==='STOP')process.exitCode=2;
  }catch(e){console.log(JSON.stringify(stop('APPROVAL_SCOPE_GATE_ERROR',e?.message||'unknown'),null,2));process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
