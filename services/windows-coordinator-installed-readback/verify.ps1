[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ExpectedImageSha256,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [switch]$ExpectAbsentService,
    [switch]$ExpectObservedService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows) { throw 'Native Windows required' }
if ($ExpectAbsentService -eq $ExpectObservedService) {
    throw 'Select exactly one expected service observation'
}
if ($ExpectedImageSha256.Length -ne 64 -or
    $ExpectedImageSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $ExpectedManifestSha256.Length -ne 64 -or
    $ExpectedManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $ExpectedVersion.Length -lt 5 -or $ExpectedVersion.Length -gt 13 -or
    $ExpectedVersion -cnotmatch '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,5}$') {
    throw 'invalid_expected_artifact'
}
$versionParts = $ExpectedVersion.Split('.')
if ([int]$versionParts[0] -gt 255 -or [int]$versionParts[1] -gt 255 -or
    [int]$versionParts[2] -gt 65535) {
    throw 'invalid_expected_artifact'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reader = Join-Path $PSScriptRoot 'Read-InstalledCoordinator.ps1'
$artifact = Join-Path $repo 'artifacts\windows-coordinator-installed-readback'
if (-not (Test-Path -LiteralPath $artifact)) {
    [void](New-Item -ItemType Directory -Path $artifact -ErrorAction Stop)
}
$receiptPath = Join-Path $artifact 'verification-receipt.json'
$commands = [Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = 'failed'
$errorText = $null
$observed = $null

function Invoke-Readback([string]$phase, [string[]]$arguments) {
    $began = [DateTimeOffset]::UtcNow.ToString('o')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $output = @(& pwsh -NoLogo -NoProfile -File $reader @arguments 2>&1 |
        ForEach-Object { $_.ToString() })
    $exitCode = $LASTEXITCODE
    $timer.Stop()
    $text = $output -join [char]10
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 32768) {
        throw "Readback output exceeded bound: $phase"
    }
    [void]$commands.Add([ordered]@{
        phase = $phase
        executable = (Get-Command pwsh).Source
        argv = @('-NoLogo', '-NoProfile', '-File', $reader) + $arguments
        cwd = (Get-Location).Path
        startedAt = $began
        durationMs = $timer.ElapsedMilliseconds
        exitCode = $exitCode
        output = $text
    })
    if ($exitCode -ne 0 -or $output.Count -ne 1) {
        throw "Readback failed: $phase"
    }
    return $output[0] | ConvertFrom-Json -Depth 12
}
function Require-Unqualified($value, [string]$phase) {
    if ($value.schemaVersion -cne 'windows-coordinator-installed-readback/1' -or
        $value.authorizesExecution -ne $false -or
        $value.productionReady -ne $false -or
        $value.helperMissingCleared -ne $false -or
        $value.sourceOnly -ne $true -or
        $value.serviceName -cne 'LexRunnerCoordinator' -or
        $value.state -cnotin @('unavailable', 'inconsistent', 'observed_unqualified')) {
        throw "Readback made an unsupported authority claim: $phase"
    }
}

try {
    $self = Invoke-Readback 'synthetic-contract' @('-SelfTest')
    Require-Unqualified $self 'synthetic-contract'
    if ($self.state -cne 'unavailable' -or
        $self.reason -cne 'synthetic_contract_pass' -or
        @($self.observations.syntheticCases.PSObject.Properties |
            Where-Object { $_.Value -ne $true }).Count -ne 0) {
        throw 'Synthetic contract cases failed'
    }
    $bad = Invoke-Readback 'invalid-digest-refusal' @(
        '-ExpectedImageSha256', 'invalid',
        '-ExpectedManifestSha256', $ExpectedManifestSha256,
        '-ExpectedVersion', $ExpectedVersion)
    Require-Unqualified $bad 'invalid-digest-refusal'
    if ($bad.state -cne 'unavailable' -or $bad.reason -cne 'invalid_expected_artifact') {
        throw 'Invalid digest did not refuse before service observation'
    }
    $observed = Invoke-Readback 'machine-read-only' @(
        '-ExpectedImageSha256', $ExpectedImageSha256,
        '-ExpectedManifestSha256', $ExpectedManifestSha256,
        '-ExpectedVersion', $ExpectedVersion)
    Require-Unqualified $observed 'machine-read-only'
    if ($observed.expected.imageSha256 -cne $ExpectedImageSha256 -or
        $observed.expected.manifestSha256 -cne $ExpectedManifestSha256 -or
        $observed.expected.version -cne $ExpectedVersion) {
        throw 'Readback lost expected artifact binding'
    }
    if ($ExpectAbsentService -and
        ($observed.state -cne 'unavailable' -or $observed.reason -cne 'service_absent' -or
            $observed.observations.activeSelectionPresent -ne $false)) {
        throw 'Expected absent coordinator service/selection was not observed'
    }
    if ($ExpectObservedService -and
        ($observed.state -cne 'observed_unqualified' -or
            $observed.reason -cne 'structural_readback_only' -or
            $observed.observations.activeSelectionPresent -ne $false)) {
        throw 'Expected installed structural readback was not observed'
    }
    $result = 'source_readback_pass'
}
catch { $errorText = $_.Exception.Message }
finally {
    $clock.Stop()
    $head = (& git -C $repo rev-parse HEAD)
    $sourceHashes = [ordered]@{}
    foreach ($name in @('Read-InstalledCoordinator.ps1', 'README.md', 'verify.ps1')) {
        $sourceHashes[$name] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $sourceLines = @($sourceHashes.Keys | ForEach-Object {
        "$($_) $($sourceHashes[$_])"
    }) -join [char]10
    $sourceDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($sourceLines + [char]10))).ToLowerInvariant()
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-installed-readback-verification/1'
        result = $result
        error = $errorText
        repoHead = $head
        cwd = (Get-Location).Path
        durationMs = $clock.ElapsedMilliseconds
        expected = [ordered]@{
            imageSha256 = $ExpectedImageSha256
            manifestSha256 = $ExpectedManifestSha256
            version = $ExpectedVersion
        }
        sourceSha256 = $sourceHashes
        sourceCandidateSha256 = $sourceDigest
        commands = $commands
        machineState = if ($null -eq $observed) { $null } else { $observed.state }
        machineReason = if ($null -eq $observed) { $null } else { $observed.reason }
        installedServiceQualified = $false
        authorizesExecution = $false
        productionReady = $false
    }
    [IO.File]::WriteAllText($receiptPath,
        (($receipt | ConvertTo-Json -Depth 12).Replace([Environment]::NewLine, [string][char]10) +
            [char]10),
        [Text.UTF8Encoding]::new($false))
}
if ($result -ne 'source_readback_pass') {
    throw "Read-only installed-service verification failed: $errorText"
}
Write-Output "Read-only coordinator observation passed; receipt: $receiptPath"
