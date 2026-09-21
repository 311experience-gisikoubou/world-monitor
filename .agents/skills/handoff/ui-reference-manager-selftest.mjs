#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { adoptUiReference } from './ui-reference-manager.mjs';
import { normalizeUiReferenceRegistry } from './ui-reference-registry.mjs';

function git(root,args){const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r;}
const root=mkdtempSync(join(tmpdir(),'ui-reference-manager-'));
mkdirSync(join(root,'docs','ui-reference','current'),{recursive:true});
const manifest={
  schemaVersion:1,projectContextId:'ui-test',projectName:'UI Test',projectRootRepository:'owner/ui-test',
  finalObjective:'Test approved UI reference management.',thisRepository:'owner/ui-test',repositoryRole:'ROOT',
  canonicalContract:{
    schemaVersion:1,contractId:'ui-test-contract',contractVersion:'2',approved:true,
    artifacts:[
      {id:'home-ui-v2',kind:'DESIGN',slot:'home-ui',status:'CURRENT',
       sources:['docs/ui-reference/CURRENT.json','docs/ui-reference/current/home.png'],
       visual:{designId:'home-ui-v2',version:'2',scope:['home'],baseline:'REFERENCE_IMAGE'}},
      {id:'home-ui-v1',kind:'DESIGN',slot:'home-ui',status:'SUPERSEDED',
       sources:['docs/ui-reference/CURRENT.json','docs/ui-reference/current/home.png'],supersededBy:'home-ui-v2',
       visual:{designId:'home-ui-v1',version:'1',scope:['home'],baseline:'REFERENCE_IMAGE'}},
    ],protectedDecisions:['approved-ui-baseline'],requiredValidation:['canonical-contract-gate']
  }
};
writeFileSync(join(root,'PROJECT_CONTEXT.json'),JSON.stringify(manifest,null,2));
writeFileSync(join(root,'docs','ui-reference','current','home.png'),'old-image');
writeFileSync(join(root,'docs','ui-reference','CURRENT.json'),JSON.stringify({
  schemaVersion:1,references:[{
    artifactId:'home-ui:v1',viewId:'home',image:'docs/ui-reference/current/home.png',approvedAt:'2026-09-20',
    viewport:{width:1440,height:900},browserZoom:100,devicePixelRatio:1,browser:'Chrome',fontFamily:'Arial'
  }]
},null,2));
writeFileSync(join(root,'new-home.png'),'new-image');
git(root,['init','-b','main']);git(root,['config','user.email','selftest@example.invalid']);git(root,['config','user.name','Selftest']);
git(root,['add','.']);git(root,['commit','-m','fixture']);git(root,['switch','-c','feat/ui-reference']);

const adopted=await adoptUiReference({
  root,artifactId:'home-ui-v2',viewId:'home',image:join(root,'new-home.png'),approvedAt:'2026-09-21',
  viewport:{width:1440,height:900},browserZoom:100,devicePixelRatio:1,browser:'Chrome',fontFamily:'Arial'
});
assert.equal(adopted.ok,true);
assert.equal(adopted.code,'UI_REFERENCE_ADOPTED');
assert.equal(readFileSync(join(root,'docs','ui-reference','current','home.png'),'utf8'),'new-image');
const registry=normalizeUiReferenceRegistry(JSON.parse(readFileSync(join(root,'docs','ui-reference','CURRENT.json'),'utf8')));
assert.equal(registry.value.references[0].artifactId,'home-ui-v2');
assert.equal(registry.value.references[0].viewId,'home');
const archive=join(root,'docs','ui-reference','archive','home','2026-09-20__home-ui_v1.png');
assert.equal(readFileSync(archive,'utf8'),'old-image');
assert.deepEqual(adopted.requiredArtifactSources,['docs/ui-reference/CURRENT.json','docs/ui-reference/current/home.png']);

assert.equal(normalizeUiReferenceRegistry({schemaVersion:1,references:[{
  artifactId:'x1',viewId:'home',image:'../escape.png',approvedAt:'2026-09-21',
  viewport:null,browserZoom:null,devicePixelRatio:null,browser:null,fontFamily:null
}]}).error.code,'UI_REFERENCE_ENTRY_INVALID');

git(root,['switch','main']);
const blocked=await adoptUiReference({
  root,artifactId:'home-ui-v2',viewId:'home',image:join(root,'new-home.png'),approvedAt:'2026-09-21',
  viewport:null,browserZoom:null,devicePixelRatio:null,browser:null,fontFamily:null
});
assert.equal(blocked.code,'UI_REFERENCE_FEATURE_BRANCH_REQUIRED');

console.log('UI_REFERENCE_MANAGER_SELFTEST=PASS adopt=PASS archive=PASS main_block=PASS');
