<#
.SYNOPSIS
    Thin wrapper: generate the current-state handoff from work-state-report.mjs
    and pass it through the EXISTING validate-handoff-message.ps1 and
    run-codex-handoff.ps1, without human copy/paste.

.DESCRIPTION
    Composition only. No new gate, no new state store, no loosened sandbox
    (run-codex-handoff.ps1 always runs `-s read-only`).

      1. Generate the handoff (available only when repo/worktree/branch/HEAD are
         concrete and consistent AND the worktree is clean).
      2. Validate it with validate-handoff-message.ps1 (run inside the job worktree).
      3. -DryRun: stop here. Nothing is written into the runtime tree, Codex is not
         invoked, no lifecycle file is moved (a temp file is used and removed).
      4. Otherwise: write to outbox, move outbox -> inbox, run run-codex-handoff.ps1,
         and on success move inbox -> processed.
         On ANY failure, evidence stays where it is and the script stops.

    inbox/outbox/processed are transport/audit trail only, not work-state authority.

.PARAMETER RepoRoot
    Repository root that holds .ai-jobs/ (used for job discovery and gh).
.PARAMETER IssueNumber
    GitHub Issue number of the work item.
.PARAMETER DryRun
    Generate + validate only.
#>
param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][int]$IssueNumber,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Stop-Wrapper { param([int]$Code, [string]$Message) [Console]::Error.WriteLine($Message); exit $Code }

$raw = & node (Join-Path $scriptDir 'work-state-report.mjs') --repo $RepoRoot --issue $IssueNumber --format handoff
if ($LASTEXITCODE -ne 0) { Stop-Wrapper 90 'work-state-report.mjs failed; nothing was written or invoked.' }
$handoff = ($raw -join "`n") | ConvertFrom-Json
if (-not $handoff.available) { Stop-Wrapper 91 "Handoff unavailable: $($handoff.reason)" }

$worktree = [string]$handoff.worktree
$validate = Join-Path $scriptDir 'validate-handoff-message.ps1'

if ($DryRun) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("dryrun-" + $handoff.messageId + ".md")
    try {
        [IO.File]::WriteAllText($tmp, [string]$handoff.content, $utf8)
        & $validate -MessagePath $tmp -RepoRoot $worktree
        $code = $LASTEXITCODE
    } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
    if ($code -ne 0) { Stop-Wrapper $code "DryRun validation failed (exit $code)." }
    Write-Output "DRYRUN OK: message_id=$($handoff.messageId); Codex not invoked; no files moved."
    exit 0
}

$runtime = Join-Path $worktree '.ai-handoff\runtime'
foreach ($d in 'outbox', 'inbox', 'processed') { New-Item -ItemType Directory -Force -Path (Join-Path $runtime $d) | Out-Null }
$name = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))-claude-to-codex.md"
$outboxPath = Join-Path $runtime "outbox\$name"
$inboxPath = Join-Path $runtime "inbox\$name"
[IO.File]::WriteAllText($outboxPath, [string]$handoff.content, $utf8)

& $validate -MessagePath $outboxPath -RepoRoot $worktree
if ($LASTEXITCODE -ne 0) { Stop-Wrapper $LASTEXITCODE "Validation failed; message left in outbox: $outboxPath" }

Move-Item -LiteralPath $outboxPath -Destination $inboxPath
& (Join-Path $scriptDir 'run-codex-handoff.ps1') -MessagePath $inboxPath -RepoRoot $worktree
if ($LASTEXITCODE -ne 0) { Stop-Wrapper $LASTEXITCODE "run-codex-handoff.ps1 failed; message left in inbox: $inboxPath" }

Move-Item -LiteralPath $inboxPath -Destination (Join-Path $runtime "processed\$name")
Write-Output "HANDOFF PROCESSED: $name"
exit 0
