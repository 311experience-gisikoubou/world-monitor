#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCanonicalContract } from './canonical-contract-gate.mjs';

function contractArtifacts(){
  return [
    {
      id:'whole-app-ui-v1',kind:'DESIGN',slot:'whole-app-ui',status:'CURRENT',sources:['PROJECT_CONTEXT.json'],
      visual:{designId:'whole-app-ui-v1',version:'1',scope:['whole-app'],baseline:'MACHINE_READABLE'},
    },
    {
      id:'delivery-entry-final-clear',kind:'DESIGN',slot:'whole-app-ui',status:'SUPERSEDED',
      sources:['docs/ui/delivery-entry-final-clear.json'],supersededBy:'whole-app-ui-v1',
      visual:{designId:'delivery-entry-final-clear',version:'1',scope:['delivery-entry'],baseline:'MACHINE_READABLE'},
    },
  ];
}
function manifest(overrides={}){
  return {
    schemaVersion:1,projectContextId:'delivery-billing-v1',projectName:'Delivery Billing',
    projectRootRepository:'311experience-gisikoubou/dental-delivery-billing',
    finalObjective:'Deliver the approved product safely.',
    thisRepository:'311experience-gisikoubou/dental-delivery-billing',repositoryRole:'ROOT',
    canonicalContract:{
      schemaVersion:1,contractId:'delivery-billing-contract',contractVersion:'1',approved:true,
      artifacts:contractArtifacts(),protectedDecisions:['human-approved-design'],
      requiredValidation:['canonical-contract-gate'],
    },
    ...overrides,
  };
}
function state(overrides={}){
  return {
    schemaVersion:1,repository:'311experience-gisikoubou/dental-delivery-billing',
    contractId:'delivery-billing-contract',contractVersion:'1',
    targetSelection:[{slot:'whole-app-ui',artifactId:'whole-app-ui-v1'}],
    usedSpecIds:['whole-app-ui-v1'],functionalGate:'PASS',...overrides,
  };
}

// Case A: current canonical target matches implementation.
assert.equal(validateCanonicalContract(manifest(),state()).contractGate,'PASS');

// Case B: superseded spec may remain in the repository, but current canonical target wins.
const b=validateCanonicalContract(manifest(),state());
assert.equal(b.contractGate,'PASS');
assert.equal(b.canonicalTargets[0].artifactId,'whole-app-ui-v1');

// Case C: two CURRENT artifacts in the same slot are ambiguous and must STOP.
const conflict=contractArtifacts();
conflict.push({
  id:'other-current-ui',kind:'DESIGN',slot:'whole-app-ui',status:'CURRENT',sources:['PROJECT_CONTEXT.json'],
  visual:{designId:'other-current-ui',version:'1',scope:['whole-app'],baseline:'MACHINE_READABLE'},
});
assert.equal(validateCanonicalContract(manifest({canonicalContract:{...manifest().canonicalContract,artifacts:conflict}})).code,'CANONICAL_SPEC_CONFLICT');

// Case D + regression fixture: human approved whole-app UI, but implementation targets the old partial UI.
const incident=validateCanonicalContract(manifest(),state({
  targetSelection:[{slot:'whole-app-ui',artifactId:'old-ui-partial-update'}],
  usedSpecIds:['delivery-entry-final-clear'],functionalGate:'PASS',
}));
assert.equal(incident.code,'CANONICAL_TARGET_MISMATCH');
assert.equal(incident.functionalGate,'PASS');

// Case E: canonical contract absent.
const missing=manifest(); delete missing.canonicalContract;
assert.equal(validateCanonicalContract(missing).code,'CANONICAL_CONTRACT_MISSING');

// Case F: another project's contract/repository is referenced.
assert.equal(validateCanonicalContract(manifest(),state({repository:'311experience-gisikoubou/digital-work-order'})).code,'CANONICAL_CONTRACT_REPOSITORY_MISMATCH');

// Explicit stale-source use is blocked even when the selected target itself is current.
assert.equal(validateCanonicalContract(manifest(),state({usedSpecIds:['whole-app-ui-v1','delivery-entry-final-clear']})).code,'SUPERSEDED_SPEC_USED');

// Case G: functional PASS never overrides Contract Gate failure.
const g=validateCanonicalContract(manifest(),state({targetSelection:[{slot:'whole-app-ui',artifactId:'delivery-entry-final-clear'}],usedSpecIds:['delivery-entry-final-clear'],functionalGate:'PASS'}));
assert.equal(g.result,'STOP');
assert.equal(g.contractGate,'FAIL');
assert.equal(g.functionalGate,'PASS');

// Visual contracts are required for DESIGN artifacts.
const badVisual=contractArtifacts(); delete badVisual[0].visual;
assert.equal(validateCanonicalContract(manifest({canonicalContract:{...manifest().canonicalContract,artifacts:badVisual}})).code,'CANONICAL_ARTIFACT_INVALID');

// CLI source verification: CURRENT source must exist in committed Git HEAD.
const root=mkdtempSync(join(tmpdir(),'canonical-contract-selftest-'));
mkdirSync(join(root,'docs','ui'),{recursive:true});
writeFileSync(join(root,'PROJECT_CONTEXT.json'),JSON.stringify(manifest(),null,2));
writeFileSync(join(root,'docs','ui','delivery-entry-final-clear.json'),'{}');
spawnSync('git',['init',root],{encoding:'utf8'});
spawnSync('git',['-C',root,'config','user.email','selftest@example.invalid'],{encoding:'utf8'});
spawnSync('git',['-C',root,'config','user.name','Selftest'],{encoding:'utf8'});
spawnSync('git',['-C',root,'add','.'],{encoding:'utf8'});
assert.equal(spawnSync('git',['-C',root,'commit','-m','fixture'],{encoding:'utf8'}).status,0);
const gatePath=fileURLToPath(new URL('./canonical-contract-gate.mjs',import.meta.url));
const cli=spawnSync(process.execPath,[gatePath,'--context-file',join(root,'PROJECT_CONTEXT.json')],{encoding:'utf8'});
assert.equal(cli.status,0);
assert.equal(JSON.parse(cli.stdout).contractGate,'PASS');

console.log('CANONICAL_CONTRACT_GATE_SELFTEST=PASS cases=A,B,C,D,E,F,G incident_fixture=STOP');
