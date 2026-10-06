#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateApprovalScopeGate } from './approval-scope-gate.mjs';

const LIFECYCLE=['WIP','LOCKED_COMPONENTS','FINAL_CANDIDATE','HUMAN_APPROVED','CANONICAL'];
const DESIGN_SCOPES=new Set(['SCREEN','WHOLE_APP']);
const SHA256_RE=/^[0-9a-f]{64}$/i;
const HEAD_RE=/^[0-9a-f]{40}$/i;
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/;
function obj(v){return Boolean(v)&&typeof v==='object'&&!Array.isArray(v);}
function text(v,max=500){return typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v)?v:null;}
function id(v){const s=text(v,160);return s&&ID_RE.test(s)?s:null;}
function repoPath(v){const s=text(v,500);return s&&!s.startsWith('/')&&!s.startsWith('\\')&&!/^[A-Za-z]:/u.test(s)&&!s.split('/').includes('..')?s:null;}
function exact(v,keys){return obj(v)&&Object.keys(v).every(k=>keys.includes(k));}
function stop(code,message,detail={}){return {result:'STOP',canonicalPromotionGate:'FAIL',code,message,...detail};}
function pass(detail={}){return {result:'PROCEED',canonicalPromotionGate:'PASS',code:'CANONICAL_PROMOTION_ALIGNED',...detail};}

export function requiresCanonicalPromotionGate(manifest){
  return Array.isArray(manifest?.canonicalContract?.requiredValidation)&&manifest.canonicalContract.requiredValidation.includes('canonical-promotion-gate');
}
export function normalizeDesignGovernance(v){
  if(v==null)return null;
  const keys=['canonicalScope','lifecycleHistory','derivedFrom','contentSource','contentSha256','artifactHead','reference'];
  if(!exact(v,keys)||Object.keys(v).length!==keys.length)return null;
  const canonicalScope=DESIGN_SCOPES.has(v.canonicalScope)?v.canonicalScope:null;
  const lifecycleHistory=Array.isArray(v.lifecycleHistory)&&v.lifecycleHistory.length<=LIFECYCLE.length&&v.lifecycleHistory.every((x,i)=>x===LIFECYCLE[i])?[...v.lifecycleHistory]:null;
  const derivedFrom=id(v.derivedFrom),contentSource=repoPath(v.contentSource);
  const contentSha256=SHA256_RE.test(v.contentSha256??'')?String(v.contentSha256).toLowerCase():null;
  const artifactHead=HEAD_RE.test(v.artifactHead??'')?String(v.artifactHead).toLowerCase():null;
  const r=v.reference;
  if(!canonicalScope||!lifecycleHistory?.length||!derivedFrom||!contentSource||!contentSha256||!artifactHead||!exact(r,['referenceId','sourcePath','sha256','scope','status','decidedAt','source']))return null;
  const referenceId=id(r.referenceId),sourcePath=repoPath(r.sourcePath),sha256=SHA256_RE.test(r.sha256??'')?String(r.sha256).toLowerCase():null;
  const scope=DESIGN_SCOPES.has(r.scope)?r.scope:null,decidedAt=text(r.decidedAt,40);
  if(!referenceId||!sourcePath||!sha256||!scope||r.status!=='DESIGN_REFERENCE'||r.source!=='EXPLICIT_HUMAN'||!decidedAt||derivedFrom!==referenceId||scope!==canonicalScope)return null;
  return {canonicalScope,lifecycleHistory,derivedFrom,contentSource,contentSha256,artifactHead,reference:{referenceId,sourcePath,sha256,scope,status:r.status,decidedAt,source:r.source}};
}
function gitBytes(root,head,path){
  const r=spawnSync('git',['-C',root,'show',head+':'+path],{encoding:null,windowsHide:true,timeout:5000,maxBuffer:16*1024*1024});
  return !r.error&&r.status===0?r.stdout:null;
}
function hash(b){return createHash('sha256').update(b).digest('hex');}
function latest(rows){return [...rows].sort((a,b)=>String(a.decidedAt).localeCompare(String(b.decidedAt))||String(a.decisionId).localeCompare(String(b.decisionId))).at(-1)??null;}

export function validateCanonicalPromotionGate(manifest,{repoRoot=null}={}){
  if(!requiresCanonicalPromotionGate(manifest))return pass({configured:false,checkedArtifacts:[]});
  const approval=validateApprovalScopeGate(manifest);if(approval.result==='STOP')return stop('CANONICAL_PROMOTION_INVALID','Approval scope evidence is invalid.',{cause:approval.code});
  const artifacts=manifest?.canonicalContract?.artifacts;
  if(!Array.isArray(artifacts))return stop('CANONICAL_PROMOTION_INVALID','Canonical artifacts are unavailable.');
  const designs=artifacts.filter(a=>a?.kind==='DESIGN'&&a?.status==='CURRENT');
  if(designs.length===0)return pass({configured:true,checkedArtifacts:[]});
  if(!repoRoot)return stop('CANONICAL_PROMOTION_REPO_ROOT_REQUIRED','Repository root is required to verify design content identity.');
  const checked=[];
  for(const a of designs){
    const g=normalizeDesignGovernance(a?.visual?.governance);
    if(!g)return stop('CANONICAL_PROMOTION_INVALID','CURRENT design lacks valid promotion governance.',{artifactId:a?.id??null});
    if(JSON.stringify(g.lifecycleHistory)!==JSON.stringify(LIFECYCLE))return stop('CANONICAL_PROMOTION_INVALID','Design lifecycle cannot skip required states.',{artifactId:a.id,lifecycleHistory:g.lifecycleHistory});
    if(!Array.isArray(a.sources)||!a.sources.includes(g.contentSource)||!a.sources.includes(g.reference.sourcePath))
      return stop('CANONICAL_PROMOTION_INVALID','Canonical design sources do not contain fixed content/reference sources.',{artifactId:a.id});
    const currentContent=gitBytes(repoRoot,'HEAD',g.contentSource),approvedContent=gitBytes(repoRoot,g.artifactHead,g.contentSource);
    const currentRef=gitBytes(repoRoot,'HEAD',g.reference.sourcePath),approvedRef=gitBytes(repoRoot,g.artifactHead,g.reference.sourcePath);
    if(!currentContent||!approvedContent||!currentRef||!approvedRef)return stop('CANONICAL_PROMOTION_INVALID','Approved/current design evidence is not readable from Git.',{artifactId:a.id});
    if(hash(currentContent)!==g.contentSha256||hash(approvedContent)!==g.contentSha256)return stop('CANONICAL_PROMOTION_INVALID','Design content changed after approval or approval head does not match.',{artifactId:a.id});
    if(hash(currentRef)!==g.reference.sha256||hash(approvedRef)!==g.reference.sha256)return stop('CANONICAL_PROMOTION_INVALID','Design reference identity changed after approval.',{artifactId:a.id});
    const rows=approval.approvals.filter(x=>x.artifactId===a.id);
    const whole=rows.filter(x=>x.approvalType==='WHOLE_SCREEN_APPROVAL'&&x.scope===g.canonicalScope&&x.approvedContentSha256===g.contentSha256&&x.approvedHead===g.artifactHead);
    const promote=rows.filter(x=>x.approvalType==='CANONICAL_PROMOTION_APPROVAL'&&x.scope===g.canonicalScope&&x.approvedContentSha256===g.contentSha256&&x.approvedHead===g.artifactHead);
    if(whole.length===0)return stop('CANONICAL_PROMOTION_INVALID','Whole-screen/app explicit approval is missing for CURRENT design.',{artifactId:a.id});
    if(promote.length===0)return stop('CANONICAL_PROMOTION_INVALID','Explicit canonical-promotion approval is missing for CURRENT design.',{artifactId:a.id});
    const last=latest(rows);
    if(last&&!['HUMAN_APPROVED','CANONICAL'].includes(last.designState))
      return stop('CANONICAL_PROMOTION_HUMAN_CORRECTION_CONFLICT','Latest explicit human design decision says the artifact is not final/canonical.',{artifactId:a.id,decisionId:last.decisionId,designState:last.designState});
    checked.push({artifactId:a.id,scope:g.canonicalScope,wholeScreenApprovalDecisionId:latest(whole)?.decisionId,canonicalPromotionDecisionId:latest(promote)?.decisionId});
  }
  return pass({configured:true,checkedArtifacts:checked});
}
function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:null;}
async function main(){
  try{
    const args=process.argv.slice(2),file=arg(args,'--context-file'),root=arg(args,'--repo-root'),pretty=args.includes('--pretty');
    if(!file||!root)throw new Error('CONTEXT_AND_ROOT_REQUIRED');
    const manifest=JSON.parse(readFileSync(resolve(file),'utf8'));
    const out=validateCanonicalPromotionGate(manifest,{repoRoot:resolve(root)});
    console.log(JSON.stringify(out,null,pretty?2:0));if(out.result==='STOP')process.exitCode=2;
  }catch(e){console.log(JSON.stringify(stop('CANONICAL_PROMOTION_GATE_ERROR',e?.message||'unknown'),null,2));process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
