<#
.SYNOPSIS
    Validates a Local AI Handoff message file before it is acted upon.
    Mechanically enforces the guards that would otherwise only be
    checked by hand: duplicate message_id, HEAD SHA drift, repository
    drift, and branch drift.

.DESCRIPTION
    Every handoff message must carry four required fields:
      - message_id : a unique identifier for this message.
      - head_sha    : the repository's HEAD SHA at the moment this
                       message was created.
      - repository  : the repository this message is scoped to (matched
                       against the actual repository name derived from
                       `git remote get-url origin` in RepoRoot).
      - branch      : the branch checked out at the moment this message
                       was created.

    Checks run in this order, stopping at the first failure:

      1. Required fields present (message_id, head_sha, repository, branch).
      2. Repository drift: the message's `repository` must match the
         actual repository name at RepoRoot. A message written for one
         repository must never be acted on inside a different one.
      3. Branch drift: the message's `branch` must match the branch
         currently checked out at RepoRoot.
      4. Duplicate message_id: scans every other file under
         .ai-handoff/runtime/{inbox,outbox,processed}/ in RepoRoot. No
         separate log file to keep in sync — the runtime tree itself is
         the source of truth.
      5. HEAD SHA drift: the message's `head_sha` must match the
         repository's actual current `git rev-parse HEAD`.

    This script only validates. It does not invoke Codex, does not move
    or edit any file, and does not decide what happens on failure — the
    caller (the orchestrating AI) must stop and report, not guess a
    recovery.

.PARAMETER MessagePath
    Path to the handoff message file to validate.

.PARAMETER RepoRoot
    Path to the repository root. Used to resolve .ai-handoff/runtime/,
    to read the current HEAD SHA and branch, and to resolve the actual
    repository name from `git remote get-url origin`.

.OUTPUTS
    stdout "OK" and exit code 0 on success.
    stderr with a specific reason and a non-zero exit code on failure:
      2 = message file or repository root not found, or the actual
          repository name could not be determined from `origin`
      3 = a required field is missing
      4 = duplicate message_id
      5 = HEAD SHA drift
      6 = repository drift
      7 = branch drift

.EXAMPLE
    & .\validate-handoff-message.ps1 -MessagePath $msg -RepoRoot $repo
    if ($LASTEXITCODE -ne 0) {
        # Stop. Do not invoke Codex. Report the failure reason (printed on stderr) to the human.
    }
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$MessagePath,

    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

function Fail {
    param([int]$Code, [string]$Reason)
    # Plain stderr write, not Write-Error: combined with
    # $ErrorActionPreference = 'Stop', Write-Error becomes a terminating
    # exception and can prevent the explicit `exit $Code` below from
    # ever running, or propagate past this script into the caller's
    # session. This keeps the exit code the single source of truth.
    [Console]::Error.WriteLine($Reason)
    exit $Code
}

function Get-RequiredField {
    param([string]$Content, [string]$FieldName, [string]$SourcePath)
    $m = [regex]::Match($Content, "(?m)^-\s*$([regex]::Escape($FieldName)):\s*``([^``]+)``")
    if (-not $m.Success) {
        Fail 3 "Message is missing the required '$FieldName' field: $SourcePath"
    }
    return $m.Groups[1].Value
}

if (-not (Test-Path -LiteralPath $MessagePath)) {
    Fail 2 "Message file not found: $MessagePath"
}

if (-not (Test-Path -LiteralPath $RepoRoot)) {
    Fail 2 "Repository root not found: $RepoRoot"
}

$resolvedMessagePath = (Resolve-Path -LiteralPath $MessagePath).Path
$content = Get-Content -Raw -LiteralPath $resolvedMessagePath

# --- Required fields ----------------------------------------------------

$messageId = Get-RequiredField -Content $content -FieldName 'message_id' -SourcePath $resolvedMessagePath
$embeddedSha = Get-RequiredField -Content $content -FieldName 'head_sha' -SourcePath $resolvedMessagePath
$declaredRepository = Get-RequiredField -Content $content -FieldName 'repository' -SourcePath $resolvedMessagePath
$declaredBranch = Get-RequiredField -Content $content -FieldName 'branch' -SourcePath $resolvedMessagePath

# --- Guard: repository drift ---------------------------------------------

Push-Location $RepoRoot
try {
    $remoteUrl = (git remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $remoteUrl) { $remoteUrl = $null } else { $remoteUrl = $remoteUrl.Trim() }
} finally {
    Pop-Location
}

if (-not $remoteUrl) {
    Fail 2 "Could not determine the actual repository name: 'git remote get-url origin' failed or returned nothing in $RepoRoot"
}

# Extract canonical "owner/repo" (not just the trailing repo name) from
# either HTTPS (https://github.com/owner/repo.git) or SSH
# (git@github.com:owner/repo.git) remote URLs, with or without a
# trailing ".git" or "/". Matching on the bare repo name alone would
# treat two different owners' same-named repositories as identical.
$repoNameMatch = [regex]::Match($remoteUrl, '[:/]([^/]+)/([^/]+?)(\.git)?/?$')
if (-not $repoNameMatch.Success) {
    Fail 2 "Could not parse an owner/repo out of origin URL '$remoteUrl'"
}
$actualRepository = "$($repoNameMatch.Groups[1].Value)/$($repoNameMatch.Groups[2].Value)"

if ($declaredRepository -ne $actualRepository) {
    Fail 6 "Repository drift detected. Message declares repository='$declaredRepository', but RepoRoot '$RepoRoot' is actually '$actualRepository' (from origin: $remoteUrl). This message was written for a different repository; do not act on it here."
}

# --- Guard: branch drift --------------------------------------------------

Push-Location $RepoRoot
try {
    $currentBranch = (git branch --show-current).Trim()
} finally {
    Pop-Location
}

if ([string]::IsNullOrEmpty($currentBranch)) {
    Fail 7 "Branch drift detected. Message declares branch='$declaredBranch', but the repository is currently in a detached-HEAD state (no current branch)."
}

if ($declaredBranch -ne $currentBranch) {
    Fail 7 "Branch drift detected. Message declares branch='$declaredBranch', but the repository is now on branch='$currentBranch'. The approved target/content/risk may no longer hold; re-approval is required before proceeding."
}

# --- Guard: duplicate message_id ------------------------------------

$runtimeRoot = Join-Path $RepoRoot '.ai-handoff\runtime'
$searchDirs = @('inbox', 'outbox', 'processed') |
    ForEach-Object { Join-Path $runtimeRoot $_ } |
    Where-Object { Test-Path -LiteralPath $_ }

$duplicates = @()
foreach ($dir in $searchDirs) {
    $files = Get-ChildItem -LiteralPath $dir -Filter '*.md' -File -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        if ($f.FullName -eq $resolvedMessagePath) { continue }
        $otherContent = Get-Content -Raw -LiteralPath $f.FullName
        $otherMatch = [regex]::Match($otherContent, '(?m)^-\s*message_id:\s*`([^`]+)`')
        if ($otherMatch.Success -and $otherMatch.Groups[1].Value -eq $messageId) {
            $duplicates += $f.FullName
        }
    }
}

if ($duplicates.Count -gt 0) {
    Fail 4 "Duplicate message_id '$messageId' already exists in: $($duplicates -join ', ')"
}

# --- Guard: HEAD SHA drift -------------------------------------------

Push-Location $RepoRoot
try {
    $currentSha = (git rev-parse HEAD).Trim()
} finally {
    Pop-Location
}

if ($embeddedSha -ne $currentSha) {
    Fail 5 "HEAD SHA drift detected. Message was created at head_sha=$embeddedSha, repository is now at $currentSha. The approved target/content/risk may no longer hold; re-approval is required before proceeding."
}

Write-Output "OK"
exit 0
