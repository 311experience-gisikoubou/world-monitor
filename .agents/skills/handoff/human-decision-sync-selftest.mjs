#!/usr/bin/env node
import assert from 'node:assert/strict';
import { validateHumanDecisionSync } from './human-decision-sync.mjs';

function manifest(){
  return {
    schemaVersion:1,projectContextId:'app-v1',projectName:'App',
    projectRootRepository:'acme/app',finalObjective:'Ship safely.',thisRepository:'acme/app',repositoryRole:'ROOT',
    canonicalContract:{
      schemaVersion:1,contractId:'app-contract',contractVersion:'2',approved:true,
      artifacts:[
        {id:'clear-theme-v2',kind:'DESIGN',slot:'whole-app-ui',status:'CURRENT',sources:['PROJECT_CONTEXT.json'],visual:{designId:'clear-theme-v2',version:'2',scope:['whole-app'],baseline:'MACHINE_READABLE'}},
        {id:'blue-theme-v1',kind:'DESIGN',slot:'whole-app-ui',status:'SUPERSEDED',sources:['docs/old-blue.json'],supersededBy:'clear-theme-v2',visual:{designId:'blue-theme-v1',version:'1',scope:['whole-app'],baseline:'MACHINE_READABLE'}},
      ],
      protectedDecisions:['human-approved-design'],requiredValidation:['canonical-contract-gate','human-decision-sync'],
    },
    humanDecisionSync:{
      schemaVersion:1,
      decisions:[
        {id:'old-blue',topic:'whole-app-theme',status:'DEPRECATED',summary:'Blue base is no longer used.',decidedAt:'2026-09-19',source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:null,artifactIds:['blue-theme-v1']},
        {id:'use-clear',topic:'whole-app-theme',status:'CONFIRMED',summary:'Use the clear theme as the current UI authority.',decidedAt:'2026-09-20',source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:'old-blue',artifactIds:['clear-theme-v2']},
      ],
      currentState:'Clear theme is the approved UI baseline.',
      nextAction:'Continue implementation against the clear theme.',
    },
  };
}
const aligned=validateHumanDecisionSync(manifest(),{schemaVersion:1,selectedDecisionIds:['use-clear']});
assert.equal(aligned.decisionSync,'PASS');
assert.equal(aligned.activeDecisions[0].id,'use-clear');
assert.equal(aligned.deprecatedDecisions[0].id,'old-blue');
assert.equal(aligned.currentState,'Clear theme is the approved UI baseline.');
assert.equal(aligned.nextAction,'Continue implementation against the clear theme.');

assert.equal(
  validateHumanDecisionSync(manifest(),{schemaVersion:1,selectedDecisionIds:['old-blue']}).code,
  'DECISION_CONFLICT',
);

const unresolved=manifest();
unresolved.humanDecisionSync.decisions.push({
  id:'layout-open',topic:'layout-density',status:'UNRESOLVED',
  summary:'Layout density remains undecided.',decidedAt:'2026-09-20',
  source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:null,artifactIds:[],
});
assert.equal(
  validateHumanDecisionSync(unresolved,{schemaVersion:1,selectedDecisionIds:['layout-open']}).code,
  'UNRESOLVED_DECISION_USED',
);

const proposed=manifest();
proposed.humanDecisionSync.decisions.push({
  id:'maybe-compact',topic:'compact-mode',status:'PROPOSED',
  summary:'AI proposes compact mode for later review.',decidedAt:'2026-09-20',
  source:'AI_PROPOSAL',type:'DESIGN',replaces:null,artifactIds:[],
});
assert.equal(
  validateHumanDecisionSync(proposed,{schemaVersion:1,selectedDecisionIds:['maybe-compact']}).code,
  'PROPOSED_DECISION_USED',
);
const requiredMissing=manifest();
delete requiredMissing.humanDecisionSync;
assert.equal(validateHumanDecisionSync(requiredMissing).code,'HUMAN_DECISION_SYNC_REQUIRED');

const staged=manifest();
staged.canonicalContract.requiredValidation=['canonical-contract-gate'];
delete staged.humanDecisionSync;
assert.equal(validateHumanDecisionSync(staged).decisionSync,'PASS');
assert.equal(validateHumanDecisionSync(staged).configured,false);

const conflict=manifest();
conflict.humanDecisionSync.decisions.push({
  id:'use-natural',topic:'whole-app-theme',status:'CONFIRMED',
  summary:'Use natural theme.',decidedAt:'2026-09-20',
  source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:null,artifactIds:['clear-theme-v2'],
});
assert.equal(validateHumanDecisionSync(conflict).code,'HUMAN_DECISION_CONFLICT');

const nonHuman=manifest();
nonHuman.humanDecisionSync.decisions.push({
  id:'ai-final',topic:'other-theme',status:'CONFIRMED',
  summary:'AI decided this.',decidedAt:'2026-09-20',
  source:'AI_PROPOSAL',type:'DESIGN',replaces:null,artifactIds:[],
});
assert.equal(validateHumanDecisionSync(nonHuman).code,'HUMAN_DECISION_INVALID');

const chain=manifest();
chain.humanDecisionSync.decisions.push(
  {id:'layout-v1',topic:'entry-layout',status:'DEPRECATED',summary:'Initial layout.',decidedAt:'2026-09-18',source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:null,artifactIds:[]},
  {id:'layout-v2',topic:'entry-layout',status:'DEPRECATED',summary:'Second layout.',decidedAt:'2026-09-19',source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:'layout-v1',artifactIds:[]},
  {id:'layout-v3',topic:'entry-layout',status:'CONFIRMED',summary:'Current layout.',decidedAt:'2026-09-20',source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:'layout-v2',artifactIds:[]},
);
assert.equal(validateHumanDecisionSync(chain).decisionSync,'PASS');

const duplicateUnresolved=manifest();
duplicateUnresolved.humanDecisionSync.decisions.push(
  {id:'open-a',topic:'open-topic',status:'UNRESOLVED',summary:'Option remains open.',decidedAt:'2026-09-20',source:'EXPLICIT_HUMAN',type:'BUSINESS',replaces:null,artifactIds:[]},
  {id:'open-b',topic:'open-topic',status:'UNRESOLVED',summary:'Duplicate open state.',decidedAt:'2026-09-20',source:'EXPLICIT_HUMAN',type:'BUSINESS',replaces:null,artifactIds:[]},
);
assert.equal(validateHumanDecisionSync(duplicateUnresolved).code,'HUMAN_DECISION_CONFLICT');

const placeholder=manifest();
placeholder.humanDecisionSync.currentState='<current-state>';
assert.equal(validateHumanDecisionSync(placeholder).code,'HUMAN_DECISION_SYNC_INVALID');

console.log('HUMAN_DECISION_SYNC_SELFTEST=PASS cases=confirmed,deprecated,unresolved,proposed,new-chat,staged-rollout,conflict,placeholder');
