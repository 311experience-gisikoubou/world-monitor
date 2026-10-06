#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCanonicalPromotionGate } from './canonical-promotion-gate.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
function git(root,args){const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();}
const root=mkdtempSync(join(tmpdir(),'canonical-promotion-selftest-'));
mkdirSync(join(root,'docs','ui'),{recursive:true});
const design='{"screen":"candidate-v1"}\n',reference='reference-image-bytes';
writeFileSync(join(root,'docs','ui','screen.json'),design);
writeFileSync(join(root,'docs','ui','reference.png'),reference);
git(root,['init','-q']);git(root,['config','user.email','selftest@example.invalid']);git(root,['config','user.name','Selftest']);git(root,['add','.']);git(root,['commit','-q','-m','candidate']);
const approvedHead=git(root,['rev-parse','HEAD']), contentHash=hash(Buffer.from(design)), refHash=hash(Buffer.from(reference));
function approval(id,topic,type,state,evidence,scope='SCREEN',date='2026-10-04'){
  return {id,topic,status:'CONFIRMED',summary:evidence,decidedAt:date,source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:null,artifactIds:['screen-v1'],designApproval:{artifactId:'screen-v1',scope,approvalType:type,designState:state,evidenceText:evidence,approvedContentSha256:contentHash,approvedHead}};
}
function manifest(){
  return {
    thisRepository:'acme/app',
    canonicalContract:{schemaVersion:1,contractId:'app-contract',contractVersion:'1',approved:true,protectedDecisions:[],requiredValidation:['canonical-contract-gate','human-decision-sync','approval-scope-gate','canonical-promotion-gate'],artifacts:[{
      id:'screen-v1',kind:'DESIGN',slot:'screen',status:'CURRENT',sources:['docs/ui/screen.json','docs/ui/reference.png'],
      visual:{designId:'screen-v1',version:'1',scope:['screen'],baseline:'MACHINE_READABLE',governance:{
        canonicalScope:'SCREEN',lifecycleHistory:['WIP','LOCKED_COMPONENTS','FINAL_CANDIDATE','HUMAN_APPROVED','CANONICAL'],derivedFrom:'reference-v1',
        contentSource:'docs/ui/screen.json',contentSha256:contentHash,artifactHead:approvedHead,
        reference:{referenceId:'reference-v1',sourcePath:'docs/ui/reference.png',sha256:refHash,scope:'SCREEN',status:'DESIGN_REFERENCE',decidedAt:'2026-10-04',source:'EXPLICIT_HUMAN'}
      }}
    }]},
    humanDecisionSync:{schemaVersion:1,decisions:[
      approval('whole','screen-whole','WHOLE_SCREEN_APPROVAL','HUMAN_APPROVED','この画面全体を最終デザインとして承認'),
      approval('promote','screen-promote','CANONICAL_PROMOTION_APPROVAL','CANONICAL','この画面全体を正式な視覚正本へ正本化')
    ],currentState:'Screen is explicitly approved and promoted.',nextAction:'Use canonical screen.'}
  };
}
writeFileSync(join(root,'PROJECT_CONTEXT.json'),JSON.stringify(manifest(),null,2));git(root,['add','PROJECT_CONTEXT.json']);git(root,['commit','-q','-m','promotion metadata']);
assert.equal(validateCanonicalPromotionGate(manifest(),{repoRoot:root}).result,'PROCEED');

const componentOnly=manifest();componentOnly.humanDecisionSync.decisions=[approval('card','card-topic','COMPONENT_APPROVAL','LOCKED_COMPONENTS','このカードを採用','COMPONENT')];
assert.equal(validateCanonicalPromotionGate(componentOnly,{repoRoot:root}).code,'CANONICAL_PROMOTION_INVALID');

const noLineage=manifest();noLineage.canonicalContract.artifacts[0].visual.governance.derivedFrom='other-reference';
assert.equal(validateCanonicalPromotionGate(noLineage,{repoRoot:root}).code,'CANONICAL_PROMOTION_INVALID');

const skipped=manifest();skipped.canonicalContract.artifacts[0].visual.governance.lifecycleHistory=['WIP','LOCKED_COMPONENTS','FINAL_CANDIDATE','CANONICAL'];
assert.equal(validateCanonicalPromotionGate(skipped,{repoRoot:root}).code,'CANONICAL_PROMOTION_INVALID');

const correction=manifest();correction.humanDecisionSync.decisions.push(approval('still-wip','screen-correction','DIRECTION_APPROVAL','WIP','まだ仮です','SCREEN','2026-10-05'));
assert.equal(validateCanonicalPromotionGate(correction,{repoRoot:root}).code,'CANONICAL_PROMOTION_HUMAN_CORRECTION_CONFLICT');

writeFileSync(join(root,'docs','ui','screen.json'),'{"screen":"changed-after-approval"}\n');git(root,['add','docs/ui/screen.json']);git(root,['commit','-q','-m','post approval change']);
assert.equal(validateCanonicalPromotionGate(manifest(),{repoRoot:root}).code,'CANONICAL_PROMOTION_INVALID');

console.log('CANONICAL_PROMOTION_GATE_SELFTEST=PASS valid=PASS component_to_screen=STOP lineage=STOP lifecycle_skip=STOP latest_correction=STOP post_approval_change=STOP');
