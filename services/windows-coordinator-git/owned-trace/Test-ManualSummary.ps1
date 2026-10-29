param([Parameter(Mandatory = $true)][string]$SummaryPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not [IO.Path]::IsPathFullyQualified($SummaryPath) -or
    -not [IO.File]::Exists($SummaryPath)) { throw 'manual_summary_missing' }
$file = [IO.FileInfo]::new($SummaryPath)
if ($file.Length -le 0 -or $file.Length -gt 8192 -or
    ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'manual_summary_size_or_type_invalid'
}
$bytes = [IO.File]::ReadAllBytes($SummaryPath)
$text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
if ($text.StartsWith([char]0xFEFF) -or $text.Contains("`r") -or
    -not $text.EndsWith("`n") -or $text.EndsWith("`n`n")) {
    throw 'manual_summary_encoding_invalid'
}
$summary = $text | ConvertFrom-Json
if ($summary.schemaVersion -cne 'lexrunner-windows-owned-etw-manual/1' -or
    $summary.result -cnotin @('calibration_observed','refused') -or
    $summary.reasonCode -cnotmatch '^[a-z0-9_]+$' -or
    $summary.sourceHead -cnotmatch '^[0-9a-f]{40}$' -or
    $summary.expectedGitSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.diagnosticImageSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.gitFixtureImageSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.fixedCommand -cne 'git.exe --version' -or
    $summary.commandCwd -cnotmatch '^RUNNER_TEMP/lexrunner-owned-etw-[0-9]+-[0-9]+-[0-9a-f]{32}$' -or
    $summary.gitDurationMs -lt 0 -or $summary.gitDurationMs -gt 30000 -or
    $summary.etlSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.etlBytes -le 0 -or $summary.etlBytes -ge 134217728 -or
    $summary.traceStarted -ne $true -or
    $summary.traceStopAttempted -ne $true -or
    $summary.traceStopped -ne $true -or
    $summary.rawEtlDeleted -ne $true -or
    $summary.cleanupCertain -ne $true -or
    $summary.authorizesLoaderClosure -ne $false -or
    $summary.authorizesExecution -ne $false -or
    $summary.helperMissingCleared -ne $false -or
    $summary.productionReady -ne $false -or
    $summary.runId -cne $env:GITHUB_RUN_ID -or
    $summary.runAttempt -cne $env:GITHUB_RUN_ATTEMPT -or
    $summary.sourceHead -cne $env:GITHUB_SHA) {
    throw 'manual_summary_readback_invalid'
}
$scratchName = $summary.commandCwd.Substring('RUNNER_TEMP/'.Length)
if (-not [IO.Directory]::Exists($env:RUNNER_TEMP) -or
    -not $scratchName.StartsWith("lexrunner-owned-etw-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)-",
        [StringComparison]::Ordinal) -or
    [IO.Directory]::Exists((Join-Path $env:RUNNER_TEMP $scratchName)) -or
    [IO.File]::Exists((Join-Path $env:RUNNER_TEMP $scratchName))) {
    throw 'manual_summary_scratch_still_present'
}
$ownedPrefix = "lexrunner-owned-etw-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)-"
$leftovers = @(Get-ChildItem -LiteralPath $env:RUNNER_TEMP -Force |
    Where-Object { $_.Name.StartsWith($ownedPrefix, [StringComparison]::Ordinal) })
if ($leftovers.Count -ne 0) { throw 'manual_summary_owned_scratch_leftover' }
if ($text -cmatch '(?i)([A-Z]:\\|\\\\\?\\|\\Device\\|\.etl\b|"(?:stdout|stderr|commandLine|etlPath)"\s*:)') {
    throw 'manual_summary_raw_path_or_output'
}
if ($summary.result -ceq 'calibration_observed') {
    if ($summary.reasonCode -cne 'calibration_observed' -or
        $summary.censusReasonCode -cne 'census_observed' -or
        $summary.headerEventsLost -ne 0 -or $summary.headerBuffersLost -ne 0 -or
        $summary.headerEndTimeValid -ne $true -or
        $summary.rootProcessId -le 0 -or
        $summary.rootCreationFileTimeUtc -le 0 -or
        $summary.jobTotalProcesses -ne 1 -or
        $summary.jobAssignedAtCreation -ne $true -or
        $summary.jobTerminalDrained -ne $true -or
        $summary.gitExitCode -ne 0) {
        throw 'manual_summary_observation_invalid'
    }
    foreach ($field in @('liveLoss','finalLiveLoss','stoppedLoss')) {
        $loss = $summary.$field
        if ($null -eq $loss -or $loss.EventsLost -ne 0 -or
            $loss.LogBuffersLost -ne 0 -or $loss.RealTimeBuffersLost -ne 0) {
            throw 'manual_summary_loss_invalid'
        }
    }
}
[pscustomobject]@{
    result = 'manual_summary_bounded'
    sha256 = (Get-FileHash -LiteralPath $SummaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    bytes = $bytes.Length
    rawEtlDeleted = $true
    authorizesExecution = $false
} | ConvertTo-Json -Compress
