<#
.SYNOPSIS
  Read-only status check for an asynchronous Claude implementation job.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoPath,
    [string]$JobId,
    [int]$LongMinutes = 60
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
function Prop($o, [string]$n) { if ($o -and $o.PSObject.Properties[$n]) { $o.$n } else { $null } }

$top = git -C $RepoPath rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $top) { Write-Host "Not a git repository: $RepoPath"; exit 1 }
$top = [IO.Path]::GetFullPath($top.Trim())
$jobsRoot = Join-Path $top '.ai-jobs'
if (-not (Test-Path $jobsRoot)) { Write-Host 'No job records.'; exit 1 }
if (-not $JobId) {
    $latest = Get-ChildItem $jobsRoot -Directory | Sort-Object Name | Select-Object -Last 1
    if (-not $latest) { Write-Host 'No jobs.'; exit 1 }
    $JobId = $latest.Name
}
$jobDir = Join-Path $jobsRoot $JobId
$statusPath = Join-Path $jobDir 'status.json'
if (-not (Test-Path $statusPath)) { Write-Host "status.json not found for $JobId"; exit 1 }
$st = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
$started = [datetime]::Parse($st.started_at)
$endRaw = Prop $st 'ended_at'
$endTime = if ($endRaw) { [datetime]::Parse($endRaw) } else { Get-Date }
$elapsed = [math]::Round(($endTime - $started).TotalMinutes, 1)
$rpid = [int](Prop $st 'runner_pid')
$startTicks = Prop $st 'runner_process_start_utc_ticks'
$alive = $false
$pidReused = $false
if ($rpid -gt 0) {
    $rp = Get-Process -Id $rpid -ErrorAction SilentlyContinue
    if ($rp -and $startTicks) {
        $alive = ([int64]$rp.StartTime.ToUniversalTime().Ticks -eq [int64]$startTicks)
        $pidReused = -not $alive
    }
}
$active = $st.state -in @('STARTING','RUNNING','GATES_RUNNING')
$view = [string]$st.state
$identityPending = $st.state -eq 'STARTING' -and -not $startTicks -and $elapsed -lt 1
if ($active -and -not $alive -and -not $identityPending) { $view = 'LOST' }
elseif ($active -and $alive -and $elapsed -gt $LongMinutes) { $view = 'LONG_RUNNING' }

Write-Host "=== $JobId [$view] ==="
Write-Host "elapsed  : $elapsed min"
Write-Host "runner   : $(if ($alive) { "alive PID $rpid" } elseif ($pidReused) { "PID $rpid reused by another process" } elseif ($identityPending) { 'identity pending' } else { 'not running' })"
Write-Host "branch   : $($st.branch)"
Write-Host "worktree : $($st.worktree)"
if (Prop $st 'continued_from') { Write-Host "from     : $($st.continued_from)" }

if (Test-Path $st.worktree) {
    $ch = @(git -C $st.worktree diff --name-only $st.root_base_commit 2>$null) + @(git -C $st.worktree ls-files --others --exclude-standard 2>$null)
    $ch = @($ch | Where-Object { $_ } | Sort-Object -Unique)
    Write-Host "`n--- changed files ($($ch.Count)) ---"
    $ch | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
    if ($ch.Count -gt 20) { Write-Host "  ... plus $($ch.Count - 20)" }
}

$resPath = Join-Path $jobDir 'result.json'
if (Test-Path $resPath) {
    $res = Get-Content $resPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host "`n--- gates ---"
    foreach ($p in $res.gates.PSObject.Properties) { Write-Host ("  {0,-18} {1}" -f $p.Name, $p.Value) }
}
$errPath = Join-Path $jobDir 'stderr.log'
if ((Test-Path $errPath) -and (Get-Item $errPath).Length -gt 0) { Write-Host "`n[!] stderr.log has output" -ForegroundColor Yellow }

Write-Host "`n--- next ---"
switch ($view) {
    { $_ -in 'STARTING','RUNNING','GATES_RUNNING' } { Write-Host 'Continue normal bounded observation; do not relaunch.' }
    'LONG_RUNNING' { Write-Host 'Warning only. Do not kill automatically; inspect progress/diff and continue observation.' }
    'LOST' { Write-Host 'Inspect diff/stderr. If still in scope, continue with -ContinueJob -ClearStaleLock.' }
    'CLAUDE_FAILED' { Write-Host 'Inspect orchestrator.json/stderr and continue only the remaining in-scope work.' }
    'GATE_FAILED' { Write-Host 'Investigate scope/test failure; do not discard changes automatically.' }
    'GATE_INCOMPLETE' { Write-Host 'Provide the missing test gate before treating the job as complete.' }
    'READY_FOR_REVIEW' { Write-Host 'Job-local gates passed. Return to the normal Foundation test/final-audit/PR workflow.' }
}
exit 0
