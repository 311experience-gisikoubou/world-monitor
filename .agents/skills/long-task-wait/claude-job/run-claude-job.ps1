<#
.SYNOPSIS
  Claude CLI implementation work as an asynchronous job and return immediately.

.DESCRIPTION
  Integrates with the Foundation's qualified Claude implementation route instead of invoking
  the raw Claude CLI directly. A dedicated git worktree + job branch isolates changes.
  Continuation reuses the same worktree/branch after checkpointing only already in-scope changes.

  This script does not merge, force-push, reset, delete worktrees/branches, or touch main directly.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoPath,
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [string]$InstructionClarityFile,
    [string]$ResearchEvidenceFile,
    [ValidatePattern('^[A-Za-z0-9-]{1,40}$')][string]$TaskName = 'task',
    [string]$ContinueJob,
    [string[]]$ScopePaths,
    [string]$TestCommand,
    [ValidateRange(1,360)][int]$ProviderTimeoutMinutes = 360,
    [ValidateRange(0,2)][int]$MaxAutoRetries = 2,
    [string]$BaseRef = 'origin/main',
    [switch]$ClearStaleLock
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
# Owned temporary files created ONLY when this launcher fills a missing
# -InstructionClarityFile/-ResearchEvidenceFile from the unique embedded
# AGENT_CYCLE_JOB_RESEARCH_V1 envelope inside -PromptFile (the real poller
# path: scripts/ai-job-poller/poll-once.ps1 passes PromptFile only). Never a
# second persistent state: each is removed as soon as its content is read
# into memory, and Fail() below removes any that remain on any rejection.
$script:bridgeExtractionTempFiles = @()

function Fail([string]$msg) {
    foreach ($f in @($script:bridgeExtractionTempFiles)) { Remove-Item $f -ErrorAction SilentlyContinue }
    Write-Host "[STOP] $msg" -ForegroundColor Red
    exit 1
}
function Q([string]$s) { '"' + ($s -replace '"', '\"') + '"' }
function Save-Json($obj, [string]$path) { [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 8), $utf8) }
function Prop($o, [string]$n) { if ($o -and $o.PSObject.Properties[$n]) { $o.$n } else { $null } }
function Get-ChangedPaths([string]$root, [string]$base) {
    $x = @()
    $x += @(git -C $root diff --name-only $base 2>$null)
    $x += @(git -C $root ls-files --others --exclude-standard 2>$null)
    @($x | Where-Object { $_ } | Sort-Object -Unique)
}
function In-Scope([string]$file, [string[]]$scope) {
    foreach ($p in @($scope)) {
        if ($p.EndsWith('/**')) {
            $prefix = $p.Substring(0, $p.Length - 3)
            if ($file -eq $prefix -or $file.StartsWith($prefix + '/')) { return $true }
        } elseif ($file -eq $p) { return $true }
    }
    return $false
}
function Resolve-GitHubRepo([string]$root) {
    $url = (git -C $root remote get-url origin 2>$null).Trim()
    $m = [regex]::Match($url, '^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+)/([^/]+?)(?:\.git)?/?$')
    if (-not $m.Success) { Fail "origin is not a recognized GitHub repository: $url" }
    @{ owner = $m.Groups[1].Value; name = $m.Groups[2].Value }
}
function Process-MatchesIdentity([int]$processId, $startTicks) {
    if ($processId -le 0 -or -not $startTicks) { return $false }
    try {
        $p = Get-Process -Id $processId -ErrorAction Stop
        return ([int64]$p.StartTime.ToUniversalTime().Ticks -eq [int64]$startTicks)
    } catch { return $false }
}

if (-not (Test-Path $RepoPath -PathType Container)) { Fail "RepoPath not found: $RepoPath" }
if (-not (Test-Path $PromptFile -PathType Leaf)) { Fail "PromptFile not found: $PromptFile" }
$PromptFile = (Resolve-Path $PromptFile).Path
if ($InstructionClarityFile) {
    if (-not (Test-Path $InstructionClarityFile -PathType Leaf)) { Fail "InstructionClarityFile not found: $InstructionClarityFile" }
    $InstructionClarityFile = (Resolve-Path $InstructionClarityFile).Path
}
if ($ResearchEvidenceFile) {
    if (-not (Test-Path $ResearchEvidenceFile -PathType Leaf)) { Fail "ResearchEvidenceFile not found: $ResearchEvidenceFile" }
    $ResearchEvidenceFile = (Resolve-Path $ResearchEvidenceFile).Path
}
$top = git -C $RepoPath rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $top) { Fail "Not a git repository: $RepoPath" }
$top = [IO.Path]::GetFullPath($top.Trim())
$repoId = Resolve-GitHubRepo $top
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js was not found.' }

git -C $top check-ignore -q '.ai-jobs/_probe' 2>$null
if ($LASTEXITCODE -ne 0) { Fail '.ai-jobs/ must be ignored by .gitignore before jobs can run.' }

$jobsRoot = Join-Path $top '.ai-jobs'
New-Item -ItemType Directory -Force -Path $jobsRoot | Out-Null
$lockPath = Join-Path $jobsRoot 'running.lock'
if (Test-Path $lockPath) {
    $old = $null
    try { $old = Get-Content $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    $oldPid = [int](Prop $old 'runner_pid')
    $oldStartTicks = Prop $old 'runner_process_start_utc_ticks'
    if (Process-MatchesIdentity $oldPid $oldStartTicks) {
        Fail "Another job is running: $(Prop $old 'job_id') (PID $oldPid)"
    }
    if ($ClearStaleLock) { Remove-Item $lockPath; Write-Host "[INFO] cleared stale lock: $(Prop $old 'job_id')" }
    else { Fail "Stale lock exists: $(Prop $old 'job_id'). Inspect it, then retry with -ClearStaleLock." }
}

$today = Get-Date -Format 'yyyyMMdd'
$n = @(Get-ChildItem $jobsRoot -Directory -Filter "$today-*" -ErrorAction SilentlyContinue).Count + 1
do { $jobId = '{0}-{1:000}' -f $today, $n; $n++ } while (Test-Path (Join-Path $jobsRoot $jobId))

$continuationDirty = @()
if ($ContinueJob) {
    $prevJobDir = Join-Path $jobsRoot $ContinueJob
    $prevPath = Join-Path $prevJobDir 'status.json'
    if (-not (Test-Path $prevPath)) { Fail "Continuation job not found: $ContinueJob" }
    $prev = Get-Content $prevPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($prev.state -in @('STARTING','RUNNING','GATES_RUNNING')) {
        $ppid = [int](Prop $prev 'runner_pid')
        $prevStartTicks = Prop $prev 'runner_process_start_utc_ticks'
        if (Process-MatchesIdentity $ppid $prevStartTicks) { Fail "Previous job is still running: $ContinueJob" }
        if (-not $prevStartTicks -and -not $ClearStaleLock) { Fail "Previous runner identity is incomplete. Inspect it, then retry with -ClearStaleLock." }
        Write-Host "[INFO] previous runner identity is no longer active; continuing from existing worktree." -ForegroundColor Yellow
    }
    $wtPath = [string]$prev.worktree
    $branch = [string]$prev.branch
    $rootBase = [string](Prop $prev 'root_base_commit')
    if (-not $rootBase) { $rootBase = [string]$prev.base_commit }
    $TaskName = [string]$prev.task
    if (-not $PSBoundParameters.ContainsKey('ScopePaths')) { $ScopePaths = @($prev.scope_paths) }
    if (-not $PSBoundParameters.ContainsKey('TestCommand')) { $TestCommand = [string](Prop $prev 'test_command') }
    if (-not $PSBoundParameters.ContainsKey('ProviderTimeoutMinutes')) { $ProviderTimeoutMinutes = [int](Prop $prev 'provider_timeout_minutes'); if ($ProviderTimeoutMinutes -le 0) { $ProviderTimeoutMinutes = 360 } }
    if (-not (Test-Path $wtPath -PathType Container)) { Fail "Previous worktree is missing: $wtPath" }
    $currentBranch = (git -C $wtPath rev-parse --abbrev-ref HEAD).Trim()
    if ($currentBranch -ne $branch) { Fail "Continuation branch mismatch: expected $branch, got $currentBranch" }
    $dirty = @(Get-ChangedPaths $wtPath 'HEAD')
    if ($dirty.Count -gt 0) {
        $outside = @($dirty | Where-Object { -not (In-Scope $_ @($ScopePaths)) })
        if ($outside.Count -gt 0) { Fail "Cannot checkpoint continuation: out-of-scope changes exist: $($outside -join ', ')" }
        $continuationDirty = $dirty
    }
} else {
    # Explicit -InstructionClarityFile/-ResearchEvidenceFile always take
    # precedence. Only when one (or both) is absent, attempt a bounded,
    # read-only extraction of the unique embedded research envelope from
    # PromptFile itself via the existing agent-job-bridge.mjs parser (never a
    # placeholder/trigger:false/ADOPT fabrication on failure). This recovers
    # exactly the evidence lost on the real poller path, which only ever
    # forwards PromptFile.
    if (-not $InstructionClarityFile -or -not $ResearchEvidenceFile) {
        $bridgeScript = Join-Path $top '.agents\skills\preflight-audit\agent-job-bridge.mjs'
        if (Test-Path $bridgeScript) {
            $extractRaw = & node $bridgeScript --extract-research-envelope $PromptFile 2>$null
            $extractExit = $LASTEXITCODE
            if ($extractExit -eq 0) {
                $extracted = $null
                try { $extracted = ($extractRaw -join "`n") | ConvertFrom-Json } catch { $extracted = $null }
                if ($extracted -and $extracted.ok -eq $true -and $extracted.value) {
                    if (-not $InstructionClarityFile) {
                        $clarityTemp = [IO.Path]::GetTempFileName()
                        Save-Json $extracted.value.instructionClarity $clarityTemp
                        $InstructionClarityFile = $clarityTemp
                        $script:bridgeExtractionTempFiles += $clarityTemp
                    }
                    if (-not $ResearchEvidenceFile) {
                        $researchTemp = [IO.Path]::GetTempFileName()
                        Save-Json $extracted.value.research $researchTemp
                        $ResearchEvidenceFile = $researchTemp
                        $script:bridgeExtractionTempFiles += $researchTemp
                    }
                }
            }
        }
    }
    if (-not $InstructionClarityFile) { Fail 'InstructionClarityFile is required for a new job (no explicit file, and no unique embedded research envelope was found in PromptFile).' }
    if (-not $ResearchEvidenceFile) { Fail 'ResearchEvidenceFile is required for a new job (AI-prepared Research Gate evidence; no new human form, and no unique embedded research envelope was found in PromptFile).' }
    if (-not $ScopePaths -or @($ScopePaths).Count -eq 0) { Fail 'ScopePaths is required for a new job.' }
    foreach ($p in @($ScopePaths)) {
        $segments = @($p.Split('/'))
        $badSegment = @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0
        if ($p -match '\\' -or $p -match ':' -or $p.StartsWith('/') -or $p.EndsWith('/') -or $badSegment -or ($p.Contains('*') -and -not $p.EndsWith('/**'))) {
            Fail "Invalid ScopePaths entry (use exact repo-relative path or directory/**; traversal is forbidden): $p"
        }
    }
    if ($BaseRef -match '^origin/(.+)$') {
        $baseBranch = $Matches[1]
        git -C $top fetch origin $baseBranch
        if ($LASTEXITCODE -ne 0) { Fail "git fetch failed for origin/$baseBranch" }
        $guard = Join-Path $top '.agents\skills\preflight-audit\live-base-ref-guard.mjs'
        if (Test-Path $guard) {
            Push-Location $top
            $oldErrorPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $guardOut = & node $guard --base $baseBranch --pretty 2>&1
                $guardExit = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $oldErrorPreference
                Pop-Location
            }
            if ($guardExit -ne 0 -or (($guardOut -join "`n") -notmatch 'LIVE_BASE_REF_GUARD=PROCEED')) { Fail "live-base-ref guard did not pass.`n$($guardOut -join "`n")" }
        }
    }
    $rootBase = (git -C $top rev-parse --verify "$BaseRef^{commit}" 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $rootBase) { Fail "BaseRef could not be resolved: $BaseRef" }
    $branch = "job/$jobId-$TaskName"
    git -C $top show-ref --verify --quiet "refs/heads/$branch"
    if ($LASTEXITCODE -eq 0) { Fail "Branch already exists: $branch" }
    $wtPath = Join-Path (Join-Path (Split-Path $top -Parent) ((Split-Path $top -Leaf) + '.ai-worktrees')) $jobId
    if (Test-Path $wtPath) { Fail "Worktree path already exists: $wtPath" }
}

# Re-evaluate the complete envelope before checkpoint/worktree/background job.
# Rebind only taskId and record its prior identity; preserve the previous context.
$orchestratorTaskId = 'claude-job-' + ($jobId -replace '[^A-Za-z0-9._:-]','-')
$researchSource = $ResearchEvidenceFile
if (-not $researchSource -and $ContinueJob) { $researchSource = Join-Path $prevJobDir 'research.json' }
if (-not $researchSource -or -not (Test-Path $researchSource -PathType Leaf)) { Fail 'Research Gate evidence is missing.' }
try { $research = Get-Content $researchSource -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'Research Gate evidence is not valid JSON.' }
if ($script:bridgeExtractionTempFiles -contains $researchSource) {
    Remove-Item $researchSource -ErrorAction SilentlyContinue
    $script:bridgeExtractionTempFiles = @($script:bridgeExtractionTempFiles | Where-Object { $_ -ne $researchSource })
}
if (-not (Prop $research 'evidence') -or -not (Prop $research.evidence 'evidenceBinding')) { Fail 'Research Gate evidence is missing evidence.evidenceBinding.' }
$originalResearchTaskId = Prop $research.evidence.evidenceBinding 'taskId'
if ($originalResearchTaskId -isnot [string] -or $originalResearchTaskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$') { Fail 'Original Research task identity is invalid.' }
$researchSourceTaskId = $originalResearchTaskId
$research.evidence.evidenceBinding.taskId = $orchestratorTaskId
$researchPacket = [ordered]@{
    schemaVersion = 1
    research = $research
    taskBinding = @{ taskId = $orchestratorTaskId; repository = @{ owner = $repoId.owner; name = $repoId.name }; scope = @($ScopePaths) }
}
if ($ContinueJob -and (Test-Path (Join-Path $prevJobDir 'research.json') -PathType Leaf)) {
    try { $previousResearch = Get-Content (Join-Path $prevJobDir 'research.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'Previous Research evidence is invalid.' }
    $researchPacket['previousContext'] = $previousResearch.context
}
$researchGate = Join-Path $top '.agents\\skills\\preflight-audit\\research-gate.mjs'
if (-not (Test-Path $researchGate)) { Fail 'research-gate.mjs is missing in repository.' }
$researchPacketFile = [IO.Path]::GetTempFileName()
$researchExit = 2
try {
    Save-Json $researchPacket $researchPacketFile
    & node $researchGate --task-envelope-file $researchPacketFile | Out-Null
    $researchExit = $LASTEXITCODE
} finally { Remove-Item $researchPacketFile -ErrorAction SilentlyContinue }
if ($researchExit -ne 0) { Fail 'Research Gate did not clear the current task/scope/conditions; no source job or worktree was started.' }

try {
    $launcherStartTicks = [int64](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
    $lockSeed = [ordered]@{
        job_id = $jobId
        runner_pid = $PID
        runner_process_start_utc_ticks = $launcherStartTicks
        started_at = (Get-Date).ToString('o')
    }
    $lockStream = New-Object System.IO.FileStream($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $lockWriter = New-Object System.IO.StreamWriter($lockStream, (New-Object System.Text.UTF8Encoding($false)))
        try { $lockWriter.Write(($lockSeed | ConvertTo-Json -Depth 4)); $lockWriter.Flush() }
        finally { $lockWriter.Dispose() }
    } finally {
        if ($lockStream) { $lockStream.Dispose() }
    }
}
catch { Fail 'Could not acquire repository job lock.' }

try {
    if ($ContinueJob -and @($continuationDirty).Count -gt 0) {
        git -C $wtPath add -A
        if ($LASTEXITCODE -ne 0) { Fail 'Failed to stage continuation checkpoint.' }
        git -C $wtPath commit -m "chore(ai-job): checkpoint $ContinueJob"
        if ($LASTEXITCODE -ne 0) { Fail 'Failed to create continuation checkpoint commit.' }
    }
    if (-not $ContinueJob) {
        git -C $top worktree add -q -b $branch $wtPath $rootBase
        if ($LASTEXITCODE -ne 0) { throw 'git worktree add failed' }
    }
    $jobDir = Join-Path $jobsRoot $jobId
    New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
    Copy-Item $PromptFile (Join-Path $jobDir 'prompt.md')

    $claritySource = $InstructionClarityFile
    if (-not $claritySource -and $ContinueJob) { $claritySource = Join-Path $prevJobDir 'instruction-clarity.json' }
    if (-not $claritySource -or -not (Test-Path $claritySource -PathType Leaf)) { throw 'Instruction clarity evidence is missing.' }
    try { $clarity = Get-Content $claritySource -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Instruction clarity evidence is not valid JSON.' }
    if ($script:bridgeExtractionTempFiles -contains $claritySource) {
        Remove-Item $claritySource -ErrorAction SilentlyContinue
        $script:bridgeExtractionTempFiles = @($script:bridgeExtractionTempFiles | Where-Object { $_ -ne $claritySource })
    }
    $orchestratorTaskId = 'claude-job-' + ($jobId -replace '[^A-Za-z0-9._:-]','-')
    if (-not $clarity.PSObject.Properties['taskId']) { $clarity | Add-Member -NotePropertyName taskId -NotePropertyValue $orchestratorTaskId }
    else { $clarity.taskId = $orchestratorTaskId }
    $clarityPath = Join-Path $jobDir 'instruction-clarity.json'
    Save-Json $clarity $clarityPath
    $clarityGate = Join-Path $top '.agents\skills\preflight-audit\instruction-clarity-gate.mjs'
    if (-not (Test-Path $clarityGate)) { throw 'instruction-clarity-gate.mjs is missing in repository.' }
    & node $clarityGate --input $clarityPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Instruction clarity gate did not pass.' }

    $researchPath = Join-Path $jobDir 'research.json'
    Save-Json $research $researchPath

    $status = [ordered]@{
        job_id = $jobId; task = $TaskName; continued_from = $ContinueJob; state = 'STARTING'
        repo = $top; repository_owner = $repoId.owner; repository_name = $repoId.name
        worktree = $wtPath; branch = $branch; root_base_commit = $rootBase
        scope_paths = @($ScopePaths); test_command = $TestCommand
        instruction_clarity_file = 'instruction-clarity.json'
        research_evidence_file = 'research.json'
        research_source_task_id = $researchSourceTaskId
        provider_timeout_minutes = $ProviderTimeoutMinutes
        max_auto_retries = [Math]::Min(2, $MaxAutoRetries); attempt = 0; auto_retries_used = 0; retry_stop_code = $null
        started_at = (Get-Date).ToString('o'); runner_pid = $null
    }
    Save-Json $status (Join-Path $jobDir 'status.json')

    $runner = Join-Path $PSScriptRoot 'claude-job-runner.ps1'
    if (-not (Test-Path $runner)) { throw 'claude-job-runner.ps1 is missing beside launcher.' }

    # Keep the worker inside this process session. Remote Desktop Commander can
    # return control while retaining this PID, so the long job is not an
    # abandoned child process that can disappear when the launch call ends.
    $selfStartTicks = [int64](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
    Save-Json ([ordered]@{ job_id = $jobId; runner_pid = $PID; runner_process_start_utc_ticks = $selfStartTicks; started_at = (Get-Date).ToString('o') }) $lockPath
} catch {
    Remove-Item $lockPath -ErrorAction SilentlyContinue
    Fail "$($_.Exception.Message) (any created worktree/branch is intentionally left for inspection)"
}

Write-Host "[STARTED] $jobId" -ForegroundColor Green
Write-Host "  PID      : $PID"
Write-Host "  worktree : $wtPath"
Write-Host "  branch   : $branch"
Write-Host "  check    : check-claude-job.ps1 -RepoPath `"$top`" -JobId $jobId"

& $runner -JobDir $jobDir -LockPath $lockPath
exit 0