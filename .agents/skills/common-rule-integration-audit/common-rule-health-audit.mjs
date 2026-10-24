#!/usr/bin/env node
import { access, readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, isAbsolute } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CONTRACTS = Object.freeze([
  {id:'human-ai-responsibility',required:'OPERATIONAL',docs:['CORE.md','OPERATIONS.md'],impl:[],tests:[],activationMode:'OPERATIONAL_AGENT_READ',enforcementScope:'OPERATIONAL',activationEvidence:[{path:'AGENTS.md',contains:'CORE.md'}]},
  {id:'project-context',required:'TECHNICAL',docs:['.agents/skills/handoff/SKILL.md'],impl:['.agents/skills/handoff/project-context-guard.mjs'],tests:['.agents/skills/handoff/project-context-guard-selftest.mjs'],activationMode:'OPERATIONAL_AGENT_CALL',enforcementScope:'LOCAL_WHEN_INVOKED',activationEvidence:[{path:'.agents/skills/handoff/SKILL.md',contains:'--turn-start'}]},
  {id:'canonical-contract',required:'TECHNICAL',docs:['.agents/skills/handoff/SKILL.md','.agents/skills/preflight-audit/SKILL.md','.agents/skills/final-pr-audit/SKILL.md'],impl:['.agents/skills/handoff/canonical-contract-gate.mjs'],tests:['.agents/skills/handoff/canonical-contract-gate-selftest.mjs'],activationMode:'TURN_START_PREFLIGHT_FINAL_AUDIT',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_PORTFOLIO_AUDIT',activationEvidence:[{path:'.agents/skills/handoff/project-context-guard.mjs',contains:'verifyCanonicalSources'},{path:'.agents/skills/preflight-audit/SKILL.md',contains:'canonical-contract-gate.mjs'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'CONTRACT_GATE=PASS'},{path:'tools/portfolio-governance-audit.mjs',contains:'canonicalContractCurrent'}]},
  {id:'human-decision-sync',required:'TECHNICAL',docs:['.agents/skills/handoff/SKILL.md','.agents/skills/preflight-audit/SKILL.md','.agents/skills/final-pr-audit/SKILL.md'],impl:['.agents/skills/handoff/human-decision-sync.mjs'],tests:['.agents/skills/handoff/human-decision-sync-selftest.mjs'],activationMode:'TURN_START_PREFLIGHT_FINAL_AUDIT',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_PORTFOLIO_AUDIT',activationEvidence:[{path:'.agents/skills/handoff/project-context-guard.mjs',contains:'validateHumanDecisionSync'},{path:'.agents/skills/preflight-audit/SKILL.md',contains:'human-decision-sync.mjs'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'human-decision-sync.mjs'},{path:'tools/portfolio-governance-audit.mjs',contains:'humanDecisionSyncCurrent'}]},
  {id:'ui-reference-authority',required:'TECHNICAL',docs:['AGENTS.md','OPERATIONS.md','.agents/skills/handoff/SKILL.md'],impl:['.agents/skills/handoff/ui-reference-registry.mjs','.agents/skills/handoff/ui-reference-manager.mjs','.agents/skills/handoff/canonical-contract-gate.mjs','.agents/skills/test-gate/ui-reference-reproduction-gate.mjs','.agents/skills/test-gate/visual-diff-engine.mjs'],tests:['.agents/skills/handoff/ui-reference-manager-selftest.mjs','.agents/skills/handoff/canonical-contract-gate-selftest.mjs','.agents/skills/test-gate/ui-reference-reproduction-gate-selftest.mjs','.agents/skills/test-gate/visual-diff-engine-selftest.mjs'],activationMode:'CANONICAL_CONTRACT_TURN_START_PREFLIGHT_STAGED_FINAL_AUDIT',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_PORTFOLIO_AUDIT',activationEvidence:[{path:'.agents/skills/handoff/canonical-contract-gate.mjs',contains:'verifyUiReferenceSources'},{path:'.agents/skills/handoff/SKILL.md',contains:'ui-reference-manager.mjs'},{path:'.agents/skills/handoff/SKILL.md',contains:'ui-reference-reproduction-gate.mjs'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'UI_MEASUREMENT'},{path:'tools/portfolio-governance-audit.mjs',contains:'uiReferenceCurrent'}]},
  {id:'project-working-memory',required:'TECHNICAL',docs:['.agents/skills/handoff/SKILL.md'],impl:['.agents/skills/handoff/project-working-memory.mjs'],tests:['.agents/skills/handoff/project-working-memory-selftest.mjs'],activationMode:'OPERATIONAL_AGENT_CALL',enforcementScope:'LOCAL_WHEN_INVOKED',activationEvidence:[{path:'.agents/skills/handoff/SKILL.md',contains:'project-working-memory.mjs'},{path:'.agents/skills/handoff/SKILL.md',contains:'artifact-recall'}]},
  {id:'anti-loop-stagnation',required:'TECHNICAL',docs:['learnings/L-0004.md','OPERATIONS.md'],impl:['.agents/skills/preflight-audit/stagnation-watch.mjs'],tests:['.agents/skills/preflight-audit/stagnation-watch-selftest.mjs'],activationMode:'OPERATIONAL_AGENT_CALL',enforcementScope:'LOCAL_WHEN_INVOKED',activationEvidence:[{path:'AGENTS.md',contains:'stagnation-watch.mjs --response-intent terminate'},{path:'learnings/L-0004.md',contains:'--interaction-signal'}]},
  {id:'long-task-wait',required:'TECHNICAL',docs:['.agents/skills/long-task-wait/SKILL.md','.agents/skills/long-task-wait/claude-job/README.md'],impl:['.agents/skills/long-task-wait/bounded-task-wait.mjs','.agents/skills/long-task-wait/turn-wait-budget.mjs','.agents/skills/long-task-wait/claude-job/run-claude-job.ps1','.agents/skills/long-task-wait/claude-job/claude-job-runner.ps1','.agents/skills/long-task-wait/claude-job/check-claude-job.ps1'],tests:['.agents/skills/long-task-wait/long-task-wait-selftest.mjs','.agents/skills/long-task-wait/claude-job-selftest.mjs','.agents/skills/long-task-wait/claude-job-runtime-selftest.mjs','.agents/skills/long-task-wait/claude-job/claude-job-runner-selftest.ps1','.agents/skills/long-task-wait/claude-job-launcher-selftest.mjs','.agents/skills/long-task-wait/claude-job-launcher-prompt-envelope-selftest.mjs'],activationMode:'OPERATIONAL_AGENT_CALL_WITH_INSTRUCTION_CLARITY',enforcementScope:'LOCAL_WHEN_INVOKED',activationEvidence:[{path:'.agents/skills/long-task-wait/SKILL.md',contains:'InstructionClarityFile'},{path:'.agents/skills/long-task-wait/claude-job/run-claude-job.ps1',contains:'instruction-clarity-gate.mjs'},{path:'.agents/skills/long-task-wait/claude-job/claude-job-runner.ps1',contains:'instructionClarity'}]},
  {id:'common-rule-integration',required:'OPERATIONAL',docs:['.agents/skills/common-rule-integration-audit/SKILL.md','OPERATIONS.md','learnings/L-0003.md'],impl:['.agents/skills/common-rule-integration-audit/common-rule-health-audit.mjs'],tests:['.agents/skills/common-rule-integration-audit/common-rule-health-audit-selftest.mjs'],activationMode:'MACHINE_NESTED_IN_PORTFOLIO_AUDIT',enforcementScope:'PORTFOLIO_AUDIT_CALL',activationEvidence:[{path:'tools/portfolio-governance-audit.mjs',contains:'collectRuleHealth'},{path:'.agents/skills/common-rule-integration-audit/SKILL.md',contains:'common-rule-health-audit.mjs'}]},
  {id:'staged-reality-checks',required:'TECHNICAL',docs:['AGENTS.md','OPERATIONS.md','.agents/skills/test-gate/SKILL.md','.agents/skills/final-pr-audit/SKILL.md'],impl:['.agents/skills/test-gate/staged-reality-gate.mjs','.agents/skills/test-gate/ui-reference-reproduction-gate.mjs','.agents/skills/test-gate/visual-diff-engine.mjs'],tests:['.agents/skills/test-gate/staged-reality-gate-selftest.mjs','.agents/skills/test-gate/ui-reference-reproduction-gate-selftest.mjs','.agents/skills/test-gate/visual-diff-engine-selftest.mjs'],activationMode:'EARLY_MILESTONE_FINAL_REALITY_WITH_FINAL_AUDIT_RECEIVER',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_FINAL_AUDIT_PLUS_PORTFOLIO_AUDIT',activationEvidence:[{path:'AGENTS.md',contains:'STAGED_REALITY_GATE_REQUIRED=YES'},{path:'.agents/skills/test-gate/SKILL.md',contains:'STAGED_REALITY_GATE_REQUIRED=YES'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'FINAL_REALITY_CHECK_REQUIRED=YES'},{path:'tools/portfolio-governance-audit.mjs',contains:'stagedRealityCurrent'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'UI_MEASUREMENT'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'ACTOR_RECORD_SEPARATION_REQUIRED'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'FOUNDATION_GOVERNANCE'}]},
  {id:'ui-browser-lifecycle',required:'TECHNICAL',docs:['.agents/skills/preflight-audit/SKILL.md','.agents/skills/test-gate/SKILL.md','OPERATIONS.md'],impl:['.agents/skills/test-gate/ui-browser-lifecycle.mjs','.agents/skills/test-gate/staged-reality-gate.mjs'],tests:['.agents/skills/test-gate/ui-browser-lifecycle-selftest.mjs','.agents/skills/test-gate/staged-reality-gate-selftest.mjs'],activationMode:'PREFLIGHT_ORPHAN_SCAN_FINALLY_CLEANUP_FINAL_UI_RECEIPT',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_STAGED_FINAL',activationEvidence:[{path:'.agents/skills/preflight-audit/SKILL.md',contains:'ui-browser-lifecycle.mjs orphan-cleanup'},{path:'.agents/skills/test-gate/SKILL.md',contains:'UI_BROWSER_CLEANUP_REQUIRED=YES'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'UI_BROWSER_CLEANUP'},{path:'OPERATIONS.md',contains:'start -> use -> finally -> cleanup'}]},
  {id:'human-visual-review-readiness',required:'TECHNICAL',docs:['AGENTS.md','.agents/skills/test-gate/SKILL.md','OPERATIONS.md'],impl:['.agents/skills/test-gate/human-visual-review-gate.mjs','.agents/skills/test-gate/staged-reality-gate.mjs','.agents/skills/test-gate/real-device-preparation-gate.mjs'],tests:['.agents/skills/test-gate/human-visual-review-gate-selftest.mjs','.agents/skills/test-gate/staged-reality-gate-selftest.mjs','.agents/skills/test-gate/real-device-preparation-gate-selftest.mjs'],activationMode:'BEFORE_HUMAN_UI_VISUAL_CONFIRMATION_AND_REAL_DEVICE_PREP',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_AGENT_MANDATORY_ENTRY',activationEvidence:[{path:'AGENTS.md',contains:'HUMAN_VISUAL_REVIEW_READY_REQUIRED=YES'},{path:'.agents/skills/test-gate/SKILL.md',contains:'HUMAN_VISUAL_REVIEW_READY_REQUIRED=YES'},{path:'.agents/skills/test-gate/SKILL.md',contains:'human-visual-review-gate.mjs'},{path:'OPERATIONS.md',contains:'HUMAN_VISUAL_REVIEW_READY_REQUIRED=YES'},{path:'.agents/skills/test-gate/human-visual-review-gate.mjs',contains:'HUMAN_VISUAL_REVIEW_READY_V1'},{path:'.agents/skills/test-gate/real-device-preparation-gate.mjs',contains:'HUMAN_VISUAL_REVIEW_RECEIPT_REQUIRED'}]},
  {id:'executable-implementation-routing',required:'TECHNICAL',docs:['.agents/skills/preflight-audit/SKILL.md','.agents/skills/final-pr-audit/SKILL.md','learnings/L-0006.md'],impl:['.agents/skills/preflight-audit/implementation-runner.mjs','.agents/skills/preflight-audit/implementation-route-receipt.mjs','.agents/skills/preflight-audit/implementation-orchestrator.mjs','.agents/skills/preflight-audit/instruction-clarity-gate.mjs','.agents/skills/preflight-audit/work-start-guard.mjs'],tests:['.agents/skills/preflight-audit/implementation-runner-selftest.mjs','.agents/skills/preflight-audit/implementation-route-receipt-selftest.mjs','.agents/skills/preflight-audit/implementation-orchestrator-selftest.mjs','.agents/skills/preflight-audit/instruction-clarity-gate-selftest.mjs','.agents/skills/preflight-audit/work-start-guard-selftest.mjs'],activationMode:'WORK_START_INSTRUCTION_CLARITY_PLUS_FINAL_PR_AUDIT_ROUTE_VERIFICATION',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_FINAL_AUDIT',activationEvidence:[{path:'.agents/skills/preflight-audit/implementation-orchestrator.mjs',contains:'INSTRUCTION_CLARITY_NOT_CONFIRMED'},{path:'.agents/skills/preflight-audit/implementation-route-receipt.mjs',contains:'INSTRUCTION_CLARITY_EVIDENCE_MISSING_OR_FAILED'},{path:'.agents/skills/preflight-audit/implementation-route-receipt.mjs',contains:'verifyFinalReceipt'},{path:'.agents/skills/preflight-audit/implementation-runner.mjs',contains:'FORBIDDEN_SCOPE_VIOLATION'},{path:'.agents/skills/preflight-audit/SKILL.md',contains:'instruction-clarity-gate.mjs'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'IMPLEMENTATION_ROUTE_RECEIPT_REQUIRED=YES'}]},
  {id:'approval-scope',required:'TECHNICAL',docs:['.agents/skills/handoff/SKILL.md','OPERATIONS.md','.agents/skills/final-pr-audit/SKILL.md'],impl:['.agents/skills/handoff/approval-scope-gate.mjs'],tests:['.agents/skills/handoff/approval-scope-gate-selftest.mjs'],activationMode:'HUMAN_DECISION_SYNC_PLUS_FINAL_AUDIT',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_FINAL_AUDIT',activationEvidence:[{path:'.agents/skills/handoff/human-decision-sync.mjs',contains:'validateApprovalScopeGate'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'DESIGN_CANONICAL_PROMOTION_REQUIRED=WHEN_CONFIGURED'}]},
  {id:'canonical-promotion',required:'TECHNICAL',docs:['.agents/skills/handoff/SKILL.md','OPERATIONS.md','.agents/skills/final-pr-audit/SKILL.md'],impl:['.agents/skills/handoff/canonical-promotion-gate.mjs','.agents/skills/handoff/canonical-contract-gate.mjs'],tests:['.agents/skills/handoff/canonical-promotion-gate-selftest.mjs','.agents/skills/handoff/canonical-contract-gate-selftest.mjs'],activationMode:'CANONICAL_CONTRACT_PLUS_FINAL_AUDIT',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_FINAL_AUDIT',activationEvidence:[{path:'.agents/skills/handoff/canonical-contract-gate.mjs',contains:'validateCanonicalPromotionGate'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'DESIGN_CANONICAL_PROMOTION_REQUIRED=WHEN_CONFIGURED'}]},
  {id:'research-gate',required:'TECHNICAL',docs:['.agents/skills/preflight-audit/SKILL.md','OPERATIONS.md','.agents/skills/final-pr-audit/SKILL.md'],impl:['.agents/skills/preflight-audit/research-gate.mjs'],tests:['.agents/skills/preflight-audit/research-gate-selftest.mjs'],activationMode:'PROJECT_INTAKE_FOLLOWED_BY_ORCHESTRATOR_AND_RECEIPT_BINDING',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_FINAL_AUDIT',activationEvidence:[{path:'.agents/skills/preflight-audit/implementation-orchestrator.mjs',contains:'RESEARCH_GATE_BLOCKED'},{path:'.agents/skills/preflight-audit/implementation-route-receipt.mjs',contains:'RESEARCH_EVIDENCE_MISSING_OR_FAILED'},{path:'.agents/skills/preflight-audit/SKILL.md',contains:'research-gate.mjs'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'RESEARCH_EVIDENCE_MISSING_OR_FAILED'}]},
  {id:'environment-lifecycle',required:'OPERATIONAL',docs:['.agents/skills/preflight-audit/SKILL.md'],impl:['.agents/skills/preflight-audit/environment-lifecycle-audit.mjs'],tests:['.agents/skills/preflight-audit/environment-lifecycle-audit-selftest.mjs'],activationMode:'OPERATIONAL_AGENT_CALL',enforcementScope:'LOCAL_WHEN_INVOKED',activationEvidence:[{path:'.agents/skills/preflight-audit/SKILL.md',contains:'environment-lifecycle-audit.mjs'}]},
]);

async function exists(p){try{await access(p);return true;}catch{return false;}}
function fail(code,detail={}){return {ok:false,code,...detail};}
async function ruleMarkdown(root){
  const files=[];
  for(const f of ['AGENTS.md','CORE.md','OPERATIONS.md','PROJECT_COMPLETION.md','.agents/skills/README.md']) if(await exists(join(root,f))) files.push(f);
  for(const d of ['learnings','roles']){
    const p=join(root,d); if(!await exists(p)) continue;
    for(const e of await readdir(p,{withFileTypes:true})) if(e.isFile()&&e.name.endsWith('.md')) files.push(d+'/'+e.name);
  }
  const s=join(root,'.agents','skills');
  if(await exists(s)) for(const e of await readdir(s,{withFileTypes:true})) if(e.isDirectory()&&await exists(join(s,e.name,'SKILL.md'))) files.push('.agents/skills/'+e.name+'/SKILL.md');
  return [...new Set(files)].sort();
}
function paras(text){
  const chunks=String(text).replaceAll('\r\n','\n').split(/\n\s*\n/u);
  return chunks.map(x=>x.replace(/\s+/gu,' ').trim()).filter(x=>x.length>=120&&!x.startsWith('#')&&!x.startsWith('```'));
}

const FOUNDATION_REPO='311experience-gisikoubou/ai-dev-foundation';
const FOUNDATION_REMOTE=/^(?:https:\/\/github\.com\/|git@github\.com:)311experience-gisikoubou\/ai-dev-foundation(?:\.git)?$/i;
const GIT_SHA=/^[a-f0-9]{40}$/;

function gitOutput(root,args){
  const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});
  return r.error||r.status!==0 ? null : r.stdout.trim();
}
function samePath(a,b){
  return process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
}
async function pinnedFoundationSource(foundationRoot,foundationHead){
  if(typeof foundationRoot!=='string'||!isAbsolute(foundationRoot)||!GIT_SHA.test(foundationHead||''))
    return fail('FOUNDATION_SOURCE_PIN_REQUIRED');
  const base=resolve(foundationRoot);
  let ctx,real;
  try{
    real=await realpath(base);
    if(!samePath(base,real))return fail('FOUNDATION_SOURCE_LINKED_ROOT');
    const p=join(base,'PROJECT_CONTEXT.json');
    const projectStat=await lstat(p);
    if(!projectStat.isFile()||projectStat.isSymbolicLink())return fail('FOUNDATION_SOURCE_CONTEXT_UNSAFE');
    ctx=JSON.parse(await readFile(p,'utf8'));
  }catch{return fail('FOUNDATION_SOURCE_CONTEXT_UNAVAILABLE');}
  if(ctx?.thisRepository!==FOUNDATION_REPO||
     ctx?.projectRootRepository!==FOUNDATION_REPO||
     ctx?.repositoryRole!=='ROOT')return fail('FOUNDATION_SOURCE_REPOSITORY_MISMATCH');
  const remote=gitOutput(base,['remote','get-url','origin']);
  const top=gitOutput(base,['rev-parse','--show-toplevel']);
  const head=gitOutput(base,['rev-parse','HEAD']);
  if(!remote||!FOUNDATION_REMOTE.test(remote)||!top||!samePath(top,base)||
     head!==foundationHead)return fail('FOUNDATION_SOURCE_GIT_IDENTITY_MISMATCH');
  for(const file of ['PROJECT_CONTEXT.json','tools/portfolio-governance-audit.mjs']){
    const full=join(base,file);
    let stat;
    try{stat=await lstat(full);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!samePath(await realpath(full),full))
      return fail('FOUNDATION_SOURCE_FILE_UNSAFE',{file});}
    catch{return fail('FOUNDATION_SOURCE_FILE_MISSING',{file});}
    if(gitOutput(base,['ls-files','--error-unmatch','--',file])!==file)
      return fail('FOUNDATION_SOURCE_UNTRACKED',{file});
  }
  // Both staged AND worktree changes to the external central contract fail closed.
  const dirty=gitOutput(base,['status','--porcelain=v1','--','PROJECT_CONTEXT.json','tools/portfolio-governance-audit.mjs']);
  if(dirty===null||dirty!=='')return fail('FOUNDATION_SOURCE_DIRTY');
  return {ok:true,root:base,head};
}

const REVIEW_LONG_FILE_LINES=500;
const STOP_LONG_FILE_LINES=800;
export async function auditRuleHealth({root,contracts=CONTRACTS,foundationRoot=null,foundationHead=null}={}){
  const base=resolve(root??process.cwd());
  if((foundationRoot===null)!==(foundationHead===null))return fail('FOUNDATION_SOURCE_PIN_REQUIRED');
  const external=foundationRoot===null?null:await pinnedFoundationSource(foundationRoot,foundationHead);
  if(external&&!external.ok)return external;
  if(external&&samePath(external.root,base))return fail('FOUNDATION_SOURCE_MUST_BE_SEPARATE');
  const rows=[];
  for(const c of contracts){
    const docsMissing=[],implementationMissing=[],testsMissing=[],activationMissing=[];
    for(const p of c.docs??[]) if(!await exists(join(base,p))) docsMissing.push(p);
    for(const p of c.impl??[]) if(!await exists(join(base,p))) implementationMissing.push(p);
    for(const p of c.tests??[]) if(!await exists(join(base,p))) testsMissing.push(p);
    for(const evidence of c.activationEvidence??[]){
      const path=join(external&&evidence.path==='tools/portfolio-governance-audit.mjs'?external.root:base,evidence.path);
      if(!await exists(path)){activationMissing.push({...evidence,reason:'FILE_MISSING'});continue;}
      const text=await readFile(path,'utf8');
      if(!text.includes(evidence.contains)) activationMissing.push({...evidence,reason:'MARKER_MISSING'});
    }
    let state='OPERATIONAL';
    if(docsMissing.length) state='MISSING';
    else if(c.required==='TECHNICAL') state=(implementationMissing.length||testsMissing.length||activationMissing.length)?'DECLARATION_ONLY':'ENFORCED';
    else if(activationMissing.length) state='DECLARATION_ONLY';
    rows.push({
      id:c.id,
      required:c.required,
      state,
      activationMode:c.activationMode??'UNSPECIFIED',
      enforcementScope:c.enforcementScope??'UNSPECIFIED',
      docsMissing,
      implementationMissing,
      testsMissing,
      activationMissing,
    });
  }
  const files=await ruleMarkdown(base), stats=[], map=new Map(), deprecated=[];
  for(const f of files){
    const t=await readFile(join(base,f),'utf8'), lines=t.replaceAll('\r\n','\n').split('\n').length;
    stats.push({file:f,lineCount:lines,long:lines>REVIEW_LONG_FILE_LINES,hardLong:lines>STOP_LONG_FILE_LINES});
    const generated=/^\s*<!--\s*GENERATED\b/iu.test(t);
    if(!generated) for(const p of paras(t)){const k=p.toLowerCase();const a=map.get(k)??[];a.push(f);map.set(k,a);}
    if(/(?:^|\n)\s*(?:Status\s*:\s*(?:deprecated|obsolete)|#+\s*(?:Deprecated|Obsolete|蟒・ｭ｢蛟呵｣忿髱樊耳螂ｨ)\b)/iu.test(t)) deprecated.push(f);
  }
  const duplicates=[];
  for(const [p,where] of map){const u=[...new Set(where)];if(u.length>1)duplicates.push({files:u,preview:p.slice(0,180)});}
  const indexPath=join(base,'learnings','INDEX.md'),index=await exists(indexPath)?await readFile(indexPath,'utf8'):'';
  const unindexed=[];
  const ld=join(base,'learnings');
  if(await exists(ld)) for(const e of await readdir(ld,{withFileTypes:true})) if(e.isFile()&&/^L-\d+\.md$/u.test(e.name)&&!index.includes(e.name.replace(/\.md$/u,''))) unindexed.push('learnings/'+e.name);
  const readmePath=join(base,'.agents','skills','README.md'),readme=await exists(readmePath)?await readFile(readmePath,'utf8'):'';
  const unlisted=[];
  const sd=join(base,'.agents','skills');
  if(await exists(sd)) for(const e of await readdir(sd,{withFileTypes:true})) if(e.isDirectory()&&await exists(join(sd,e.name,'SKILL.md'))&&!readme.includes(e.name)) unlisted.push(e.name);
  const declarationOnly=rows.filter(x=>x.state==='DECLARATION_ONLY'),missing=rows.filter(x=>x.state==='MISSING'),longFiles=stats.filter(x=>x.long),hardLongFiles=stats.filter(x=>x.hardLong);
  const activationFailures=rows.filter(x=>x.activationMissing.length>0);
  const ok=declarationOnly.length===0&&missing.length===0&&unindexed.length===0&&hardLongFiles.length===0&&duplicates.length===0;
  return {ok,code:ok?'COMMON_RULE_HEALTH_PASS':'COMMON_RULE_HEALTH_STOP',schemaVersion:1,externalPortfolioSource:external?{repository:FOUNDATION_REPO,head:external.head,scope:'CENTRAL_SOURCE_MARKERS_ONLY',centralAuditExecuted:false}:null,limits:{reviewLongFileLines:REVIEW_LONG_FILE_LINES,stopLongFileLines:STOP_LONG_FILE_LINES},totals:{contracts:rows.length,enforced:rows.filter(x=>x.state==='ENFORCED').length,operational:rows.filter(x=>x.state==='OPERATIONAL').length,declarationOnly:declarationOnly.length,missing:missing.length,activationFailures:activationFailures.length,markdownFiles:files.length,markdownLines:stats.reduce((n,x)=>n+x.lineCount,0),longFiles:longFiles.length,hardLongFiles:hardLongFiles.length,duplicateParagraphs:duplicates.length,unindexedLearnings:unindexed.length,unlistedSkills:unlisted.length},reviewRecommended:Boolean(declarationOnly.length||missing.length||longFiles.length||duplicates.length||unindexed.length||unlisted.length),contracts:rows,inventory:{longFiles,hardLongFiles,duplicateParagraphs:duplicates,unindexedLearnings:unindexed,unlistedSkills:unlisted,deprecatedCandidates:[...new Set(deprecated)].sort()},rule:'ENFORCED means implementation, test, and declared activation evidence were found inside the stated enforcementScope; it never implies universal browser auto-trigger. No automatic rule deletion or merge. Files over '+REVIEW_LONG_FILE_LINES+' Markdown lines are review evidence; files over '+STOP_LONG_FILE_LINES+' Markdown lines or exact duplicated long rule paragraphs force STOP until split/consolidated.'};
}
function args(argv){let root=process.cwd(),pretty=false,foundationRoot=null,foundationHead=null;for(let i=0;i<argv.length;i++){if(argv[i]==='--root'&&argv[i+1])root=argv[++i];else if(argv[i]==='--foundation-root'&&argv[i+1])foundationRoot=argv[++i];else if(argv[i]==='--foundation-head'&&argv[i+1])foundationHead=argv[++i];else if(argv[i]==='--pretty')pretty=true;else return fail('ARGUMENT_INVALID');}return {ok:true,root:resolve(root),pretty,foundationRoot,foundationHead};}
async function main(){const a=args(process.argv.slice(2));if(!a.ok){console.log(JSON.stringify(a));process.exitCode=2;return;}try{const o=await auditRuleHealth({root:a.root,foundationRoot:a.foundationRoot,foundationHead:a.foundationHead});console.log(JSON.stringify(o,null,a.pretty?2:0));console.error('COMMON_RULE_HEALTH='+(o.ok?'PASS':'STOP')+' declarationOnly='+(o.totals?.declarationOnly??'unverified')+' markdownLines='+(o.totals?.markdownLines??'unverified'));if(!o.ok)process.exitCode=2;}catch(e){console.log(JSON.stringify(fail(e?.message||'COMMON_RULE_HEALTH_INTERNAL_ERROR')));process.exitCode=2;}}
export { CONTRACTS };
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();