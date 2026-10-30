param(
    [Parameter(Mandatory = $true)][string]$ArtifactDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false

if (-not $env:WINDIR -and $env:SystemRoot) { $env:WINDIR = $env:SystemRoot }
if (-not [OperatingSystem]::IsWindows() -or [IntPtr]::Size -ne 8) {
    throw 'windows_x64_source_gate_required'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$project = Join-Path $PSScriptRoot 'OwnedTraceDraft.csproj'
$stage = [IO.Path]::GetFullPath($ArtifactDirectory)
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts'))
if (-not [IO.Path]::IsPathFullyQualified($ArtifactDirectory) -or
    -not $stage.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) {
    throw 'fresh_repo_artifact_directory_required'
}
[IO.Directory]::CreateDirectory($stage) | Out-Null
$bin = Join-Path $stage 'bin'
$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
$utf8 = [Text.UTF8Encoding]::new($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$commands = [Collections.Generic.List[object]]::new()

function Get-Length([string]$path) {
    if (-not [IO.File]::Exists($path)) { return 0L }
    return ([IO.FileInfo]::new($path)).Length
}

function Invoke-Bounded([string]$label, [string[]]$arguments,
    [long]$outputLimit, [int]$timeoutMs) {
    $stdout = Join-Path $stage "$label.stdout"
    $stderr = Join-Path $stage "$label.stderr"
    if ([IO.File]::Exists($stdout) -or [IO.File]::Exists($stderr)) {
        throw 'command_output_collision'
    }
    foreach ($argument in $arguments) {
        if ($argument.Contains('"')) { throw 'command_argument_invalid' }
    }
    $argumentLine = (@($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $child = $null
    try {
        $child = Start-Process -FilePath $dotnet -ArgumentList $argumentLine `
            -WorkingDirectory $repo -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        while (-not $child.HasExited) {
            if ((Get-Length $stdout) -gt $outputLimit -or
                (Get-Length $stderr) -gt $outputLimit) { throw 'command_output_limit' }
            if ($watch.ElapsedMilliseconds -ge $timeoutMs) { throw 'command_timeout' }
            Start-Sleep -Milliseconds 50
        }
        $child.WaitForExit()
        $watch.Stop()
        $stdoutBytes = Get-Length $stdout
        $stderrBytes = Get-Length $stderr
        if ($stdoutBytes -gt $outputLimit -or $stderrBytes -gt $outputLimit) {
            throw 'command_output_limit'
        }
        $result = [ordered]@{
            label = $label
            command = $dotnet
            arguments = $arguments
            cwd = $repo
            durationMs = $watch.ElapsedMilliseconds
            exitCode = $child.ExitCode
            stdoutBytes = $stdoutBytes
            stdoutSha256 = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash.ToLowerInvariant()
            stderrBytes = $stderrBytes
            stderrSha256 = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $commands.Add($result)
        return $result
    }
    finally {
        if ($null -ne $child) {
            if (-not $child.HasExited) {
                try { $child.Kill($true) } catch { }
                try { $child.WaitForExit(5000) | Out-Null } catch { }
            }
            $child.Dispose()
        }
    }
}

$build = Invoke-Bounded 'build' @('build', $project, '-c', 'Release',
    '-o', $bin, '-p:NuGetAudit=false', '--nologo') 65536 120000
if ($build.exitCode -ne 0) { throw 'owned_etw_build_failed' }
$dll = Join-Path $bin 'OwnedTraceDraft.dll'
if (-not [IO.File]::Exists($dll)) { throw 'owned_etw_build_output_missing' }
$imageHash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()

$self = Invoke-Bounded 'selftest' @($dll, '--selftest') 8192 10000
if ($self.exitCode -ne 0 -or $self.stderrBytes -ne 0) { throw 'owned_etw_selftest_failed' }
$selfResult = Get-Content -LiteralPath (Join-Path $stage 'selftest.stdout') -Raw | ConvertFrom-Json
if ($selfResult.schemaVersion -cne 'lexrunner-owned-etw-policy-draft/1' -or
    $selfResult.result -cne 'source_fixture_pass' -or
    $selfResult.nativeLayoutVerified -ne $true -or
    @($selfResult.cases).Count -ne 42 -or
    @($selfResult.cases | Where-Object { $_.Passed -ne $true }).Count -ne 0 -or
    $selfResult.traceStarted -ne $false -or $selfResult.traceStopped -ne $false -or
    $selfResult.authorizesLoaderClosure -ne $false -or
    $selfResult.authorizesExecution -ne $false) {
    throw 'owned_etw_selftest_readback_invalid'
}

$preflight = Invoke-Bounded 'preflight-selftest' @($dll, '--preflight-selftest') 8192 10000
if ($preflight.exitCode -ne 0 -or $preflight.stderrBytes -ne 0) { throw 'owned_etw_preflight_selftest_failed' }
$preflightResult = Get-Content -LiteralPath (Join-Path $stage 'preflight-selftest.stdout') -Raw | ConvertFrom-Json
if ($preflightResult.schemaVersion -cne 'lexrunner-etw-preflight-source/1' -or
    $preflightResult.result -cne 'pass' -or @($preflightResult.cases).Count -ne 39 -or
    @($preflightResult.cases | Where-Object { $_.passed -ne $true }).Count -ne 0 -or
    $preflightResult.authorizesExecution -ne $false) { throw 'owned_etw_preflight_selftest_invalid' }
$statusTest = & (Join-Path $PSScriptRoot 'Test-ManualCaptureStatus.ps1') -SelfTest
if ($statusTest.result -cne 'source_status_pass' -or $statusTest.caseCount -ne 49 -or
    $statusTest.authorizesExecution -ne $false) { throw 'owned_etw_status_selftest_failed' }

$refusal = Invoke-Bounded 'capture-refusal' @($dll, '--capture') 1024 10000
if ($refusal.exitCode -ne 3 -or $refusal.stderrBytes -ne 0) {
    throw 'owned_etw_capture_route_exposed'
}
$refusalResult = Get-Content -LiteralPath (Join-Path $stage 'capture-refusal.stdout') -Raw | ConvertFrom-Json
if ($refusalResult.schemaVersion -cne 'lexrunner-owned-etw-policy-draft/1' -or
    $refusalResult.result -cne 'refused' -or
    $refusalResult.reasonCode -cne 'source_only_selftest_required' -or
    $refusalResult.traceStarted -ne $false -or $refusalResult.traceStopped -ne $false -or
    $refusalResult.authorizesLoaderClosure -ne $false -or
    $refusalResult.authorizesExecution -ne $false) {
    throw 'owned_etw_capture_refusal_readback_invalid'
}

$calibrationRefusal = Invoke-Bounded 'calibration-refusal' @($dll, '--capture-calibrate') 1024 10000
if ($calibrationRefusal.exitCode -ne 3 -or $calibrationRefusal.stderrBytes -ne 0) {
    throw 'owned_etw_calibration_bare_route_exposed'
}
$calibrationResult = Get-Content -LiteralPath (Join-Path $stage 'calibration-refusal.stdout') -Raw | ConvertFrom-Json
if ($calibrationResult.schemaVersion -cne 'lexrunner-owned-etw-manual-status/2' -or
    $calibrationResult.result -cne 'refused' -or
    $calibrationResult.reasonCode -cne 'arguments_invalid' -or
    $calibrationResult.phase -cne 'preflight' -or $null -ne $calibrationResult.summarySha256 -or
    $calibrationResult.rawEtlDeleted -ne $false -or
    $calibrationResult.authorizesLoaderClosure -ne $false -or
    $calibrationResult.authorizesExecution -ne $false) {
    throw 'owned_etw_calibration_refusal_readback_invalid'
}

$head = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$' -or
    ($env:GITHUB_SHA -and $head -cne $env:GITHUB_SHA)) {
    throw 'source_head_unavailable_or_mismatched'
}
$sourceHashes = [ordered]@{}
foreach ($name in @('OwnedTraceDraft.csproj', 'Program.cs', 'NativeTraceAdapter.cs',
        'CaptureCalibration.cs', 'ManualCaptureDiagnostic.cs', 'OfflineEtlParser.cs',
        'README.md', 'MANUAL_CALIBRATION.md', 'verify.ps1',
        'Test-ReceiptBounds.ps1', 'Test-ManualSummary.ps1', 'Test-ManualCaptureStatus.ps1')) {
    $sourceHashes[$name] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) `
        -Algorithm SHA256).Hash.ToLowerInvariant()
}
$clock.Stop()
$receipt = [ordered]@{
    schemaVersion = 'lexrunner-windows-owned-etw-source-gate/1'
    result = 'source_fixture_pass'
    sourceHead = $head
    hostOS = [Environment]::OSVersion.VersionString
    processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    sourceCwd = $PSScriptRoot
    durationMs = $clock.ElapsedMilliseconds
    imageSha256 = $imageHash
    caseCount = 42
    preflightCaseCount = 39
    statusSanitizerCaseCount = 49
    commands = @($commands.ToArray())
    sourceSha256 = $sourceHashes
    nativeTraceStarted = $false
    nativeTraceStopped = $false
    etlCaptured = $false
    authorizesLoaderClosure = $false
    authorizesExecution = $false
}
$bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $receipt -Depth 8 -Compress) + "`n")
if ($bytes.Length -gt 8192) { throw 'owned_etw_receipt_limit' }
$receiptPath = Join-Path $stage 'verification-receipt.json'
[IO.File]::WriteAllBytes($receiptPath, $bytes)
[pscustomobject]@{
    result = $receipt.result
    sourceHead = $head
    caseCount = $receipt.caseCount
    imageSha256 = $imageHash
    receiptBytes = $bytes.Length
    receiptSha256 = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    nativeTraceStarted = $false
    authorizesExecution = $false
} | ConvertTo-Json -Compress
