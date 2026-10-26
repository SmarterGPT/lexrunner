[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$HelperExecutable,
    [Parameter(Mandatory)][string]$WorkflowSignatureReceipt,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$HelperSourceRevision,
    [Parameter(Mandatory)][ValidateRange(1, [long]::MaxValue)][long]$SigningRunId,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$HelperVersion = '0.1.0'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'The MSI build profile requires native Windows x64'
}
$parts = $HelperVersion.Split('.') | ForEach-Object { [int]$_ }
if ($parts[0] -gt 255 -or $parts[1] -gt 255 -or $parts[2] -gt 65535) { throw 'Version exceeds MSI limits' }
if (-not [IO.Path]::IsPathFullyQualified($HelperExecutable) -or -not [IO.Path]::IsPathFullyQualified($OutputDirectory)) {
    throw 'Select absolute local helper and output paths explicitly'
}
$helper = (Resolve-Path -LiteralPath $HelperExecutable).Path
$workflowReceipt = Get-Content -LiteralPath (Resolve-Path -LiteralPath $WorkflowSignatureReceipt).Path -Raw | ConvertFrom-Json
if ($workflowReceipt.source_revision -cne $HelperSourceRevision -or $workflowReceipt.signature_status -ne 'valid') {
    throw 'Selected workflow signature receipt does not match the helper source'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must be new; existing artifacts are never overwritten' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectRoot = Join-Path $repoRoot 'installers\windows-helper'
$payload = Join-Path $output 'payload'
New-Item -ItemType Directory -Path $payload -Force | Out-Null
$clock = [Diagnostics.Stopwatch]::StartNew()
$receipt = [ordered]@{
    schemaVersion = 'windows-helper-msi-build/1'
    installerSourceHead = (& git.exe -C $repoRoot rev-parse HEAD).Trim()
    installerSourceDirty = @(& git.exe -C $repoRoot status --porcelain).Count -gt 0
    helperSourceRevision = $HelperSourceRevision
    signingRun = "https://github.com/SmarterGPT/lexrunner/actions/runs/$SigningRunId"
    profile = 'windows-helper-msi-direct/1'
    productionReady = $false
    installed = $false
    outcome = 'failed'
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 12) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
}
function Digest([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
try {
    # Retain read/no-write/no-delete custody across signature verification and copy.
    $held = [IO.File]::Open($helper, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $signaturePath = Join-Path $output 'helper-signature-verification.json'
        & (Join-Path $PSScriptRoot 'verify-windows-helper-signature.ps1') -Path $helper -SourceRevision $HelperSourceRevision -ReceiptPath $signaturePath
        $signature = Get-Content -LiteralPath $signaturePath -Raw | ConvertFrom-Json
        $generation = $signature.artifact_sha256
        if ($generation -notmatch '^[0-9a-f]{64}$' -or $signature.signature_status -ne 'valid') { throw 'Invalid helper verification receipt' }
        if ($workflowReceipt.artifact_sha256 -cne $generation -or $workflowReceipt.publisher_identity_eku -cne $signature.publisher_identity_eku) {
            throw 'Downloaded helper does not match the selected workflow receipt'
        }
        $copy = Join-Path $payload 'lexrunner-windows-boundary-helper.exe'
        Copy-Item -LiteralPath $helper -Destination $copy
        if ((Digest $copy) -cne $generation) { throw 'Copied helper bytes differ from the held verified image' }
    } finally { $held.Dispose() }
    $manifest = [ordered]@{
        schemaVersion = 'windows-helper-generation/1'; profile = 'windows-helper-msi-direct/1'
        generationId = $generation; helperVersion = $HelperVersion
        helper = [ordered]@{ file = 'lexrunner-windows-boundary-helper.exe'; sha256 = $generation; bytes = $signature.artifact_bytes; architecture = 'x64'; protocolVersion = '2.0.0'; removalVersion = '1.0.0' }
        source = [ordered]@{ repository = 'SmarterGPT/lexrunner'; revision = $HelperSourceRevision; signingRunId = $SigningRunId; basis = 'explicit workflow selection; independent release attestation still required' }
        publisherPolicy = [ordered]@{ id = 'lexrunner-azure-helper-publisher/1'; subject = $signature.publisher; identityEku = $signature.publisher_identity_eku }
        state = 'provisioned-unqualified'; productionReady = $false
    }
    $manifestPath = Join-Path $payload 'generation.json'
    Write-Json $manifestPath $manifest
    $manifestDigest = Digest $manifestPath
    Write-Json (Join-Path $payload 'installed.json') ([ordered]@{
        schemaVersion = 'windows-helper-installation/1'; generationId = $generation; manifestSha256 = $manifestDigest
        state = 'provisioned-unqualified'; productionReady = $false
    })
    # Cabinet DOS timestamps are packaging metadata, not signature/provenance time.
    # Normalize local staging copies only; the downloaded signed image is untouched.
    foreach ($file in Get-ChildItem -LiteralPath $payload -File) { $file.LastWriteTime = [DateTime]::new(2000, 1, 1, 0, 0, 0, [DateTimeKind]::Unspecified) }
    $arguments = @('build', 'WindowsHelperMsiBuilder.csproj', '-c', 'Release', '--nologo')
    $log = Join-Path $output 'build.log'
    $buildClock = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $projectRoot
    try { & dotnet.exe @arguments *> $log; $code = $LASTEXITCODE }
    finally { Pop-Location; $buildClock.Stop() }
    $tail = (Get-Content -LiteralPath $log -Tail 15) -join "`n"
    if ($tail.Length -gt 2048) { $tail = $tail.Substring($tail.Length - 2048) }
    $receipt.command = @('dotnet.exe') + $arguments; $receipt.cwd = $projectRoot
    $receipt.buildDurationMs = $buildClock.ElapsedMilliseconds; $receipt.exitCode = $code
    $receipt.outputTail = $tail; $receipt.buildLogSha256 = Digest $log
    if ($code -ne 0) { throw "MSI build failed; inspect $log" }
    $recipeBytes = [Text.Encoding]::UTF8.GetBytes((@('Program.cs', 'NativeDatabase.cs', 'MsiRecipe.cs', 'MsiSignatureStorage.cs', 'WindowsHelperMsiBuilder.csproj') | ForEach-Object { Digest (Join-Path $projectRoot $_) }) -join "`n")
    $recipe = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($recipeBytes)).ToLowerInvariant()
    $msi = Join-Path $output 'msi\LexRunner.WindowsHelper.qualification.win-x64.msi'
    $tool = Join-Path $projectRoot 'bin\Release\net8.0\WindowsHelperMsiBuilder.exe'
    $toolClock = [Diagnostics.Stopwatch]::StartNew()
    & $tool $msi $payload $generation $manifestDigest $HelperVersion $recipe *> (Join-Path $output 'package.log')
    $toolCode = $LASTEXITCODE; $toolClock.Stop()
    $receipt.packagingCommand = @($tool, $msi, $payload, $generation, $manifestDigest, $HelperVersion, $recipe)
    $receipt.packagingDurationMs = $toolClock.ElapsedMilliseconds; $receipt.packagingExitCode = $toolCode
    if ($toolCode -ne 0) { throw "Native MSI packaging failed; inspect $(Join-Path $output 'package.log')" }
    if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) { throw 'Expected MSI artifact missing' }
    $receipt.helperSha256 = $generation; $receipt.manifestSha256 = $manifestDigest
    $receipt.msi = $msi; $receipt.msiSha256 = Digest $msi
    $receipt.outcome = 'built-unsigned-candidate'
} finally {
    $clock.Stop(); $receipt.durationMs = $clock.ElapsedMilliseconds
    $receipt.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-Json (Join-Path $output 'build-receipt.json') $receipt
}
Write-Output "MSI candidate built; no installation or activation performed: $($receipt.msi)"
