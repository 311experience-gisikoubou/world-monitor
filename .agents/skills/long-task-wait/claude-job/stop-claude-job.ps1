<#
.SYNOPSIS
  Explicit, fail-closed manual stop for one named asynchronous Claude implementation job.

.DESCRIPTION
  This is a dedicated, narrowly-scoped safety valve. It is NOT a second execution route and
  it must never be auto-invoked from check-claude-job.ps1, LONG_RUNNING, or NO_PROGRESS_WARNING.
  Those remain warning/candidate signals only.

  Fail-closed identity contract:
  - The caller supplies only -RepoPath and -JobId (and an optional human-readable -Reason).
    A PID is never accepted as a parameter; the only PID ever acted on is the one already
    recorded in that job's own status.json.
  - The job must currently be active (STARTING, RUNNING, or GATES_RUNNING).
  - The recorded runner_pid + runner_process_start_utc_ticks must exactly match a live
    process right now (the same identity check used by run-claude-job.ps1/check-claude-job.ps1).
    PID reuse by an unrelated process is treated as "not this job" and refused, not stopped.
  - Identity is re-verified immediately before acting to shrink the check/act race window.

  On confirmed stop (Windows only): the exact recorded runner process tree is stopped with
  `taskkill /PID <recorded pid> /T /F`, so an orchestrator/provider child process of that
  exact runner cannot be left orphaned. status.json is then marked state=STOPPED with
  stopped_at/stop_reason. .ai-jobs/running.lock is removed only when its own recorded
  job_id + runner_pid + runner_process_start_utc_ticks exactly match this same job/identity;
  a lock belonging to a different job/identity is left untouched.

  This script never merges, pushes, resets, deletes branches/worktrees, or performs any
  production action. The worktree and branch are left in place for inspection.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoPath,
    [Parameter(Mandatory = $true)][string]$JobId,
    [string]$Reason = 'manual safe stop'
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

function Fail([string]$msg) { Write-Host "[STOP-FAILED] $msg" -ForegroundColor Red; exit 1 }
function Prop($o, [string]$n) { if ($o -and $o.PSObject.Properties[$n]) { $o.$n } else { $null } }
function Save-Json($obj, [string]$path) { [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 8), $utf8) }
function Process-MatchesIdentity([int]$processId, $startTicks) {
    if ($processId -le 0 -or -not $startTicks) { return $false }
    try {
        $p = Get-Process -Id $processId -ErrorAction Stop
        return ([int64]$p.StartTime.ToUniversalTime().Ticks -eq [int64]$startTicks)
    } catch { return $false }
}
function Test-SafeJobId([string]$id) {
    # Bounded safe-token rule (not coupled to only yyyyMMdd-NNN, so future/test IDs remain
    # safe): 1-64 chars, first/last char alphanumeric, interior chars limited to
    # alphanumeric plus '.', '_', '-'. This rejects path separators ('/', '\'),
    # drive/colon syntax (':'), whitespace of any kind, '.'/'..' traversal segments
    # (which cannot appear because a leading/trailing '.' is never allowed), and any
    # other character outside this bounded allow-list.
    if ([string]::IsNullOrEmpty($id)) { return $false }
    return [bool]($id -cmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$')
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Fail 'This safe-stop script currently supports Windows only.'
}

if (-not (Test-SafeJobId $JobId)) {
    Fail "Invalid JobId (must be 1-64 characters, letters/digits/'.'/'_'/'-' only, no path separators, drive/colon syntax, whitespace, or leading/trailing punctuation): $JobId"
}

$top = git -C $RepoPath rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $top) { Fail "Not a git repository: $RepoPath" }
$top = [IO.Path]::GetFullPath($top.Trim())
$jobsRoot = Join-Path $top '.ai-jobs'
$jobDir = Join-Path $jobsRoot $JobId
$statusPath = Join-Path $jobDir 'status.json'
if (-not (Test-Path $statusPath)) { Fail "status.json not found for job: $JobId (unknown/mistyped JobId fails closed)" }

$st = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$st.job_id -ne $JobId) { Fail "status.json job_id does not match requested JobId: $JobId" }
if ($st.state -notin @('STARTING', 'RUNNING', 'GATES_RUNNING')) {
    Fail "Job $JobId is not active (state: $($st.state)); nothing to stop. Refusing to act on a terminal job."
}

$rpid = [int](Prop $st 'runner_pid')
$startTicks = Prop $st 'runner_process_start_utc_ticks'
if (-not (Process-MatchesIdentity $rpid $startTicks)) {
    Fail "Recorded runner identity for $JobId does not match a live process (PID $rpid). Refusing to stop anything: the job may have already ended, its PID may have been reused by an unrelated process, or identity was never recorded."
}

# Re-verify immediately before acting to shrink the check-then-act race window.
Start-Sleep -Milliseconds 50
if (-not (Process-MatchesIdentity $rpid $startTicks)) {
    Fail "Runner identity for $JobId changed between verification and stop. Refusing to act."
}

Write-Host "[STOPPING] $JobId (exact recorded identity match: PID $rpid)" -ForegroundColor Yellow
$taskkillCmd = Get-Command taskkill.exe -ErrorAction SilentlyContinue
if (-not $taskkillCmd) { Fail 'taskkill.exe was not found.' }
& $taskkillCmd.Source /PID $rpid /T /F | Out-Null
$killExit = $LASTEXITCODE

Start-Sleep -Milliseconds 300
if (Process-MatchesIdentity $rpid $startTicks) {
    Fail "taskkill exited $killExit but the exact recorded process is still alive; job left untouched (state unchanged). Inspect manually; do not retry blindly."
}

$stoppedAt = (Get-Date).ToString('o')
$st | Add-Member -NotePropertyName state -NotePropertyValue 'STOPPED' -Force
$st | Add-Member -NotePropertyName stopped_at -NotePropertyValue $stoppedAt -Force
$st | Add-Member -NotePropertyName stop_reason -NotePropertyValue $Reason -Force
$st | Add-Member -NotePropertyName ended_at -NotePropertyValue $stoppedAt -Force
Save-Json $st $statusPath

$lockPath = Join-Path $jobsRoot 'running.lock'
if (Test-Path $lockPath) {
    $lock = $null
    try { $lock = Get-Content $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    $lockJobId = Prop $lock 'job_id'
    $lockPidRaw = Prop $lock 'runner_pid'
    $lockStartTicks = Prop $lock 'runner_process_start_utc_ticks'
    $lockPidVal = if ($null -ne $lockPidRaw) { [int]$lockPidRaw } else { -1 }
    $identityMatches = ([string]$lockJobId -eq $JobId) -and ($lockPidVal -eq $rpid) -and $lockStartTicks -and ([int64]$lockStartTicks -eq [int64]$startTicks)
    if ($identityMatches) {
        Remove-Item $lockPath -ErrorAction SilentlyContinue
        Write-Host '[INFO] removed running.lock (matched this exact job/identity)'
    } else {
        Write-Host '[INFO] running.lock left in place (does not match this job/identity)'
    }
}

Write-Host "[STOPPED] $JobId" -ForegroundColor Green
Write-Host "  PID      : $rpid"
Write-Host "  reason   : $Reason"
Write-Host "  worktree : $($st.worktree) (left in place; not deleted)"
Write-Host "  branch   : $($st.branch) (left in place; not deleted)"
exit 0
