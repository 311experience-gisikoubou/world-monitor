#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const toolArg=process.argv[2];
if(!toolArg) throw new Error('project-working-memory path required');
const tool=resolve(toolArg);
const mod=await import(pathToFileURL(tool).href);
const { evaluateArtifactRecall, evaluateDecisionGate, evaluateFocusGate }=mod;
function run(root,action,input=null,expected=0){
  const args=[tool,'--root',root,'--action',action,'--pretty'];
  if(input!==null) args.push('--input-json',JSON.stringify(input));
  const r=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});
  if(r.status!==expected) throw new Error(`${action} expected ${expected} got ${r.status}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
function git(root,args){const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true}); if(r.status!==0) throw new Error(r.stderr); return r.stdout.trim();}
const root=await mkdtemp(join(tmpdir(),'project-memory-selftest-'));
try{
  git(root,['init']);
  git(root,['config','user.email','test@example.invalid']);
  git(root,['config','user.name','Selftest']);
  git(root,['remote','add','origin','https://github.com/acme/app.git']);
  const context={
    schemaVersion:1,
    projectContextId:'app-v1',
    projectName:'App',
    projectRootRepository:'acme/app',
    finalObjective:'Deliver the approved app safely.',
    thisRepository:'acme/app',
    repositoryRole:'ROOT',
    canonicalContract:{schemaVersion:1,contractId:'app-v1-contract',contractVersion:'1',approved:true,artifacts:[{id:'app-v1-baseline',kind:'GOVERNANCE',slot:'project-baseline',status:'CURRENT',sources:['PROJECT_CONTEXT.json']}],protectedDecisions:[],requiredValidation:['canonical-contract-gate']},
  };
  await writeFile(join(root,'PROJECT_CONTEXT.json'),JSON.stringify(context,null,2)+'\n','utf8');
  await mkdir(join(root,'design'),{recursive:true});
  await writeFile(join(root,'design','clear.svg'),'<svg></svg>\n','utf8');
  git(root,['add','PROJECT_CONTEXT.json','design/clear.svg']);
  git(root,['commit','-m','seed']);
  git(root,['branch','-M','main']);

  let out=run(root,'ensure');
  assert.equal(out.ok,true);
  assert.equal(out.code,'WORKING_MEMORY_CREATED');
  assert.equal(git(root,['check-ignore','.ai/working/project-memory.json']),'.ai/working/project-memory.json');
  assert(!git(root,['status','--short']).includes('.ai/working'));
  const excludePath=resolve(root,git(root,['rev-parse','--git-path','info/exclude']));
  await writeFile(excludePath,'','utf8');
  out=run(root,'snapshot');
  assert.equal(out.code,'WORKING_MEMORY_SNAPSHOT');
  assert.equal(git(root,['check-ignore','.ai/working/project-memory.json']),'.ai/working/project-memory.json');

  out=run(root,'record-reference',{id:'clear',label:'Clear',classification:'VERIFIED',locatorKind:'REPO_PATH',locator:'design/clear.svg',verificationBasis:'FILE_EXISTS',creationReason:null,supersedes:null});
  assert.equal(out.code,'REFERENCE_RECORDED');
  run(root,'record-reference',{id:'olive',label:'Olive',classification:'UNVERIFIED',locatorKind:'NONE',locator:null,verificationBasis:null,creationReason:null,supersedes:null});
  run(root,'record-reference',{id:'chic',label:'Chic',classification:'UNVERIFIED',locatorKind:'NONE',locator:null,verificationBasis:null,creationReason:null,supersedes:null});

  out=run(root,'artifact-recall',{referenceIds:['clear','olive','chic'],recreate:false},2);
  assert.equal(out.code,'PAST_ARTIFACTS_UNVERIFIED');
  assert.equal(out.action,'REPORT_MISSING');
  assert.deepEqual(out.unresolved.map(x=>x.id),['olive','chic']);
  out=run(root,'artifact-recall',{referenceIds:['clear','olive','chic'],recreate:true,recreationReason:'元画像2案が見つからないため比較用に再現する'});
  assert.equal(out.code,'PAST_ARTIFACT_RECREATION_ALLOWED');
  assert.equal(out.requiredClassification,'NEWLY_CREATED');
  assert.match(out.requiredDisclosure,/元の実物が見つからない/);

  out=run(root,'decision-gate',{decisionClass:'TECHNICAL',evidenceClassification:'UNVERIFIED'},2);
  assert.equal(out.code,'EVIDENCE_VERIFICATION_REQUIRED');
  assert.equal(out.requiredAction,'AI_VERIFY_FIRST');
  out=run(root,'decision-gate',{decisionClass:'HUMAN_VALUE',evidenceClassification:'VERIFIED'},2);
  assert.equal(out.code,'HUMAN_VALUE_DECISION_REQUIRED');
  assert.equal(out.requiredAction,'WAIT_HUMAN');

  out=run(root,'set-focus',{goalId:'unbacked-goal',goal:'人間が決めたことにする',goalSource:'EXPLICIT_HUMAN',nextStep:'進める',approvedReferenceId:null,decisionId:null},2);
  assert.equal(out.code,'FOCUS_HUMAN_DECISION_REQUIRED');

  out=run(root,'record-decision',{id:'use-clear',state:'CONFIRMED',summary:'Clearを最終デザイン基準にする',source:'EXPLICIT_HUMAN',referenceIds:['clear'],supersedes:null});
  assert.equal(out.code,'HUMAN_DECISION_RECORDED');
  out=run(root,'set-focus',{goalId:'final-design',goal:'最終製品デザインを決める',goalSource:'EXPLICIT_HUMAN',nextStep:'Clear基準で全体画面を確認する',approvedReferenceId:'clear',decisionId:'use-clear'});
  assert.equal(out.code,'CURRENT_FOCUS_SET');
  out=run(root,'snapshot');
  assert.equal(out.currentGoal,'最終製品デザインを決める');
  assert.equal(out.approvedReference.id,'clear');
  assert.equal(out.lastHumanDecision.id,'use-clear');
  assert.equal(out.nextStep,'Clear基準で全体画面を確認する');

  out=run(root,'focus-gate',{goalId:'final-design',requireApprovedReference:true});
  assert.equal(out.code,'CURRENT_FOCUS_ALIGNED');
  out=run(root,'focus-gate',{goalId:'sprite-order',requireApprovedReference:false},2);
  assert.equal(out.code,'CURRENT_GOAL_MISMATCH');

  out=run(root,'record-decision',{id:'ai-choice',state:'CONFIRMED',summary:'AIが勝手に決めた',source:'AI_INFERENCE',referenceIds:[],supersedes:null},2);
  assert.equal(out.code,'DECISION_FIELDS_INVALID');

  out=run(root,'record-decision',{id:'design-undecided',state:'UNRESOLVED',summary:'配色は未決定のまま残す',source:'EXPLICIT_HUMAN',referenceIds:[],supersedes:'use-clear'});
  assert.equal(out.code,'HUMAN_DECISION_RECORDED');
  out=run(root,'snapshot');
  assert.equal(out.lastHumanDecision.id,'design-undecided');
  assert.equal(out.lastHumanDecision.state,'UNRESOLVED');
  out=run(root,'focus-gate',{goalId:'final-design',requireApprovedReference:true},2);
  assert.equal(out.code,'CURRENT_FOCUS_DECISION_STALE');
  assert.equal(out.requiredAction,'REANCHOR_FROM_LATEST_HUMAN_DECISION');

  const state=JSON.parse(await readFile(join(root,'.ai','working','project-memory.json'),'utf8'));
  const recall=await evaluateArtifactRecall({root,state,referenceIds:['clear']});
  assert.equal(recall.code,'PAST_ARTIFACTS_VERIFIED');
  const humanGate=evaluateDecisionGate({decisionClass:'HUMAN_VALUE',evidenceClassification:'UNVERIFIED',humanDecision:{state:'CONFIRMED',source:'EXPLICIT_HUMAN'},uncertaintyDisclosed:false});
  assert.equal(humanGate.code,'UNCERTAINTY_DISCLOSURE_REQUIRED');
  const focus=await evaluateFocusGate({root,state,goalId:'final-design',requireApprovedReference:true});
  assert.equal(focus.ok,false);
  assert.equal(focus.code,'CURRENT_FOCUS_DECISION_STALE');

  await writeFile(join(root,'PROJECT_CONTEXT.json'),JSON.stringify({...context,projectName:'Other'},null,2)+'\n','utf8');
  out=run(root,'snapshot',null,2);
  assert.equal(out.code,'WORKING_MEMORY_CONTEXT_UNVERIFIED');

  console.log('project-working-memory selftest: PASS');
} finally {
  await rm(root,{recursive:true,force:true});
}
