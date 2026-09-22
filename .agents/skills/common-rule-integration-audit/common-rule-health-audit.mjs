#!/usr/bin/env node
import { access, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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
  {id:'long-task-wait',required:'TECHNICAL',docs:['.agents/skills/long-task-wait/SKILL.md','.agents/skills/long-task-wait/claude-job/README.md'],impl:['.agents/skills/long-task-wait/bounded-task-wait.mjs','.agents/skills/long-task-wait/turn-wait-budget.mjs','.agents/skills/long-task-wait/claude-job/run-claude-job.ps1','.agents/skills/long-task-wait/claude-job/claude-job-runner.ps1','.agents/skills/long-task-wait/claude-job/check-claude-job.ps1'],tests:['.agents/skills/long-task-wait/long-task-wait-selftest.mjs','.agents/skills/long-task-wait/claude-job-selftest.mjs'],activationMode:'OPERATIONAL_AGENT_CALL',enforcementScope:'LOCAL_WHEN_INVOKED',activationEvidence:[{path:'.agents/skills/long-task-wait/SKILL.md',contains:'bounded-task-wait.mjs'},{path:'.agents/skills/long-task-wait/SKILL.md',contains:'claude-job/'}]},
  {id:'common-rule-integration',required:'OPERATIONAL',docs:['.agents/skills/common-rule-integration-audit/SKILL.md','OPERATIONS.md','learnings/L-0003.md'],impl:['.agents/skills/common-rule-integration-audit/common-rule-health-audit.mjs'],tests:['.agents/skills/common-rule-integration-audit/common-rule-health-audit-selftest.mjs'],activationMode:'MACHINE_NESTED_IN_PORTFOLIO_AUDIT',enforcementScope:'PORTFOLIO_AUDIT_CALL',activationEvidence:[{path:'tools/portfolio-governance-audit.mjs',contains:'collectRuleHealth'},{path:'.agents/skills/common-rule-integration-audit/SKILL.md',contains:'common-rule-health-audit.mjs'}]},
  {id:'staged-reality-checks',required:'TECHNICAL',docs:['AGENTS.md','OPERATIONS.md','.agents/skills/test-gate/SKILL.md','.agents/skills/final-pr-audit/SKILL.md'],impl:['.agents/skills/test-gate/staged-reality-gate.mjs','.agents/skills/test-gate/ui-reference-reproduction-gate.mjs','.agents/skills/test-gate/visual-diff-engine.mjs'],tests:['.agents/skills/test-gate/staged-reality-gate-selftest.mjs','.agents/skills/test-gate/ui-reference-reproduction-gate-selftest.mjs','.agents/skills/test-gate/visual-diff-engine-selftest.mjs'],activationMode:'EARLY_MILESTONE_FINAL_REALITY_WITH_FINAL_AUDIT_RECEIVER',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_FINAL_AUDIT_PLUS_PORTFOLIO_AUDIT',activationEvidence:[{path:'AGENTS.md',contains:'STAGED_REALITY_GATE_REQUIRED=YES'},{path:'.agents/skills/test-gate/SKILL.md',contains:'STAGED_REALITY_GATE_REQUIRED=YES'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'FINAL_REALITY_CHECK_REQUIRED=YES'},{path:'tools/portfolio-governance-audit.mjs',contains:'stagedRealityCurrent'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'UI_MEASUREMENT'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'ACTOR_RECORD_SEPARATION_REQUIRED'},{path:'.agents/skills/test-gate/staged-reality-gate.mjs',contains:'FOUNDATION_GOVERNANCE'}]},
  {id:'executable-implementation-routing',required:'TECHNICAL',docs:['.agents/skills/preflight-audit/SKILL.md','.agents/skills/final-pr-audit/SKILL.md','learnings/L-0006.md'],impl:['.agents/skills/preflight-audit/implementation-runner.mjs','.agents/skills/preflight-audit/implementation-route-receipt.mjs','.agents/skills/preflight-audit/implementation-orchestrator.mjs','.agents/skills/preflight-audit/work-start-guard.mjs'],tests:['.agents/skills/preflight-audit/implementation-runner-selftest.mjs','.agents/skills/preflight-audit/implementation-route-receipt-selftest.mjs','.agents/skills/preflight-audit/implementation-orchestrator-selftest.mjs','.agents/skills/preflight-audit/work-start-guard-selftest.mjs'],activationMode:'WORK_START_PLUS_FINAL_PR_AUDIT_ROUTE_VERIFICATION',enforcementScope:'LOCAL_WHEN_INVOKED_PLUS_FINAL_AUDIT',activationEvidence:[{path:'.agents/skills/preflight-audit/implementation-route-receipt.mjs',contains:'verifyFinalReceipt'},{path:'.agents/skills/preflight-audit/implementation-runner.mjs',contains:'FORBIDDEN_SCOPE_VIOLATION'},{path:'.agents/skills/preflight-audit/SKILL.md',contains:'work-start-guard.mjs'},{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'IMPLEMENTATION_ROUTE_RECEIPT_REQUIRED=YES'}]},
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
export async function auditRuleHealth({root,contracts=CONTRACTS}={}){
  const base=resolve(root??process.cwd());
  const rows=[];
  for(const c of contracts){
    const docsMissing=[],implementationMissing=[],testsMissing=[],activationMissing=[];
    for(const p of c.docs??[]) if(!await exists(join(base,p))) docsMissing.push(p);
    for(const p of c.impl??[]) if(!await exists(join(base,p))) implementationMissing.push(p);
    for(const p of c.tests??[]) if(!await exists(join(base,p))) testsMissing.push(p);
    for(const evidence of c.activationEvidence??[]){
      const path=join(base,evidence.path);
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
    stats.push({file:f,lineCount:lines,long:lines>500});
    const generated=/^\s*<!--\s*GENERATED\b/iu.test(t);
    if(!generated) for(const p of paras(t)){const k=p.toLowerCase();const a=map.get(k)??[];a.push(f);map.set(k,a);}
    if(/(?:^|\n)\s*(?:Status\s*:\s*(?:deprecated|obsolete)|#+\s*(?:Deprecated|Obsolete|廃止候補|非推奨)\b)/iu.test(t)) deprecated.push(f);
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
  const declarationOnly=rows.filter(x=>x.state==='DECLARATION_ONLY'),missing=rows.filter(x=>x.state==='MISSING'),longFiles=stats.filter(x=>x.long);
  const activationFailures=rows.filter(x=>x.activationMissing.length>0);
  const ok=declarationOnly.length===0&&missing.length===0&&unindexed.length===0;
  return {ok,code:ok?'COMMON_RULE_HEALTH_PASS':'COMMON_RULE_HEALTH_STOP',schemaVersion:1,totals:{contracts:rows.length,enforced:rows.filter(x=>x.state==='ENFORCED').length,operational:rows.filter(x=>x.state==='OPERATIONAL').length,declarationOnly:declarationOnly.length,missing:missing.length,activationFailures:activationFailures.length,markdownFiles:files.length,markdownLines:stats.reduce((n,x)=>n+x.lineCount,0),longFiles:longFiles.length,duplicateParagraphs:duplicates.length,unindexedLearnings:unindexed.length,unlistedSkills:unlisted.length},reviewRecommended:Boolean(declarationOnly.length||missing.length||longFiles.length||duplicates.length||unindexed.length||unlisted.length),contracts:rows,inventory:{longFiles,duplicateParagraphs:duplicates,unindexedLearnings:unindexed,unlistedSkills:unlisted,deprecatedCandidates:[...new Set(deprecated)].sort()},rule:'ENFORCED means implementation, test, and declared activation evidence were found inside the stated enforcementScope; it never implies universal browser auto-trigger. No automatic rule deletion or merge.'};
}
function args(argv){let root=process.cwd(),pretty=false;for(let i=0;i<argv.length;i++){if(argv[i]==='--root'&&argv[i+1])root=argv[++i];else if(argv[i]==='--pretty')pretty=true;else return fail('ARGUMENT_INVALID');}return {ok:true,root:resolve(root),pretty};}
async function main(){const a=args(process.argv.slice(2));if(!a.ok){console.log(JSON.stringify(a));process.exitCode=2;return;}try{const o=await auditRuleHealth({root:a.root});console.log(JSON.stringify(o,null,a.pretty?2:0));console.error('COMMON_RULE_HEALTH='+(o.ok?'PASS':'STOP')+' declarationOnly='+o.totals.declarationOnly+' markdownLines='+o.totals.markdownLines);if(!o.ok)process.exitCode=2;}catch(e){console.log(JSON.stringify(fail(e?.message||'COMMON_RULE_HEALTH_INTERNAL_ERROR')));process.exitCode=2;}}
export { CONTRACTS };
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
