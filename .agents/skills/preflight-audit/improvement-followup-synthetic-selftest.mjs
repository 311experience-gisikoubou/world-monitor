#!/usr/bin/env node
import assert from 'node:assert/strict';
import { prepareSyntheticIssueAction, simulateSyntheticIssueAction, assessReadOnlyIssuePublication, reconcileSyntheticHandoffReadback, matchSuppliedGitHubGetShape, reviewSuppliedGitHubCommentPages, reviewStableSuppliedGitHubReadback, previewSyntheticHandoff } from './improvement-followup-synthetic.mjs';

const NOW=Date.parse('2026-10-11T12:00:00Z');
const time=new Date(NOW-60000).toISOString(),SHA='a'.repeat(40);
const task={projectContextId:'project-a',repository:'acme/app-b',issueNumber:500,branch:'job/abc',
  worktree:'/work/app-b',headSha:SHA,jobId:'job-a',capturedAt:time};
const project={projectContextId:'project-a',projectRootRepository:'acme/app-b',owner:'acme',
  ownedRepositories:['acme/app-a','acme/app-b'],capturedAt:time};
const candidate={id:'synthetic-1',subjectOwner:'acme',subjectRepository:'acme/app-a',
  relatedIssueNumber:null,title:'Fix mock parser',kind:'technical_bugfix',protectedData:false,
  capturedAt:time,causeVerified:true,causeDescription:'Synthetic parser missing guard',
  desiredOutcome:'Synthetic parser returns a safe default',
  allowedPaths:['src/parser.js'],forbiddenPaths:['src/billing'],
  reproductionCommand:'node tools/repro.js',testCommand:'node tools/test.js',dedupKey:'parser-safe-1',
  runnerEvidence:null};
const existing=()=>({fetchedAt:time,retrievalComplete:true,entries:[]});
const prior=()=>({number:42,repository:'acme/app-a',dedupKey:'parser-safe-1',branch:null,worktree:null,headSha:null});
const input=(overrides={})=>({simulationOnly:true,dataClass:'synthetic',activeTask:task,projectSnapshot:project,
 existingIssues:existing(),candidates:[candidate],...overrides});
const store=(issues=[])=>({synthetic:true,repository:'acme/app-a',retrievalComplete:true,issues});

// No prior issue -> one simulated issue only, with a stable marker and no fake real URL.
{
 const before=JSON.stringify(task);
 const p=prepareSyntheticIssueAction(input(),'synthetic-1',NOW);
 assert.equal(p.ok,true);
 assert.equal(p.action.kind,'NEW_ISSUE');
 assert.equal(p.action.mode,'SYNTHETIC_ONLY');
 assert.equal(p.externalWrite,false);
 const first=simulateSyntheticIssueAction(p.action,store());
 assert.equal(first.code,'SYNTHETIC_CREATE_ONLY');
 assert.equal(first.state.issues.length,1);
 assert.equal(first.runnerStatus,'NOT_STARTED');
 assert.equal(first.status,'SIMULATED_ONLY');
 const again=simulateSyntheticIssueAction(p.action,first.state);
 assert.equal(again.code,'SYNTHETIC_ALREADY_RECORDED');
 assert.equal(again.state.issues.length,1);
 assert.equal(JSON.stringify(task),before);
}
// Existing issue -> append exactly once, no Issue creation on replay.
{
 const p=prepareSyntheticIssueAction(input({existingIssues:{...existing(),entries:[prior()]}}),'synthetic-1',NOW);
 assert.equal(p.ok,true);
 assert.equal(p.action.kind,'APPEND_EXISTING');
 assert.equal(p.action.issueNumber,42);
 const before=store([{number:42,title:'Already tracked',body:'',comments:[]}]);
 const result=simulateSyntheticIssueAction(p.action,before);
 assert.equal(result.code,'SYNTHETIC_APPEND_ONLY');
 assert.equal(result.state.issues.length,1);
 assert.equal(result.state.issues[0].comments.length,1);
 assert.equal(before.issues[0].comments.length,0); // input never mutated
 const replay=simulateSyntheticIssueAction(p.action,result.state);
 assert.equal(replay.code,'SYNTHETIC_ALREADY_RECORDED');
 assert.equal(replay.state.issues[0].comments.length,1);
}
// Wrong-target dedup marker cannot prove an append to the specified Issue.
{
 const p=prepareSyntheticIssueAction(input({existingIssues:{...existing(),entries:[prior()]}}),'synthetic-1',NOW);
 const marker='<!-- foundation-synthetic-followup:parser-safe-1 -->';
 const wrong=store([{number:42,title:'Intended',body:'',comments:[]},
   {number:99,title:'Different',body:marker,comments:[]}]);
 const r=simulateSyntheticIssueAction(p.action,wrong);
 assert.equal(r.ok,false);
 assert.equal(r.code,'SYNTHETIC_WRONG_ISSUE_CONFLICT');
 assert.equal(r.externalWrite,false);
 assert.equal(wrong.issues[0].comments.length,0);
}
// ACK loss -> UNKNOWN, never retry or claim a real POST (and fixture can be reconciled read-only).
{
 const p=prepareSyntheticIssueAction(input(),'synthetic-1',NOW);
 const unknown=simulateSyntheticIssueAction(p.action,store(),{simulateAckLost:true});
 assert.equal(unknown.code,'SYNTHETIC_ACK_UNKNOWN_NO_RETRY');
 assert.equal(unknown.status,'UNKNOWN');
 assert.equal(unknown.externalWrite,false);
 const reconciled=simulateSyntheticIssueAction(p.action,unknown.state);
 assert.equal(reconciled.code,'SYNTHETIC_ALREADY_RECORDED');
 assert.equal(reconciled.state.issues.length,1);
}
// Critical fail-closed, no mock action for unsafe or unverified input.
{
 const badOwner={...candidate,subjectOwner:'stranger',subjectRepository:'stranger/repo'};
 assert.equal(prepareSyntheticIssueAction(input({candidates:[badOwner]}),'synthetic-1',NOW).ok,false);
 const badProject={...project,projectContextId:'another-project'};
 assert.equal(prepareSyntheticIssueAction(input({projectSnapshot:badProject}),'synthetic-1',NOW).code,'DISPATCH_PROJECT_CONTEXT_MISMATCH');
 const stale={...candidate,capturedAt:new Date(NOW-1200000).toISOString()};
 assert.equal(prepareSyntheticIssueAction(input({candidates:[stale]}),'synthetic-1',NOW).ok,false);
 const protectedCandidate={...candidate,protectedData:true};
 assert.equal(prepareSyntheticIssueAction(input({candidates:[protectedCandidate]}),'synthetic-1',NOW).ok,false);
 const secret={...candidate,causeDescription:'password=not-for-logs'};
 assert.equal(prepareSyntheticIssueAction(input({candidates:[secret]}),'synthetic-1',NOW).code,'CONTENT_NOT_SAFELY_CLASSIFIED');
 const feature={...candidate,kind:'feature'};
 assert.equal(prepareSyntheticIssueAction(input({candidates:[feature]}),'synthetic-1',NOW).ok,false);
 assert.equal(prepareSyntheticIssueAction(input({simulationOnly:false}),'synthetic-1',NOW).code,'SYNTHETIC_MODE_REQUIRED');
 const noRunner={...candidate,runnerEvidence:null};
 assert.equal(prepareSyntheticIssueAction(input({candidates:[noRunner]}),'synthetic-1',NOW).status,'NOT_STARTED');
 const invalidStore={...store(),synthetic:false};
 const action=prepareSyntheticIssueAction(input(),'synthetic-1',NOW).action;
 assert.equal(simulateSyntheticIssueAction(action,invalidStore).ok,false);
 assert.equal(simulateSyntheticIssueAction({...action,mode:'GITHUB_LIVE'},store()).ok,false);
}
// Phase 3B offline metadata-only review guards; no Github network or writes.
{
 const head='c'.repeat(40);
 const action={mode:'SYNTHETIC_ONLY',kind:'APPEND_EXISTING',targetRepository:'acme/app-a',
   sourceRepository:'acme/app-b',sourceIssueNumber:500,sourceJobId:'job-b',
   sourceHead:head,issueNumber:42,dedupKey:'parser-safe-1',actionKey:'acme/app-a#parser-safe-1',
   title:'not safe to publish',body:'password=PRIVATE_SENTINEL'};
 const snapshot=(entries=[{number:42,dedupKey:'parser-safe-1',state:'open',commentsComplete:true,handoffMarkerPresent:false}])=>({
   repository:'acme/app-a',capturedAt:time,retrievalComplete:true,
   totalIssueCount:entries.length,entries
 });
 const call=(a=action,iv=snapshot(),extras={})=>assessReadOnlyIssuePublication({
   action:a,inventory:iv,sourceVisibility:'PRIVATE',targetVisibility:'PRIVATE',nowMs:NOW,...extras
 });
 const pass=call();
 assert.equal(pass.ok,true);
 assert.equal(pass.status,'REVIEW_ONLY');
 assert.equal(pass.outboundAllowed,false);
 assert.equal(pass.providerState,'NOT_STARTED');
 assert.equal(pass.fixedTemplate.includes('PRIVATE_SENTINEL'),false);
 assert.equal(pass.fixedTemplate.includes('not safe to publish'),false);
 const old={number:11,dedupKey:null,state:'open',commentsComplete:false,handoffMarkerPresent:false};
 assert.equal(call({...action,kind:'NEW_ISSUE',issueNumber:null},snapshot([old])).code,'LEGACY_OR_EXISTING_ISSUES_NOT_EXCLUDED');
 assert.equal(call({...action,kind:'NEW_ISSUE',issueNumber:null},snapshot([])).code,'METADATA_REVIEW_ONLY');
 assert.equal(call(action,snapshot(),{sourceVisibility:'PRIVATE',targetVisibility:'PUBLIC'}).code,'VISIBILITY_OR_PRIVACY_BOUNDARY_UNKNOWN');
 assert.equal(call(action,{...snapshot(),retrievalComplete:false}).code,'TARGET_INVENTORY_NOT_COMPLETE');
 assert.equal(call(action,{...snapshot(),capturedAt:new Date(NOW-600000).toISOString()}).code,'TARGET_INVENTORY_STALE');
 assert.equal(call(action,snapshot([{number:42,dedupKey:'parser-safe-1',state:'open',commentsComplete:true,handoffMarkerPresent:true}])).code,'EXACT_TARGET_ALREADY_HAS_HANDOFF');
 assert.equal(call(action,snapshot([{number:99,dedupKey:'parser-safe-1',state:'open',commentsComplete:true,handoffMarkerPresent:false}])).code,'TARGET_ISSUE_NOT_OPEN');
 assert.equal(call(action,snapshot([{number:42,dedupKey:null,state:'open',commentsComplete:true,handoffMarkerPresent:false}])).code,'TARGET_ISSUE_MARKER_NOT_VERIFIED');
 assert.equal(call(action,snapshot([
   {number:42,dedupKey:'parser-safe-1',state:'open',commentsComplete:true,handoffMarkerPresent:false},
   {number:99,dedupKey:'parser-safe-1',state:'open',commentsComplete:true,handoffMarkerPresent:false}
 ])).code,'TARGET_DEDUP_CONFLICT');
 assert.equal(call(action,snapshot([{number:42,dedupKey:'parser-safe-1',state:'open',commentsComplete:false,handoffMarkerPresent:false}])).code,'TARGET_ISSUE_MARKER_NOT_VERIFIED');
 assert.equal(call({...action,sourceHead:'not-a-sha'}).code,'SOURCE_ACTION_IDENTITY_INVALID');
 assert.equal(call({...action,actionKey:'acme/other#parser-safe-1'}).code,'SOURCE_ACTION_IDENTITY_INVALID');
 assert.equal(call(action,{...snapshot(),totalIssueCount:3}).code,'TARGET_INVENTORY_NOT_COMPLETE');
 assert.equal(call({...action,kind:'NEW_ISSUE',issueNumber:null},snapshot([{number:7,dedupKey:'other',state:'open',commentsComplete:true,handoffMarkerPresent:false}])).code,'LEGACY_OR_EXISTING_ISSUES_NOT_EXCLUDED');
}


// Phase 3B receipt reconciliation stays synthetic and never authenticates its input.
{
  const a={mode:'SYNTHETIC_ONLY',kind:'APPEND_EXISTING',targetRepository:'acme/app-a',
    sourceRepository:'acme/app-b',sourceIssueNumber:5,sourceHead:'c'.repeat(40),
    sourceJobId:'job1',issueNumber:42,dedupKey:'parser-safe-1',
    actionKey:'acme/app-a#parser-safe-1'};
  const ack={state:'ACK_RECEIVED',repository:'acme/app-a',issueNumber:42,commentId:123};
  const view={repository:'acme/app-a',capturedAt:time,retrievalComplete:true,
    issueNumber:42,issueMarkerCount:0,issueMarkerKey:null,
    comments:[{id:123,author:'maintainer-bot',markerKey:'parser-safe-1'}]};
  const call=(aa=a,ww=ack,rr=view,extra={})=>
    reconcileSyntheticHandoffReadback({action:aa,writeAck:ww,readback:rr,
      expectedAuthor:'maintainer-bot',nowMs:NOW,...extra});
  const matched=call();
  assert.equal(matched.code,'SYNTHETIC_READBACK_MATCH_CANDIDATE');
  assert.equal(matched.ok,true);
  assert.equal(matched.authenticated,false);
  assert.equal(matched.outboundAllowed,false);
  assert.equal(matched.providerState,'NOT_STARTED');
  assert.equal(matched.simulatedCommentId,123);
  assert.equal(call(a,{...ack,state:'ACK_UNKNOWN',commentId:null}).ok,true);
  assert.equal(call(a,ack,{...view,issueNumber:99}).code,'READBACK_ISSUE_MISMATCH');
  assert.equal(call(a,ack,{...view,comments:[{...view.comments[0],id:124}]}).code,'READBACK_COMMENT_ID_MISMATCH');
  assert.equal(call(a,ack,{...view,comments:[{...view.comments[0],author:'other-author'}]}).code,'READBACK_AUTHOR_MISMATCH');
  assert.equal(call(a,ack,{...view,comments:[...view.comments,{id:125,author:'maintainer-bot',markerKey:'parser-safe-1'}]}).code,'READBACK_MARKER_DUPLICATE');
  assert.equal(call(a,ack,{...view,comments:[]}).code,'READBACK_MARKER_MISSING');
  assert.equal(call(a,ack,{...view,retrievalComplete:false}).code,'READBACK_INCOMPLETE');
  assert.equal(call(a,ack,{...view,capturedAt:new Date(NOW-600000).toISOString()}).code,'READBACK_STALE');
  assert.equal(call(a,{...ack,commentId:null}).code,'ACK_RECEIVED_WITHOUT_ID');
  assert.equal(call({...a,mode:'GITHUB_LIVE'}).code,'RECEIPT_ACTION_INVALID');
  const newAction={...a,kind:'NEW_ISSUE',issueNumber:null};
  const newAck={...ack,commentId:null};
  const newView={...view,issueMarkerCount:1,issueMarkerKey:'parser-safe-1',comments:[]};
  assert.equal(call(newAction,newAck,newView).code,'SYNTHETIC_READBACK_MATCH_CANDIDATE');
  assert.equal(call(newAction,newAck,{...newView,issueMarkerCount:0}).code,'READBACK_CREATE_TARGET_MISMATCH');
  assert.equal(call(newAction,newAck,{...newView,issueMarkerKey:'wrong-marker'}).code,'READBACK_CREATE_TARGET_MISMATCH');
  assert.equal(call(newAction,newAck,{...newView,comments:[{id:123,author:'maintainer-bot',markerKey:'parser-safe-1'}]}).code,'READBACK_NEW_ISSUE_COMMENT_CONFLICT');
}



// Offline validation of already-supplied GitHub GET response shape.
// No remote request: these are synthetic objects, never trusted evidence.
{
 const repository='acme/app-a',n=42,id=61001,author='synthetic-bot',key='fix-test-1';
 const url=(host,path,hash='')=>'https:'+'/'+'/'+host+path+hash;
 const html=url('github.com','/'+repository+'/issues/'+n);
 const api=url('api.github.com','/repos/'+repository+'/issues/'+n);
 const issue={number:n,html_url:html,url:api};
 const comment={id,html_url:html+'#issuecomment-'+id,
   url:url('api.github.com','/repos/'+repository+'/issues/comments/'+id),
   issue_url:api,user:{login:author},
   body:'<!-- foundation-followup:'+key+' -->\nSource-only technical observation.'};
 const trial=(changes={})=>matchSuppliedGitHubGetShape({
   expectedRepository:repository,expectedIssueNumber:n,expectedCommentId:id,
   expectedAuthor:author,expectedMarkerKey:key,issue,comment,...changes});
 const pass=trial();
 assert.equal(pass.ok,true);
 assert.equal(pass.code,'GH_GET_SHAPE_MATCH_ONLY');
 assert.equal(pass.authenticated,false);
 assert.equal(pass.markerUniqueConfirmed,false);
 assert.equal(pass.outboundAllowed,false);
 assert.equal(pass.providerState,'NOT_STARTED');
 assert.equal(pass.body,undefined);
 assert.equal(trial({expectedRepository:'acme/else'}).code,'GH_ISSUE_IDENTITY_MISMATCH');
 assert.equal(trial({expectedCommentId:id+1}).code,'GH_COMMENT_IDENTITY_MISMATCH');
 assert.equal(trial({issue:{...issue,number:99}}).code,'GH_ISSUE_IDENTITY_MISMATCH');
 assert.equal(trial({issue:{...issue,pull_request:{}}}).code,'GH_ISSUE_IDENTITY_MISMATCH');
 assert.equal(trial({issue:{...issue,html_url:html+'?q=1'}}).code,'GH_ISSUE_IDENTITY_MISMATCH');
 assert.equal(trial({issue:{...issue,html_url:html.replace('github.com','other.com')}}).code,'GH_ISSUE_IDENTITY_MISMATCH');
 assert.equal(trial({comment:{...comment,id:id+1}}).code,'GH_COMMENT_IDENTITY_MISMATCH');
 assert.equal(trial({comment:{...comment,issue_url:api.replace('/issues/42','/issues/99')}}).code,'GH_COMMENT_IDENTITY_MISMATCH');
 assert.equal(trial({comment:{...comment,user:{login:'other-bot'}}}).code,'GH_COMMENT_AUTHOR_MISMATCH');
 assert.equal(trial({comment:{...comment,body:'secret=PRIVATE_SENTINEL'}}).code,'GH_COMMENT_MARKER_MISMATCH');
 assert.equal(trial({comment:{...comment,body:comment.body+'\n<!-- foundation-followup:'+key+' -->'}}).code,'GH_COMMENT_MARKER_MISMATCH');
 assert.equal(trial({comment:{...comment,body:'<!-- foundation-followup:'+key+' -->evil'}}).code,'GH_COMMENT_MARKER_MISMATCH');
}



// Offline complete-page integrity scan: caller-provided data is not authenticated.
{
 const repo='acme/app-a',num=42,key='bug-safe-1',author='bot';
 const issue={number:num,comments:2,html_url:'https:'+'/'+'/github.com/'+repo+'/issues/'+num,
   url:'https:'+'/'+'/api.github.com/repos/'+repo+'/issues/'+num};
 const mk='<!-- foundation-followup:'+key+' -->';
 const c=(id,body='',user='other')=>({
   id,url:'https:'+'/'+'/api.github.com/repos/'+repo+'/issues/comments/'+id,
   issue_url:issue.url,html_url:issue.html_url+'#issuecomment-'+id,
   user:{login:user},body});
 const pages=[{page:1,comments:[c(1,mk+'\nSource-only metadata',author),c(2,'Unrelated technical note')]}];
 const call=(changes={})=>reviewSuppliedGitHubCommentPages({
   expectedRepository:repo,expectedIssueNumber:num,expectedAuthor:author,
   expectedMarkerKey:key,issue,pages,capturedAt:time,nowMs:NOW,...changes});
 const good=call();
 assert.equal(good.ok,true);
 assert.equal(good.code,'PAGE_MARKER_MATCH_CANDIDATE');
 assert.equal(good.authenticated,false);
 assert.equal(good.markerUniqueConfirmed,false);
 assert.equal(good.outboundAllowed,false);
 assert.equal(good.providerState,'NOT_STARTED');
 assert.equal(good.comparedComments,2);
 assert.equal(good.body,undefined);
 assert.equal(call({issue:{...issue,comments:3}}).code,'PAGE_SEQUENCE_OR_COUNT_MISMATCH');
 assert.equal(call({pages:[]}).code,'PAGE_SET_INCOMPLETE');
 assert.equal(call({pages:[{page:2,comments:pages[0].comments}]}).code,'PAGE_SEQUENCE_OR_COUNT_MISMATCH');
 assert.equal(call({pages:[{page:1,comments:[c(1,mk,author),c(1,'other')]}]}).code,'PAGE_COMMENT_IDENTITY_OR_SCHEMA_INVALID');
 assert.equal(call({pages:[{page:1,comments:[c(1,mk,author),c(2,mk,author)]}]}).code,'PAGE_MARKER_DUPLICATE');
 assert.equal(call({pages:[{page:1,comments:[c(1,mk,'wrong'),c(2,'note')]}]}).code,'PAGE_MARKER_AUTHOR_CONFLICT');
 assert.equal(call({pages:[{page:1,comments:[c(1,'prefix '+mk,author),c(2,'note')]}]}).code,'PAGE_MARKER_EMBEDDED_OR_REPEATED');
 assert.equal(call({pages:[{page:1,comments:[c(1,mk+'\\n'+mk,author),c(2,'note')]}]}).code,'PAGE_MARKER_EMBEDDED_OR_REPEATED');
 assert.equal(call({pages:[{page:1,comments:[c(1,'none'),c(2,'none')]}]}).code,'PAGE_MARKER_NOT_FOUND');
 assert.equal(call({pages:[{page:1,comments:[{...c(1,mk,author),issue_url:issue.url.replace('/issues/42','/issues/99')},c(2,'note')]}]}).code,'PAGE_COMMENT_IDENTITY_OR_SCHEMA_INVALID');
 assert.equal(call({issue:{...issue,comments:501}}).code,'PAGE_ISSUE_IDENTITY_OR_COUNT_INVALID');
 assert.equal(call({issue:{...issue,pull_request:{}}}).code,'PAGE_ISSUE_IDENTITY_OR_COUNT_INVALID');
 assert.equal(call({capturedAt:new Date(NOW-6*60000).toISOString()}).code,'PAGE_EVIDENCE_STALE_OR_UNKNOWN');
 const hundred=Array.from({length:100},(_,i)=>c(i+1,i===25?mk:'filler',i===25?author:'other'));
 const oneHundredIssue={...issue,comments:101};
 const nextPage=[{page:1,comments:hundred},{page:2,comments:[c(101,'last')]}];
 assert.equal(call({issue:oneHundredIssue,pages:nextPage}).code,'PAGE_MARKER_MATCH_CANDIDATE');
 assert.equal(call({issue:oneHundredIssue,pages:[nextPage[0]]}).code,'PAGE_SET_INCOMPLETE');
 assert.equal(call({issue:oneHundredIssue,pages:[nextPage[0],{page:3,comments:[c(101,'last')]}]}).code,'PAGE_SEQUENCE_OR_COUNT_MISMATCH');
}

// Synthetic unchanged Issue GET before/after with matching marker page.
{
 const repo='acme/app-a',n=42,id=91,key='safe-1',author='tech-bot';
 const issueUrl='https:'+'/'+'/github.com/'+repo+'/issues/'+n;
 const apiUrl='https:'+'/'+'/api.github.com/repos/'+repo+'/issues/'+n;
 const issue={id:777,node_id:'I_777',number:n,comments:1,updated_at:'2026-10-11T00:00:00Z',state:'open',html_url:issueUrl,url:apiUrl};
 const comment={id,url:'https:'+'/'+'/api.github.com/repos/'+repo+'/issues/comments/'+id,issue_url:apiUrl,html_url:issueUrl+'#issuecomment-'+id,user:{login:author},body:'<!-- foundation-followup:'+key+' -->\nTechnical marker'};
 const pages=[{page:1,comments:[comment]}];
 const check=(rest={})=>reviewStableSuppliedGitHubReadback({expectedRepository:repo,expectedIssueNumber:n,expectedAuthor:author,expectedMarkerKey:key,beforeIssue:issue,afterIssue:{...issue},pages,observedAtStart:time,observedAtEnd:time,nowMs:NOW,...rest});
 const ok=check();
 assert.equal(ok.code,'STABLE_SUPPLIED_READBACK_CANDIDATE');
 assert.equal(ok.authenticated,false);
 assert.equal(ok.markerUniqueConfirmed,false);
 assert.equal(ok.atomicSnapshotProven,false);
 assert.equal(ok.outboundAllowed,false);
 assert.equal(ok.providerState,'NOT_STARTED');
 assert.equal(check({afterIssue:{...issue,comments:2}}).code,'STABILITY_ISSUE_CHANGED_DURING_READ');
 assert.equal(check({afterIssue:{...issue,state:'closed'}}).code,'STABILITY_ISSUE_CHANGED_DURING_READ');
 assert.equal(check({afterIssue:{...issue,id:999}}).code,'STABILITY_ISSUE_CHANGED_DURING_READ');
 assert.equal(check({beforeIssue:null}).code,'STABILITY_ISSUE_GET_ABSENT');
 assert.equal(check({observedAtStart:new Date(NOW+1000).toISOString()}).code,'STABILITY_WINDOW_INVALID');
 assert.equal(check({pages:[{page:1,comments:[]}]}).code,'STABILITY_PAGE_REVIEW_STOP');
}



// Complete in-memory Phase 2+3A+3B preview: never returns raw candidate
// content or any real GitHub write permission.
{
 const view=(entries=[])=>({repository:'acme/app-a',capturedAt:time,
   retrievalComplete:true,totalIssueCount:entries.length,entries});
 const run=(overrides={})=>previewSyntheticHandoff({
   input:input(),candidateId:'synthetic-1',inventory:view(),
   sourceVisibility:'PRIVATE',targetVisibility:'PRIVATE',nowMs:NOW,
   ...overrides
 });
 const create=run();
 assert.equal(create.ok,true);
 assert.equal(create.code,'SYNTHETIC_HANDOFF_REVIEW_ONLY');
 assert.equal(create.actionKind,'NEW_ISSUE');
 assert.equal(create.targetRepository,'acme/app-a');
 assert.equal(create.targetIssueNumber,null);
 assert.equal(create.outboundAllowed,false);
 assert.equal(create.authenticated,false);
 assert.equal(create.providerState,'NOT_STARTED');
 assert.equal(create.status,'REVIEW_ONLY');
 assert.equal(create.body,undefined);
 assert.equal(create.fixedTemplate.includes('Synthetic parser missing guard'),false);
 assert.equal(create.fixedTemplate.includes('node tools/repro.js'),false);
 const priorMeta={number:42,dedupKey:'parser-safe-1',state:'open',
   commentsComplete:true,handoffMarkerPresent:false};
 const append=run({input:input({existingIssues:{...existing(),entries:[prior()]}}),
   inventory:view([priorMeta])});
 assert.equal(append.code,'SYNTHETIC_HANDOFF_REVIEW_ONLY');
 assert.equal(append.actionKind,'APPEND_EXISTING');
 assert.equal(append.targetIssueNumber,42);
 assert.equal(append.outboundAllowed,false);
 const blockedLegacy=run({inventory:view([{...priorMeta,dedupKey:null}])});
 assert.equal(blockedLegacy.code,'LEGACY_OR_EXISTING_ISSUES_NOT_EXCLUDED');
 const blockedReused=run({input:input({existingIssues:{...existing(),entries:[prior()]}}),
   inventory:view([{...priorMeta,handoffMarkerPresent:true}])});
 assert.equal(blockedReused.code,'EXACT_TARGET_ALREADY_HAS_HANDOFF');
 assert.equal(blockedReused.status,'RECORDED_CANDIDATE');
 assert.equal(run({targetVisibility:'PUBLIC'}).code,'VISIBILITY_OR_PRIVACY_BOUNDARY_UNKNOWN');
 assert.equal(run({inventory:{...view(),retrievalComplete:false}}).code,'TARGET_INVENTORY_NOT_COMPLETE');
 assert.equal(run({inventory:{...view(),capturedAt:new Date(NOW-600000).toISOString()}}).code,'TARGET_INVENTORY_STALE');
 assert.equal(run({input:input({projectSnapshot:{...project,owner:'wrong'}})}).ok,false);
 assert.equal(run({input:input({candidates:[{...candidate,protectedData:true}]})}).ok,false);
 assert.equal(run({input:input({candidates:[{...candidate,causeDescription:'password=sensitive'}]})}).code,'CONTENT_NOT_SAFELY_CLASSIFIED');
 assert.equal(run({input:input({simulationOnly:false})}).code,'SYNTHETIC_MODE_REQUIRED');
}

console.log('improvement-followup synthetic selftest: PASS');
