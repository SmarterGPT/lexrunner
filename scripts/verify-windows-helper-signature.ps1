[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceRevision,
  [Parameter(Mandatory)][string]$ReceiptPath
)
$ErrorActionPreference = 'Stop'
# Qualification tooling on a trusted CI runner, not a production bootstrap root.
$artifact = (Resolve-Path -LiteralPath $Path).Path
$receipt = [IO.Path]::GetFullPath($ReceiptPath)
if ([string]::Equals($artifact, $receipt, [StringComparison]::OrdinalIgnoreCase)) { throw 'Receipt would overwrite artifact' }
if (Test-Path -LiteralPath $receipt) { throw 'Receipt already exists' }
$expectedSubject = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new(
  'CN=Joseph Gustavson, O=Joseph Gustavson, L=Dousman, S=Wisconsin, C=US, PostalCode=53118')
$identityEku = '1.3.6.1.4.1.311.97.664386437.910814316.510550690.722133748'
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signTool = Get-ChildItem -LiteralPath $kits -Directory |
  Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' |
  Sort-Object { [version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $signTool) { throw 'Windows SDK SignTool is required' }
$timer = [Diagnostics.Stopwatch]::StartNew()
# Deny ordinary write/delete during these local checks. No ancestor custody claim.
$stream = [IO.File]::Open($artifact, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  if ($stream.Length -lt 256 -or $stream.Length -gt 64MB) { throw 'Unsupported helper size' }
  $bytes = [byte[]]::new([int]$stream.Length)
  $stream.ReadExactly($bytes)
  if ($bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'Missing DOS header' }
  $pe = [BitConverter]::ToUInt32($bytes, 0x3c)
  if ($pe -gt $bytes.Length - 264) { throw 'Invalid PE offset' }
  if ([BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550 -or
      [BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664 -or
      [BitConverter]::ToUInt16($bytes, $pe + 24) -ne 0x20b) { throw 'Expected x64 PE32+ helper' }
  $security = $pe + 24 + 112 + 32
  $offset = [long][BitConverter]::ToUInt32($bytes, $security)
  $size = [long][BitConverter]::ToUInt32($bytes, $security + 4)
  if ($offset -lt $pe + 264 -or $size -lt 8 -or $offset + $size -gt $bytes.Length) { throw 'Missing or invalid embedded signature' }
  $length = [long][BitConverter]::ToUInt32($bytes, $offset)
  if ($length -lt 8 -or $length -gt $size -or [Math]::Ceiling($length / 8.0) * 8 -ne $size -or
      [BitConverter]::ToUInt16($bytes, $offset + 4) -ne 0x200 -or
      [BitConverter]::ToUInt16($bytes, $offset + 6) -ne 2) { throw 'Expected exactly one PKCS7 certificate entry' }
  Add-Type -AssemblyName System.Security.Cryptography.Pkcs
  $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
  $cms.Decode([byte[]]$bytes[($offset + 8)..($offset + $length - 1)])
  if ($cms.SignerInfos.Count -ne 1) { throw 'Expected one primary signer' }
  $signer = $cms.SignerInfos[0]
  if (@($signer.UnsignedAttributes | Where-Object { $_.Oid.Value -eq '1.3.6.1.4.1.311.2.4.1' }).Count) {
    throw 'Nested secondary signatures are not supported by this qualification profile'
  }
  & $signTool verify /pa /all /tw /q $artifact
  if ($LASTEXITCODE -ne 0) { throw 'SignTool signature or timestamp verification failed' }
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact
  if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
      $null -eq $signature.TimeStamperCertificate) { throw 'Expected valid embedded timestamped Authenticode signature' }
  $certificate = $signature.SignerCertificate
  if (-not [Linq.Enumerable]::SequenceEqual($certificate.RawData, $signer.Certificate.RawData) -or
      -not [Linq.Enumerable]::SequenceEqual($certificate.SubjectName.RawData, $expectedSubject.RawData)) { throw 'Unexpected publisher' }
  foreach ($oid in @('1.3.6.1.5.5.7.3.3', $identityEku)) {
    if (@($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $oid }).Count -ne 1) { throw 'Missing publisher or code-signing EKU' }
  }
  $timer.Stop()
  $record = [ordered]@{
    kind = 'windows-helper-signing-qualification'; source_revision = $SourceRevision
    source_revision_basis = 'workflow checkout; not embedded source provenance'
    artifact_sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    artifact_bytes = $bytes.Length; architecture = 'win-x64'
    publisher = $certificate.Subject; publisher_identity_eku = $identityEku
    observed_leaf_thumbprint = $certificate.Thumbprint
    timestamp_present = $true; signature_status = 'valid'; signature_count = 1
    observed_at = [DateTimeOffset]::UtcNow.ToString('O'); duration_seconds = $timer.Elapsed.TotalSeconds
    production_ready = $false
  }
  [IO.File]::WriteAllText($receipt, (($record | ConvertTo-Json -Depth 4) -replace "`r`n", "`n") + "`n")
} finally { $stream.Dispose() }
