# Pure bounded auto-retry policy for the Claude job runner. No I/O, no side effects.
# Dot-sourced by claude-job-runner.ps1 and claude-job-runner-selftest.ps1.

$script:HumanGateCodes = @('HUMAN_GATE_REQUIRED', 'WAITING_AT_VALID_HUMAN_GATE', 'HUMAN_CONFIRMATION_REQUIRED')
$script:HumanGateRegex = '\b(HUMAN_GATE_REQUIRED|WAITING_AT_VALID_HUMAN_GATE|HUMAN_CONFIRMATION_REQUIRED)\b'
$script:AutoRetryHardMax = 2

function Get-EffectiveMaxAutoRetries($Requested) {
    $n = 2
    if ($null -ne $Requested -and "$Requested" -match '^\d+$') { $n = [int]$Requested }
    if ($n -gt $script:AutoRetryHardMax) { $n = $script:AutoRetryHardMax }
    if ($n -lt 0) { $n = 0 }
    return $n
}

function Get-FailureFingerprint([string]$TestLog) {
    $t = [string]$TestLog
    $t = $t -replace "`r", ''
    $t = $t -replace '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?', '<TS>'
    $t = $t -replace '(?i)\b\d+(\.\d+)?\s*(ms|milliseconds?|seconds?|secs?|s)\b', '<DUR>'
    $t = $t -replace '(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', '<GUID>'
    $t = $t -replace '(?i)\b[0-9a-f]{12,}\b', '<HEX>'
    $t = $t -replace '(?i)[a-z]:\\[^\s:"'']+', '<PATH>'
    $t = $t -replace '(?i)(/[A-Za-z0-9._-]+){3,}', '<PATH>'
    $t = ($t -split "`n" | ForEach-Object { ($_ -replace '\s+', ' ').Trim() } | Where-Object { $_ }) -join "`n"
    $t = $t.ToLowerInvariant()
    if ($t.Length -gt 4000) { $t = $t.Substring($t.Length - 4000) }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) } finally { $sha.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Returns @{ retry=[bool]; stop_code=[string]; fingerprint=[string] }
function Get-AutoRetryDecision {
    param(
        $Gates,
        [string]$OrchCode,
        [string]$TestLog,
        [int]$AutoRetriesUsed,
        $MaxAutoRetries,
        [string[]]$PriorFingerprints = @(),
        [string]$OrchEvidence = ''
    )
    if ($OrchEvidence.Length -gt 262144) { $OrchEvidence = $OrchEvidence.Substring(0, 262144) }
    $max = Get-EffectiveMaxAutoRetries $MaxAutoRetries
    $g = @{}
    if ($Gates) { foreach ($k in $Gates.Keys) { $g[[string]$k] = [string]$Gates[$k] } }
    $fp = $null
    $stop = { param($c) @{ retry = $false; stop_code = $c; fingerprint = $fp } }

    $gateText = ($g.Values -join "`n")
    if ($script:HumanGateCodes -contains $OrchCode -or $OrchCode -match $script:HumanGateRegex -or
        $gateText -match $script:HumanGateRegex -or $TestLog -match $script:HumanGateRegex -or
        $OrchEvidence -match $script:HumanGateRegex) {
        $hit = $null
        foreach ($src in @($OrchCode, $gateText, $TestLog, $OrchEvidence)) {
            $m = [regex]::Match([string]$src, $script:HumanGateRegex)
            if ($m.Success) { $hit = $m.Groups[1].Value; break }
        }
        return (& $stop $hit)
    }
    foreach ($k in @('orchestrator_exit', 'claude_result', 'scope', 'test')) {
        if (-not $g.ContainsKey($k)) { return (& $stop 'INVALID_EVIDENCE') }
    }
    if ($g['orchestrator_exit'] -ne 'PASS' -or $g['claude_result'] -ne 'PASS') { return (& $stop 'CLAUDE_OR_ORCHESTRATOR_FAILED') }
    if ($g['scope'] -ne 'PASS') { return (& $stop 'SCOPE_FAILED') }
    if ($g['test'] -like 'SKIPPED*') { return (& $stop 'TEST_SKIPPED_OR_INCOMPLETE') }
    if ($g['test'] -eq 'PASS') { return (& $stop 'NOT_APPLICABLE_PASSED') }
    if ($g['test'] -like '*transport error*') { return (& $stop 'TEST_TRANSPORT_ERROR') }
    if ($g['test'] -notmatch '^FAIL: exit -?\d+ \(see test\.log\)$') { return (& $stop 'INVALID_EVIDENCE') }
    if ([string]::IsNullOrWhiteSpace($TestLog)) { return (& $stop 'INVALID_EVIDENCE') }
    $fp = Get-FailureFingerprint $TestLog
    if (@($PriorFingerprints) -contains $fp) { return (& $stop 'REPEATED_FAILURE') }
    if ($AutoRetriesUsed -ge $max) { return (& $stop 'MAX_RETRIES_EXHAUSTED') }
    return @{ retry = $true; stop_code = $null; fingerprint = $fp }
}
