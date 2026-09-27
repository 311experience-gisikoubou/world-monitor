<#
  Selftest for bounded AI-owned auto-continuation in the Claude job runner.
  Part 1: pure policy. Part 2: runner integration with a local fake orchestrator in a temp git repo.
  No network, no real Claude. Temp data is removed at the end.
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'claude-job-retry-policy.ps1')

$script:fail = 0
$script:pass = 0
function Check([bool]$cond, [string]$name) {
    if ($cond) { $script:pass++; Write-Host "  ok   $name" }
    else { $script:fail++; Write-Host "  FAIL $name" -ForegroundColor Red }
}

function New-Gates([string]$test = 'FAIL: exit 1 (see test.log)') {
    [ordered]@{ orchestrator_exit = 'PASS'; claude_result = 'PASS'; scope = 'PASS'; test = $test }
}

Write-Host '== policy =='
$d = Get-AutoRetryDecision -Gates (New-Gates) -OrchCode 'OK' -TestLog 'AssertionError: x' -AutoRetriesUsed 0 -MaxAutoRetries 2 -PriorFingerprints @()
Check ($d.retry -eq $true -and -not $d.stop_code) 'retryable test failure retries'
$g = New-Gates; $g['scope'] = 'FAIL: out-of-scope a.txt'
$d = Get-AutoRetryDecision -Gates $g -OrchCode 'OK' -TestLog 'x' -AutoRetriesUsed 0 -MaxAutoRetries 2
Check ($d.retry -eq $false -and $d.stop_code -eq 'SCOPE_FAILED') 'scope fail stops'
$g = New-Gates; $g['claude_result'] = 'FAIL: X'
$d = Get-AutoRetryDecision -Gates $g -OrchCode 'X' -TestLog 'x' -AutoRetriesUsed 0 -MaxAutoRetries 2
Check ($d.retry -eq $false -and $d.stop_code -eq 'CLAUDE_OR_ORCHESTRATOR_FAILED') 'Claude fail stops'
$d = Get-AutoRetryDecision -Gates (New-Gates 'FAIL: test transport error (see test.log)') -OrchCode 'OK' -TestLog 'boom' -AutoRetriesUsed 0 -MaxAutoRetries 2
Check ($d.retry -eq $false -and $d.stop_code -eq 'TEST_TRANSPORT_ERROR') 'transport error stops'
$d = Get-AutoRetryDecision -Gates (New-Gates 'SKIPPED: no test command') -OrchCode 'OK' -TestLog '' -AutoRetriesUsed 0 -MaxAutoRetries 2
Check ($d.retry -eq $false -and $d.stop_code -eq 'TEST_SKIPPED_OR_INCOMPLETE') 'skipped test stops'
$d = Get-AutoRetryDecision -Gates (New-Gates) -OrchCode 'OK' -TestLog '   ' -AutoRetriesUsed 0 -MaxAutoRetries 2
Check ($d.retry -eq $false -and $d.stop_code -eq 'INVALID_EVIDENCE') 'missing evidence stops'
foreach ($code in @('HUMAN_GATE_REQUIRED', 'WAITING_AT_VALID_HUMAN_GATE', 'HUMAN_CONFIRMATION_REQUIRED')) {
    $d = Get-AutoRetryDecision -Gates (New-Gates) -OrchCode 'OK' -TestLog "output`n$code`n" -AutoRetriesUsed 0 -MaxAutoRetries 2
    Check ($d.retry -eq $false -and $d.stop_code -eq $code) "human gate $code stops"
}
$nested = '{"result":"COMPLETED","code":"OK","details":{"steps":[{"note":{"status":"WAITING_AT_VALID_HUMAN_GATE"}}]}}'
$d = Get-AutoRetryDecision -Gates (New-Gates) -OrchCode 'OK' -TestLog 'AssertionError: x' -AutoRetriesUsed 0 -MaxAutoRetries 2 -OrchEvidence $nested
Check ($d.retry -eq $false -and $d.stop_code -eq 'WAITING_AT_VALID_HUMAN_GATE') 'nested orchestrator human gate stops'
$d = Get-AutoRetryDecision -Gates (New-Gates) -OrchCode 'OK' -TestLog 'AssertionError: x' -AutoRetriesUsed 0 -MaxAutoRetries 2 -OrchEvidence '{"note":"not a HUMAN_GATE_REQUIRED_x token"}'
Check ($d.retry -eq $true) 'non-exact token in orchestrator evidence does not stop'
$fpA = Get-FailureFingerprint "Error at 2026-01-01T10:00:00Z took 12ms in C:\a\b\c.js`nexpected 1"
$fpB = Get-FailureFingerprint "Error at 2027-05-05T11:11:11Z took 99ms in D:\x\y.js`nexpected 1"
Check ($fpA -eq $fpB) 'fingerprint normalizes timestamps/durations/paths'
Check ($fpA -ne (Get-FailureFingerprint "Error`nexpected 2")) 'fingerprint distinguishes different failures'
$d = Get-AutoRetryDecision -Gates (New-Gates) -OrchCode 'OK' -TestLog 'same failure' -AutoRetriesUsed 1 -MaxAutoRetries 2 -PriorFingerprints @((Get-FailureFingerprint 'same failure'))
Check ($d.retry -eq $false -and $d.stop_code -eq 'REPEATED_FAILURE') 'repeated fingerprint stops'
$d = Get-AutoRetryDecision -Gates (New-Gates) -OrchCode 'OK' -TestLog 'new failure' -AutoRetriesUsed 2 -MaxAutoRetries 2 -PriorFingerprints @('a', 'b')
Check ($d.retry -eq $false -and $d.stop_code -eq 'MAX_RETRIES_EXHAUSTED') 'max retry exhaustion stops'
Check ((Get-EffectiveMaxAutoRetries 9) -eq 2 -and (Get-EffectiveMaxAutoRetries $null) -eq 2 -and (Get-EffectiveMaxAutoRetries 1) -eq 1) 'max retries clamped to hard max 2'

Write-Host '== runner integration =='
$runner = Join-Path $PSScriptRoot 'claude-job-runner.ps1'
$psExe = (Get-Process -Id $PID).Path
$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ('claude-job-selftest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpRoot | Out-Null

function Invoke-Scenario([string]$name, [string]$mode, [string]$branchOverride = '') {
    $repo = Join-Path $tmpRoot $name
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'src'), (Join-Path $repo '.agents\skills\preflight-audit') | Out-Null
    [IO.File]::WriteAllText((Join-Path $repo '.gitignore'), ".ai-jobs/`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $repo 'src\.keep'), "k`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $repo 'check.js'), @'
const fs = require('fs');
const n = parseInt(fs.readFileSync('src/out.txt', 'utf8').trim(), 10);
const mode = process.env.SELFTEST_MODE;
if (mode === 'human') { console.log('HUMAN_GATE_REQUIRED'); process.exit(1); }
if (mode === 'nested') { console.log('AssertionError: nested gate case'); process.exit(1); }
if (mode === 'repeat') { console.log('AssertionError: expected 1 to equal 2'); process.exit(1); }
if (n >= 2) process.exit(0);
console.log('AssertionError: got attempt ' + n);
process.exit(1);
'@, $utf8)
    [IO.File]::WriteAllText((Join-Path $repo '.agents\skills\preflight-audit\implementation-orchestrator.mjs'), @'
import fs from 'node:fs';
import { execSync } from 'node:child_process';
process.stdin.resume();
process.stdin.on('end', () => {
  // Model production orchestrator: reject a dirty worktree before doing any work.
  const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (dirty) {
    fs.mkdirSync('.ai-jobs', { recursive: true });
    fs.appendFileSync('.ai-jobs/rejects.txt', 'x\n');
    console.log(JSON.stringify({ result: 'FAILED', code: 'WORKTREE_NOT_CLEAN' }));
    process.exit(1);
  }
  fs.mkdirSync('.ai-jobs', { recursive: true });
  let n = 0;
  try { n = parseInt(fs.readFileSync('.ai-jobs/counter.txt', 'utf8'), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync('.ai-jobs/counter.txt', String(n));
  fs.writeFileSync('src/out.txt', String(n) + '\n');
  if (process.env.SELFTEST_MODE === 'outscope') fs.writeFileSync('outside.txt', 'x\n');
  const out = { result: 'COMPLETED', code: 'OK' };
  if (process.env.SELFTEST_MODE === 'nested') out.details = { steps: [{ status: 'HUMAN_CONFIRMATION_REQUIRED' }] };
  console.log(JSON.stringify(out));
});
'@, $utf8)
    # Local-only handling: PS 5.1 treats native stderr (LF->CRLF warnings) as an error under Stop.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        git -c core.safecrlf=false -C $repo init -q 2>&1 | Out-Null
        git -c core.safecrlf=false -C $repo add -A 2>&1 | Out-Null
        git -c core.safecrlf=false -c user.name=selftest -c user.email=selftest@example.invalid -C $repo commit -q -m base 2>&1 | Out-Null
        $base = ((git -c core.safecrlf=false -C $repo rev-parse HEAD 2>$null) | Out-String).Trim()
        $defaultBranch = ((git -C $repo rev-parse --abbrev-ref HEAD 2>$null) | Out-String).Trim()
        git -C $repo checkout -q -b job/selftest 2>&1 | Out-Null
    } finally { $ErrorActionPreference = $prevEap }
    $jobDir = Join-Path $repo '.ai-jobs\job1'
    New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
    [IO.File]::WriteAllText((Join-Path $jobDir 'prompt.md'), "ORIGINAL OBJECTIVE`n", $utf8)
    $st = [ordered]@{
        job_id = 'job1'; task = 'selftest'; state = 'STARTING'; worktree = $repo; branch = $(if ($branchOverride) { $branchOverride } else { 'job/selftest' })
        root_base_commit = $base; scope_paths = @('src/**'); test_command = 'node check.js'
        provider_timeout_minutes = 1; repository_owner = 'o'; repository_name = 'r'
        max_auto_retries = 2; started_at = (Get-Date).ToString('o')
    }
    [IO.File]::WriteAllText((Join-Path $jobDir 'status.json'), ($st | ConvertTo-Json -Depth 6), $utf8)
    $lock = Join-Path $repo '.ai-jobs\running.lock'
    [IO.File]::WriteAllText($lock, '{"job_id":"job1"}', $utf8)
    $env:SELFTEST_MODE = $mode
    $env:GIT_AUTHOR_NAME = 'selftest'; $env:GIT_COMMITTER_NAME = 'selftest'
    $env:GIT_AUTHOR_EMAIL = 'selftest@example.invalid'; $env:GIT_COMMITTER_EMAIL = 'selftest@example.invalid'
    try { & $psExe -NoProfile -ExecutionPolicy Bypass -File $runner -JobDir $jobDir -LockPath $lock 2>&1 | Out-Null }
    finally {
        Remove-Item Env:\SELFTEST_MODE, Env:\GIT_AUTHOR_NAME, Env:\GIT_COMMITTER_NAME, Env:\GIT_AUTHOR_EMAIL, Env:\GIT_COMMITTER_EMAIL -ErrorAction SilentlyContinue
    }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $commits = [int](((git -C $repo rev-list --count "$base..HEAD" 2>$null) | Out-String).Trim())
        $curBranch = ((git -C $repo rev-parse --abbrev-ref HEAD 2>$null) | Out-String).Trim()
        $defaultTip = ((git -C $repo rev-parse $defaultBranch 2>$null) | Out-String).Trim()
        $dirtyNow = @(git -C $repo status --porcelain 2>$null | Where-Object { $_ })
    } finally { $ErrorActionPreference = $prevEap }
    $rejectsPath = Join-Path $repo '.ai-jobs\rejects.txt'
    $counterPath = Join-Path $repo '.ai-jobs\counter.txt'
    [pscustomobject]@{
        Base = $base; Commits = $commits; Branch = $curBranch; DefaultTip = $defaultTip; DirtyNow = $dirtyNow
        Rejects = $(if (Test-Path $rejectsPath) { @(Get-Content $rejectsPath).Count } else { 0 })
        OrchCalls = $(if (Test-Path $counterPath) { [int](Get-Content $counterPath -Raw).Trim() } else { 0 })
        Status = (Get-Content (Join-Path $jobDir 'status.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
        Result = (Get-Content (Join-Path $jobDir 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
        JobDir = $jobDir
    }
}

try {
    $r = Invoke-Scenario 'pass-on-retry' ''
    Check ($r.Status.state -eq 'READY_FOR_REVIEW' -and $r.Result.final_state -eq 'READY_FOR_REVIEW') 'retry pass => READY_FOR_REVIEW'
    Check (Test-Path (Join-Path $r.JobDir 'DONE')) 'retry pass => DONE'
    Check ($r.Status.attempt -eq 2 -and $r.Status.auto_retries_used -eq 1) 'status shows attempt 2 / 1 retry'
    Check (@($r.Result.attempts).Count -eq 2 -and $r.Result.gates.test -eq 'PASS' -and @($r.Result.changed_files).Count -gt 0) 'result keeps gates/changed_files + attempts summary'
    Check ((Test-Path (Join-Path $r.JobDir 'attempts\attempt-1\test.log')) -and (Test-Path (Join-Path $r.JobDir 'attempts\attempt-2\result.json'))) 'per-attempt audit evidence preserved'
    Check ((Get-Content (Join-Path $r.JobDir 'prompt.md') -Raw) -eq "ORIGINAL OBJECTIVE`n") 'prompt.md not overwritten'
    $t = Get-Content (Join-Path $r.JobDir 'attempts\attempt-2\task.json') -Raw -Encoding UTF8
    Check ($t -match 'ORIGINAL OBJECTIVE' -and $t -match 'got attempt 1') 'retry prompt keeps objective and includes failure evidence'
    Check ($r.Rejects -eq 0 -and $r.OrchCalls -eq 2) 'dirty-worktree-rejecting orchestrator never rejected: checkpoint made worktree clean'
    Check ($r.Commits -eq 1 -and $r.Branch -eq 'job/selftest' -and @($r.Result.retry_checkpoints).Count -eq 1) 'exactly one checkpoint commit on the same feature branch'
    Check ($r.DefaultTip -eq $r.Base) 'main/default branch untouched by checkpoint'
    Check ($r.Result.attempts[0].final_state -eq 'GATE_FAILED' -and $null -eq $r.Result.retry_stop_code) 'first attempt failed then retried without stop code'

    $r = Invoke-Scenario 'repeat' 'repeat'
    Check ($r.Status.state -eq 'GATE_FAILED' -and $r.Status.retry_stop_code -eq 'REPEATED_FAILURE') 'repeated failure stops with REPEATED_FAILURE'
    Check ($r.Status.attempt -eq 2 -and $r.Status.auto_retries_used -eq 1) 'repeat stops without extra retry'
    Check (-not (Test-Path (Join-Path $r.JobDir 'DONE'))) 'no DONE on failure'
    Check ($r.Commits -eq 1 -and $r.OrchCalls -eq 2 -and $r.Rejects -eq 0) 'repeat: only the one needed checkpoint, no extra retry'
    Check ($r.DefaultTip -eq $r.Base) 'repeat: main untouched'

    $r = Invoke-Scenario 'human' 'human'
    Check ($r.Status.state -eq 'GATE_FAILED' -and $r.Status.retry_stop_code -eq 'HUMAN_GATE_REQUIRED') 'human gate stops with canonical code'
    Check ($r.Status.attempt -eq 1 -and $r.Status.auto_retries_used -eq 0) 'human gate => no retry'
    Check ($r.Commits -eq 0 -and @($r.Result.retry_checkpoints).Count -eq 0) 'human gate => zero retry checkpoint'

    $r = Invoke-Scenario 'nested' 'nested'
    Check ($r.Status.state -eq 'GATE_FAILED' -and $r.Status.retry_stop_code -eq 'HUMAN_CONFIRMATION_REQUIRED') 'nested orchestrator human gate stops with canonical code'
    Check ($r.Status.attempt -eq 1 -and $r.Status.auto_retries_used -eq 0) 'nested human gate => no retry'
    Check ($r.Commits -eq 0) 'nested human gate => zero retry checkpoint'

    $r = Invoke-Scenario 'outscope' 'outscope'
    Check ($r.Status.state -eq 'GATE_FAILED' -and $r.Status.retry_stop_code -eq 'SCOPE_FAILED' -and $r.Status.attempt -eq 1) 'out-of-scope change stops with SCOPE_FAILED'
    Check ($r.Commits -eq 0 -and (@($r.DirtyNow) -join ' ') -match 'outside\.txt') 'out-of-scope changes never checkpointed'

    $r = Invoke-Scenario 'ckfail' '' 'some-other-branch'
    Check ($r.Status.state -eq 'GATE_FAILED' -and $r.Status.retry_stop_code -eq 'RETRY_CHECKPOINT_FAILED') 'checkpoint failure fails closed with RETRY_CHECKPOINT_FAILED'
    Check ($r.OrchCalls -eq 1 -and $r.Commits -eq 0 -and $r.Status.attempt -eq 1) 'checkpoint failure => no further implementation attempt, no commit'
    Check (-not (Test-Path (Join-Path $r.JobDir 'DONE'))) 'checkpoint failure => no DONE'
} finally {
    Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
}

Write-Host "`nPASS=$script:pass FAIL=$script:fail"
if ($script:fail -gt 0) { exit 1 }
Write-Host 'claude-job-runner-selftest: OK'
exit 0
