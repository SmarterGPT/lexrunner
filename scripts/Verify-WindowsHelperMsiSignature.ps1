[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceRevision,
    [Parameter(Mandatory)][string]$ReceiptPath
)
$ErrorActionPreference = 'Stop'
$artifact = (Resolve-Path -LiteralPath $Path).Path
$receipt = [IO.Path]::GetFullPath($ReceiptPath)
if (Test-Path -LiteralPath $receipt) { throw 'Receipt already exists' }
if (-not $artifact.EndsWith('.msi', [StringComparison]::OrdinalIgnoreCase)) { throw 'Expected MSI artifact' }
# Same existing publisher policy as verify-windows-helper-signature.ps1. This is
# trusted qualification tooling, not an installer bootstrap or production grant.
$expectedSubject = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=Joseph Gustavson, O=Joseph Gustavson, L=Dousman, S=Wisconsin, C=US, PostalCode=53118')
$identityEku = '1.3.6.1.4.1.311.97.664386437.910814316.510550690.722133748'
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signTool = Get-ChildItem -LiteralPath $kits -Directory | Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' |
    Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $signTool) { throw 'Windows SDK SignTool required' }
$held = [IO.File]::Open($artifact,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
    if ($held.Length -lt 512 -or $held.Length -gt 128MB) { throw 'MSI size outside supported profile' }
    & $signTool verify /pa /all /tw /q $artifact
    if ($LASTEXITCODE -ne 0) { throw 'MSI signature or timestamp verification failed' }
    $signature = Get-AuthenticodeSignature -LiteralPath $artifact
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or $null -eq $signature.TimeStamperCertificate) { throw 'Expected valid embedded timestamped MSI signature' }
    $certificate = $signature.SignerCertificate
    if (-not [Linq.Enumerable]::SequenceEqual($certificate.SubjectName.RawData,$expectedSubject.RawData)) { throw 'Unexpected MSI publisher' }
    foreach ($oid in @('1.3.6.1.5.5.7.3.3',$identityEku)) {
        if (@($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $oid }).Count -ne 1) { throw 'Required MSI publisher EKU missing' }
    }
    if (-not ('LexRunnerMsiSignatureStorage' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot '../installers/windows-helper/MsiSignatureStorage.cs')
    }
    Add-Type -AssemblyName System.Security.Cryptography.Pkcs
    $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
    $cms.Decode([LexRunnerMsiSignatureStorage]::Read($artifact))
    if ($cms.SignerInfos.Count -ne 1 -or @($cms.SignerInfos[0].UnsignedAttributes | Where-Object { $_.Oid.Value -eq '1.3.6.1.4.1.311.2.4.1' }).Count) { throw 'Expected one MSI primary signer without nested secondary signatures' }
    if (-not [Linq.Enumerable]::SequenceEqual($cms.SignerInfos[0].Certificate.RawData,$certificate.RawData)) { throw 'MSI SIP and embedded signer disagree' }
    $clock.Stop()
    $record = [ordered]@{
        kind = 'windows-helper-msi-signing-qualification'; source_revision = $SourceRevision
        source_revision_basis = 'workflow checkout; verify the separate artifact attestation for source binding'
        artifact_sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
        artifact_bytes = $held.Length; publisher = $certificate.Subject; publisher_identity_eku = $identityEku
        signature_status = 'valid'; signature_count = 1; timestamp_present = $true
        observed_leaf_thumbprint = $certificate.Thumbprint; observed_at = [DateTimeOffset]::UtcNow.ToString('o')
        durationMs = $clock.ElapsedMilliseconds; production_ready = $false; installed = $false
    }
    [IO.File]::WriteAllText($receipt,(($record | ConvertTo-Json -Depth 6) -replace "`r`n","`n") + "`n",[Text.UTF8Encoding]::new($false))
} finally { $held.Dispose() }
