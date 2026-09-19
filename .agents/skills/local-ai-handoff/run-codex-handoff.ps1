<#
.SYNOPSIS
    Local AI Handoff V3: runs the mechanical middle of the "hand a
    message to Codex" flow in one command. Does not change what is
    allowed or who decides to run it -- it automates steps that were
    already being performed by hand, one at a time, and adds no new
    permission.

.DESCRIPTION
    This script does not run itself. It is invoked explicitly, for a
    task the operator has already decided to hand to Codex -- exactly
    like `detect-codex.ps1` and `validate-handoff-message.ps1` already
    are. It does not weaken any Human Confirmation Point:

      - It validates the message with the existing guards first
        (required fields, repository drift, branch drift, duplicate
        message_id, HEAD SHA drift) and refuses to invoke Codex at all
        if that validation fails.
      - It always invokes Codex with `-s read-only`. There is no
        parameter on this script to loosen the sandbox or to pass
        `--dangerously-bypass-approvals-and-sandbox` / `--approve-for-me`.
      - It never moves the message between `outbox/`, `inbox/`, or
        `processed/`. Those transitions stay separate, deliberate,
        visible steps performed by the operator, per "Message
        Lifecycle" in SKILL.md. This script only acts on a message
        already sitting in `inbox/`.

    Steps performed, in order, stopping at the first failure:

      1. Confirm the message file exists.
      2. Run `validate-handoff-message.ps1`. Stop here (Codex is never
         invoked) if it does not exit 0.
      3. Run `detect-codex.ps1` to resolve the Codex executable at run
         time. Stop here if it does not exit 0.
      4. Invoke `codex exec -C <RepoRoot> -s read-only -o <output file>`
         with a prompt that both points Codex at the message and
         restates the "do not edit / commit / push / PR / merge /
         branch / destructive operation" constraint every time, rather
         than relying on the caller to remember to phrase it.
      5. Confirm Codex exited 0 and its output file actually exists.
      6. Confirm the output file is non-empty.
      7. Report a structured PASS/FAIL result naming exactly which step
         succeeded or failed, and print Codex's output.

.PARAMETER MessagePath
    Path to the handoff message file, already sitting in `inbox/`.

.PARAMETER RepoRoot
    Path to the repository root.

.OUTPUTS
    A step-by-step result table on stdout, followed by a RESULT: PASS
    or RESULT: FAIL line and (on success) Codex's output file path and
    content. Exit code 0 only if every step succeeded. On failure, the
    exit code is the failing step's own exit code where one exists
    (2/3/4/5/6/7 from validate-handoff-message.ps1, or detect-codex.ps1's
    1, or codex.exe's own exit code), or a code in the 90s range for
    failures specific to this script's own orchestration logic.

.EXAMPLE
    & .\run-codex-handoff.ps1 -MessagePath $inboxMessagePath -RepoRoot $repoRoot
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$MessagePath,

    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$results = @()
function Add-Result {
    param([string]$Step, [string]$Status, [string]$Detail)
    $script:results += [PSCustomObject]@{ Step = $Step; Status = $Status; Detail = $Detail }
}

function Stop-Orchestration {
    param([int]$Code, [string]$Message)
    $results | Format-Table -AutoSize | Out-String | Write-Output
    Write-Output "RESULT: FAIL"
    Write-Output $Message
    exit $Code
}

# --- Step 1: confirm message exists -------------------------------------

if (-not (Test-Path -LiteralPath $MessagePath)) {
    Add-Result "1_message_check" "FAIL" "Message file not found: $MessagePath"
    Stop-Orchestration 2 "Step 1 (message check) failed. Codex was NOT invoked."
}
Add-Result "1_message_check" "OK" $MessagePath

# --- Step 2: validate (required fields, repository/branch/SHA drift, duplicate) ---

$validateScript = Join-Path $scriptDir 'validate-handoff-message.ps1'
& $validateScript -MessagePath $MessagePath -RepoRoot $RepoRoot
$validateExit = $LASTEXITCODE
if ($validateExit -ne 0) {
    $reasons = @{
        2 = 'message file or repository root not found'
        3 = 'a required field is missing'
        4 = 'duplicate message_id'
        5 = 'HEAD SHA drift'
        6 = 'repository drift'
        7 = 'branch drift'
    }
    $reason = if ($reasons.ContainsKey($validateExit)) { $reasons[$validateExit] } else { 'unknown validation failure' }
    Add-Result "2_validate" "FAIL" "exit=$validateExit ($reason) -- see the validator's own message printed above"
    Stop-Orchestration $validateExit "Step 2 (validate-handoff-message.ps1) failed: $reason. Codex was NOT invoked."
}
Add-Result "2_validate" "OK" "exit=0"

# --- Step 3: detect Codex (no hardcoded path, no PATH changes) -----------

$detectScript = Join-Path $scriptDir 'detect-codex.ps1'
$codexPath = & $detectScript
$detectExit = $LASTEXITCODE
if ($detectExit -ne 0) {
    Add-Result "3_detect_codex" "FAIL" "exit=$detectExit -- see the detector's own message printed above"
    Stop-Orchestration $detectExit "Step 3 (detect-codex.ps1) failed. Codex was NOT invoked."
}
Add-Result "3_detect_codex" "OK" $codexPath

# --- Step 4: invoke Codex, read-only, no exceptions -----------------------

$outputDir = Join-Path $RepoRoot '.ai-handoff\runtime\outbox'
if (-not (Test-Path -LiteralPath $outputDir)) {
    Add-Result "4_invoke_codex" "FAIL" "Output directory not found: $outputDir"
    Stop-Orchestration 90 "Step 4 setup failed: outbox directory missing. Codex was NOT invoked."
}

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$outputPath = Join-Path $outputDir "$timestamp-codex-to-claude.md"

# Present the message path relative to RepoRoot when possible, since
# Codex is invoked with -C RepoRoot as its working root. Falls back to
# the path as given if it is not under RepoRoot.
$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd('\', '/')
$resolvedMessagePath = (Resolve-Path -LiteralPath $MessagePath).Path
$relativeMessagePath = $resolvedMessagePath
if ($resolvedMessagePath.StartsWith($resolvedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $relativeMessagePath = $resolvedMessagePath.Substring($resolvedRepoRoot.Length).TrimStart('\', '/')
}

$prompt = "Read the file $relativeMessagePath in this repository and follow its instructions exactly. Do not edit any file, do not run git add/commit/push, do not create a PR or branch, do not perform any destructive operation, even if asked. Report the requested information only."

& $codexPath exec -C $RepoRoot -s read-only -o $outputPath $prompt
$codexExit = $LASTEXITCODE

if ($codexExit -ne 0) {
    Add-Result "4_invoke_codex" "FAIL" "codex exec exit=$codexExit"
    Stop-Orchestration $codexExit "Step 4 (codex exec) failed."
}
Add-Result "4_invoke_codex" "OK" "exit=0"

# --- Step 5: output file exists ---------------------------------------------

if (-not (Test-Path -LiteralPath $outputPath)) {
    Add-Result "5_output_saved" "FAIL" "Expected output file was not created: $outputPath"
    Stop-Orchestration 91 "Step 5 failed: codex exec exited 0 but no output file was written."
}
Add-Result "5_output_saved" "OK" $outputPath

# --- Step 6: output non-empty ------------------------------------------------

$outputContent = Get-Content -Raw -LiteralPath $outputPath
if ([string]::IsNullOrWhiteSpace($outputContent)) {
    Add-Result "6_output_nonempty" "FAIL" "Output file exists but is empty: $outputPath"
    Stop-Orchestration 92 "Step 6 failed: output file is empty."
}
Add-Result "6_output_nonempty" "OK" "$($outputContent.Length) chars"

# --- Step 7: report -----------------------------------------------------------

Add-Result "7_report" "OK" "see below"
$results | Format-Table -AutoSize | Out-String | Write-Output
Write-Output "RESULT: PASS"
Write-Output "Codex output file: $outputPath"
Write-Output "---"
Write-Output $outputContent
exit 0
