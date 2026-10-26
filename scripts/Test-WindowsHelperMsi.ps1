[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$HelperExecutable,
    [Parameter(Mandatory)][string]$ArtifactDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows required' }
$root = [IO.Path]::GetFullPath($ArtifactDirectory)
if (-not [IO.Path]::IsPathFullyQualified($ArtifactDirectory) -or (Test-Path -LiteralPath $root)) { throw 'Select a new absolute artifact directory' }
New-Item -ItemType Directory -Path $root | Out-Null
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$project = Join-Path $repoRoot 'installers\windows-helper'
$head = (& git.exe -C $repoRoot rev-parse HEAD).Trim()
$commands = [Collections.Generic.List[object]]::new(); $cases = [Collections.Generic.List[string]]::new()
function Run([string]$Name, [string]$Exe, [string[]]$Arguments, [string]$Cwd, [bool]$Pass = $true) {
    $clock = [Diagnostics.Stopwatch]::StartNew(); $log = Join-Path $root "$Name.log"
    Push-Location $Cwd
    try { & $Exe @Arguments *> $log; $code = $LASTEXITCODE } finally { Pop-Location; $clock.Stop() }
    $tail = (Get-Content -LiteralPath $log -Tail 8) -join "`n"
    if ($tail.Length -gt 2048) { $tail = $tail.Substring($tail.Length - 2048) }
    $commands.Add([ordered]@{ command = @($Exe) + $Arguments; cwd = $Cwd; commit = $head; durationMs = $clock.ElapsedMilliseconds; exitCode = $code; outputTail = $tail; log = $log })
    if (($code -eq 0) -ne $Pass) { throw "Unexpected result for $Name; inspect $log" }
}
function Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false)) }
function Digest([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$receipt = [ordered]@{ schemaVersion = 'windows-helper-msi-tests/1'; commit = $head; commands = $commands; cases = $cases; outcome = 'failed'; installed = $false; productionReady = $false }
try {
    Run 'build-tool' 'dotnet.exe' @('build','WindowsHelperMsiBuilder.csproj','-c','Release','--nologo') $project
    $tool = Join-Path $project 'bin\Release\net8.0\WindowsHelperMsiBuilder.exe'
    $payload = Join-Path $root 'payload'; New-Item -ItemType Directory -Path $payload | Out-Null
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $HelperExecutable).Path -Destination (Join-Path $payload 'lexrunner-windows-boundary-helper.exe')
    $generation = Digest (Join-Path $payload 'lexrunner-windows-boundary-helper.exe')
    Json (Join-Path $payload 'generation.json') ([ordered]@{ schemaVersion = 'windows-helper-generation/1'; profile = 'windows-helper-msi-direct/1'; generationId = $generation; helperVersion = '0.1.0'; helper = @{ sha256 = $generation }; state = 'provisioned-unqualified'; productionReady = $false })
    $manifest = Digest (Join-Path $payload 'generation.json')
    Json (Join-Path $payload 'installed.json') ([ordered]@{ generationId = $generation; manifestSha256 = $manifest; productionReady = $false })
    foreach ($file in Get-ChildItem -LiteralPath $payload -File) { $file.LastWriteTime = [DateTime]::new(2000,1,1,0,0,0,[DateTimeKind]::Unspecified) }
    $recipe = Digest (Join-Path $project 'MsiRecipe.cs')
    foreach ($name in @('first','second')) { Run "package-$name" $tool @((Join-Path $root "$name\helper.msi"),$payload,$generation,$manifest,'0.1.0',$recipe) $repoRoot }
    $msi = Join-Path $root 'first\helper.msi'
    if ((Digest $msi) -cne (Digest (Join-Path $root 'second\helper.msi'))) { throw 'Repeated package bytes differ' }
    $cases.Add('reproducible-unsigned-package')
    $inspect = Join-Path $PSScriptRoot 'Inspect-WindowsHelperMsi.ps1'
    Run 'inspect-valid' 'pwsh.exe' @('-NoLogo','-NoProfile','-File',$inspect,'-Path',$msi,'-ExpectedGeneration',$generation,'-ExpectedManifestDigest',$manifest,'-ReceiptPath',(Join-Path $root 'valid.json')) $repoRoot
    $cases.Add('exact-structure-and-embedded-payload')
    Run 'wrong-generation' 'pwsh.exe' @('-NoLogo','-NoProfile','-File',$inspect,'-Path',$msi,'-ExpectedGeneration',('0' * 64),'-ExpectedManifestDigest',$manifest,'-ReceiptPath',(Join-Path $root 'wrong-generation.json')) $repoRoot $false
    $cases.Add('wrong-generation-refused')
    if (-not ('LexRunnerMsiFixtureMutation' -as [type])) {
        Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices;
public static class LexRunnerMsiFixtureMutation {
  static void Check(uint code) { if(code!=0) throw new IOException("Fixture MSI mutation failed: "+code); }
  public static void Apply(string path,string sql) {
    uint database=0,view=0; try { Check(MsiOpenDatabaseW(path,(IntPtr)1,out database));
      Check(MsiDatabaseOpenViewW(database,sql,out view)); Check(MsiViewExecute(view,0)); Check(MsiDatabaseCommit(database));
    } finally { if(view!=0) MsiCloseHandle(view); if(database!=0) MsiCloseHandle(database); }
  }
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiOpenDatabaseW(string path,IntPtr mode,out uint database);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiDatabaseOpenViewW(uint database,string sql,out uint view);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiViewExecute(uint view,uint record);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiDatabaseCommit(uint database);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiCloseHandle(uint handle);
}
'@
    }
    $mutations = [ordered]@{
        'missing-retention' = 'UPDATE `Component` SET `Attributes`=256 WHERE `Component`=''RetainedHelperImage'''
        'registry-escape' = 'UPDATE `Registry` SET `Key`=''Software\Unrelated'' WHERE `Registry`=''ManifestDigest'''
        'unexpected-activation' = 'UPDATE `Registry` SET `Name`=''ActiveSelection'' WHERE `Registry`=''GenerationState'''
        'directory-escape' = 'UPDATE `Directory` SET `DefaultDir`=''elsewhere'' WHERE `Directory`=''HelperApplicationRoot'''
        'file-escape' = 'UPDATE `File` SET `FileName`=''different.exe'' WHERE `File`=''HelperImage'''
        'component-directory' = 'UPDATE `Component` SET `Directory_`=''TARGETDIR'' WHERE `Component`=''RetainedHelperImage'''
        'permission-condition' = 'UPDATE `MsiLockPermissionsEx` SET `Condition`=''0'' WHERE `MsiLockPermissionsEx`=''HelperImage'''
        'permission-rights' = 'UPDATE `MsiLockPermissionsEx` SET `SDDLText`=''O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;BU)'' WHERE `MsiLockPermissionsEx`=''HelperImage'''
        'action-sequence' = 'UPDATE `InstallExecuteSequence` SET `Sequence`=3900 WHERE `Action`=''CreateFolders'''
        'search-binding' = 'DELETE FROM `AppSearch`'
        'locator-key' = 'UPDATE `RegLocator` SET `Key`=''Software\SmarterGPT.LexRunner.WindowsHelper\NeverProvisioned'' WHERE `Signature_`=''ExistingGeneration'''
        'locator-view' = 'UPDATE `RegLocator` SET `Type`=2 WHERE `Signature_`=''ExistingGeneration'''
        'catalog-component' = 'UPDATE `Registry` SET `Component_`=''InstallationMarker'' WHERE `Registry`=''GenerationState'''
        'folder-missing' = 'DELETE FROM `CreateFolder` WHERE `Directory_`=''HelperApplicationRoot'''
        'feature-disabled' = 'UPDATE `Feature` SET `Level`=0 WHERE `Feature`=''Helper'''
        'file-optional' = 'UPDATE `File` SET `Attributes`=0 WHERE `File`=''HelperImage'''
        'file-hash' = 'UPDATE `MsiFileHash` SET `HashPart1`=0 WHERE `File_`=''HelperImage'''
        'media-range' = 'UPDATE `Media` SET `LastSequence`=2 WHERE `DiskId`=1'
    }
    foreach ($item in $mutations.GetEnumerator()) {
        $copy = Join-Path $root ($item.Key + '.msi'); Copy-Item -LiteralPath $msi -Destination $copy
        # Mutate only a fresh artifact copy whose absolute parent is this test root.
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($copy)) -cne $root) { throw 'Unsafe fixture mutation path' }
        [LexRunnerMsiFixtureMutation]::Apply($copy,$item.Value)
        Run $item.Key 'pwsh.exe' @('-NoLogo','-NoProfile','-File',$inspect,'-Path',$copy,'-ExpectedGeneration',$generation,'-ExpectedManifestDigest',$manifest,'-ReceiptPath',(Join-Path $root ($item.Key + '.json'))) $repoRoot $false
        $cases.Add($item.Key + '-refused')
    }
    Run 'input-digest-mismatch' $tool @((Join-Path $root 'bad-input\helper.msi'),$payload,('0' * 64),$manifest,'0.1.0',$recipe) $repoRoot $false
    $cases.Add('input-digest-mismatch-refused')
    $verifySignature = Join-Path $PSScriptRoot 'Verify-WindowsHelperMsiSignature.ps1'
    Run 'unsigned-msi-refused' 'pwsh.exe' @('-NoLogo','-NoProfile','-File',$verifySignature,'-Path',$msi,'-SourceRevision',$head,'-ReceiptPath',(Join-Path $root 'unsigned-signature.json')) $repoRoot $false
    $cases.Add('unsigned-msi-refused')
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $signTool = Get-ChildItem -LiteralPath $kits -Directory | Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' |
        Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $signTool) { throw 'Windows SDK SignTool required for signer negative control' }
    $signedFixture = Join-Path $root 'self-signed-fixture.msi'; Copy-Item -LiteralPath $msi -Destination $signedFixture
    $pfx = Join-Path $root 'ephemeral-fixture.pfx'; $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    $rsa = [Security.Cryptography.RSA]::Create(2048); $certificate = $null
    try {
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=LexRunner MSI fixture', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $oids = [Security.Cryptography.OidCollection]::new(); [void]$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(1))
        [IO.File]::WriteAllBytes($pfx,$certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$password))
        # Ephemeral key only; no OS trust enrollment. Never persist password in command receipts.
        & $signTool sign /fd SHA256 /f $pfx /p $password $signedFixture *> (Join-Path $root 'fixture-sign.log')
        if ($LASTEXITCODE -ne 0) { throw 'Ephemeral MSI fixture signing failed' }
    } finally { if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx }; if ($certificate) { $certificate.Dispose() }; $rsa.Dispose(); $password = $null }
    Add-Type -Path (Join-Path $project 'MsiSignatureStorage.cs')
    Add-Type -AssemblyName System.Security.Cryptography.Pkcs
    $cms = [Security.Cryptography.Pkcs.SignedCms]::new(); $cms.Decode([LexRunnerMsiSignatureStorage]::Read($signedFixture))
    if ($cms.SignerInfos.Count -ne 1) { throw 'MSI signature stream parser did not observe the fixture signer' }
    $cms.CheckSignature($true)
    $cases.Add('real-embedded-msi-signature-readback')
    Run 'untrusted-msi-refused' 'pwsh.exe' @('-NoLogo','-NoProfile','-File',$verifySignature,'-Path',$signedFixture,'-SourceRevision',$head,'-ReceiptPath',(Join-Path $root 'untrusted-signature.json')) $repoRoot $false
    $cases.Add('untrusted-msi-refused')
    $receipt.outcome = 'passed'; $receipt.msiSha256 = Digest $msi; $receipt.generation = $generation; $receipt.manifest = $manifest
} finally { Json (Join-Path $root 'test-receipt.json') $receipt }
Write-Output "MSI offline qualification passed: $($cases.Count) cases; no installation performed"
# Negative controls deliberately leave a nonzero native LASTEXITCODE. GitHub's
# pwsh wrapper propagates it even after successful assertions unless reset here.
exit 0
