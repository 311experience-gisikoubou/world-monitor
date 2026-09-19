<#
.SYNOPSIS
    Locates the local Codex CLI executable (codex.exe) without hardcoding its
    version-hash install directory and without modifying PATH.

.DESCRIPTION
    Codex CLI (the desktop app's bundled CLI) installs to a per-build,
    hash-named subdirectory under:
        $env:LOCALAPPDATA\OpenAI\Codex\bin\<hash>\codex.exe
    The <hash> segment changes across installs/updates, so it must never be
    embedded literally in scripts or skill instructions. This script searches
    for it at run time instead.

    This script only detects and prints the path. It does not add anything to
    PATH and does not modify any user/system environment variable.

.OUTPUTS
    On success: the full path to codex.exe, printed to stdout, exit code 0.
    On failure: an error on stderr, exit code 1, nothing on stdout.

.EXAMPLE
    $codexPath = & .\detect-codex.ps1
    if ($LASTEXITCODE -eq 0) { & $codexPath --version }
#>

$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'

if (-not (Test-Path $root)) {
    # Plain stderr write, not Write-Error: combined with a caller that
    # sets $ErrorActionPreference = 'Stop' (as run-codex-handoff.ps1
    # does), Write-Error becomes a terminating exception that propagates
    # out of this script entirely, bypassing its own `exit 1` and any
    # caller-side $LASTEXITCODE check. This keeps the exit code the
    # single source of truth regardless of the caller's error preference.
    [Console]::Error.WriteLine("Codex install root not found: $root (Codex CLI does not appear to be installed on this machine)")
    exit 1
}

$candidates = Get-ChildItem -Path $root -Filter 'codex.exe' -Recurse -ErrorAction SilentlyContinue

if (-not $candidates -or $candidates.Count -eq 0) {
    [Console]::Error.WriteLine("codex.exe not found under $root")
    exit 1
}

# If multiple version-hash directories exist (e.g. after an update left an
# older build in place), prefer the most recently modified one rather than
# guessing which hash is "current".
$codex = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Output $codex.FullName
exit 0
