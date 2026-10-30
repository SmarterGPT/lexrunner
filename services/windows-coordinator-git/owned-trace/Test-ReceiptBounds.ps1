param(
    [Parameter(Mandatory = $true)][string]$ArtifactDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$stage = [IO.Path]::GetFullPath($ArtifactDirectory)
$path = Join-Path $stage 'verification-receipt.json'
if (-not [IO.File]::Exists($path)) { throw 'owned_etw_receipt_missing' }
$file = [IO.FileInfo]::new($path)
if ($file.Length -le 0 -or $file.Length -gt 8192 -or
    ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'owned_etw_receipt_size_or_type_invalid'
}
$bytes = [IO.File]::ReadAllBytes($path)
$text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
if ($text.StartsWith([char]0xFEFF) -or $text.Contains("`r") -or
    -not $text.EndsWith("`n") -or $text.EndsWith("`n`n")) {
    throw 'owned_etw_receipt_encoding_invalid'
}
$receipt = $text | ConvertFrom-Json
if ($receipt.schemaVersion -cne 'lexrunner-windows-owned-etw-source-gate/1' -or
    $receipt.result -cne 'source_fixture_pass' -or
    $receipt.sourceHead -notmatch '^[0-9a-f]{40}$' -or
    ($env:GITHUB_SHA -and $receipt.sourceHead -cne $env:GITHUB_SHA) -or
    $receipt.processArchitecture -cne 'X64' -or
    $receipt.caseCount -ne 42 -or
    $receipt.preflightCaseCount -ne 39 -or $receipt.statusSanitizerCaseCount -ne 155 -or $receipt.nativeActionDiagnosticCaseCount -ne 117 -or
    $receipt.imageSha256 -notmatch '^[0-9a-f]{64}$' -or
    @($receipt.commands).Count -ne 6 -or
    @($receipt.sourceSha256.PSObject.Properties).Count -ne 13 -or
    $receipt.nativeTraceStarted -ne $false -or
    $receipt.nativeTraceStopped -ne $false -or
    $receipt.etlCaptured -ne $false -or
    $receipt.authorizesLoaderClosure -ne $false -or
    $receipt.authorizesExecution -ne $false) {
    throw 'owned_etw_receipt_readback_invalid'
}
$labels = @('build', 'selftest', 'query-diagnostic-selftest', 'preflight-selftest', 'capture-refusal', 'calibration-refusal')
$exits = @(0, 0, 0, 0, 3, 3)
$caps = @(65536, 8192, 8192, 8192, 1024, 1024)
for ($i = 0; $i -lt 6; $i++) {
    $command = $receipt.commands[$i]
    if ($command.label -cne $labels[$i] -or
        $command.exitCode -ne $exits[$i] -or
        $command.durationMs -lt 0 -or
        $command.stdoutBytes -lt 0 -or $command.stdoutBytes -gt $caps[$i] -or
        $command.stderrBytes -lt 0 -or $command.stderrBytes -gt $caps[$i] -or
        $command.stdoutSha256 -notmatch '^[0-9a-f]{64}$' -or
        $command.stderrSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'owned_etw_command_receipt_invalid'
    }
}
[pscustomobject]@{
    result = 'bounded_receipt_pass'
    bytes = $bytes.Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    nativeTraceStarted = $false
    authorizesExecution = $false
} | ConvertTo-Json -Compress
