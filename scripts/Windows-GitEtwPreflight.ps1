# Calibration preflight only. This script never starts or stops an ETW logger.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-StrictHost {
    if ($env:GITHUB_ACTIONS -ne 'true' -or
        $env:RUNNER_OS -ne 'Windows' -or
        $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
        $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch' -or
        $env:GITHUB_REF -ne 'refs/heads/main' -or
        $env:GITHUB_REPOSITORY -ne 'SmarterGPT/lexrunner') {
        throw 'isolated_host_required'
    }
    if ($env:GITHUB_RUN_ID -notmatch '^[0-9]{1,20}$' -or
        $env:GITHUB_RUN_ATTEMPT -notmatch '^[0-9]{1,5}$' -or
        $env:GITHUB_SHA -notmatch '^[0-9a-f]{40}$') {
        throw 'github_identity_unavailable'
    }
    if (-not [IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP)) {
        throw 'runner_temp_unavailable'
    }
    if (-not [Environment]::Is64BitProcess) {
        throw 'windows_x64_required'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'elevated_host_required'
        }
    }
    finally { $identity.Dispose() }
}

function Get-ExistingLength([string]$path) {
    if (-not [IO.File]::Exists($path)) { return 0L }
    return ([IO.FileInfo]::new($path)).Length
}

function Write-Receipt {
    $json = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json.Replace(([string][char]13 + [char]10), [string][char]10) + [char]10)
    if ($bytes.Length -gt 32768) { throw 'receipt_size_limit' }
    [IO.File]::WriteAllBytes($receiptPath, $bytes)
}

function Invoke-BoundedReadOnlyXperf([string]$label, [string[]]$arguments, [string]$xperfPath, [string]$outputRoot) {
    $stdoutPath = Join-Path $outputRoot ($label + '.stdout')
    $stderrPath = Join-Path $outputRoot ($label + '.stderr')
    if ([IO.File]::Exists($stdoutPath) -or [IO.File]::Exists($stderrPath)) {
        throw 'output_collision'
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $child = $null
    try {
        $child = Start-Process -FilePath $xperfPath -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        while (-not $child.HasExited) {
            if ((Get-ExistingLength $stdoutPath) -gt 65536 -or
                (Get-ExistingLength $stderrPath) -gt 65536) {
                throw 'xperf_output_limit'
            }
            if ($clock.ElapsedMilliseconds -ge 15000) { throw 'xperf_read_timeout' }
            Start-Sleep -Milliseconds 50
        }
        $child.WaitForExit()
        if ((Get-ExistingLength $stdoutPath) -gt 65536 -or
            (Get-ExistingLength $stderrPath) -gt 65536) {
            throw 'xperf_output_limit'
        }
        return [ordered]@{
            label = $label
            arguments = $arguments
            exitCode = $child.ExitCode
            durationMs = $clock.ElapsedMilliseconds
            stdoutBytes = (Get-ExistingLength $stdoutPath)
            stdoutSha256 = (Get-FileHash -LiteralPath $stdoutPath -Algorithm SHA256).Hash.ToLowerInvariant()
            stderrBytes = (Get-ExistingLength $stderrPath)
            stderrSha256 = (Get-FileHash -LiteralPath $stderrPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    finally {
        if ($null -ne $child) {
            if (-not $child.HasExited) {
                try { $child.Kill($true) } catch { }
                try { $child.WaitForExit(5000) | Out-Null } catch { }
            }
            $child.Dispose()
        }
        # A child can write past the polling threshold before it is killed.
        # Remove oversized files before any artifact step sees this directory.
        foreach ($path in @($stdoutPath, $stderrPath)) {
            if ([IO.File]::Exists($path) -and (Get-ExistingLength $path) -gt 65536) {
                try { [IO.File]::Delete($path) } catch { }
            }
        }
    }
}

try { Test-StrictHost }
catch {
    [Console]::Error.WriteLine('isolated_host_required')
    exit 3
}

$nonce = 'lexrunner-etw-calibration-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT
$outputRoot = Join-Path $env:RUNNER_TEMP $nonce
if ([IO.Directory]::Exists($outputRoot) -or [IO.File]::Exists($outputRoot)) {
    [Console]::Error.WriteLine('calibration_output_occupied')
    exit 3
}
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$receiptPath = Join-Path $outputRoot 'preflight-receipt.json'
$receipt = [ordered]@{
    schemaVersion = 'lexrunner-windows-etw-calibration-preflight/1'
    result = 'refused'
    reason = 'not_started'
    sourceHeadFromWorkflow = $env:GITHUB_SHA
    sourceVerification = 'workflow_input_only'
    hostImageOS = $env:ImageOS
    hostImageVersion = $env:ImageVersion
    osVersion = [Environment]::OSVersion.VersionString
    architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    startedAt = [DateTimeOffset]::UtcNow.ToString('O')
    xperf = $null
    commandResults = @()
    kernelLoggerNameObserved = $null
    loggerGrammarVerified = $false
    lostCountersVerified = $false
    traceCaptured = $false
    authorizesLoaderClosure = $false
    authorizesExecution = $false
}
Write-Receipt
$stage = 'xperf_discovery'
try {
    $candidates = @(Get-Command -Name xperf.exe -All -CommandType Application -ErrorAction Stop)
    $paths = @($candidates | ForEach-Object { $_.Source } | Select-Object -Unique)
    if ($paths.Count -ne 1) { throw 'xperf_path_ambiguous' }
    $xperfPath = $paths[0]
    if (-not [IO.Path]::IsPathFullyQualified($xperfPath)) { throw 'xperf_path_unqualified' }
    $xperfInfo = [IO.FileInfo]::new($xperfPath)
    if (($xperfInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'xperf_reparse_refused'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $xperfPath
    if ($signature.Status -ne 'Valid' -or
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation(,|$)') {
        throw 'xperf_signature_unavailable'
    }
    $receipt.xperf = [ordered]@{
        path = $xperfPath
        bytes = $xperfInfo.Length
        sha256 = (Get-FileHash -LiteralPath $xperfPath -Algorithm SHA256).Hash.ToLowerInvariant()
        fileVersion = $xperfInfo.VersionInfo.FileVersion
        signerSubject = $signature.SignerCertificate.Subject
        signerThumbprint = $signature.SignerCertificate.Thumbprint
    }
    $nonzeroCommands = 0
    foreach ($item in @(
        @{ label = 'help-start'; arguments = @('-help','start') },
        @{ label = 'help-stop'; arguments = @('-help','stop') },
        @{ label = 'help-processing'; arguments = @('-help','processing') },
        @{ label = 'help-tracestats'; arguments = @('-help','tracestats') },
        @{ label = 'loggers'; arguments = @('-loggers') }
    )) {
        $stage = 'xperf_' + $item.label
        $result = Invoke-BoundedReadOnlyXperf $item.label $item.arguments $xperfPath $outputRoot
        $receipt.commandResults += $result
        Write-Receipt
        if ($result.exitCode -ne 0) { $nonzeroCommands++ }
    }
    if ($nonzeroCommands -ne 0) {
        $stage = 'xperf_read_command_exit'
        throw 'xperf_read_command_failed'
    }
    $stage = 'logger_observation'
    # Advisory only: the actual logger query grammar is not calibrated yet.
    $loggerBytes = [IO.File]::ReadAllBytes((Join-Path $outputRoot 'loggers.stdout'))
    $loggerText = [Text.Encoding]::UTF8.GetString($loggerBytes)
    $receipt.kernelLoggerNameObserved = $loggerText.Contains('NT Kernel Logger', [StringComparison]::OrdinalIgnoreCase)
    if ($receipt.kernelLoggerNameObserved) { throw 'existing_kernel_logger_observed' }
    $receipt.result = 'calibration_preflight_only'
    $receipt.reason = 'trace_grammar_and_ownership_unqualified'
    $receipt.completedAt = [DateTimeOffset]::UtcNow.ToString('O')
    Write-Receipt
    Write-Output 'etw_calibration_preflight_only'
    exit 0
}
catch {
    $receipt.result = 'refused'
    $receipt.reason = $stage
    $receipt.errorType = $_.Exception.GetType().Name
    $receipt.completedAt = [DateTimeOffset]::UtcNow.ToString('O')
    Write-Receipt
    [Console]::Error.WriteLine('etw_calibration_preflight_refused')
    exit 3
}
