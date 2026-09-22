<#
  Internal background runner. Do not invoke directly.
  It delegates Claude execution to the Foundation implementation-orchestrator, then performs
  the job-local test gate. DONE is created only by this outer runner after every local gate passes.
#>
param([string]$JobDir, [string]$LockPath)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$statusPath = Join-Path $JobDir 'status.json'
$orchestratorOut = Join-Path $JobDir 'orchestrator.json'
$errPath = Join-Path $JobDir 'stderr.log'
$testLog = Join-Path $JobDir 'test.log'

function Prop($o, [string]$n) { if ($o -and $o.PSObject.Properties[$n]) { $o.$n } else { $null } }
function Save-Json($obj, [string]$path) { [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 6), $utf8) }
function Update-Status([hashtable]$changes) {
    $s = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($k in $changes.Keys) { $s | Add-Member -NotePropertyName $k -NotePropertyValue $changes[$k] -Force }
    Save-Json $s $statusPath
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

$st = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
$selfStartTicks = [int64](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
Update-Status @{ state = 'RUNNING'; runner_pid = $PID; runner_process_start_utc_ticks = $selfStartTicks; runner_started_at = (Get-Date).ToString('o') }
$gates = [ordered]@{}

try {
    $orchestrator = Join-Path $st.worktree '.agents\skills\preflight-audit\implementation-orchestrator.mjs'
    if (-not (Test-Path $orchestrator)) { throw "implementation-orchestrator.mjs is missing in worktree" }
    # Windows PowerShell 5.1 attaches provider note-properties to Get-Content output.
    # Cast to a plain string before JSON serialization or task.json can expand to tens of MB.
    $prompt = [string](Get-Content (Join-Path $JobDir 'prompt.md') -Raw -Encoding UTF8)
    $task = [ordered]@{
        schemaVersion = 1; taskId = ('claude-job-' + ($st.job_id -replace '[^A-Za-z0-9._:-]','-'))
        kind = 'implementation'; objective = [string]$st.task; prompt = $prompt
        repoRoot = [string]$st.worktree; branch = [string]$st.branch
        allowedScope = @($st.scope_paths); forbiddenScope = @()
        doneConditions = @('Implement only the requested task within allowedScope.')
        requiredTests = @(); dataClass = 'source-only'
        repository = @{ owner = [string]$st.repository_owner; name = [string]$st.repository_name }
    }
    $taskPath = Join-Path $JobDir 'task.json'
    Save-Json $task $taskPath
    $timeoutMs = [int64]$st.provider_timeout_minutes * 60 * 1000
    Push-Location $st.worktree
    try {
        $raw = Get-Content $taskPath -Raw -Encoding UTF8 | & node $orchestrator --timeout-ms $timeoutMs --pretty 2> $errPath
        $nodeExit = $LASTEXITCODE
        [IO.File]::WriteAllText($orchestratorOut, (($raw | ForEach-Object { [string]$_ }) -join "`n"), $utf8)
    } finally { Pop-Location }
    $orch = $null
    try { $orch = Get-Content $orchestratorOut -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    $gates['orchestrator_exit'] = if ($nodeExit -eq 0) { 'PASS' } else { "FAIL: exit $nodeExit" }
    $gates['claude_result'] = if ($orch -and $orch.result -eq 'COMPLETED') { 'PASS' } else { "FAIL: $(Prop $orch 'code')" }
    Update-Status @{ state = 'GATES_RUNNING'; orchestrator_code = (Prop $orch 'code'); claude_ended_at = (Get-Date).ToString('o') }

    $changed = @()
    $changed += @(git -C $st.worktree diff --name-only $st.root_base_commit 2>$null)
    $changed += @(git -C $st.worktree ls-files --others --exclude-standard 2>$null)
    $changed = @($changed | Where-Object { $_ } | Sort-Object -Unique)
    if ($changed.Count -eq 0) { $gates['scope'] = 'FAIL: no changes' }
    else {
        $outside = @($changed | Where-Object { -not (In-Scope $_ @($st.scope_paths)) })
        $gates['scope'] = if ($outside.Count -eq 0) { 'PASS' } else { 'FAIL: out-of-scope ' + (($outside | Select-Object -First 10) -join ', ') }
    }

    $testCmd = [string](Prop $st 'test_command')
    if (-not $testCmd) { $gates['test'] = 'SKIPPED: no test command' }
    elseif ($gates['claude_result'] -ne 'PASS' -or $gates['scope'] -ne 'PASS') { $gates['test'] = 'SKIPPED: earlier gate failed' }
    else {
        Update-Status @{ state = 'GATES_RUNNING'; gate_step = 'test' }
        try {
            Push-Location $st.worktree
            try {
                if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
                    $cmdExe = (Get-Command cmd.exe -ErrorAction Stop).Source
                    $o = & $cmdExe /d /s /c $testCmd 2>&1
                } else {
                    $o = & bash -c $testCmd 2>&1
                }
                $tc = $LASTEXITCODE
                [IO.File]::WriteAllText($testLog, (($o | ForEach-Object { [string]$_ }) -join "`n"), $utf8)
            } finally { Pop-Location }
            $gates['test'] = if ($tc -eq 0) { 'PASS' } else { "FAIL: exit $tc (see test.log)" }
        } catch {
            [IO.File]::WriteAllText($testLog, "test transport error: $($_.Exception.Message)`n", $utf8)
            $gates['test'] = "FAIL: test transport error (see test.log)"
        }
    }

    $vals = @($gates.Values)
    if (@($vals | Where-Object { $_ -like 'FAIL*' }).Count -gt 0) {
        $final = if ($gates['claude_result'] -ne 'PASS') { 'CLAUDE_FAILED' } else { 'GATE_FAILED' }
    } elseif (@($vals | Where-Object { $_ -like 'SKIPPED*' }).Count -gt 0) { $final = 'GATE_INCOMPLETE' }
    else { $final = 'READY_FOR_REVIEW' }

    $result = [ordered]@{ job_id = $st.job_id; final_state = $final; gates = $gates; changed_files = $changed; judged_at = (Get-Date).ToString('o') }
    Save-Json $result (Join-Path $JobDir 'result.json')
    if ($final -eq 'READY_FOR_REVIEW') { [IO.File]::WriteAllText((Join-Path $JobDir 'DONE'), "judged_by=outer_runner`n$((Get-Date).ToString('o'))`n", $utf8) }
    Update-Status @{ state = $final; ended_at = (Get-Date).ToString('o'); gate_step = $null }
} catch {
    [IO.File]::WriteAllText($errPath, "[runner] $($_.Exception.Message)`n", $utf8)
    Update-Status @{ state = 'CLAUDE_FAILED'; ended_at = (Get-Date).ToString('o'); runner_error = $_.Exception.Message }
} finally {
    for ($i = 0; $i -lt 20; $i++) {
        if ((Test-Path $LockPath) -and (Get-Item $LockPath).Length -gt 0) { break }
        Start-Sleep -Milliseconds 250
    }
    try {
        $lock = Get-Content $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($lock.job_id -eq $st.job_id) { Remove-Item $LockPath -ErrorAction SilentlyContinue }
    } catch { }
}
