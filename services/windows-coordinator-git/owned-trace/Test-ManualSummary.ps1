param([Parameter(Mandatory = $true)][string]$SummaryPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Is-NativeInteger($value) {
    $value -is [byte] -or $value -is [sbyte] -or $value -is [int16] -or
        $value -is [uint16] -or $value -is [int32] -or $value -is [uint32] -or
        $value -is [int64] -or $value -is [uint64]
}
function Is-Int64Value($value) {
    if (-not (Is-NativeInteger $value)) { return $false }
    $number = [decimal]$value
    $number -ge [decimal]([int64]::MinValue) -and $number -le [decimal]([int64]::MaxValue)
}
function Is-UInt32Value($value) {
    if (-not (Is-NativeInteger $value)) { return $false }
    $number = [decimal]$value
    $number -ge 0 -and $number -le [decimal]([uint32]::MaxValue)
}
function Has-ExactFields($value, [string[]]$expected) {
    if ($null -eq $value) { return $false }
    $actual = @($value.PSObject.Properties.Name)
    $actual.Count -eq $expected.Count -and
        @(Compare-Object -ReferenceObject $expected -DifferenceObject $actual -CaseSensitive).Count -eq 0
}

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
if ($summary.schemaVersion -cne 'lexrunner-windows-owned-etw-manual/2' -or
    $summary.result -cnotin @('calibration_observed','refused') -or
    $summary.reasonCode -cnotmatch '^[a-z0-9_]+$' -or
    $summary.sourceHead -cnotmatch '^[0-9a-f]{40}$' -or
    $summary.expectedGitSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.diagnosticApphostSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.gitFixtureApphostSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.diagnosticManagedAssemblySha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $summary.gitFixtureManagedAssemblySha256 -cnotmatch '^[0-9a-f]{64}$' -or
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
$samples = @($summary.jobSamples)
if ($samples.Count -gt 32 -or $samples.Count -gt $summary.jobTotalProcesses) {
    throw 'manual_summary_job_sample_count'
}
$sampleIds = [Collections.Generic.HashSet[uint32]]::new()
foreach ($sample in $samples) {
    if (-not (Has-ExactFields $sample @('ProcessId','ParentProcessId','CreationFileTimeUtc','ImageKind')) -or
        -not (Is-UInt32Value $sample.ProcessId) -or -not (Is-UInt32Value $sample.ParentProcessId) -or
        -not (Is-Int64Value $sample.CreationFileTimeUtc) -or $sample.ImageKind -isnot [string] -or
        $sample.ProcessId -le 0 -or $sample.ParentProcessId -le 0 -or
        $sample.CreationFileTimeUtc -le 0 -or -not $sampleIds.Add($sample.ProcessId) -or
        $sample.ImageKind -cnotin @('selected_git_root','console_name_candidate','other') -or
        (($sample.ImageKind -ceq 'selected_git_root') -ne ($sample.ProcessId -eq $summary.rootProcessId)) -or
        ($sample.ProcessId -eq $summary.rootProcessId -and $sample.CreationFileTimeUtc -ne $summary.rootCreationFileTimeUtc)) {
        throw 'manual_summary_job_sample_value'
    }
}
if ($summary.rootProcessId -gt 0 -and -not $sampleIds.Contains($summary.rootProcessId)) {
    throw 'manual_summary_root_sample_missing'
}
$header = $summary.censusHeaderObservation
if ($null -ne $header) {
    if (-not (Has-ExactFields $header @('StartFileTimeUtc','EndFileTimeUtc','CaptureMode',
            'MaximumFileSizeMiB','PointerSize','EventsLost','BuffersLost','FirstFailedCheck')) -or
        -not (Is-Int64Value $header.StartFileTimeUtc) -or -not (Is-Int64Value $header.EndFileTimeUtc) -or
        -not (Is-UInt32Value $header.CaptureMode) -or -not (Is-UInt32Value $header.MaximumFileSizeMiB) -or
        -not (Is-UInt32Value $header.PointerSize) -or -not (Is-UInt32Value $header.EventsLost) -or
        -not (Is-UInt32Value $header.BuffersLost) -or $header.FirstFailedCheck -isnot [string]) {
        throw 'manual_summary_header_shape_or_type'
    }
    $reason = if ($header.StartFileTimeUtc -le 0) {'start_time'}
        elseif ($header.EndFileTimeUtc -le $header.StartFileTimeUtc) {'end_time'}
        elseif ($header.CaptureMode -ne 0x02400001) {'capture_mode'}
        elseif ($header.MaximumFileSizeMiB -ne 128) {'maximum_file_size'}
        elseif ($header.PointerSize -notin @(8,64)) {'pointer_size'} else {'none'}
    if ($summary.result -cne 'refused' -or $summary.censusReasonCode -cne 'etl_header_invalid' -or
        $reason -ceq 'none' -or $header.FirstFailedCheck -cne $reason) {
        throw 'manual_summary_header_observation'
    }
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
