#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg=process.argv[2];
if(!arg) throw new Error('audit path required');
const {auditRuleHealth,CONTRACTS}=await import(pathToFileURL(resolve(arg)).href);
const root=await mkdtemp(join(tmpdir(),'rule-health-selftest-'));
async function put(path,text){await mkdir(join(root,...path.split('/').slice(0,-1)),{recursive:true});await writeFile(join(root,...path.split('/')),text,'utf8');}
const contract={id:'x',required:'TECHNICAL',docs:['RULE.md'],impl:['impl.mjs'],tests:['test.mjs']};
try{
  await put('RULE.md','# Rule\n\nThis repeated policy paragraph intentionally exceeds the duplicate-detection threshold. It describes the same operational rule in exactly the same words so the inventory can prove that duplicated long rule text is detected across canonical Markdown files without changing either source automatically.\n');
  await put('impl.mjs','export const ok=true;\n');
  await put('test.mjs','console.log("pass");\n');
  await put('AGENTS.md','# Agents\n');
  await put('CORE.md','# Core\n\nThis repeated policy paragraph intentionally exceeds the duplicate-detection threshold. It describes the same operational rule in exactly the same words so the inventory can prove that duplicated long rule text is detected across canonical Markdown files without changing either source automatically.\n');
  await put('OPERATIONS.md','# Operations\n\nThis repeated policy paragraph intentionally exceeds the duplicate-detection threshold. It describes the same operational rule in exactly the same words so the inventory can prove that duplicated long rule text is detected across canonical Markdown files without changing either source automatically.\n');
  await put('PROJECT_COMPLETION.md','# Completion\n');
  await put('.agents/skills/README.md','# Skills\n\n- demo\n');
  await put('.agents/skills/demo/SKILL.md','# Demo\n');
  await put('learnings/INDEX.md','# Index\n\n- L-0001\n');
  await put('learnings/L-0001.md','# Learning\n');
  await put('roles/GPT.md','# Role\n');

  let out=await auditRuleHealth({root,contracts:[contract]});
  assert.equal(out.ok,true);
  assert.equal(out.contracts[0].state,'ENFORCED');
  assert.equal(out.totals.declarationOnly,0);
  assert.equal(out.totals.unindexedLearnings,0);
  assert.equal(out.totals.unlistedSkills,0);
  assert(out.totals.duplicateParagraphs>=1);
  assert.equal(out.reviewRecommended,true);

  const activated={...contract,id:'activated',activationMode:'MACHINE_CALL',enforcementScope:'LOCAL_WHEN_INVOKED',activationEvidence:[{path:'RULE.md',contains:'operational rule'}]};
  out=await auditRuleHealth({root,contracts:[activated]});
  assert.equal(out.ok,true);
  assert.equal(out.contracts[0].state,'ENFORCED');
  assert.equal(out.contracts[0].activationMode,'MACHINE_CALL');
  assert.equal(out.contracts[0].enforcementScope,'LOCAL_WHEN_INVOKED');
  assert.equal(out.contracts[0].activationMissing.length,0);

  const missingTrigger={...activated,activationEvidence:[{path:'RULE.md',contains:'not-present-trigger'}]};
  out=await auditRuleHealth({root,contracts:[missingTrigger]});
  assert.equal(out.ok,false);
  assert.equal(out.contracts[0].state,'DECLARATION_ONLY');
  assert.equal(out.totals.activationFailures,1);
  assert.equal(out.contracts[0].activationMissing[0].reason,'MARKER_MISSING');

  const routingContract=CONTRACTS.find(c=>c.id==='executable-implementation-routing');
  assert(routingContract,'executable implementation routing contract must be registered');
  assert.equal(routingContract.required,'TECHNICAL');
  assert(routingContract.impl.includes('.agents/skills/preflight-audit/implementation-orchestrator.mjs'));
  assert(routingContract.tests.includes('.agents/skills/preflight-audit/implementation-orchestrator-selftest.mjs'));
  const finalAuditActivation=routingContract.activationEvidence.find(e=>e.path==='.agents/skills/final-pr-audit/SKILL.md');
  assert.equal(finalAuditActivation?.contains,'IMPLEMENTATION_ROUTE_RECEIPT_REQUIRED=YES');

  const routingActivation={...contract,id:'routing-activation',activationEvidence:[{path:'.agents/skills/final-pr-audit/SKILL.md',contains:'IMPLEMENTATION_ROUTE_RECEIPT_REQUIRED=YES'}]};
  await put('.agents/skills/final-pr-audit/SKILL.md','# Final audit\n\nIMPLEMENTATION_ROUTE_RECEIPT_REQUIRED=YES\n');
  out=await auditRuleHealth({root,contracts:[routingActivation]});
  assert.equal(out.ok,true);
  assert.equal(out.contracts[0].state,'ENFORCED');
  await put('.agents/skills/final-pr-audit/SKILL.md','# Final audit\n');
  out=await auditRuleHealth({root,contracts:[routingActivation]});
  assert.equal(out.ok,false);
  assert.equal(out.contracts[0].state,'DECLARATION_ONLY');
  assert.equal(out.contracts[0].activationMissing[0].reason,'MARKER_MISSING');

  await rm(join(root,'impl.mjs'));
  out=await auditRuleHealth({root,contracts:[contract]});
  assert.equal(out.ok,false);
  assert.equal(out.contracts[0].state,'DECLARATION_ONLY');
  assert.equal(out.totals.declarationOnly,1);

  await put('impl.mjs','export const ok=true;\n');
  await put('learnings/L-0002.md','# Unindexed\n');
  out=await auditRuleHealth({root,contracts:[contract]});
  assert.equal(out.ok,false);
  assert(out.inventory.unindexedLearnings.includes('learnings/L-0002.md'));

  await put('learnings/INDEX.md','# Index\n\n- L-0001\n- L-0002\n');
  await put('.agents/skills/orphan/SKILL.md','# Orphan\n');
  out=await auditRuleHealth({root,contracts:[contract]});
  assert.equal(out.ok,true);
  assert(out.inventory.unlistedSkills.includes('orphan'));
  assert.equal(out.reviewRecommended,true);

  const longBody=Array.from({length:510},(_,i)=>'line '+i).join('\n');
  await put('CORE.md','# Core\n'+longBody+'\n');
  out=await auditRuleHealth({root,contracts:[contract]});
  assert(out.inventory.longFiles.some(x=>x.file==='CORE.md'));

  console.log('common-rule-health-audit selftest: PASS');
} finally {
  await rm(root,{recursive:true,force:true});
}
