// Issue #280 Phase 3A. OFFLINE SYNTHETIC simulation only.
// Reuses Phase 2 classifier. No live transport/credentials/side effects.
import { buildDispatchReport } from './improvement-followup.mjs';

const PRIVATE_HINT = /(?:api[_-]?key|access[_-]?token|private[_-]?key|password|bearer\s|患者|患者名|医院名|売上|請求|credential|authorization\s*:)/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MARKER = '<!-- foundation-synthetic-followup:';
const markerFor = (key) => MARKER + key + ' -->';
const blocked = (code) => ({ ok: false, code, action: null, status: 'NOT_STARTED', externalWrite: false });
const safeContent = (x,n) => typeof x === 'string' && x.length > 0 && x.length <= n && !PRIVATE_HINT.test(x) && !CONTROL.test(x);
const plain = (x) => x.replace(/[\r\n]+/g,' ').trim();

export function prepareSyntheticIssueAction(input, candidateId, nowMs = Date.now()) {
  if (!input || input.simulationOnly !== true || input.dataClass !== 'synthetic') return blocked('SYNTHETIC_MODE_REQUIRED');
  if (!ID.test(candidateId ?? '') || !Number.isInteger(nowMs)) return blocked('SYNTHETIC_INPUT_INVALID');
  const report = buildDispatchReport({
    candidates:input.candidates, activeTask:input.activeTask, projectSnapshot:input.projectSnapshot,
    existingIssues:input.existingIssues, nowMs, generatedAt:new Date(nowMs).toISOString(),
  });
  if (!report.ok) return blocked(report.code);
  const matches = report.items.filter(x => x.id === candidateId);
  const cs = input.candidates.filter(x => x.id === candidateId);
  if (matches.length !== 1 || cs.length !== 1) return blocked('CANDIDATE_NOT_FOUND');
  const found = matches[0], c = cs[0];
  if (found.dispatchStatus !== 'PLAN_READY' || !found.dispatch) return blocked(found.code || 'ACTION_NOT_ELIGIBLE');
  if (c.kind !== 'technical_bugfix' || c.protectedData !== false) return blocked('ACTION_NOT_SAFE');
  if (!safeContent(c.title,240) || !safeContent(c.causeDescription,1500) ||
      !safeContent(c.desiredOutcome,800) || !safeContent(c.reproductionCommand,800) ||
      !safeContent(c.testCommand,800)) return blocked('CONTENT_NOT_SAFELY_CLASSIFIED');
  const x = found.dispatch;
  if (!ID.test(x.dedupKey ?? '') || !['APPEND_EXISTING','NEW_ISSUE'].includes(x.action) ||
      !x.targetRepository || x.targetRepository !== c.subjectRepository) return blocked('DISPATCH_IDENTITY_MISMATCH');
  const issueNumber=x.existingIssueNumber;
  if (x.action === 'APPEND_EXISTING' ? !Number.isSafeInteger(issueNumber) || issueNumber < 1 : issueNumber !== null) {
    return blocked('ISSUE_TARGET_INVALID');
  }
  const content = [
    markerFor(x.dedupKey),
    '**Source task:** ' + input.activeTask.repository + '#' + input.activeTask.issueNumber,
    '**Target:** ' + x.targetRepository + (issueNumber ? '#' + issueNumber : ' (new Issue proposal)'),
    '**Cause (' + (c.causeVerified ? 'verified' : 'unverified') + '):** ' + plain(c.causeDescription),
    '**Outcome:** ' + plain(c.desiredOutcome),
    '**Allowed paths:** ' + c.allowedPaths.join(', '),
    '**Forbidden paths:** ' + (c.forbiddenPaths.join(', ') || '(none)'),
    '**Reproduce:** ' + plain(c.reproductionCommand),
    '**Test:** ' + plain(c.testCommand),
    '**Executor:** NOT_STARTED. No provider launch; Draft PR and merge remain gated.',
  ].join('\n');
  return {ok:true,code:'SYNTHETIC_ACTION_PREPARED',status:'NOT_STARTED',externalWrite:false,
    action:{mode:'SYNTHETIC_ONLY',kind:x.action,targetRepository:x.targetRepository,
      issueNumber,dedupKey:x.dedupKey,actionKey:x.targetRepository+'#'+x.dedupKey,
      title:'[Synthetic candidate] '+plain(c.title),body:content,
      sourceRepository:input.activeTask.repository,sourceIssueNumber:input.activeTask.issueNumber,
      sourceHead:input.activeTask.headSha,sourceJobId:input.activeTask.jobId}
  };
}
function checkStore(store,repo) {
  if (!store || store.synthetic!==true || store.repository!==repo || store.retrievalComplete!==true ||
      !Array.isArray(store.issues) || store.issues.length>200) return false;
  const numbers=new Set();
  for(const issue of store.issues) {
    if(!issue || !Number.isSafeInteger(issue.number) || issue.number<1 || numbers.has(issue.number) ||
       typeof issue.title!=='string' || typeof issue.body!=='string' ||
       !Array.isArray(issue.comments) || issue.comments.length>500 ||
       !issue.comments.every(c=>typeof c==='string')) return false;
    numbers.add(issue.number);
  }
  return true;
}
// A pure in-memory fixture, not a callable transport adapter.
// It cannot post to GitHub even when passed a real repository name.
export function simulateSyntheticIssueAction(action,store,options={}) {
  if(!action || action.mode!=='SYNTHETIC_ONLY' || !ID.test(action.dedupKey??'') ||
     !['APPEND_EXISTING','NEW_ISSUE'].includes(action.kind) ||
     action.actionKey!==action.targetRepository+'#'+action.dedupKey ||
     !safeContent(action.title,320) || !safeContent(action.body,5000) ||
     !action.body.includes(markerFor(action.dedupKey))) return blocked('SYNTHETIC_ACTION_INVALID');
  if(!checkStore(store,action.targetRepository)) return blocked('SYNTHETIC_STORE_INVALID');
  const updated=structuredClone(store);
  const marked=updated.issues.filter(issue =>
    issue.body.includes(markerFor(action.dedupKey)) ||
    issue.comments.some(c=>c.includes(markerFor(action.dedupKey))));
  if(marked.length>1) return blocked('SYNTHETIC_DUPLICATE_CONFLICT');
  // An APPEND marker on a different Issue is a collision, NOT a receipt.
  if(marked.length===1 && action.kind==='APPEND_EXISTING' &&
     marked[0].number!==action.issueNumber) return blocked('SYNTHETIC_WRONG_ISSUE_CONFLICT');
  if(marked.length===1) return {ok:true,code:'SYNTHETIC_ALREADY_RECORDED',status:'SIMULATED_ONLY',
    externalWrite:false,simulatedIssueNumber:marked[0].number,state:updated,runnerStatus:'NOT_STARTED'};
  let target;
  if(action.kind==='APPEND_EXISTING'){
    target=updated.issues.find(issue=>issue.number===action.issueNumber);
    if(!target) return blocked('SYNTHETIC_ISSUE_NOT_FOUND');
    target.comments.push(action.body);
  } else {
    if(action.issueNumber!==null)return blocked('SYNTHETIC_NEW_ISSUE_TARGET_INVALID');
    const next=updated.issues.length===0?1:Math.max(...updated.issues.map(i=>i.number))+1;
    target={number:next,title:action.title,body:action.body,comments:[]};
    updated.issues.push(target);
  }
  if(options.simulateAckLost===true)return {ok:false,code:'SYNTHETIC_ACK_UNKNOWN_NO_RETRY',status:'UNKNOWN',
    externalWrite:false,simulatedIssueNumber:null,state:updated,runnerStatus:'NOT_STARTED'};
  return {ok:true,code:action.kind==='APPEND_EXISTING'?'SYNTHETIC_APPEND_ONLY':'SYNTHETIC_CREATE_ONLY',
    status:'SIMULATED_ONLY',externalWrite:false,simulatedIssueNumber:target.number,state:updated,runnerStatus:'NOT_STARTED'};
}


// Phase 3B preparatory guard: a PURE, READ-ONLY metadata check.
// It cannot authorize or invoke GitHub writes. For live publishing the
// separately-triggered Research/Security Gate and approved connector remain
// mandatory; untrusted caller "complete" flags are NOT attestation.
const REPO_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_METADATA_AGE_MS = 5 * 60 * 1000;
const VISIBILITIES = new Set(['PUBLIC','PRIVATE']);
const shape = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).every(k => keys.includes(k));
export function assessReadOnlyIssuePublication({ action, inventory, sourceVisibility, targetVisibility, nowMs = Date.now() } = {}) {
  const stop = code => ({ok:false,code,status:'STOP',outboundAllowed:false,providerState:'NOT_STARTED'});
  if (!action || action.mode !== 'SYNTHETIC_ONLY' ||
      !['APPEND_EXISTING','NEW_ISSUE'].includes(action.kind) ||
      !REPO_ID.test(action.targetRepository ?? '') ||
      !REPO_ID.test(action.sourceRepository ?? '') ||
      !ID.test(action.dedupKey ?? '') ||
      action.actionKey !== action.targetRepository+'#'+action.dedupKey ||
      !Number.isSafeInteger(action.sourceIssueNumber) || action.sourceIssueNumber<1 ||
      !/^[0-9a-f]{40}$/.test(action.sourceHead ?? '') ||
      !ID.test(action.sourceJobId ?? '')) return stop('SOURCE_ACTION_IDENTITY_INVALID');
  if (!VISIBILITIES.has(sourceVisibility) || !VISIBILITIES.has(targetVisibility) ||
      (sourceVisibility==='PRIVATE' && targetVisibility==='PUBLIC')) return stop('VISIBILITY_OR_PRIVACY_BOUNDARY_UNKNOWN');
  if (!shape(inventory,['repository','capturedAt','retrievalComplete','totalIssueCount','entries']) ||
      inventory.repository!==action.targetRepository || inventory.retrievalComplete!==true ||
      !Number.isSafeInteger(inventory.totalIssueCount) || inventory.totalIssueCount<0 ||
      inventory.totalIssueCount>200 || !Array.isArray(inventory.entries) ||
      inventory.entries.length!==inventory.totalIssueCount ||
      !Number.isInteger(nowMs)) return stop('TARGET_INVENTORY_NOT_COMPLETE');
  const captured=Date.parse(inventory.capturedAt);
  if (!Number.isFinite(captured) || captured>nowMs || nowMs-captured>MAX_METADATA_AGE_MS) return stop('TARGET_INVENTORY_STALE');
  const numbers=new Set(),dedup=[];
  for (const item of inventory.entries) {
    if (!shape(item,['number','dedupKey','state','commentsComplete','handoffMarkerPresent']) ||
      !Number.isSafeInteger(item.number) || item.number<1 || numbers.has(item.number) ||
      !(item.dedupKey===null || ID.test(item.dedupKey)) ||
      !['open','closed'].includes(item.state) ||
      typeof item.commentsComplete!=='boolean' ||
      typeof item.handoffMarkerPresent!=='boolean') return stop('TARGET_ISSUE_METADATA_INVALID');
    numbers.add(item.number);
    if(item.dedupKey===action.dedupKey) dedup.push(item);
  }
  if(dedup.length>1) return stop('TARGET_DEDUP_CONFLICT');
  // Unlike the synthetic simulator, real old Issues can have no marker.
  // Any unmarked Issue means a new Issue cannot be proved nonduplicative.
  if(action.kind==='NEW_ISSUE') {
    if(action.issueNumber!==null) return stop('NEW_ISSUE_TARGET_INVALID');
    if(inventory.totalIssueCount!==0) return stop('LEGACY_OR_EXISTING_ISSUES_NOT_EXCLUDED');
  } else {
    if(!Number.isSafeInteger(action.issueNumber) || action.issueNumber<1) return stop('APPEND_ISSUE_NUMBER_INVALID');
    const exact=inventory.entries.find(x=>x.number===action.issueNumber);
    if(!exact || exact.state!=='open') return stop('TARGET_ISSUE_NOT_OPEN');
    if(dedup.length!==1 || dedup[0].number!==action.issueNumber ||
       !exact.commentsComplete) return stop('TARGET_ISSUE_MARKER_NOT_VERIFIED');
    if(exact.handoffMarkerPresent) return {
      ok:false,code:'EXACT_TARGET_ALREADY_HAS_HANDOFF',status:'RECORDED_CANDIDATE',
      outboundAllowed:false,providerState:'NOT_STARTED'
    };
  }
  // Fixed vocabulary only. NEVER include untrusted title/body, command lines,
  // raw cause, file paths or protected business information from an action.
  const lines=[
    '<!-- foundation-handoff-review:'+action.dedupKey+' -->',
    'Technical follow-up: source-only candidate (REVIEW ONLY).',
    'Source: '+action.sourceRepository+'#'+action.sourceIssueNumber,
    'Destination: '+action.targetRepository+(action.kind==='APPEND_EXISTING'?'#'+action.issueNumber:' (new Issue candidate)'),
    'Provider: NOT_STARTED. No automatic dispatch, approval or merge.'
  ];
  return {ok:true,code:'METADATA_REVIEW_ONLY',status:'REVIEW_ONLY',
    outboundAllowed:false,providerState:'NOT_STARTED',
    actionKind:action.kind,targetRepository:action.targetRepository,
    targetIssueNumber:action.kind==='APPEND_EXISTING'?action.issueNumber:null,
    fixedTemplate:lines.join('\n')};
}


// Phase 3B incremental receipt contract, OFFLINE ONLY. Caller-supplied readback
// is not authenticated evidence; this never creates a real POSTED/RUNNING/DONE
// receipt, even if values match. A real GitHub collector must separately prove
// the origin and source, under the triggered Research/Security Gate.
export function reconcileSyntheticHandoffReadback({
  action, writeAck, readback, expectedAuthor, nowMs=Date.now(),
}={}) {
  const stop=code=>({ok:false,code,status:'UNKNOWN',authenticated:false,
    outboundAllowed:false,providerState:'NOT_STARTED'});
  if(!action || action.mode!=='SYNTHETIC_ONLY' ||
     !['NEW_ISSUE','APPEND_EXISTING'].includes(action.kind) ||
     !REPO_ID.test(action.targetRepository??'') ||
     !ID.test(action.dedupKey??'') ||
     action.actionKey!==action.targetRepository+'#'+action.dedupKey ||
     !ID.test(expectedAuthor??'') || !Number.isInteger(nowMs)) return stop('RECEIPT_ACTION_INVALID');
  if(!shape(writeAck,['state','repository','issueNumber','commentId']) ||
     !['ACK_RECEIVED','ACK_UNKNOWN'].includes(writeAck.state) ||
     writeAck.repository!==action.targetRepository ||
     !(writeAck.issueNumber===null || (Number.isSafeInteger(writeAck.issueNumber)&&writeAck.issueNumber>0)) ||
     !(writeAck.commentId===null || (Number.isSafeInteger(writeAck.commentId)&&writeAck.commentId>0)))
    return stop('WRITE_ACK_INVALID');
  if(!shape(readback,['repository','capturedAt','retrievalComplete','issueNumber','issueMarkerCount','issueMarkerKey','comments']) ||
     readback.repository!==action.targetRepository ||
     readback.retrievalComplete!==true ||
     !Number.isSafeInteger(readback.issueNumber) || readback.issueNumber<1 ||
     !Number.isSafeInteger(readback.issueMarkerCount) ||
     readback.issueMarkerCount<0 || readback.issueMarkerCount>1 ||
     !(readback.issueMarkerKey===null || ID.test(readback.issueMarkerKey)) ||
     !Array.isArray(readback.comments) || readback.comments.length>500)
    return stop('READBACK_INCOMPLETE');
  const when=Date.parse(readback.capturedAt);
  if(!Number.isFinite(when)||when>nowMs||nowMs-when>MAX_METADATA_AGE_MS) return stop('READBACK_STALE');
  if(writeAck.issueNumber!==null && readback.issueNumber!==writeAck.issueNumber) return stop('READBACK_ISSUE_MISMATCH');
  if(action.kind==='APPEND_EXISTING' && (readback.issueNumber!==action.issueNumber ||
    (readback.issueMarkerCount!==0 || readback.issueMarkerKey!==null))) return stop('READBACK_APPEND_TARGET_MISMATCH');
  if(action.kind==='NEW_ISSUE' && (action.issueNumber!==null ||
    (readback.issueMarkerCount!==1 || readback.issueMarkerKey!==action.dedupKey))) return stop('READBACK_CREATE_TARGET_MISMATCH');
  const ids=new Set();const hits=[];
  for(const comment of readback.comments){
    if(!shape(comment,['id','author','markerKey']) ||
       !Number.isSafeInteger(comment.id) || comment.id<1 ||
       !ID.test(comment.author??'') ||
       !(comment.markerKey===null||ID.test(comment.markerKey)) ||
       ids.has(comment.id)) return stop('READBACK_COMMENT_SCHEMA_CONFLICT');
    ids.add(comment.id);
    if(comment.markerKey===action.dedupKey) hits.push(comment);
  }
  if(action.kind==='APPEND_EXISTING') {
    if(hits.length!==1) return stop(hits.length===0?'READBACK_MARKER_MISSING':'READBACK_MARKER_DUPLICATE');
    if(hits[0].author!==expectedAuthor) return stop('READBACK_AUTHOR_MISMATCH');
    if(writeAck.commentId!==null&&writeAck.commentId!==hits[0].id) return stop('READBACK_COMMENT_ID_MISMATCH');
  } else if(hits.length!==0 || writeAck.commentId!==null) {
    return stop('READBACK_NEW_ISSUE_COMMENT_CONFLICT');
  }
  if(writeAck.state==='ACK_RECEIVED' && (writeAck.issueNumber===null ||
    (action.kind==='APPEND_EXISTING' && writeAck.commentId===null)))
    return stop('ACK_RECEIVED_WITHOUT_ID');
  // Even when the simulation agrees, it is a *candidate* only. A separately
  // authenticated GitHub GET/POST route must issue a real-world receipt.
  return {ok:true,code:'SYNTHETIC_READBACK_MATCH_CANDIDATE',status:'REVIEW_ONLY',
    authenticated:false,outboundAllowed:false,providerState:'NOT_STARTED',
    targetRepository:action.targetRepository,issueNumber:readback.issueNumber,
    simulatedCommentId:action.kind==='APPEND_EXISTING'?hits[0].id:null,
    sourceAckState:writeAck.state};
}


// Phase 3B offline parser for ALREADY-SUPPLIED GitHub GET response objects.
// This does NOT fetch, authenticate the caller, prove global marker uniqueness,
// grant publication authority, or elevate any provider execution state.
const githubGetUrlMatches=(value, host, pathname, hash='')=>{
  if(typeof value!=='string' || value.length>500 || !value.startsWith('https:')) return false;
  try {
    const u=new URL(value);
    return u.protocol==='https:' && u.hostname===host && u.host===host &&
      u.username==='' && u.password==='' && u.pathname===pathname &&
      u.search==='' && u.hash===hash;
  }catch{return false}
};
export function matchSuppliedGitHubGetShape({
  expectedRepository,expectedIssueNumber,expectedCommentId,
  expectedAuthor,expectedMarkerKey,issue,comment
}={}) {
  const stop=code=>({ok:false,code,status:'UNKNOWN',authenticated:false,
    markerUniqueConfirmed:false,outboundAllowed:false,providerState:'NOT_STARTED'});
  if(!REPO_ID.test(expectedRepository??'') ||
    expectedRepository.split('/').some(s=>s==='.'||s==='..') ||
    !Number.isSafeInteger(expectedIssueNumber)||expectedIssueNumber<1 ||
    !Number.isSafeInteger(expectedCommentId)||expectedCommentId<1 ||
    !ID.test(expectedAuthor??'')||!ID.test(expectedMarkerKey??''))
    return stop('GH_EXPECTED_IDENTITY_INVALID');
  if(!issue || typeof issue!=='object'||Array.isArray(issue) ||
     !comment || typeof comment!=='object'||Array.isArray(comment))
    return stop('GH_GET_RESPONSE_MISSING');
  const route=expectedRepository+'/issues/'+expectedIssueNumber;
  const issuePath='/'+route;
  const apiIssuePath='/repos/'+route;
  const commentApiPath='/repos/'+expectedRepository+'/issues/comments/'+expectedCommentId;
  if(issue.number!==expectedIssueNumber || issue.pull_request!==undefined ||
     !githubGetUrlMatches(issue.html_url,'github.com',issuePath) ||
     !githubGetUrlMatches(issue.url,'api.github.com',apiIssuePath))
    return stop('GH_ISSUE_IDENTITY_MISMATCH');
  if(comment.id!==expectedCommentId ||
     !githubGetUrlMatches(comment.html_url,'github.com',issuePath,'#issuecomment-'+expectedCommentId) ||
     !githubGetUrlMatches(comment.issue_url,'api.github.com',apiIssuePath) ||
     !githubGetUrlMatches(comment.url,'api.github.com',commentApiPath))
    return stop('GH_COMMENT_IDENTITY_MISMATCH');
  if(comment.user?.login!==expectedAuthor)return stop('GH_COMMENT_AUTHOR_MISMATCH');
  const marker='<!-- foundation-followup:'+expectedMarkerKey+' -->';
  if(typeof comment.body!=='string'||comment.body.length>8000||
     !(comment.body===marker||comment.body.startsWith(marker+'\n'))||
     comment.body.indexOf(marker,marker.length)!==-1)
    return stop('GH_COMMENT_MARKER_MISMATCH');
  return {ok:true,code:'GH_GET_SHAPE_MATCH_ONLY',status:'READ_ONLY_REVIEW',
    authenticated:false,markerUniqueConfirmed:false,outboundAllowed:false,
    providerState:'NOT_STARTED',repository:expectedRepository,
    issueNumber:expectedIssueNumber,commentId:expectedCommentId};
}


// Phase 3B offline scan of already-provided Issue/comment GET page snapshots.
// Page claims and comment-count equality are never authenticated by this
// helper, so a match is only a candidate for a trusted external readback.
export function reviewSuppliedGitHubCommentPages({
  expectedRepository, expectedIssueNumber, expectedAuthor,
  expectedMarkerKey, issue, pages, capturedAt, nowMs=Date.now()
}={}) {
  const stop=code=>({ok:false,code,status:'UNKNOWN',authenticated:false,
    markerUniqueConfirmed:false,outboundAllowed:false,providerState:'NOT_STARTED'});
  if(!REPO_ID.test(expectedRepository??'') ||
     expectedRepository.split('/').some(s=>s==='.'||s==='..')||
     !Number.isSafeInteger(expectedIssueNumber)||expectedIssueNumber<1||
     !ID.test(expectedAuthor??'')||!ID.test(expectedMarkerKey??'')||
     !Number.isSafeInteger(nowMs))return stop('PAGE_EXPECTED_IDENTITY_INVALID');
  const when=Date.parse(capturedAt);
  if(typeof capturedAt!=='string'||!Number.isFinite(when)||
     when>nowMs||nowMs-when>MAX_METADATA_AGE_MS)
    return stop('PAGE_EVIDENCE_STALE_OR_UNKNOWN');
  if(!issue||typeof issue!=='object'||Array.isArray(issue)||
     issue.number!==expectedIssueNumber||issue.pull_request!==undefined||
     !githubGetUrlMatches(issue.html_url,'github.com',
       '/'+expectedRepository+'/issues/'+expectedIssueNumber)||
     !githubGetUrlMatches(issue.url,'api.github.com',
       '/repos/'+expectedRepository+'/issues/'+expectedIssueNumber)||
     !Number.isSafeInteger(issue.comments)||issue.comments<0||issue.comments>500)
    return stop('PAGE_ISSUE_IDENTITY_OR_COUNT_INVALID');
  const pageCount=Math.max(1,Math.ceil(issue.comments/100));
  if(!Array.isArray(pages)||pages.length!==pageCount)
    return stop('PAGE_SET_INCOMPLETE');
  const seen=new Set(),matches=[];
  const apiIssue='/repos/'+expectedRepository+'/issues/'+expectedIssueNumber;
  const htmlIssue='/'+expectedRepository+'/issues/'+expectedIssueNumber;
  const marker='<!-- foundation-followup:'+expectedMarkerKey+' -->';
  let n=0;
  for(let i=0;i<pages.length;i++){
    const p=pages[i],expectedLength=Math.min(100,issue.comments-i*100);
    if(!shape(p,['page','comments'])||p.page!==i+1||
       !Array.isArray(p.comments)||p.comments.length!==expectedLength)
      return stop('PAGE_SEQUENCE_OR_COUNT_MISMATCH');
    for(const c of p.comments){
      n++;
      if(!c||typeof c!=='object'||Array.isArray(c)||
         !Number.isSafeInteger(c.id)||c.id<1||seen.has(c.id)||
         !githubGetUrlMatches(c.url,'api.github.com',
           '/repos/'+expectedRepository+'/issues/comments/'+c.id)||
         !githubGetUrlMatches(c.issue_url,'api.github.com',apiIssue)||
         !githubGetUrlMatches(c.html_url,'github.com',htmlIssue,
           '#issuecomment-'+c.id)||
         typeof c.body!=='string'||c.body.length>8000 ||
         typeof c.user?.login!=='string')
        return stop('PAGE_COMMENT_IDENTITY_OR_SCHEMA_INVALID');
      seen.add(c.id);
      if(!c.body.includes(marker))continue;
      if(!(c.body===marker||c.body.startsWith(marker+'\n'))||
         c.body.indexOf(marker,marker.length)!==-1)
        return stop('PAGE_MARKER_EMBEDDED_OR_REPEATED');
      if(c.user.login!==expectedAuthor)
        return stop('PAGE_MARKER_AUTHOR_CONFLICT');
      matches.push(c.id);
      if(matches.length>1)return stop('PAGE_MARKER_DUPLICATE');
    }
  }
  if(n!==issue.comments)return stop('PAGE_COMMENT_COUNT_MISMATCH');
  if(matches.length!==1)return stop('PAGE_MARKER_NOT_FOUND');
  // Caller-provided issue.comments/pages can both be forged or become stale
  // during live requests. Never grant mutation or provider-run authority.
  return {ok:true,code:'PAGE_MARKER_MATCH_CANDIDATE',
    status:'READ_ONLY_REVIEW',authenticated:false,markerUniqueConfirmed:false,
    outboundAllowed:false,providerState:'NOT_STARTED',
    repository:expectedRepository,issueNumber:expectedIssueNumber,
    commentId:matches[0],comparedComments:n,comparedPages:pages.length};
}


// Two already-supplied Issue GET snapshots bracket supplied comment pages.
// This pure function detects visible changes, NOT atomic remote consistency.
// No transport, external authority, credential handling or remote write.
export function reviewStableSuppliedGitHubReadback({
  expectedRepository,expectedIssueNumber,expectedAuthor,
  expectedMarkerKey,beforeIssue,afterIssue,pages,
  observedAtStart,observedAtEnd,nowMs=Date.now(),
}={}) {
  const stop=code=>({ok:false,code,status:'UNKNOWN',authenticated:false,
    markerUniqueConfirmed:false,atomicSnapshotProven:false,
    outboundAllowed:false,providerState:'NOT_STARTED'});
  if(!Number.isSafeInteger(nowMs)||typeof observedAtStart!=='string'||
     typeof observedAtEnd!=='string')return stop('STABILITY_CLOCK_INVALID');
  const start=Date.parse(observedAtStart),end=Date.parse(observedAtEnd);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||
     end>nowMs||nowMs-start>MAX_METADATA_AGE_MS)
    return stop('STABILITY_WINDOW_INVALID');
  if(!beforeIssue||typeof beforeIssue!=='object'||Array.isArray(beforeIssue)||
     !afterIssue||typeof afterIssue!=='object'||Array.isArray(afterIssue))
    return stop('STABILITY_ISSUE_GET_ABSENT');
  const matchIdentity=v=>v.number===expectedIssueNumber &&
    v.pull_request===undefined && Number.isSafeInteger(v.id)&&v.id>0 &&
    typeof v.node_id==='string'&&v.node_id.length>0&&v.node_id.length<256 &&
    typeof v.updated_at==='string'&&Number.isFinite(Date.parse(v.updated_at)) &&
    (v.state==='open'||v.state==='closed') &&
    githubGetUrlMatches(v.html_url,'github.com',
      '/'+expectedRepository+'/issues/'+expectedIssueNumber) &&
    githubGetUrlMatches(v.url,'api.github.com',
      '/repos/'+expectedRepository+'/issues/'+expectedIssueNumber);
  if(typeof expectedRepository!=='string'||!REPO_ID.test(expectedRepository)||
     expectedRepository.split('/').some(x=>x==='.'||x==='..')||
     !Number.isSafeInteger(expectedIssueNumber)||expectedIssueNumber<1||
     !matchIdentity(beforeIssue)||!matchIdentity(afterIssue))
    return stop('STABILITY_ISSUE_IDENTITY_INVALID');
  const fields=['id','node_id','number','url','html_url','comments','updated_at','state'];
  if(fields.some(k=>beforeIssue[k]!==afterIssue[k]))
    return stop('STABILITY_ISSUE_CHANGED_DURING_READ');
  const matched=reviewSuppliedGitHubCommentPages({
    expectedRepository,expectedIssueNumber,expectedAuthor,expectedMarkerKey,
    issue:afterIssue,pages,capturedAt:observedAtEnd,nowMs
  });
  if(matched.code!=='PAGE_MARKER_MATCH_CANDIDATE'||
     matched.authenticated!==false||matched.outboundAllowed!==false)
    return stop('STABILITY_PAGE_REVIEW_STOP');
  return {ok:true,code:'STABLE_SUPPLIED_READBACK_CANDIDATE',
    status:'READ_ONLY_REVIEW',authenticated:false,
    markerUniqueConfirmed:false,atomicSnapshotProven:false,
    outboundAllowed:false,providerState:'NOT_STARTED',
    repository:expectedRepository,issueNumber:expectedIssueNumber,
    candidateCommentId:matched.commentId,
    comparedComments:matched.comparedComments,
    comparedPages:matched.comparedPages};
}


// Phase 3B: one local, source-only integration entry point.
// Reuses Phase 2 owner routing + 3A action preparation + 3B metadata review.
// No transport, implicit POST authorization, sensitive free-text return,
// synthetic data mutation, or provider launch. This is NOT a live collector.
export function previewSyntheticHandoff({
  input,candidateId,inventory,sourceVisibility,targetVisibility,nowMs=Date.now()
}={}) {
  const stop=(code,status='STOP')=>({
    ok:false,code,status,authenticated:false,
    outboundAllowed:false,providerState:'NOT_STARTED'
  });
  const prepared=prepareSyntheticIssueAction(input,candidateId,nowMs);
  if(prepared.ok!==true || !prepared.action)
    return stop(prepared.code??'SYNTHETIC_PREPARATION_UNKNOWN');
  const review=assessReadOnlyIssuePublication({
    action:prepared.action,inventory,
    sourceVisibility,targetVisibility,nowMs
  });
  if(review.ok!==true)return stop(review.code??'SYNTHETIC_REVIEW_UNKNOWN',review.status==='RECORDED_CANDIDATE'?'RECORDED_CANDIDATE':'STOP');
  if(review.code!=='METADATA_REVIEW_ONLY'||review.outboundAllowed!==false||
     review.providerState!=='NOT_STARTED'||review.status!=='REVIEW_ONLY'||
     typeof review.fixedTemplate!=='string')
    return stop('SYNTHETIC_REVIEW_CONTRACT_INVALID');
  return {
    ok:true,code:'SYNTHETIC_HANDOFF_REVIEW_ONLY',
    status:'REVIEW_ONLY',authenticated:false,outboundAllowed:false,
    providerState:'NOT_STARTED',
    actionKind:review.actionKind,
    targetRepository:review.targetRepository,
    targetIssueNumber:review.targetIssueNumber,
    fixedTemplate:review.fixedTemplate
  };
}
