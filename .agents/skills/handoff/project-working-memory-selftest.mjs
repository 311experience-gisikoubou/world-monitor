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
const { evaluateArtifactRecall, evaluateFocusGate }=mod;
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
  const contract={schemaVersion:1,contractId:'app-v1-contract',contractVersion:'1',approved:true,artifacts:[{id:'app-v1-baseline',kind:'GOVERNANCE',slot:'project-baseline',status:'CURRENT',sources:['PROJECT_CONTEXT.json']}],protectedDecisions:[],requiredValidation:['canonical-contract-gate','human-decision-sync']};
  const confirmed={id:'use-clear',topic:'visual-baseline',status:'CONFIRMED',summary:'Clear is the approved baseline.',decidedAt:'2026-09-20',source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:null,artifactIds:[]};
  const context={
    schemaVersion:1,
    projectContextId:'app-v1',
    projectName:'App',
    projectRootRepository:'acme/app',
    finalObjective:'Deliver the approved app safely.',
    thisRepository:'acme/app',
    repositoryRole:'ROOT',
    canonicalContract:contract,
    humanDecisionSync:{schemaVersion:1,decisions:[confirmed],currentState:'Clear baseline is confirmed.',nextAction:'Continue from the confirmed baseline.'},
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
  assert.equal(out.state.schemaVersion,2);
  assert.equal(git(root,['check-ignore','.ai/working/project-memory.json']),'.ai/working/project-memory.json');

  const memoryPath=join(root,'.ai','working','project-memory.json');
  const initial=JSON.parse(await readFile(memoryPath,'utf8'));
  const legacy={...initial,schemaVersion:1,decisions:[{id:'legacy-local',state:'CONFIRMED',summary:'legacy',source:'EXPLICIT_HUMAN',referenceIds:[],supersedes:null}]};
  await writeFile(memoryPath,JSON.stringify(legacy,null,2)+'\n','utf8');
  run(root,'snapshot');
  const migrated=JSON.parse(await readFile(memoryPath,'utf8'));
  assert.equal(migrated.schemaVersion,2);
  assert.equal(Object.hasOwn(migrated,'decisions'),false);

  out=run(root,'record-reference',{id:'clear',label:'Clear',classification:'VERIFIED',locatorKind:'REPO_PATH',locator:'design/clear.svg',verificationBasis:'FILE_EXISTS',creationReason:null,supersedes:null});
  assert.equal(out.code,'REFERENCE_RECORDED');
  run(root,'record-reference',{id:'olive',label:'Olive',classification:'UNVERIFIED',locatorKind:'NONE',locator:null,verificationBasis:null,creationReason:null,supersedes:null});
  out=run(root,'artifact-recall',{referenceIds:['clear','olive'],recreate:false},2);
  assert.equal(out.code,'PAST_ARTIFACTS_UNVERIFIED');
  assert.deepEqual(out.unresolved.map(x=>x.id),['olive']);
  out=run(root,'artifact-recall',{referenceIds:['clear','olive'],recreate:true,recreationReason:'recreate missing reference for comparison'});
  assert.equal(out.code,'PAST_ARTIFACT_RECREATION_ALLOWED');
  assert.equal(out.requiredClassification,'NEWLY_CREATED');

  out=run(root,'record-decision',{id:'duplicate-local'},2);
  assert.equal(out.code,'ACTION_INVALID');
  out=run(root,'decision-gate',{decisionId:'use-clear'},2);
  assert.equal(out.code,'ACTION_INVALID');

  out=run(root,'set-focus',{goalId:'unbacked-goal',goal:'Treat this as a human choice.',goalSource:'EXPLICIT_HUMAN',nextStep:'Continue.',approvedReferenceId:null,decisionId:null},2);
  assert.equal(out.code,'FOCUS_HUMAN_DECISION_REQUIRED');
  out=run(root,'set-focus',{goalId:'final-design',goal:'Review the final design.',goalSource:'EXPLICIT_HUMAN',nextStep:'Review the full screen against Clear.',approvedReferenceId:'clear',decisionId:'use-clear'});
  assert.equal(out.code,'CURRENT_FOCUS_SET');

  out=run(root,'snapshot');
  assert.equal(out.currentGoal,'Review the final design.');
  assert.equal(out.approvedReference.id,'clear');
  assert.equal(out.authoritativeHumanDecision.id,'use-clear');
  assert.equal(out.nextStep,'Review the full screen against Clear.');
  out=run(root,'focus-gate',{goalId:'final-design',requireApprovedReference:true});
  assert.equal(out.code,'CURRENT_FOCUS_ALIGNED');
  out=run(root,'focus-gate',{goalId:'other',requireApprovedReference:false},2);
  assert.equal(out.code,'CURRENT_GOAL_MISMATCH');

  const deprecated={...confirmed,status:'DEPRECATED'};
  const replacement={
    id:'use-olive',topic:'visual-baseline',status:'CONFIRMED',
    summary:'Olive is now the approved baseline.',decidedAt:'2026-09-20',
    source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:'use-clear',artifactIds:[]
  };
  const changed={...context,humanDecisionSync:{
    schemaVersion:1,decisions:[deprecated,replacement],
    currentState:'Olive baseline is confirmed.',nextAction:'Re-anchor work to Olive.'
  }};
  await writeFile(join(root,'PROJECT_CONTEXT.json'),JSON.stringify(changed,null,2)+'\n','utf8');
  git(root,['add','PROJECT_CONTEXT.json']);
  git(root,['commit','-m','change decision']);
  out=run(root,'focus-gate',{goalId:'final-design',requireApprovedReference:true},2);
  assert.equal(out.code,'CURRENT_FOCUS_DECISION_STALE');
  assert.equal(out.requiredAction,'REANCHOR_FROM_HUMAN_DECISION_SYNC');
  const state=JSON.parse(await readFile(memoryPath,'utf8'));
  const recall=await evaluateArtifactRecall({root,state,referenceIds:['clear']});
  assert.equal(recall.code,'PAST_ARTIFACTS_VERIFIED');
  const focus=await evaluateFocusGate({
    root,state,goalId:'final-design',requireApprovedReference:true,
    humanDecisionSync:{activeDecisions:[replacement]}
  });
  assert.equal(focus.ok,false);
  assert.equal(focus.code,'CURRENT_FOCUS_DECISION_STALE');

  await writeFile(join(root,'PROJECT_CONTEXT.json'),JSON.stringify({...changed,projectName:'Other'},null,2)+'\n','utf8');
  out=run(root,'snapshot',null,2);
  assert.equal(out.code,'WORKING_MEMORY_CONTEXT_UNVERIFIED');

  console.log('project-working-memory selftest: PASS');
} finally {
  await rm(root,{recursive:true,force:true});
}
