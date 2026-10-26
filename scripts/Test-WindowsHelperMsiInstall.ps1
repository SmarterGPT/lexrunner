[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedGeneration,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedManifestDigest,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][switch]$EphemeralCi
)
$ErrorActionPreference = 'Stop'
# This lane installs an explicitly unqualified fixture on a disposable hosted
# runner only. It is not a local installer, publisher verifier or activation path.
if (-not $EphemeralCi -or -not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'SmarterGPT/lexrunner' -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') {
    throw 'Real MSI smoke installation is restricted to the explicitly selected disposable Windows hosted-CI lane'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Hosted MSI smoke requires its existing administrative runner token' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
$msi = (Resolve-Path -LiteralPath $Path).Path
$root = [IO.Path]::GetFullPath($ArtifactDirectory)
if (-not [IO.Path]::IsPathFullyQualified($ArtifactDirectory) -or (Test-Path -LiteralPath $root)) { throw 'Select a new absolute artifact directory' }
$application = Join-Path $env:ProgramFiles 'SmarterGPT.LexRunner.WindowsHelper'
$generation = Join-Path $application ('generations\' + $ExpectedGeneration)
$registryRoot = 'Registry::HKEY_LOCAL_MACHINE\Software\SmarterGPT.LexRunner.WindowsHelper'
if ((Test-Path -LiteralPath $application) -or (Test-Path -LiteralPath $registryRoot)) { throw 'Hosted smoke requires an absent dedicated application/catalog; existing state is never modified' }
New-Item -ItemType Directory -Path $root | Out-Null
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$head = (& git.exe -C $repoRoot rev-parse HEAD).Trim()
$commands = [Collections.Generic.List[object]]::new()
$cases = [Collections.Generic.List[string]]::new()
$aclObservations = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{ schemaVersion='windows-helper-msi-install-smoke/1'; commit=$head; outcome='failed'; artifactSha256=(Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant(); generationId=$ExpectedGeneration; cases=$cases; commands=$commands; aclObservations=$aclObservations; productionReady=$false; activeSelectionPublished=$false; installationAttempted=$false; token='existing hosted administrative runner; ordinary-worker denial is not established' }
function Json([string]$File, $Value) { [IO.File]::WriteAllText($File,(($Value|ConvertTo-Json -Depth 12)-replace "`r`n","`n")+"`n",[Text.UTF8Encoding]::new($false)) }
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Digest([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Installer([string]$Name, [string[]]$Arguments, [string]$ExpectedRefusal = '') {
    $log = Join-Path $root ($Name+'.log')
    $exe = Join-Path $env:WINDIR 'System32\msiexec.exe'
    $args = $Arguments + @('/qn','/norestart','/L*v',('"'+$log+'"'))
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { throw 'Installer timeout; state is uncertain and retained, no forced service/process termination' }
    $clock.Stop(); $code = $process.ExitCode; $process.Dispose()
    $tail = (Get-Content -LiteralPath $log -Tail 6) -join "`n"
    if ($tail.Length -gt 2048) { $tail=$tail.Substring($tail.Length-2048) }
    $commands.Add([ordered]@{command=@($exe)+$args;cwd=$repoRoot;commit=$head;durationMs=$clock.ElapsedMilliseconds;exitCode=$code;log=$log;logSha256=Digest $log;outputTail=$tail})
    if ($ExpectedRefusal) {
        Require ($code -eq 1603 -and (Select-String -LiteralPath $log -SimpleMatch $ExpectedRefusal -Quiet)) "Expected deliberate $Name refusal, got $code"
    } else { Require ($code -eq 0) "Installer $Name failed or requires reboot: $code" }
}
function ProtectedAcl([string]$Target, [bool]$Registry = $false) {
    $acl = Get-Acl -LiteralPath $Target
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $group = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    $aclObservations.Add([ordered]@{path=$Target;owner=$owner;group=$group;protected=$acl.AreAccessRulesProtected;sddl=$acl.Sddl})
    Require ($owner -ceq 'S-1-5-18' -and $group -ceq 'S-1-5-18' -and $acl.AreAccessRulesProtected -and $rules.Count -eq 3) 'Installed ownership/protected DACL differs from authored profile'
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        Require ($sid -in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545') -and $rule.AccessControlType -eq 'Allow' -and -not $rule.IsInherited) 'Unexpected installed access rule'
        $rights = if ($Registry) { [long]$rule.RegistryRights } else { [long]$rule.FileSystemRights }
        $mask = $rights -band 0xffffffffL
        $allowed = if ($Registry) { if($sid -ceq 'S-1-5-32-545'){@(0x20019L)}else{@(0xf003fL)} } else { if($sid -ceq 'S-1-5-32-545'){@(0x1200a9L,0xa0000000L)}else{@(0x1f01ffL)} }
        Require ($mask -in $allowed) 'Installed access mask differs from authored profile'
    }
}
function Payload([bool]$MarkerPresent) {
    Require ((Digest (Join-Path $generation 'lexrunner-windows-boundary-helper.exe')) -ceq $ExpectedGeneration) 'Installed helper bytes changed'
    Require ((Digest (Join-Path $generation 'generation.json')) -ceq $ExpectedManifestDigest) 'Installed manifest bytes changed'
    Require ((Test-Path -LiteralPath (Join-Path $generation 'installed.json')) -eq $MarkerPresent) 'Installation eligibility marker state differs'
    $key = Get-Item -LiteralPath ($registryRoot+'\Generations\'+$ExpectedGeneration)
    try {
        Require ($key.GetValue('ManifestDigest') -ceq $ExpectedManifestDigest -and $key.GetValue('State') -ceq 'provisioned-unqualified') 'Installed descriptive catalog differs'
    } finally { $key.Close() }
    $key = Get-Item -LiteralPath $registryRoot
    try { Require ($key.GetValueNames().Count -eq 0) 'Installer must never publish active selection' } finally { $key.Close() }
}
try {
    & (Join-Path $PSScriptRoot 'Inspect-WindowsHelperMsi.ps1') -Path $msi -ExpectedGeneration $ExpectedGeneration -ExpectedManifestDigest $ExpectedManifestDigest -ReceiptPath (Join-Path $root 'inspection.json')
    $product = [LexRunnerMsiReadV1]::Query($msi,'SELECT `Value` FROM `Property` WHERE `Property`=''ProductCode''')[0][0]
    Require ($product -match '^\{[0-9A-F-]{36}\}$') 'Invalid fixture product identity'
    $receipt.productCode=$product
    $receipt.installationAttempted=$true
    Installer 'install' @('/i',('"'+$msi+'"'))
    Payload $true
    foreach ($dir in @($application,(Join-Path $application 'generations'),$generation)) { ProtectedAcl $dir }
    foreach ($name in @('lexrunner-windows-boundary-helper.exe','generation.json','installed.json')) { ProtectedAcl (Join-Path $generation $name) }
    foreach ($key in @($registryRoot,($registryRoot+'\Generations'),($registryRoot+'\Generations\'+$ExpectedGeneration))) { ProtectedAcl $key $true }
    $cases.Add('actual-clean-install-payload-and-protection')
    $helper = Join-Path $generation 'lexrunner-windows-boundary-helper.exe'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    & $helper --unsupported-install-smoke *> (Join-Path $root 'installed-helper.log')
    $code = $LASTEXITCODE; $clock.Stop()
    $commands.Add([ordered]@{command=@($helper,'--unsupported-install-smoke');cwd=$PWD.Path;commit=$head;durationMs=$clock.ElapsedMilliseconds;exitCode=$code;log=(Join-Path $root 'installed-helper.log')})
    Require ($code -eq 2) 'Installed native helper did not load and reject unsupported arguments'
    $cases.Add('installed-native-image-loads')
    Installer 'repair-refused' @('/famus',$product) 'cannot be repaired or modified in place'
    Payload $true
    $cases.Add('in-place-repair-refused')
    Installer 'uninstall' @('/x',$product)
    Payload $false
    $cases.Add('uninstall-removes-marker-retains-generation-and-catalog')
    Installer 'reinstall-refused' @('/i',('"'+$msi+'"')) 'This generation already exists'
    Payload $false
    $cases.Add('retained-generation-reprovision-refused')
    $receipt.outcome='passed'
    $receipt.retainedGeneration=$generation
    $receipt.markerPresent=$false
} finally {
    $receipt.completedAt=[DateTimeOffset]::UtcNow.ToString('o')
    Json (Join-Path $root 'installation-smoke-receipt.json') $receipt
}
Write-Output "Hosted MSI installation smoke passed: $($cases.Count) cases; retained unqualified generation, no active selection"
exit 0
