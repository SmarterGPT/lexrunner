# Negative control for draft-only file bounds. Runs pwsh as a fake noisy tool;
# it never invokes xperf or starts ETW.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$draftRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/windows-git-etw-tool-preflight'))
$preflightPath = Join-Path $PSScriptRoot 'Windows-GitEtwPreflight.ps1'
$guardPath = Join-Path $PSScriptRoot 'Test-Windows-GitEtwArtifactBounds.ps1'
$testTemp = Join-Path $draftRoot 'negative-control'
[IO.Directory]::CreateDirectory($testTemp) | Out-Null
$env:RUNNER_TEMP = $testTemp
$runId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$env:GITHUB_RUN_ID = $runId
$env:GITHUB_RUN_ATTEMPT = '1'
$outputRoot = Join-Path $testTemp ('lexrunner-etw-calibration-' + $runId + '-1')
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($preflightPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'preflight_parse_failed' }
foreach ($name in @('Get-ExistingLength', 'Invoke-BoundedReadOnlyXperf')) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw 'preflight_function_missing' }
    . ([ScriptBlock]::Create($definition.Extent.Text))
}

$fakePath = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
$noise = 'while ($true) { [Console]::Out.Write((''x'' * 8192)) }'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($noise))
$clock = [Diagnostics.Stopwatch]::StartNew()
$observed = $null
try {
    Invoke-BoundedReadOnlyXperf 'help-start' @('-NoLogo', '-NoProfile', '-EncodedCommand', $encoded) $fakePath $outputRoot | Out-Null
    throw 'noisy_tool_not_refused'
}
catch {
    $observed = $_.Exception.Message
    if ($observed -ne 'xperf_output_limit') { throw }
}
$clock.Stop()

$noiseFiles = @(Get-ChildItem -LiteralPath $outputRoot -File -Force)
if (@($noiseFiles | Where-Object Length -GT 65536).Count -ne 0) {
    throw 'oversized_noisy_output_retained'
}
$receipt = [ordered]@{
    schemaVersion = 'lexrunner-windows-etw-calibration-preflight/1'
    result = 'refused'
    reason = 'negative_control'
    lostCountersVerified = $false
    traceCaptured = $false
    authorizesLoaderClosure = $false
    authorizesExecution = $false
}
$receiptJson = ConvertTo-Json -InputObject $receipt -Compress
[IO.File]::WriteAllText((Join-Path $outputRoot 'preflight-receipt.json'), $receiptJson, [Text.UTF8Encoding]::new($false))

$guardPassOutput = & $guardPath 2>&1 | Out-String
$guardPassCode = $LASTEXITCODE
if ($guardPassCode -ne 0 -or $guardPassOutput -notmatch 'etw_artifact_bounds_ok') {
    throw 'bounded_stage_refused'
}
$uploadRoot = Join-Path $testTemp ('lexrunner-etw-upload-' + $runId + '-1')
$staged = @(Get-ChildItem -LiteralPath $uploadRoot -File -Force)
if (@($staged | Where-Object Length -GT 65536).Count -ne 0) {
    throw 'oversized_staged_file'
}

$env:GITHUB_RUN_ATTEMPT = '2'
$overflowRoot = Join-Path $testTemp ('lexrunner-etw-calibration-' + $runId + '-2')
[IO.Directory]::CreateDirectory($overflowRoot) | Out-Null
[IO.File]::WriteAllText((Join-Path $overflowRoot 'preflight-receipt.json'), $receiptJson, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllBytes((Join-Path $overflowRoot 'help-stop.stdout'), [byte[]]::new(65537))
$guardRefusalOutput = & $guardPath 2>&1 | Out-String
$guardRefusalCode = $LASTEXITCODE
if ($guardRefusalCode -ne 3) {
    throw 'oversized_artifact_not_refused'
}
$overflowUploadRoot = Join-Path $testTemp ('lexrunner-etw-upload-' + $runId + '-2')
if ([IO.Directory]::Exists($overflowUploadRoot) -and
    @(Get-ChildItem -LiteralPath $overflowUploadRoot -File -Force).Count -ne 0) {
    throw 'refused_stage_retained_files'
}

$testReceipt = [ordered]@{
    schemaVersion = 'lexrunner-windows-etw-noisy-tool-negative/1'
    result = 'passed'
    runId = $runId
    fakeTool = $fakePath
    fakeToolSha256 = (Get-FileHash -LiteralPath $fakePath -Algorithm SHA256).Hash.ToLowerInvariant()
    noisyToolDurationMs = $clock.ElapsedMilliseconds
    noisyToolRefusal = $observed
    rawNoisyOutputMaxBytes = if ($noiseFiles.Count -eq 0) { 0 } else { ($noiseFiles | Measure-Object Length -Maximum).Maximum }
    boundedStageExitCode = $guardPassCode
    boundedStageBytes = ($staged | Measure-Object Length -Sum).Sum
    oversizedStageExitCode = $guardRefusalCode
    oversizedStageFileCount = if ([IO.Directory]::Exists($overflowUploadRoot)) { @(Get-ChildItem -LiteralPath $overflowUploadRoot -File -Force).Count } else { 0 }
    xperfInvoked = $false
    etwStarted = $false
}
$testReceiptPath = Join-Path $draftRoot 'NEGATIVE_CONTROL_RECEIPT.json'
[IO.File]::WriteAllText($testReceiptPath, ((ConvertTo-Json -InputObject $testReceipt -Depth 5) + [char]10), [Text.UTF8Encoding]::new($false))
Write-Output ('noisy_tool_negative_passed receipt=' + $testReceiptPath)
