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
    [string]$ExpectedCapacityStatePath,
    [string[]]$ScopePaths,
    [string]$TestCommand,
    [ValidateRange(1,360)][int]$ProviderTimeoutMinutes = 360,
    [ValidateRange(0,2)][int]$MaxAutoRetries = 2,
    [string]$BaseRef = 'origin/main',
    [switch]$ClearStaleLock,
    [ValidateRange(0,2147483647)][int]$TargetPrNumber = 0,
    [ValidateRange(0,2147483647)][int]$TargetIssueNumber = 0,
    [switch]$PostJobReview
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
# Local in-scope WIP source-content identity; never a new authorization/lock.
# Uses the repository object hash and fails closed for special paths/files.
function Get-ContinuationContentIdentity([string]$root, [string[]]$paths) {
    if (@($paths).Count -gt 20) { throw 'CONTINUATION_DIRTY_CONTENT_UNSAFE' }
    $rows = @()
    foreach ($file in @($paths)) {
        if ($file -notmatch '^[A-Za-z0-9._/-]+$' -or $file.StartsWith('/') -or
            $file -match '(^|/)\.\.(?:/|$)' -or
            $file -match '(?i)(^|/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|token|patient|private-key)[^/]*)') {
            throw 'CONTINUATION_DIRTY_CONTENT_UNSAFE'
        }
        $path = Join-Path $root ($file -replace '/', '\')
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -gt 1048576) { throw 'CONTINUATION_DIRTY_CONTENT_UNSAFE' }
        $object = @(git -C $root hash-object -- $file 2>$null)
        if ($LASTEXITCODE -ne 0 -or $object.Count -ne 1 -or
            $object[0] -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {
            throw 'CONTINUATION_DIRTY_CONTENT_UNVERIFIED'
        }
        $rows += ($file + [char]9 + [string]$item.Length + [char]9 + $object[0])
    }
    return @($rows)
}

function Assert-ExpectedProviderCapacitySnapshot([string]$root, $previous, [string]$oldJobId,
    [int]$issue, [string]$statePath) {
    if (-not $statePath -or $issue -le 0 -or [IO.Path]::GetFileName($statePath) -cne 'provider-capacity-state.json') {
        throw 'CONTINUATION_CAPACITY_SNAPSHOT_INVALID'
    }
    $record = Get-Item -LiteralPath $statePath -ErrorAction Stop
    if ($record.PSIsContainer -or ($record.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $record.Length -gt 65536) {
        throw 'CONTINUATION_CAPACITY_SNAPSHOT_INVALID'
    }
    try { $capacity = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'CONTINUATION_CAPACITY_SNAPSHOT_INVALID' }
    $snapshot = $capacity.worktreeSnapshot
    if ($null -eq $snapshot -or [int]$snapshot.version -ne 1 -or
        [int]$capacity.issueNumber -ne $issue -or [string]$capacity.latestFoundationJobId -cne $oldJobId -or
        [string]$snapshot.jobId -cne $oldJobId -or [int]$snapshot.issueNumber -ne $issue -or
        [string]$snapshot.worktree -cne [string]$previous.worktree -or
        [string]$snapshot.branch -cne [string]$previous.branch) {
        throw 'CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH'
    }
    $branch = @(git -C $root rev-parse --abbrev-ref HEAD 2>$null)
    $head = @(git -C $root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $branch.Count -ne 1 -or
        $branch[0] -cne [string]$snapshot.branch -or $head[0] -cne [string]$snapshot.head) {
        throw 'CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH'
    }
    $raw = @(git -C $root status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0 -or $raw.Count -gt 20) {
        throw 'CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH'
    }
    $entries = @($snapshot.entries | Where-Object { $null -ne $_ })
    if ($raw.Count -ne $entries.Count) {
        throw 'CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH'
    }
    for ($i = 0; $i -lt $raw.Count; $i++) {
        if ($raw[$i].Length -lt 4) { throw "CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH" }
        $status = $raw[$i].Substring(0, 2)
        $name = $raw[$i].Substring(3)
        $saved = $entries[$i]
        if ($name -cne [string]$saved.path -or $status -cne [string]$saved.status -or
            $name -notmatch '^[A-Za-z0-9._/-]+$' -or $name.StartsWith('/') -or
            $name -match '(^|/)\.\.(?:/|$)' -or
            $name -match '(?i)(^|/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|token|patient|private-key)[^/]*)') {
            throw 'CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH'
        }
        $file = Get-Item -LiteralPath (Join-Path $root ($name -replace '/', '\')) -ErrorAction Stop
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            [int64]$file.Length -ne [int64]$saved.bytes -or $file.Length -gt 1048576) {
            throw 'CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH'
        }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        if ($hash -cne [string]$saved.sha256) {
            throw 'CONTINUATION_CAPACITY_SNAPSHOT_MISMATCH'
        }
    }
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
function Invoke-GitAllowingStderr([string[]]$ArgList) {
    # PS 5.1 Desktop wraps every line a native command writes to stderr as a
    # non-terminating ErrorRecord, which becomes a TERMINATING exception the
    # instant $ErrorActionPreference is 'Stop' (set globally above) -- even
    # when the native process itself exits 0. git routinely writes
    # informational/progress text to stderr on a genuine success, e.g. a
    # `worktree add` whose checkout runs a configured smudge filter. Scope
    # 'Continue' narrowly around one native call and decide success only
    # from $LASTEXITCODE, never from PowerShell's own error stream.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = @(& git @ArgList 2>&1 | ForEach-Object { [string]$_ })
        $exit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    [PSCustomObject]@{ Output = $out; ExitCode = $exit }
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
$continuationContentIdentity = @()
$legacyContinuationUnbound = $false
if ($ExpectedCapacityStatePath -and -not $ContinueJob) { Fail 'CAPACITY_SNAPSHOT_REQUIRES_CONTINUATION' }
if ($ContinueJob) {
    $prevJobDir = Join-Path $jobsRoot $ContinueJob
    $prevPath = Join-Path $prevJobDir 'status.json'
    if (-not (Test-Path $prevPath)) { Fail "Continuation job not found: $ContinueJob" }
    $prev = Get-Content $prevPath -Raw -Encoding UTF8 | ConvertFrom-Json
    # Issue #332 safety correction: any post_job_review_* marker property
    # (post_job_review_state/code/head/receipt/next_owner/audit_code),
    # regardless of its value -- even present-but-null/empty/unrecognized --
    # or an outer state of READY_FOR_REVIEW means this job's implementation
    # run already finished and either completed or failed its post-job
    # review. That is never a genuine pre-review WAIT_PROVIDER continuation;
    # resuming it here would silently restart staging/checkpoint/claim on an
    # already-reviewed (or already-failed-review) job. Fail closed before any
    # claim/stage/checkpoint is touched; the old worktree and its unreviewed
    # dirty WIP are left exactly as found. (Deliberately checks property
    # PRESENCE, not truthiness, so a null/empty marker value is not a false
    # negative; deliberately excludes the bare `post_job_review` opt-in flag,
    # which is always present on every job and carries no review outcome.)
    $reviewMarkerProps = @($prev.PSObject.Properties.Name | Where-Object { $_ -match '^post_job_review_' })
    if (@($reviewMarkerProps).Count -gt 0 -or [string]$prev.state -eq 'READY_FOR_REVIEW') {
        Fail 'POST_JOB_REVIEW_REQUIRES_FRESH_QUALIFIED_REPAIR_JOB: previous job already carries a post-job-review marker or reached READY_FOR_REVIEW; start a fresh qualified repair job instead of continuing this one.'
    }
    if ($prev.state -in @('STARTING','RUNNING','GATES_RUNNING')) {
        $ppid = [int](Prop $prev 'runner_pid')
        $prevStartTicks = Prop $prev 'runner_process_start_utc_ticks'
        if (Process-MatchesIdentity $ppid $prevStartTicks) { Fail "Previous job is still running: $ContinueJob" }
        if (-not $prevStartTicks -and -not $ClearStaleLock) { Fail "Previous runner identity is incomplete. Inspect it, then retry with -ClearStaleLock." }
        Write-Host "[INFO] previous runner identity is no longer active; continuing from existing worktree." -ForegroundColor Yellow
    }
    $prevPr = [int](Prop $prev 'target_pr_number')
    $prevIssue = [int](Prop $prev 'target_issue_number')
    # Defer old unbound identity rejection until after Research Gate so its
    # established FAIL/UNKNOWN diagnostics retain their existing precedence.
    $legacyContinuationUnbound = ($prevPr -eq 0 -and $prevIssue -eq 0)
    if ($prevPr -gt 0 -and $TargetPrNumber -gt 0 -and $prevPr -ne $TargetPrNumber) { Fail 'Continuation PR identity mismatch.' }
    if ($prevIssue -gt 0 -and $TargetIssueNumber -gt 0 -and $prevIssue -ne $TargetIssueNumber) { Fail 'Continuation Issue identity mismatch.' }
    if ($prevPr -gt 0 -and $TargetPrNumber -eq 0) { $TargetPrNumber = $prevPr }
    if ($prevIssue -gt 0 -and $TargetIssueNumber -eq 0) { $TargetIssueNumber = $prevIssue }
    $wtPath = [string]$prev.worktree
    $branch = [string]$prev.branch
    $rootBase = [string](Prop $prev 'root_base_commit')
    if (-not $rootBase) { $rootBase = [string]$prev.base_commit }
    $TaskName = [string]$prev.task
    if (-not $PSBoundParameters.ContainsKey('ScopePaths')) { $ScopePaths = @($prev.scope_paths) }
    if (-not $PSBoundParameters.ContainsKey('TestCommand')) { $TestCommand = [string](Prop $prev 'test_command') }
    if (-not $PSBoundParameters.ContainsKey('ProviderTimeoutMinutes')) { $ProviderTimeoutMinutes = [int](Prop $prev 'provider_timeout_minutes'); if ($ProviderTimeoutMinutes -le 0) { $ProviderTimeoutMinutes = 360 } }
    # -PostJobReview opt-in is inherited from the original job unless this
    # continuation call explicitly passes its own value.
    if ($PSBoundParameters.ContainsKey('PostJobReview')) { $postJobReviewEnabled = [bool]$PostJobReview }
    else { $postJobReviewEnabled = [bool](Prop $prev 'post_job_review') }
    if (-not (Test-Path $wtPath -PathType Container)) { Fail "Previous worktree is missing: $wtPath" }
    if ($ExpectedCapacityStatePath) {
        Assert-ExpectedProviderCapacitySnapshot $wtPath $prev $ContinueJob $TargetIssueNumber $ExpectedCapacityStatePath
    }
    $currentBranch = (git -C $wtPath rev-parse --abbrev-ref HEAD).Trim()
    if ($currentBranch -ne $branch) { Fail "Continuation branch mismatch: expected $branch, got $currentBranch" }
    $dirty = @(Get-ChangedPaths $wtPath 'HEAD')
    if ($dirty.Count -gt 0) {
        $outside = @($dirty | Where-Object { -not (In-Scope $_ @($ScopePaths)) })
        if ($outside.Count -gt 0) { Fail "Cannot checkpoint continuation: out-of-scope changes exist: $($outside -join ', ')" }
        $continuationDirty = $dirty
        $continuationContentIdentity = @(Get-ContinuationContentIdentity $wtPath @($continuationDirty))
    }
} else {
    $postJobReviewEnabled = [bool]$PostJobReview
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
if ($legacyContinuationUnbound) {
    Fail 'CONTINUATION_TARGET_IDENTITY_MISSING: original job had no bound Issue or PR.'
}

# Preserve Research Gate diagnostics first. Once cleared, reject source-writing
# launches without an Issue/PR identity before any checkpoint/worktree/runner.
# Continuation has already inherited its original recorded target identity.
if ($TargetPrNumber -eq 0 -and $TargetIssueNumber -eq 0) {
    Fail 'TARGET_IDENTITY_REQUIRED: Supply -TargetIssueNumber or -TargetPrNumber; targetless source writer not permitted.'
}

# Atomic cross-clone claim; targetless legacy jobs cannot reach this stage.
$writerClaimGranted = $false
$writerClaimScript = Join-Path $PSScriptRoot 'writer-claim-store.mjs'
$writerClaimArgs = @()
if ($TargetPrNumber -gt 0 -or $TargetIssueNumber -gt 0) {
    if (-not (Test-Path $writerClaimScript -PathType Leaf)) { Fail 'Atomic writer claim helper missing.' }
    $writerToken = [guid]::NewGuid().ToString('N')
    $writerTicks = ([int64](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks).ToString()
    $writerClaimArgs = @('--repo', ($repoId.owner + '/' + $repoId.name), '--branch', $branch, '--job-id', $jobId, '--owner-token', $writerToken)
    if ($TargetPrNumber -gt 0) { $writerClaimArgs += @('--pr', [string]$TargetPrNumber) }
    if ($TargetIssueNumber -gt 0) { $writerClaimArgs += @('--issue', [string]$TargetIssueNumber) }
    $claimRaw = & node $writerClaimScript --acquire @writerClaimArgs --pid ([string]$PID) --process-start-ticks $writerTicks
    if ($LASTEXITCODE -ne 0) { Fail 'Atomic writer claim unavailable; no source write.' }
    $claim = $null
    try { $claim = ($claimRaw -join [Environment]::NewLine) | ConvertFrom-Json } catch { Fail 'Atomic writer claim result invalid.' }
    if (-not $claim -or $claim.ok -ne $true -or $claim.code -ne 'WRITER_CLAIM_GRANTED') { Fail 'Atomic writer claim not granted.' }
    $writerClaimGranted = $true
}
$postJobReviewRequestedFailure = $false
try {
try {
    # Cast to a decimal STRING before JSON serialization (see the matching
    # comment near $selfStartTicks below): a bare JSON number here would
    # already have lost precision by the time any reader parses it back.
    $launcherStartTicks = ([int64](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks).ToString()
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
    if ($ContinueJob -and $ExpectedCapacityStatePath) {
        Assert-ExpectedProviderCapacitySnapshot $wtPath $prev $ContinueJob $TargetIssueNumber $ExpectedCapacityStatePath
    }
    if ($ContinueJob -and @($continuationDirty).Count -gt 0) {
        # The original scope inspection occurred before Research Gate and claim acquisition.
        # Re-check after those steps: a late outside file must never enter a checkpoint.
        $checkpointPaths = @(Get-ChangedPaths $wtPath 'HEAD')
        if (@(Compare-Object -ReferenceObject @($continuationDirty) -DifferenceObject @($checkpointPaths)).Count -gt 0) {
            throw 'CONTINUATION_DIRTY_SET_CHANGED: worktree changed after scope inspection; no checkpoint.'
        }
        # Names can remain identical while file bytes change during Research/claim.
        $lockedContentIdentity = @(Get-ContinuationContentIdentity $wtPath @($continuationDirty))
        if (@(Compare-Object -ReferenceObject @($continuationContentIdentity) -DifferenceObject @($lockedContentIdentity)).Count -gt 0) {
            throw 'CONTINUATION_DIRTY_CONTENT_CHANGED: worktree bytes changed before checkpoint.'
        }
        # Never use bare git add -A: stage ONLY the enumerated approved files,
        # regardless of any subsequently created untracked files.
        $addResult = Invoke-GitAllowingStderr (@('-C', $wtPath, 'add', '-A', '--') + @($continuationDirty))
        if ($addResult.ExitCode -ne 0) { throw 'Failed to stage continuation checkpoint.' }
        $stagedPaths = @(git -C $wtPath diff --cached --name-only HEAD)
        if ($LASTEXITCODE -ne 0 -or @(Compare-Object -ReferenceObject @($continuationDirty) -DifferenceObject @($stagedPaths)).Count -gt 0) {
            throw 'CONTINUATION_STAGED_SET_MISMATCH: refuse checkpoint with unexpected staged paths.'
        }
        # After staging, index blobs must equal the original source WIP blobs.
        foreach ($row in @($continuationContentIdentity)) {
            $parts = $row -split ([string][char]9), 3
            if ($parts.Count -ne 3) { throw 'CONTINUATION_STAGED_CONTENT_MISMATCH' }
            $stagedObject = @(git -C $wtPath rev-parse (':' + $parts[0]) 2>$null)
            if ($LASTEXITCODE -ne 0 -or $stagedObject.Count -ne 1 -or
                $stagedObject[0] -cne $parts[2]) {
                throw 'CONTINUATION_STAGED_CONTENT_MISMATCH: staged source differs from verified WIP.'
            }
        }
        # Re-verify the live worktree bytes one more time before committing.
        # Staging/commit only ever operate on the INDEX: a disk-level
        # mutation occurring between the pre-stage identity recheck above and
        # this point (for example a race during/after `git add` itself) must
        # still fail closed, even though the index content captured a moment
        # earlier remains safe on its own.
        $poststageContentIdentity = @(Get-ContinuationContentIdentity $wtPath @($continuationDirty))
        if (@(Compare-Object -ReferenceObject @($continuationContentIdentity) -DifferenceObject @($poststageContentIdentity)).Count -gt 0) {
            throw 'CONTINUATION_DIRTY_CONTENT_CHANGED: worktree bytes changed after staging; no checkpoint.'
        }
        $commitResult = Invoke-GitAllowingStderr @('-C', $wtPath, 'commit', '-m', "chore(ai-job): checkpoint $ContinueJob")
        if ($commitResult.ExitCode -ne 0) { throw 'Failed to create continuation checkpoint commit.' }
    }
    if (-not $ContinueJob) {
        $wtResult = Invoke-GitAllowingStderr @('-C', $top, 'worktree', 'add', '-q', '-b', $branch, $wtPath, $rootBase)
        if ($wtResult.ExitCode -ne 0) {
            $wtMsg = (($wtResult.Output -join ' ') -replace '\s+', ' ').Trim()
            throw ('git worktree add failed: ' + $wtMsg.Substring(0, [Math]::Min(300, $wtMsg.Length)))
        }
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
        target_pr_number = $TargetPrNumber; target_issue_number = $TargetIssueNumber
        post_job_review = $postJobReviewEnabled
        started_at = (Get-Date).ToString('o'); runner_pid = $null
    }
    Save-Json $status (Join-Path $jobDir 'status.json')

    $runner = Join-Path $PSScriptRoot 'claude-job-runner.ps1'
    if (-not (Test-Path $runner)) { throw 'claude-job-runner.ps1 is missing beside launcher.' }

    # Keep the worker inside this process session. Remote Desktop Commander can
    # return control while retaining this PID, so the long job is not an
    # abandoned child process that can disappear when the launch call ends.
    # Ticks are cast to a decimal STRING before ever reaching JSON: a plain
    # JSON number here would silently lose precision on JSON.parse (.NET
    # Ticks routinely exceed Number.MAX_SAFE_INTEGER), breaking every exact
    # identity comparison downstream. Existing cast-to-[int64] readers (e.g.
    # Process-MatchesIdentity below) remain compatible with a string input.
    $selfStartTicks = ([int64](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks).ToString()
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

# Opt-in, bounded post-job review (Issue #332). Invoked beside this TRUSTED
# launcher, in this SAME process, ONLY after the outer runner's own real
# READY_FOR_REVIEW + DONE + every gate PASS -- and ONLY while still inside
# this try block, i.e. strictly BEFORE the finally below releases this job's
# own writer claim. A failure/skip/missing result is recorded on status.json
# as this helper's own post_job_review_state/code; it never fabricates a
# successful stdout line, and never causes the claim release itself to be
# skipped.
$statusPathForReview = Join-Path $jobDir 'status.json'
# Issue #332 safety correction: the ONLY lower-level provider/runner
# diagnostic codes ever persisted into status.json when the post-job-review
# audit reviewer itself failed to complete (code AUDIT_INVOCATION_NOT_COMPLETED).
# status.json is low-trust evidence readable by anything else on the Windows
# PC, so it may never carry a raw/unbounded string from the provider; any
# value not on this allowlist is reduced to UNKNOWN before being written.
$script:AllowedPostJobReviewAuditCodes = @(
    'TASK_SCHEMA_INVALID','CLAUDE_CLI_UNAVAILABLE','UNSAFE_PROVIDER_ENV_PRESENT',
    'RUNNER_BINARY_OR_FLAGS_UNTRUSTED','SUBSCRIPTION_AUTH_NOT_VERIFIED','PROVIDER_TIMEOUT',
    'PROVIDER_OUTPUT_TOO_LARGE','PROVIDER_STOPPED','PROVIDER_OUTPUT_INVALID','UNKNOWN'
)
# Issue #332 Phase 2 slice #1: bounded, local-only, all-or-nothing capture of
# the independent reviewer's OWN genuine CONCERNS/FAIL verdict+findings --
# ONLY ever for code AUDIT_VERDICT_NOT_PASS, and ONLY after every element
# passes strict type/count/length/control-sequence validation below. This
# never stores unbounded text, full source/diffs, or secrets, and never
# publishes anything to GitHub; it is pure local status.json evidence for a
# fresh repair launcher to read. Anything missing/malformed stores nothing
# (verdict/findings are simply absent) and leaves the original STOP/code
# already written by the caller completely unchanged.
$script:PostJobReviewMaxFindings = 50
$script:PostJobReviewMaxFindingLength = 500
$script:PostJobReviewUnsafeCharRegex = '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
function Get-SafePostJobReviewFindings($verdict, $findings) {
    if ($verdict -isnot [string] -or ($verdict -ne 'CONCERNS' -and $verdict -ne 'FAIL')) { return $null }
    if ($null -eq $findings) { return $null }
    $list = @($findings)
    if ($list.Count -gt $script:PostJobReviewMaxFindings) { return $null }
    foreach ($item in $list) {
        if ($item -isnot [string] -or $item.Length -gt $script:PostJobReviewMaxFindingLength -or
            $item -match $script:PostJobReviewUnsafeCharRegex) { return $null }
    }
    return [PSCustomObject]@{ verdict = $verdict; findings = @($list) }
}
function Set-PostJobReviewStatus([string]$state, [string]$code, $proof = $null, [string]$auditCode = $null, $rawVerdict = $null, $rawFindings = $null) {
    try {
        $s = Get-Content $statusPathForReview -Raw -Encoding UTF8 | ConvertFrom-Json
        $s | Add-Member -NotePropertyName post_job_review_state -NotePropertyValue $state -Force
        $s | Add-Member -NotePropertyName post_job_review_code -NotePropertyValue $code -Force
        if ($proof) {
            $s | Add-Member -NotePropertyName post_job_review_head -NotePropertyValue ([string]$proof.headAfter) -Force
            $s | Add-Member -NotePropertyName post_job_review_receipt -NotePropertyValue ([string]$proof.receiptPath) -Force
            $s | Add-Member -NotePropertyName post_job_review_next_owner -NotePropertyValue ([string]$proof.nextOwner) -Force
        }
        if ($auditCode) {
            $s | Add-Member -NotePropertyName post_job_review_audit_code -NotePropertyValue $auditCode -Force
        }
        if ($code -eq 'AUDIT_VERDICT_NOT_PASS') {
            $safeVerdict = Get-SafePostJobReviewFindings $rawVerdict $rawFindings
            if ($safeVerdict) {
                $s | Add-Member -NotePropertyName post_job_review_verdict -NotePropertyValue ([string]$safeVerdict.verdict) -Force
                $s | Add-Member -NotePropertyName post_job_review_findings -NotePropertyValue @($safeVerdict.findings) -Force
            }
        }
        Save-Json $s $statusPathForReview
    } catch { Write-Warning 'Could not record post_job_review_state/code on status.json.' }
}
# WAIT_PROVIDER is a genuine pre-review provider-capacity pause, not a
# completed/failed audit. Do not create ANY post_job_review_* result marker
# on it: -ContinueJob must still be allowed to take the existing safe
# capacity-snapshot/claim path. GATE_FAILED and all other paths retain
# their existing SKIPPED/STOP markers and fail-closed continuation guard.
$preReviewIsProviderWait = $false
if ($postJobReviewEnabled) {
    try {
        $preReviewStatus = Get-Content $statusPathForReview -Raw -Encoding UTF8 | ConvertFrom-Json
        $preReviewIsProviderWait = ($preReviewStatus -and [string]$preReviewStatus.state -eq 'WAIT_PROVIDER')
    } catch { }
}
if ($postJobReviewEnabled -and -not $preReviewIsProviderWait) {
    Set-PostJobReviewStatus 'PENDING' 'POST_JOB_REVIEW_PENDING'
    $readyForReview = $false
    $finalStatus = $null
    try { $finalStatus = Get-Content $statusPathForReview -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    $donePathForReview = Join-Path $jobDir 'DONE'
    if ($finalStatus -and [string]$finalStatus.state -eq 'READY_FOR_REVIEW' -and (Test-Path $donePathForReview -PathType Leaf)) {
        $resultForReview = $null
        try { $resultForReview = Get-Content (Join-Path $jobDir 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
        if ($resultForReview -and [string]$resultForReview.final_state -eq 'READY_FOR_REVIEW' -and $resultForReview.gates) {
            $gateValues = @($resultForReview.gates.PSObject.Properties | ForEach-Object { [string]$_.Value })
            $requiredGateKeys = @('orchestrator_exit','claude_result','scope','test')
            $missingGates = @($requiredGateKeys | Where-Object { -not $resultForReview.gates.PSObject.Properties[$_] })
            if ($missingGates.Count -eq 0 -and @($gateValues).Count -ge 4 -and -not (@($gateValues | Where-Object { $_ -ne 'PASS' }).Count -gt 0)) {
                $readyForReview = $true
            }
        }
    }
    if ($readyForReview) {
        $postJobReviewScript = Join-Path $PSScriptRoot 'post-job-review.mjs'
        if (-not (Test-Path $postJobReviewScript -PathType Leaf)) {
            Set-PostJobReviewStatus 'STOP' 'POST_JOB_REVIEW_SCRIPT_MISSING'
            $postJobReviewRequestedFailure = $true
        } else {
            $reviewRaw = & node $postJobReviewScript --job-dir $jobDir 2>$null
            $reviewExit = $LASTEXITCODE
            $reviewResult = $null
            try { $reviewResult = ($reviewRaw -join [Environment]::NewLine) | ConvertFrom-Json } catch { $reviewResult = $null }
            if ($reviewExit -eq 0 -and $reviewResult -and $reviewResult.ok -eq $true -and [string]$reviewResult.result -eq 'COMPLETED') {
                Set-PostJobReviewStatus 'COMPLETED' ([string]$reviewResult.code) $reviewResult
                # Only bounded completion facts leave this trusted launch point.
                Write-Output ("[POST_JOB_HANDOFF] " + ([ordered]@{
                    jobId=$jobId; head=$reviewResult.headAfter; receiptPath=$reviewResult.receiptPath
                    nextOwner=$reviewResult.nextOwner; preparedForMerge=$false
                } | ConvertTo-Json -Compress))
            } else {
                $failCode = if ($reviewResult -and $reviewResult.code) { [string]$reviewResult.code } else { 'POST_JOB_REVIEW_INVOCATION_FAILED' }
                # Never persist the audit module's own raw lower-level code
                # verbatim: reduce it to the allowlist (else UNKNOWN) before
                # it ever reaches status.json. Prop() guards this read since,
                # unlike .code, .auditCode is absent for every failCode other
                # than AUDIT_INVOCATION_NOT_COMPLETED, and this file's global
                # Set-StrictMode -Version 2 throws on a missing property.
                $sanitizedAuditCode = $null
                if ($failCode -eq 'AUDIT_INVOCATION_NOT_COMPLETED') {
                    $rawAuditCode = Prop $reviewResult 'auditCode'
                    $sanitizedAuditCode = if ($rawAuditCode -and ($script:AllowedPostJobReviewAuditCodes -contains [string]$rawAuditCode)) { [string]$rawAuditCode } else { 'UNKNOWN' }
                }
                # Prop() guards these reads: .verdict/.findings only exist on a
                # genuine AUDIT_VERDICT_NOT_PASS envelope; Set-StrictMode would
                # otherwise throw on every other failCode's missing property.
                $rawVerdictForStatus = $null
                $rawFindingsForStatus = $null
                if ($failCode -eq 'AUDIT_VERDICT_NOT_PASS') {
                    $rawVerdictForStatus = Prop $reviewResult 'verdict'
                    $rawFindingsForStatus = Prop $reviewResult 'findings'
                }
                Set-PostJobReviewStatus 'STOP' $failCode $null $sanitizedAuditCode $rawVerdictForStatus $rawFindingsForStatus
                $postJobReviewRequestedFailure = $true
            }
        }
    } else {
        if ($finalStatus -and [string]$finalStatus.state -eq 'READY_FOR_REVIEW') {
            Set-PostJobReviewStatus 'STOP' 'OUTER_REQUIRED_GATES_NOT_PASS'
            $postJobReviewRequestedFailure = $true
        } else {
            Set-PostJobReviewStatus 'SKIPPED' 'OUTER_NOT_READY_FOR_REVIEW'
        }
    }
}
} finally {
    if ($writerClaimGranted) {
        $releaseRaw = & node $writerClaimScript --release @writerClaimArgs 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Atomic writer claim release did not succeed; left fail-closed.' }
    }
}
if ($postJobReviewRequestedFailure) { exit 1 }
exit 0