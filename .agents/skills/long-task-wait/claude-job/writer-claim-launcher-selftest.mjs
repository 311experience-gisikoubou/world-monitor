import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(os.tmpdir(),'ai-foundation-writer-claim-selftest');
fs.mkdirSync(root,{recursive:true});
const mode=process.argv[2]||'--all';
const proto=path.join(here,'run-claude-job.ps1');
const helper=path.join(here,'writer-claim-store.mjs');
const tmp=fs.mkdtempSync(path.join(root,'qa-launcher-'));
const claims=path.join(tmp,'localappdata');
fs.mkdirSync(claims,{recursive:true});
// Synthetic temp-owned cleanup only; preserve fixtures on FAIL for debugging.
process.on('exit', (code) => {
 if (code !== 0) return;
 if (path.dirname(tmp) !== root || !path.basename(tmp).startsWith('qa-launcher-')) return;
 try { fs.rmSync(tmp, {recursive:true, force:true}); }
 catch (e) { process.stderr.write('synthetic cleanup warning: '+String(e && e.code || 'UNKNOWN')+'\n'); }
});
function run(cmd,args,cwd){
 const r=spawnSync(cmd,args,{cwd,encoding:'utf8',timeout:10000,windowsHide:true});
 if(r.status!==0)throw Error(cmd+' '+args[0]+' failed: '+r.status+' '+(r.stderr||'').slice(0,300));
 return r.stdout.trim();
}
function prepare(id){
 const repo=path.join(tmp,'repo-'+id);
 fs.mkdirSync(repo,{recursive:true});
 run('git',['init','-q',repo],tmp);
 run('git',['config','user.name','Synthetic QA'],repo);
 run('git',['config','user.email','qa@example.invalid'],repo);
 run('git',['config','core.autocrlf','false'],repo); // synthetic temp-only: no Windows line-ending warnings in native PowerShell
 run('git',['remote','add','origin','https://github.com/qa-fixture/repo.git'],repo);
 fs.writeFileSync(path.join(repo,'.gitignore'),'.ai-jobs/\n');
 fs.writeFileSync(path.join(repo,'sample.txt'),'synthetic-only\n');
 fs.mkdirSync(path.join(repo,'.agents','skills','preflight-audit'),{recursive:true});
 fs.mkdirSync(path.join(repo,'.agents','skills','long-task-wait','claude-job'),{recursive:true});
 fs.writeFileSync(path.join(repo,'.agents','skills','preflight-audit','research-gate.mjs'),"import fs from 'node:fs';\nif(process.env.SELFTEST_INJECT_OUTSIDE) fs.writeFileSync(process.env.SELFTEST_INJECT_OUTSIDE,'late synthetic out-of-scope edit\\n');\nif(process.env.SELFTEST_INJECT_INSIDE) fs.writeFileSync(process.env.SELFTEST_INJECT_INSIDE,process.env.SELFTEST_INJECT_INSIDE_CONTENT?Buffer.from(process.env.SELFTEST_INJECT_INSIDE_CONTENT,'base64'):'late same-path synthetic WIP mutation\\n');\nprocess.exit(0);\n");
 fs.writeFileSync(path.join(repo,'.agents','skills','preflight-audit','instruction-clarity-gate.mjs'),'process.exit(0);\n');
 const jobScripts=path.join(repo,'.agents','skills','long-task-wait','claude-job');
 fs.copyFileSync(proto,path.join(jobScripts,'run-claude-job.ps1'));
 fs.copyFileSync(helper,path.join(jobScripts,'writer-claim-store.mjs'));
 fs.writeFileSync(path.join(jobScripts,'claude-job-runner.ps1'),"param([string]$JobDir,[string]$LockPath)\n$s = Get-Content (Join-Path $JobDir 'status.json') -Raw | ConvertFrom-Json\n$f = Join-Path $s.worktree 'qa-wrote-this-file.txt'\n[IO.File]::WriteAllText($f,('synthetic owned writer '+$s.job_id))\nStart-Sleep -Milliseconds 2400\nif (Test-Path $LockPath) { Remove-Item $LockPath }\n");
 fs.writeFileSync(path.join(repo,'prompt.md'),'synthetic source-only: no cloud\n');
 fs.writeFileSync(path.join(repo,'clarity.json'),'{"taskId":"synthetic-scope-only"}\n');
 fs.writeFileSync(path.join(repo,'research.json'),'{"evidence":{"evidenceBinding":{"taskId":"synthetic-scope-only"}},"context":{}}\n');
 run('git',['add','.'],repo);run('git',['commit','-q','-m','synthetic qa base'],repo);
 return repo;
}
// --- CRLF filter fixture support (Issue #332 safe repair) ------------------
// A real (clean+smudge) synthetic Git filter, configured LOCALLY per
// synthetic repo only (never global). The driver script lives OUTSIDE every
// synthetic repo's working tree so it can never surface as an untracked
// file in `git status`/`ls-files --others` and pollute launcher scope
// checks. It only ever reads stdin and writes stdout; it NEVER writes to
// the checkout target itself (the defect diagnosed in job #002's fixture,
// which caused `fatal ...: smudge filter qaselftest failed`).
const filterScript = path.join(tmp, 'qaselftest-filter.mjs');
fs.writeFileSync(filterScript,
  "const chunks=[];process.stdin.on('data',c=>chunks.push(c));\n" +
  "process.stdin.on('end',()=>{\n" +
  " const input=Buffer.concat(chunks);\n" +
  " if(process.argv[2]==='clean'){\n" +
  "  process.stdout.write(Buffer.from(input.toString('binary').replace(/\\r\\n/g,'\\n'),'binary'));\n" +
  " } else { process.stdout.write(input); }\n" +
  "});\n"
);
function prepareWithFilter(id){
 const repo=prepare(id);
 const filterCmd='node "'+filterScript.replace(/\\/g,'/')+'" ';
 run('git',['config','filter.qaselftest.clean',filterCmd+'clean'],repo);
 run('git',['config','filter.qaselftest.smudge',filterCmd+'smudge'],repo);
 run('git',['config','filter.qaselftest.required','true'],repo);
 fs.writeFileSync(path.join(repo,'.gitattributes'),'sample.txt filter=qaselftest\n');
 run('git',['add','.gitattributes'],repo);
 run('git',['commit','-q','-m','synthetic qa filter attrs'],repo);
 return repo;
}
// Resolve the real git.exe once; the PATH-local shim below forwards every
// other git invocation to it unchanged.
const realGitPath=((spawnSync('where',['git'],{encoding:'utf8',windowsHide:true}).stdout)||'').split(/\r?\n/)[0].trim();
if(process.platform==='win32' && !realGitPath) throw Error('CANNOT_RESOLVE_REAL_GIT_FOR_SHIM');
// A tightly-scoped PATH-local git command shim: forwards every git
// invocation unchanged to the real git, EXCEPT it recognizes exactly ONE
// test's own real `git add -A -- sample.txt` call for its own isolated
// worktree (verified to be inside this run's fixture root), forwards that
// too, and only AFTER the real add has already returned success does it
// perform one authorized synthetic mutation -- then never triggers again
// (one-shot sentinel file). No general command execution, no global git
// settings, no access outside the one target worktree it was configured
// for, and every other git command (and every other arg shape of `add`) is
// forwarded completely unchanged.
const gitShimScript=path.join(tmp,'git-shim.mjs');
fs.writeFileSync(gitShimScript,[
 "import {spawnSync} from 'node:child_process';",
 "import fs from 'node:fs';",
 "import path from 'node:path';",
 "const realGit=process.env.QASHIM_REAL_GIT;",
 "const targetWorktree=process.env.QASHIM_TARGET_WORKTREE;",
 "const targetFile=process.env.QASHIM_TARGET_FILE||'sample.txt';",
 "const mode=process.env.QASHIM_MODE;",
 "const sentinel=process.env.QASHIM_SENTINEL;",
 "const fixtureRoot=process.env.QASHIM_FIXTURE_ROOT;",
 "const args=process.argv.slice(2);",
 "function forward(){const r=spawnSync(realGit,args,{stdio:'inherit',windowsHide:true});process.exit(r.status===null?1:r.status);}",
 "function isTargetAdd(){",
 " if(!targetWorktree||!mode||!fixtureRoot) return false;",
 " if(fs.existsSync(sentinel)) return false;",
 " if(args.length<6) return false;",
 " if(args[0]!=='-C') return false;",
 " const cPath=path.resolve(args[1]);",
 " if(cPath!==path.resolve(targetWorktree)) return false;",
 " if(!cPath.startsWith(path.resolve(fixtureRoot))) return false;",
 " if(args[2]!=='add'||args[3]!=='-A'||args[4]!=='--'||args[5]!==targetFile) return false;",
 " return true;",
 "}",
 "if(!isTargetAdd()){ forward(); }",
 "else {",
 " const r=spawnSync(realGit,args,{stdio:'inherit',windowsHide:true});",
 " if(r.status!==0){ process.exit(r.status===null?1:r.status); }",
 " try{ fs.writeFileSync(sentinel,String(Date.now())); }catch{}",
 " const filePath=path.join(targetWorktree,targetFile);",
 " if(mode==='poststage_drift'){",
 "  fs.writeFileSync(filePath,'authorized synthetic partial WIP\\r\\n');",
 " } else if(mode==='staged_tamper'){",
 "  const tampered=Buffer.from('tampered-staged-content-only\\n','utf8');",
 "  const hashed=spawnSync(realGit,['-C',targetWorktree,'hash-object','-w','--stdin'],{input:tampered,encoding:'utf8',windowsHide:true});",
 "  const blobSha=(hashed.stdout||'').trim();",
 "  spawnSync(realGit,['-C',targetWorktree,'update-index','--cacheinfo','100644',blobSha,targetFile],{stdio:'inherit',windowsHide:true});",
 " }",
 " process.exit(0);",
 "}",
].join('\n'));
const gitShimDir=process.platform==='win32'?fs.mkdtempSync(path.join(root,'qa-gitshim-')):null;
if(gitShimDir) fs.writeFileSync(path.join(gitShimDir,'git.cmd'),'@echo off\r\nnode "'+gitShimScript+'" %*\r\nexit /b %ERRORLEVEL%\r\n');
if(process.platform!=='win32'){ console.log('writer-claim-launcher selftest: SKIP (Windows PowerShell 5.1 required)'); process.exit(0); }
if(mode==='--all'){
  const modes=['resume_late_outside','resume_late_inside','resume_allowed','reject_review_stop','reject_review_pending','reject_review_completed','reject_review_unrecognized','reject_review_legacy_ready','reject_review_empty_state','reject_review_null_state','reject_review_code_only','reject_review_receipt_only','auditcode_allowlisted','auditcode_unknown','reviewfindings_positive_concerns','reviewfindings_positive_fail','reviewfindings_empty_verdict','reviewfindings_bogus_verdict','reviewfindings_nonstring_finding','reviewfindings_long_finding','reviewfindings_unsafe_chars','reviewfindings_absent','reviewfindings_invocation_failed','optin_wait_provider_resume','optin_gate_failed_skipped_rejected','resume_capacity_valid','resume_capacity_tampered','resume_capacity_late_content','targetless','legacy_continue','same','same_pr_new_branch','simultaneous','same_issue_different_pr','same_branch_different_pr','different','stale','reacquire','runner_throw','crlf_unchanged_pass','crlf_prestage_drift','crlf_poststage_drift','crlf_staged_tamper'];
  for(const m of modes){
    const rr=spawnSync(process.execPath,[fileURLToPath(import.meta.url),m],{encoding:'utf8',windowsHide:true,timeout:25000});
    if(rr.status!==0)throw Error('SUBTEST_FAILED '+m+' '+(rr.stdout||'').slice(-1300)+' '+(rr.stderr||'').slice(-600));
    console.log('writer-claim-launcher '+m+': PASS');
  }
  console.log(`writer-claim-launcher selftest: PASS (${modes.length} real Windows 5.1 subprocess fixtures)`);
  process.exit(0);
}
const repo1=prepare('a'),repo2=prepare('b');
function launch(repo,pr,issue,taskName,continueJob=null,injectFile=null,injectInsideFile=null,capacityPath=null,extraEnv=null,insideContentBase64=null,postJobReview=false){return new Promise(resolve=>{
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(repo,'.agents','skills','long-task-wait','claude-job','run-claude-job.ps1'),'-RepoPath',repo,'-PromptFile',path.join(repo,'prompt.md'),'-InstructionClarityFile',path.join(repo,'clarity.json'),'-ResearchEvidenceFile',path.join(repo,'research.json'),'-TaskName',taskName,'-ScopePaths','sample.txt','-BaseRef','HEAD','-ProviderTimeoutMinutes','1','-MaxAutoRetries','0'];
 if(pr)args.push('-TargetPrNumber',String(pr));if(issue)args.push('-TargetIssueNumber',String(issue));
 if(continueJob)args.push('-ContinueJob',continueJob);if(capacityPath)args.push('-ExpectedCapacityStatePath',capacityPath);
 if(postJobReview)args.push('-PostJobReview');
 const p=spawn('powershell.exe',args,{env:{...process.env,LOCALAPPDATA:claims,
   ...(injectFile?{SELFTEST_INJECT_OUTSIDE:injectFile}:{}),
   ...(injectInsideFile?{SELFTEST_INJECT_INSIDE:injectInsideFile}:{}),
   ...(insideContentBase64?{SELFTEST_INJECT_INSIDE_CONTENT:insideContentBase64}:{}),
   ...(extraEnv||{})},windowsHide:true});
 let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);
 p.on('error',e=>resolve({exit:-1,error:String(e),stdout:stdout.slice(-650),stderr:stderr.slice(-650),repo}));
 p.on('close',x=>resolve({exit:x,started:stdout.includes('[STARTED]'),claimRejected:/claim.*not granted|claim.*unavailable|claim.*failed/i.test(stdout+stderr),stdout:stdout.slice(-650),stderr:stderr.slice(-650),repo}));
 });}
function keys(){const p=path.join(claims,'ai-dev-foundation','writer-claims');return fs.existsSync(p)?fs.readdirSync(p).filter(x=>x.endsWith('.json')):[];}
// Locates the single `.ai-jobs/<yyyyMMdd-NNN>` directory a fresh (non-
// continuation) launch just created, for tests that need to read its own
// status.json afterward. Returns null unless exactly one exists.
function findJobDir(repo){
 const jobsRoot=path.join(repo,'.ai-jobs');
 if(!fs.existsSync(jobsRoot))return null;
 const entries=fs.readdirSync(jobsRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^\d{8}-\d{3}$/.test(e.name));
 return entries.length===1?path.join(jobsRoot,entries[0].name):null;
}
async function waitForClaim(ms){const until=Date.now()+ms;while(Date.now()<until){if(keys().length>=2)return true;await new Promise(r=>setTimeout(r,70));}return false;}
// The real continuation checkpoint is a source-write after the early scope
// check. Model a late out-of-scope arrival during Research Gate: no broad
// git add -A may capture that file, while a normal scoped WIP still resumes.
if(mode==='resume_late_outside'||mode==='resume_late_inside'||mode==='resume_allowed'){
 const jobId='20261011-099',branch='job/'+jobId+'-qa-a';
 const worktree=path.join(repo1+'.ai-worktrees',jobId);
 run('git',['worktree','add','-q','-b',branch,worktree],repo1);
 fs.writeFileSync(path.join(worktree,'sample.txt'),'authorized synthetic partial WIP\n');
 const dir=path.join(repo1,'.ai-jobs',jobId);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({
   state:'WAIT_PROVIDER',worktree,branch,task:'qa-a',scope_paths:['sample.txt'],
   root_base_commit:run('git',['rev-parse','HEAD'],worktree),
   target_pr_number:288,target_issue_number:283,
   provider_timeout_minutes:1,test_command:''
 }));
 fs.copyFileSync(path.join(repo1,'research.json'),path.join(dir,'research.json'));
 fs.copyFileSync(path.join(repo1,'clarity.json'),path.join(dir,'instruction-clarity.json'));
 const lateFile=path.join(worktree,'late-outside.js');
 const inject=mode==='resume_late_outside',inside=mode==='resume_late_inside';
 const result=await launch(repo1,288,283,'qa-a',jobId,inject?lateFile:null,inside?path.join(worktree,'sample.txt'):null);
 const commits=Number(run('git',['rev-list','--count','HEAD'],worktree));
 const changed=run('git',['diff','--name-only','HEAD'],worktree);
 const marked=fs.existsSync(path.join(worktree,'qa-wrote-this-file.txt'));
 const late=fs.existsSync(lateFile);
 const lockLeft=fs.existsSync(path.join(repo1,'.ai-jobs','running.lock'));
 const pass=inside?(!result.started&&result.exit!==0&&
    /CONTINUATION_DIRTY_CONTENT_CHANGED/.test(result.stdout+result.stderr)&&
    commits===1&&!late&&!marked&&!lockLeft&&changed.includes('sample.txt')&&keys().length===0)
    :inject?(!result.started&&result.exit!==0&&
   /CONTINUATION_DIRTY_SET_CHANGED/.test(result.stdout+result.stderr)&&
   commits===1&&late&&!marked&&!lockLeft&&changed.includes('sample.txt')&&keys().length===0)
   :(result.started&&result.exit===0&&commits===2&&!late&&marked&&
   run('git',['show','--format=','--name-only','HEAD'],worktree)==='sample.txt'&&
   keys().length===0&&!lockLeft);
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,started:result.started,
   commits,changed,late,marked,lockLeft,claims:keys().length,
   stdout:result.stdout,stderr:result.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}
// Issue #332 safety correction: a continuation must be refused BEFORE any
// claim/stage/checkpoint whenever the previous job already carries ANY
// post_job_review_* marker property (regardless of its value) or already
// reached outer state READY_FOR_REVIEW. Each variant below targets exactly
// one adversarial shape of that prior review state; all must refuse
// identically (same code, no new commit/claim/lock, old WIP untouched).
const postJobReviewRejectionModes = {
 reject_review_stop: { state: 'WAIT_PROVIDER', extra: { post_job_review_state: 'STOP', post_job_review_code: 'AUDIT_INVOCATION_NOT_COMPLETED' } },
 reject_review_pending: { state: 'WAIT_PROVIDER', extra: { post_job_review_state: 'PENDING', post_job_review_code: 'POST_JOB_REVIEW_PENDING' } },
 reject_review_completed: { state: 'WAIT_PROVIDER', extra: { post_job_review_state: 'COMPLETED', post_job_review_code: 'POST_JOB_REVIEW_FINAL_RECEIPT_ISSUED' } },
 reject_review_unrecognized: { state: 'WAIT_PROVIDER', extra: { post_job_review_state: 'SOME_UNRECOGNIZED_VALUE' } },
 reject_review_legacy_ready: { state: 'READY_FOR_REVIEW', extra: {} },
 reject_review_empty_state: { state: 'WAIT_PROVIDER', extra: { post_job_review_state: '' } },
 reject_review_null_state: { state: 'WAIT_PROVIDER', extra: { post_job_review_state: null } },
 reject_review_code_only: { state: 'WAIT_PROVIDER', extra: { post_job_review_code: 'POST_JOB_REVIEW_PENDING' } },
 reject_review_receipt_only: { state: 'WAIT_PROVIDER', extra: { post_job_review_receipt: 'C:\\fake\\post-job-review-receipt.json' } },
};
if(Object.hasOwn(postJobReviewRejectionModes,mode)){
 const cfg=postJobReviewRejectionModes[mode];
 const jobId='20261011-399',branch='job/'+jobId+'-qa-e';
 const worktree=path.join(repo1+'.ai-worktrees',jobId);
 run('git',['worktree','add','-q','-b',branch,worktree],repo1);
 fs.writeFileSync(path.join(worktree,'sample.txt'),'authorized synthetic partial WIP\n');
 const dir=path.join(repo1,'.ai-jobs',jobId);
 fs.mkdirSync(dir,{recursive:true});
 const prevStatus=Object.assign({
   state:cfg.state,worktree,branch,task:'qa-e',scope_paths:['sample.txt'],
   root_base_commit:run('git',['rev-parse','HEAD'],worktree),
   target_pr_number:288,target_issue_number:283,
   provider_timeout_minutes:1,test_command:'',
 },cfg.extra);
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(prevStatus));
 fs.copyFileSync(path.join(repo1,'research.json'),path.join(dir,'research.json'));
 fs.copyFileSync(path.join(repo1,'clarity.json'),path.join(dir,'instruction-clarity.json'));
 const result=await launch(repo1,288,283,'qa-e',jobId);
 const commits=Number(run('git',['rev-list','--count','HEAD'],worktree));
 const content=fs.readFileSync(path.join(worktree,'sample.txt'),'utf8');
 const marked=fs.existsSync(path.join(worktree,'qa-wrote-this-file.txt'));
 const lockLeft=fs.existsSync(path.join(repo1,'.ai-jobs','running.lock'));
 const pass=!result.started&&result.exit!==0&&
   /POST_JOB_REVIEW_REQUIRES_FRESH_QUALIFIED_REPAIR_JOB/.test(result.stdout+result.stderr)&&
   commits===1&&!marked&&!lockLeft&&keys().length===0&&
   content==='authorized synthetic partial WIP\n';
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,started:result.started,
   commits,marked,lockLeft,claims:keys().length,content,
   stdout:result.stdout,stderr:result.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}
// Targeted test of the auditCode allowlist sanitization (Issue #332 safety
// correction #2): a fresh job whose claude-job-runner.ps1 stub drives it
// straight to READY_FOR_REVIEW/DONE/all-PASS-gates, paired with a
// post-job-review.mjs stub that reports a fixed STOP/AUDIT_INVOCATION_NOT_COMPLETED
// result carrying one raw `auditCode`. Only run-claude-job.ps1's own
// sanitization is under test here, never post-job-review.mjs's real
// evidence cross-checks (replaced wholesale by the stub).
if(mode==='auditcode_allowlisted'||mode==='auditcode_unknown'){
 const rawAuditCode=mode==='auditcode_allowlisted'?'PROVIDER_TIMEOUT':'TOTALLY_MADE_UP_RAW_PROVIDER_STRING';
 const expectedPersisted=mode==='auditcode_allowlisted'?'PROVIDER_TIMEOUT':'UNKNOWN';
 const repo=prepare(mode);
 const jobScripts=path.join(repo,'.agents','skills','long-task-wait','claude-job');
 fs.writeFileSync(path.join(jobScripts,'claude-job-runner.ps1'),
   "param([string]$JobDir,[string]$LockPath)\n"+
   "$s = Get-Content (Join-Path $JobDir 'status.json') -Raw | ConvertFrom-Json\n"+
   "$s | Add-Member -NotePropertyName state -NotePropertyValue 'READY_FOR_REVIEW' -Force\n"+
   "[IO.File]::WriteAllText((Join-Path $JobDir 'status.json'), ($s | ConvertTo-Json -Depth 8))\n"+
   "$result = [ordered]@{ job_id=$s.job_id; final_state='READY_FOR_REVIEW'; gates=[ordered]@{orchestrator_exit='PASS';claude_result='PASS';scope='PASS';test='PASS'}; changed_files=@('sample.txt') }\n"+
   "[IO.File]::WriteAllText((Join-Path $JobDir 'result.json'), ($result | ConvertTo-Json -Depth 8))\n"+
   "[IO.File]::WriteAllText((Join-Path $JobDir 'DONE'), 'done')\n"+
   "if (Test-Path $LockPath) { Remove-Item $LockPath }\n"
 );
 fs.writeFileSync(path.join(jobScripts,'post-job-review.mjs'),
   "process.stdout.write(JSON.stringify({schemaVersion:1,ok:false,result:'STOP',code:'AUDIT_INVOCATION_NOT_COMPLETED',auditCode:"+JSON.stringify(rawAuditCode)+"}));\n"+
   "process.exitCode=1;\n"
 );
 const result=await launch(repo,288,283,'qa-f',null,null,null,null,null,null,true);
 const jobDir=findJobDir(repo);
 let statusAfter=null;
 try{ statusAfter=JSON.parse(fs.readFileSync(path.join(jobDir,'status.json'),'utf8')); }catch{}
 const pass=!!jobDir&&result.exit!==0&&!!statusAfter&&
   statusAfter.post_job_review_state==='STOP'&&
   statusAfter.post_job_review_code==='AUDIT_INVOCATION_NOT_COMPLETED'&&
   statusAfter.post_job_review_audit_code===expectedPersisted&&
   keys().length===0;
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,jobDir,statusAfter,
   stdout:result.stdout,stderr:result.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}

// Issue #332 Phase 2 slice #1: bounded, all-or-nothing capture of the
// independent reviewer's OWN genuine CONCERNS/FAIL verdict+findings is
// recorded ONLY for a genuine code AUDIT_VERDICT_NOT_PASS, and ONLY once
// every finding passes type/count/length/control-sequence validation. Each
// config below drives a real fresh job through a stub claude-job-runner.ps1
// (straight to READY_FOR_REVIEW/DONE/all-PASS) and a stub post-job-review.mjs
// returning one crafted envelope; only run-claude-job.ps1's own
// sanitization is under test, never post-job-review.mjs's real review.
function readyForReviewRunnerScript(){
 return "param([string]$JobDir,[string]$LockPath)\n"+
   "$s = Get-Content (Join-Path $JobDir 'status.json') -Raw | ConvertFrom-Json\n"+
   "$s | Add-Member -NotePropertyName state -NotePropertyValue 'READY_FOR_REVIEW' -Force\n"+
   "[IO.File]::WriteAllText((Join-Path $JobDir 'status.json'), ($s | ConvertTo-Json -Depth 8))\n"+
   "$result = [ordered]@{ job_id=$s.job_id; final_state='READY_FOR_REVIEW'; gates=[ordered]@{orchestrator_exit='PASS';claude_result='PASS';scope='PASS';test='PASS'}; changed_files=@('sample.txt') }\n"+
   "[IO.File]::WriteAllText((Join-Path $JobDir 'result.json'), ($result | ConvertTo-Json -Depth 8))\n"+
   "[IO.File]::WriteAllText((Join-Path $JobDir 'DONE'), 'done')\n"+
   "if (Test-Path $LockPath) { Remove-Item $LockPath }\n";
}
const reviewFindingsModes = {
 reviewfindings_positive_concerns: { verdict:'CONCERNS', findings:['specific narrow issue'], stored:true },
 reviewfindings_positive_fail: { verdict:'FAIL', findings:['blocking defect one','blocking defect two'], stored:true },
 reviewfindings_empty_verdict: { verdict:'', findings:['x'], stored:false },
 reviewfindings_bogus_verdict: { verdict:'MAYBE', findings:['x'], stored:false },
 reviewfindings_nonstring_finding: { verdict:'CONCERNS', findings:[42,'ok'], stored:false },
 reviewfindings_long_finding: { verdict:'FAIL', findings:['x'.repeat(600)], stored:false },
 reviewfindings_unsafe_chars: { verdict:'CONCERNS', findings:['bad\u001b[31mred\u001b[0m'], stored:false },
 reviewfindings_absent: { omit:true, stored:false },
};
if(Object.hasOwn(reviewFindingsModes,mode)){
 const cfg=reviewFindingsModes[mode];
 const repo=prepare(mode);
 const jobScripts=path.join(repo,'.agents','skills','long-task-wait','claude-job');
 fs.writeFileSync(path.join(jobScripts,'claude-job-runner.ps1'),readyForReviewRunnerScript());
 const envelope={schemaVersion:1,ok:false,result:'STOP',code:'AUDIT_VERDICT_NOT_PASS'};
 if(!cfg.omit){ envelope.verdict=cfg.verdict; envelope.findings=cfg.findings; }
 fs.writeFileSync(path.join(jobScripts,'post-job-review.mjs'),
   "process.stdout.write("+JSON.stringify(JSON.stringify(envelope))+");\nprocess.exitCode=1;\n");
 const result=await launch(repo,288,283,'qa-rf',null,null,null,null,null,null,true);
 const jobDir=findJobDir(repo);
 let statusAfter=null;
 try{ statusAfter=JSON.parse(fs.readFileSync(path.join(jobDir,'status.json'),'utf8')); }catch{}
 const has=!!statusAfter&&Object.prototype.hasOwnProperty.call(statusAfter,'post_job_review_verdict');
 const pass=!!jobDir&&result.exit!==0&&!!statusAfter&&
   statusAfter.post_job_review_state==='STOP'&&statusAfter.post_job_review_code==='AUDIT_VERDICT_NOT_PASS'&&
   keys().length===0&&
   (cfg.stored
     ? has&&statusAfter.post_job_review_verdict===cfg.verdict&&JSON.stringify(statusAfter.post_job_review_findings)===JSON.stringify(cfg.findings)
     : !has&&!Object.prototype.hasOwnProperty.call(statusAfter,'post_job_review_findings'));
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,jobDir,statusAfter,
   stdout:result.stdout,stderr:result.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}
// Simulates an absent/unauthenticated audit result (no parseable JSON output
// at all): verdict/findings must never be stored, and the code must remain
// the genuine invocation-failure code, never AUDIT_VERDICT_NOT_PASS.
if(mode==='reviewfindings_invocation_failed'){
 const repo=prepare(mode);
 const jobScripts=path.join(repo,'.agents','skills','long-task-wait','claude-job');
 fs.writeFileSync(path.join(jobScripts,'claude-job-runner.ps1'),readyForReviewRunnerScript());
 fs.writeFileSync(path.join(jobScripts,'post-job-review.mjs'),"process.stdout.write('not json, no audit happened');\nprocess.exitCode=1;\n");
 const result=await launch(repo,288,283,'qa-rf2',null,null,null,null,null,null,true);
 const jobDir=findJobDir(repo);
 let statusAfter=null;
 try{ statusAfter=JSON.parse(fs.readFileSync(path.join(jobDir,'status.json'),'utf8')); }catch{}
 const pass=!!jobDir&&result.exit!==0&&!!statusAfter&&
   statusAfter.post_job_review_state==='STOP'&&statusAfter.post_job_review_code==='POST_JOB_REVIEW_INVOCATION_FAILED'&&
   !Object.prototype.hasOwnProperty.call(statusAfter,'post_job_review_verdict')&&
   !Object.prototype.hasOwnProperty.call(statusAfter,'post_job_review_findings')&&
   keys().length===0;
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,jobDir,statusAfter,
   stdout:result.stdout,stderr:result.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}

if(mode==='optin_wait_provider_resume'||mode==='optin_gate_failed_skipped_rejected'){
 const good=mode==='optin_wait_provider_resume';
 const repo=prepare(good?'qa-wait-optin':'qa-fail-optin');
 const scripts=path.join(repo,'.agents','skills','long-task-wait','claude-job');
 // Real launcher and real Windows PowerShell runner invocation, but only a
 // synthetic fixture outer runner: never contact a real Claude provider.
 const syntheticState=good?'WAIT_PROVIDER':'GATE_FAILED';
 fs.writeFileSync(path.join(scripts,'claude-job-runner.ps1'),[
  'param([string]$JobDir,[string]$LockPath)',
  '$s = Get-Content (Join-Path $JobDir \'status.json\') -Raw | ConvertFrom-Json',
  '$s | Add-Member -NotePropertyName state -NotePropertyValue '+JSON.stringify(syntheticState)+' -Force',
  '[IO.File]::WriteAllText((Join-Path $JobDir \'status.json\'), ($s | ConvertTo-Json -Depth 8))',
  '$res = [ordered]@{ job_id=$s.job_id; final_state='+JSON.stringify(syntheticState)+'; gates=[ordered]@{orchestrator_exit=\'FAIL: synthetic\';claude_result=\'FAIL: synthetic\';scope=\'PASS\';test=\'SKIPPED: synthetic\'}; changed_files=@() }',
  '[IO.File]::WriteAllText((Join-Path $JobDir \'result.json\'), ($res | ConvertTo-Json -Depth 8))',
  'if (Test-Path $LockPath) { Remove-Item $LockPath }',
 ].join('\n')+'\n');
 const first=await launch(repo,288,283,'qa-optin',null,null,null,null,null,null,true);
 const firstDir=findJobDir(repo);
 let firstStatus=null;
 if(firstDir)try{firstStatus=JSON.parse(fs.readFileSync(path.join(firstDir,'status.json'),'utf8'));}catch{}
 const markers=firstStatus?Object.keys(firstStatus).filter(k=>k.startsWith('post_job_review_')):[];
 const firstJobId=firstDir?path.basename(firstDir):'missing';
 const previousHead=run('git',['rev-parse','HEAD'],repo);
 const resumed=firstDir?await launch(repo,288,283,'qa-optin',firstJobId):{exit:-1,started:false,stdout:'no first job'};
 const afterHead=run('git',['rev-parse','HEAD'],repo);
 const statuses=fs.existsSync(path.join(repo,'.ai-jobs'))?
  fs.readdirSync(path.join(repo,'.ai-jobs'),{withFileTypes:true}).filter(x=>x.isDirectory()&&/^\d{8}-\d{3}$/.test(x.name)).map(x=>x.name):[];
 const noCheckpoint=previousHead===afterHead;
 const clean=!!firstStatus?.worktree&&run('git',['status','--porcelain'],firstStatus.worktree)==='';
 const noClaims=keys().length===0;
 const pass=good
  ? first.exit===0&&first.started&&firstStatus?.state==='WAIT_PROVIDER'&&
    firstStatus?.post_job_review===true&&markers.length===0&&
    resumed.exit===0&&resumed.started&&statuses.length===2&&noCheckpoint&&clean&&noClaims
  : first.exit===0&&first.started&&firstStatus?.state==='GATE_FAILED'&&
    firstStatus?.post_job_review_state==='SKIPPED'&&
    firstStatus?.post_job_review_code==='OUTER_NOT_READY_FOR_REVIEW'&&
    !resumed.started&&resumed.exit!==0&&
    /POST_JOB_REVIEW_REQUIRES_FRESH_QUALIFIED_REPAIR_JOB/.test(resumed.stdout+resumed.stderr)&&
    statuses.length===1&&noCheckpoint&&clean&&noClaims;
 console.log(JSON.stringify({scenario:mode,pass,firstExit:first.exit,firstState:firstStatus?.state,
  reviewMarkers:markers,firstReviewState:firstStatus?.post_job_review_state,
  resumedExit:resumed.exit,resumedStarted:resumed.started,
  refused:/POST_JOB_REVIEW_REQUIRES_FRESH_QUALIFIED_REPAIR_JOB/.test(resumed.stdout+resumed.stderr),
  statuses, noCheckpoint, clean, noClaims, firstStdout:first.stdout.slice(-250),
  resumeStdout:resumed.stdout.slice(-250),resumeStderr:resumed.stderr.slice(-220),scratch:tmp}));
 process.exit(pass?0:2);
}

if(mode==='resume_capacity_valid'||mode==='resume_capacity_tampered'||mode==='resume_capacity_late_content'){
 const jobId='20261011-099',branch='job/'+jobId+'-qa-a';
 const worktree=path.join(repo1+'.ai-worktrees',jobId);
 run('git',['worktree','add','-q','-b',branch,worktree],repo1);
 const bytes=Buffer.from('authorized synthetic partial WIP\n','utf8');
 fs.writeFileSync(path.join(worktree,'sample.txt'),bytes);
 const dir=path.join(repo1,'.ai-jobs',jobId);fs.mkdirSync(dir,{recursive:true});
 const prev={state:'WAIT_PROVIDER',worktree,branch,task:'qa-a',scope_paths:['sample.txt'],root_base_commit:run('git',['rev-parse','HEAD'],worktree),target_pr_number:288,target_issue_number:283,provider_timeout_minutes:1,test_command:''};
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(prev));
 fs.copyFileSync(path.join(repo1,'research.json'),path.join(dir,'research.json'));
 fs.copyFileSync(path.join(repo1,'clarity.json'),path.join(dir,'instruction-clarity.json'));
 const stateFile=path.join(repo1,'.ai-jobs','poller','provider-capacity-state.json');fs.mkdirSync(path.dirname(stateFile),{recursive:true});
 const snap={version:1,jobId,issueNumber:283,worktree,branch,head:prev.root_base_commit,entries:[{path:'sample.txt',status:' M',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]};
 if(mode==='resume_capacity_tampered')snap.entries[0].sha256='0'.repeat(64);
 fs.writeFileSync(stateFile,JSON.stringify({issueNumber:283,latestFoundationJobId:jobId,worktreeSnapshot:snap}));
 const result=await launch(repo1,288,283,'qa-a',jobId,null,mode==='resume_capacity_late_content'?path.join(worktree,'sample.txt'):null,stateFile);
 const commits=Number(run('git',['rev-list','--count','HEAD'],worktree));
 const content=fs.readFileSync(path.join(worktree,'sample.txt'),'utf8');
 const lock=fs.existsSync(path.join(repo1,'.ai-jobs','running.lock'));
 const mark=fs.existsSync(path.join(worktree,'qa-wrote-this-file.txt'));
 const bad=mode==='resume_capacity_tampered';
 const late=mode==='resume_capacity_late_content';
 const pass=late?(!result.started&&result.exit!==0&&/CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH/.test(result.stdout+result.stderr)&&commits===1&&!mark&&!lock&&keys().length===0&&content==='late same-path synthetic WIP mutation\n')
  :bad?(!result.started&&result.exit!==0&&/CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH/.test(result.stdout+result.stderr)&&commits===1&&!mark&&!lock&&keys().length===0&&content==='authorized synthetic partial WIP\n')
   :(result.started&&result.exit===0&&commits===2&&mark&&!lock&&keys().length===0);
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,started:result.started,commits,lock,mark,stdout:result.stdout,stderr:result.stderr}));
 process.exit(pass?0:2);
}
if(mode==='legacy_continue'){
 const jobId='20261011-099';
 const jobDir=path.join(repo1,'.ai-jobs',jobId);
 fs.mkdirSync(jobDir,{recursive:true});
 fs.writeFileSync(path.join(jobDir,'status.json'),JSON.stringify({
   state:'CLAUDE_FAILED',worktree:repo1,
   branch:run('git',['branch','--show-current'],repo1),task:'qa-legacy',
   root_base_commit:run('git',['rev-parse','HEAD'],repo1),
   scope_paths:['sample.txt'],target_pr_number:0,target_issue_number:0
 }));
 const denied=await launch(repo1,0,283,'qa-legacy',jobId);
 const w=repo1+'.ai-worktrees';
 const worktrees=fs.existsSync(w)?fs.readdirSync(w).length:0;
 const pass=denied.exit!==0&&!denied.started&&
   /CONTINUATION_TARGET_IDENTITY_MISSING/.test(denied.stdout+denied.stderr)&&
   worktrees===0&&keys().length===0;
 console.log(JSON.stringify({scenario:'legacy_continuation_identity_reassignment',pass,
   exit:denied.exit,started:denied.started,worktrees,claims:keys().length,scratch:tmp}));
 process.exit(pass?0:2);
}
if(mode==='targetless'){
 const denied=await launch(repo1,0,0,'qa-legacy');
 const w=repo1+'.ai-worktrees';
 const worktrees=fs.existsSync(w)?fs.readdirSync(w).length:0;
 const pass=denied.exit!==0&&!denied.started&&
   /TARGET_IDENTITY_REQUIRED/.test(denied.stdout+denied.stderr)&&
   worktrees===0&&keys().length===0;
 console.log(JSON.stringify({scenario:'targetless_legacy_fail_closed',pass,
   exit:denied.exit,started:denied.started,worktrees,claims:keys().length,scratch:tmp}));
 process.exit(pass?0:2);
}
if(mode==='stale'){
 const cdir=path.join(claims,'ai-dev-foundation','writer-claims');
 const claimArgs=[helper,'--acquire','--claims-dir',cdir,'--repo','qa-fixture/repo','--pr','288','--issue','283','--branch','job/20261011-001-qa-a','--job-id','dead-fixture','--owner-token','0aa5ffeebabedead0aa5ffeebabedead','--pid','12345','--process-start-ticks','1'];
 const created=spawnSync('node',claimArgs,{encoding:'utf8',windowsHide:true,timeout:6000});
 if(created.status!==0)throw Error('FAILED_FIXTURE_CLAIM');
 const denied=await launch(repo1,288,283,'qa-a');
 const dirs=fs.existsSync(repo1+'.ai-worktrees')?fs.readdirSync(repo1+'.ai-worktrees'):[];
 const pass=!denied.started&&denied.claimRejected&&dirs.length===0&&keys().length===3;
 console.log(JSON.stringify({scenario:'stale_owner',pass,denied:{exit:denied.exit,started:denied.started,claimRejected:denied.claimRejected,stdout:denied.stdout},retainedClaimKeys:keys().length,worktreesCreated:dirs.length,scratch:tmp}));
 process.exit(pass?0:2);
}
if(mode==='runner_throw'){
 const runner=path.join(repo1,'.agents','skills','long-task-wait','claude-job','claude-job-runner.ps1');
 fs.writeFileSync(runner,"param([string]$JobDir,[string]$LockPath)\nthrow 'synthetic failure'\n");
 const crashed=await launch(repo1,288,283,'qa-a');
 const remaining=keys().length;
 const pass=crashed.started&&crashed.exit!==0&&remaining===0;
 console.log(JSON.stringify({scenario:'runner_throw_cleanup',pass,started:crashed.started,exit:crashed.exit,claimsRemaining:remaining,stderr:crashed.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}
if(mode==='crlf_unchanged_pass'||mode==='crlf_prestage_drift'){
 const repo1f=prepareWithFilter('c');
 const jobId='20261011-199',branch='job/'+jobId+'-qa-c';
 const worktree=path.join(repo1f+'.ai-worktrees',jobId);
 run('git',['worktree','add','-q','-b',branch,worktree],repo1f);
 fs.writeFileSync(path.join(worktree,'sample.txt'),'authorized synthetic partial WIP\n');
 const dir=path.join(repo1f,'.ai-jobs',jobId);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({
   state:'WAIT_PROVIDER',worktree,branch,task:'qa-c',scope_paths:['sample.txt'],
   root_base_commit:run('git',['rev-parse','HEAD'],worktree),
   target_pr_number:288,target_issue_number:283,
   provider_timeout_minutes:1,test_command:''
 }));
 fs.copyFileSync(path.join(repo1f,'research.json'),path.join(dir,'research.json'));
 fs.copyFileSync(path.join(repo1f,'clarity.json'),path.join(dir,'instruction-clarity.json'));
 const drift=mode==='crlf_prestage_drift';
 // CRLF-only drift: same visual text, different raw bytes, injected into
 // the SAME path during Research Gate (before the launcher's pre-stage
 // identity recheck). Proves raw --no-filters identity catches a pure
 // line-ending change that a normalizing filter could otherwise launder.
 const crlfBytes=Buffer.from('authorized synthetic partial WIP\r\n','utf8').toString('base64');
 const result=await launch(repo1f,288,283,'qa-c',jobId,null,drift?path.join(worktree,'sample.txt'):null,null,null,drift?crlfBytes:null);
 const commits=Number(run('git',['rev-list','--count','HEAD'],worktree));
 const changed=run('git',['diff','--name-only','HEAD'],worktree);
 const marked=fs.existsSync(path.join(worktree,'qa-wrote-this-file.txt'));
 const lockLeft=fs.existsSync(path.join(repo1f,'.ai-jobs','running.lock'));
 const pass=drift?(!result.started&&result.exit!==0&&
    /CONTINUATION_DIRTY_CONTENT_CHANGED/.test(result.stdout+result.stderr)&&
    commits===2&&!marked&&!lockLeft&&changed.includes('sample.txt')&&keys().length===0)
   :(result.started&&result.exit===0&&commits===3&&marked&&
    run('git',['show','--format=','--name-only','HEAD'],worktree)==='sample.txt'&&
    keys().length===0&&!lockLeft);
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,started:result.started,
   commits,changed,marked,lockLeft,claims:keys().length,
   stdout:result.stdout,stderr:result.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}
if(mode==='crlf_poststage_drift'||mode==='crlf_staged_tamper'){
 const repo1f=prepareWithFilter('d');
 const jobId='20261011-299',branch='job/'+jobId+'-qa-d';
 const worktree=path.join(repo1f+'.ai-worktrees',jobId);
 run('git',['worktree','add','-q','-b',branch,worktree],repo1f);
 fs.writeFileSync(path.join(worktree,'sample.txt'),'authorized synthetic partial WIP\n');
 const dir=path.join(repo1f,'.ai-jobs',jobId);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({
   state:'WAIT_PROVIDER',worktree,branch,task:'qa-d',scope_paths:['sample.txt'],
   root_base_commit:run('git',['rev-parse','HEAD'],worktree),
   target_pr_number:288,target_issue_number:283,
   provider_timeout_minutes:1,test_command:''
 }));
 fs.copyFileSync(path.join(repo1f,'research.json'),path.join(dir,'research.json'));
 fs.copyFileSync(path.join(repo1f,'clarity.json'),path.join(dir,'instruction-clarity.json'));
 const sentinel=path.join(gitShimDir,'triggered-'+jobId+'.flag');
 const shimMode=mode==='crlf_poststage_drift'?'poststage_drift':'staged_tamper';
 const pathKey=Object.keys(process.env).find(k=>k.toUpperCase()==='PATH')||'PATH';
 const extraEnv={
   [pathKey]: gitShimDir+path.delimiter+process.env[pathKey],
   QASHIM_REAL_GIT: realGitPath,
   QASHIM_TARGET_WORKTREE: worktree,
   QASHIM_TARGET_FILE: 'sample.txt',
   QASHIM_MODE: shimMode,
   QASHIM_SENTINEL: sentinel,
   QASHIM_FIXTURE_ROOT: tmp,
 };
 // Deterministic, zero-flake, scoped OUTSIDE the production launcher: the
 // PATH-local shim forwards this one real `git add` for this one worktree
 // to the real git, then performs its one authorized synthetic mutation
 // only after real git has already returned success -- never inside a git
 // filter (the prior defect: a filter self-writing its own checkout target
 // caused a Windows file-lock failure, diagnosed in job #002).
 const result=await launch(repo1f,288,283,'qa-d',jobId,null,null,null,extraEnv);
 const commits=Number(run('git',['rev-list','--count','HEAD'],worktree));
 const marked=fs.existsSync(path.join(worktree,'qa-wrote-this-file.txt'));
 const lockLeft=fs.existsSync(path.join(repo1f,'.ai-jobs','running.lock'));
 const shimFired=fs.existsSync(sentinel);
 const diskContent=fs.readFileSync(path.join(worktree,'sample.txt'),'utf8');
 let stagedObject=null;
 try{ stagedObject=run('git',['rev-parse',':sample.txt'],worktree); }catch{ stagedObject=null; }
 const pass=shimMode==='poststage_drift'
   ?(shimFired&&!result.started&&result.exit!==0&&
     /CONTINUATION_DIRTY_CONTENT_CHANGED/.test(result.stdout+result.stderr)&&
     commits===2&&!marked&&!lockLeft&&keys().length===0&&
     diskContent==='authorized synthetic partial WIP\r\n')
   :(shimFired&&!result.started&&result.exit!==0&&
     /CONTINUATION_STAGED_CONTENT_MISMATCH/.test(result.stdout+result.stderr)&&
     commits===2&&!marked&&!lockLeft&&keys().length===0&&
     diskContent==='authorized synthetic partial WIP\n'&&
     /^[0-9a-f]{40,64}$/.test(stagedObject||''));
 console.log(JSON.stringify({scenario:mode,pass,exit:result.exit,started:result.started,
   commits,marked,lockLeft,shimFired,diskContent,stagedObject,claims:keys().length,
   stdout:result.stdout,stderr:result.stderr,scratch:tmp}));
 process.exit(pass?0:2);
}
if(mode==='simultaneous'){
  const [one,two]=await Promise.all([launch(repo1,288,283,'qa-a'),launch(repo2,288,283,'qa-b')]);
  const markers=[repo1,repo2].map(r=>{const p=r+'.ai-worktrees';return fs.existsSync(p)?fs.readdirSync(p).reduce((v,n)=>v+Number(fs.existsSync(path.join(p,n,'qa-wrote-this-file.txt'))),0):0;});
  const approved=[one,two].filter(x=>x.started).length;
  const denied=[one,two].filter(x=>x.claimRejected&&!x.started).length;
  const pass=approved===1&&denied===1&&markers[0]+markers[1]===1&&keys().length===0;
  console.log(JSON.stringify({scenario:'simultaneous_two_clones_same_pr_issue',pass,started:approved,denied,markers,claimFilesLeft:keys().length,scratch:tmp}));
  process.exit(pass?0:2);
}
const first=launch(repo1,288,283,'qa-a');
const acquired=await waitForClaim(7000);
if(!acquired){const x=await first; console.log(JSON.stringify({error:'NO_CLAIM',first:x,keys:keys(),temp:tmp}));process.exit(2);}
const second=launch(repo2,mode==='different'?296:mode==='same_issue_different_pr'||mode==='same_branch_different_pr'?297:288,mode==='different'?297:mode==='same_branch_different_pr'?298:283,mode==='same_pr_new_branch'||mode==='same_issue_new_branch'||mode==='same_issue_different_pr'||mode==='different'?'qa-b':'qa-a');
const [ra,rb]=await Promise.all([first,second]);
const writes=[repo1,repo2].map(repo=>({repo:path.basename(repo),count:(fs.existsSync(repo+'.ai-worktrees')?fs.readdirSync(repo+'.ai-worktrees') :[]).reduce((n,name)=>n+(fs.existsSync(path.join(repo+'.ai-worktrees',name,'qa-wrote-this-file.txt'))?1:0),0)}));
const n=writes.reduce((sum,r)=>sum+r.count,0);
const unremoved=keys().length;
if(mode==='reacquire'){
 const next=await launch(repo2,288,283,'qa-b');
 const p=repo2+'.ai-worktrees';
 const count=fs.existsSync(p)?fs.readdirSync(p).reduce((n,x)=>n+(fs.existsSync(path.join(p,x,'qa-wrote-this-file.txt'))?1:0),0):0;
 const pass=ra.started&&!rb.started&&rb.claimRejected&&next.started&&count===1&&keys().length===0;
 console.log(JSON.stringify({scenario:'release_reacquire',pass,firstExit:ra.exit,loserExit:rb.exit,laterExit:next.exit,laterStarted:next.started,secondWriteCount:count,remainingClaims:keys().length,scratch:tmp}));
 process.exit(pass?0:2);
}

console.log(JSON.stringify({first:{exit:ra.exit,started:ra.started,stdout:ra.stdout,stderr:ra.stderr},second:{exit:rb.exit,started:rb.started,claimRejected:rb.claimRejected,stdout:rb.stdout,stderr:rb.stderr},writes,writingProcesses:n,claimsRemaining:unremoved,scratch:tmp}));
if(!ra.started||unremoved!==0||(mode==='different' ? (!rb.started||n!==2) : (rb.started||!rb.claimRejected||n!==1)))process.exitCode=2;
