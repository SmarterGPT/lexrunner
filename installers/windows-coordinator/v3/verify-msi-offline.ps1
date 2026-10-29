[CmdletBinding()]
param([ValidatePattern('\A\d+\.\d+\.\d+\z')][string]$Version = '2.5.0')

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    -not [Environment]::Is64BitProcess) { throw 'V3 offline MSI source gate requires native Windows x64' }
if (-not $env:WINDIR -and $env:SystemRoot) { $env:WINDIR = $env:SystemRoot }
$env:OS = 'Windows_NT'

$project = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$repository = (& git -C $project rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repository) { throw 'LexRunner root unavailable' }
$repository = [IO.Path]::GetFullPath($repository).TrimEnd('\')
$head = (& git -C $repository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cnotmatch '\A[0-9a-f]{40}\z') {
    throw 'LexRunner HEAD unavailable'
}
$draftRoot = Join-Path $repository 'artifacts/windows-v3-msi-draft/20261028/overlay'
$draftMode = $project.StartsWith($draftRoot, [StringComparison]::OrdinalIgnoreCase)
$artifactRoot = if ($draftMode) {
    Join-Path $repository 'artifacts/windows-v3-msi-draft/20261028'
} else {
    Join-Path $repository 'artifacts/windows-coordinator-v3-msi-offline'
}
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$artifact = Join-Path $artifactRoot ('source-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $artifact -ErrorAction Stop | Out-Null
$nodeTsx = Join-Path $repository 'node_modules/tsx/dist/cli.mjs'
$fixtureScript = Join-Path $repository 'installers/windows-coordinator/v3/fixture.ts'
$builderProject = Join-Path $project 'WindowsCoordinatorV3MsiBuilder.csproj'
$boundedSource = Join-Path $project '../v2/BoundedProcess.cs'
foreach ($path in @($nodeTsx, $fixtureScript, $builderProject, $boundedSource)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Source dependency missing: $path" }
}
Add-Type -Path $boundedSource -ErrorAction Stop

$commands = [Collections.Generic.List[object]]::new()
function Invoke-Bounded([string]$exe, [string[]]$arguments, [int]$timeoutMs = 300000) {
    $executable = (Get-Command $exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
    $start = [Diagnostics.ProcessStartInfo]::new($executable)
    $start.WorkingDirectory = $repository
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $arguments) { [void]$start.ArgumentList.Add($argument) }
    $result = [QualificationBoundedProcess]::Run($start, $timeoutMs, 262144, 4096)
    $commands.Add([ordered]@{
        command = @($executable) + $arguments
        cwd = $repository
        commit = $head
        durationMs = $result.DurationMs
        outcome = $result.Outcome.ToString()
        exitCode = $result.ExitCode
        outputBytes = $result.TotalOutputBytes
        outputTruncated = $result.OutputTruncated
        boundedOutput = $result.Stdout + $result.Stderr
    })
    return $result
}
function Require-Exit($result, [int]$code, [string]$name) {
    if ($result.Outcome -ne [QualificationProcessOutcome]::Exited -or
        $result.ExitCode -ne $code) { throw "$name did not exit $code within its bounds" }
}
function Digest([string]$path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}
function New-Fixture([string]$name) {
    $root = Join-Path $artifact $name
    $result = Invoke-Bounded 'node.exe' @($nodeTsx, $fixtureScript, $root) 30000
    Require-Exit $result 0 "Synthetic fixture $name"
    $parsed = $result.Stdout.Trim() | ConvertFrom-Json
    if ($parsed.fileCount -ne 8 -or $parsed.authorizesLaunch -ne $false) {
        throw "Synthetic fixture $name claimed unsupported authority"
    }
    return [pscustomobject]@{ root = $root; graph = $parsed }
}
function Expect-Rejected([string]$name, [string]$payload, [string]$manifestDigest,
    [string]$recipeDigest, [string]$version = $Version) {
    $output = Join-Path $artifact "$name/should-not-exist.msi"
    $result = Invoke-Bounded 'dotnet.exe' @($builder, $output, $payload,
        $manifestDigest, $version, $recipeDigest) 300000
    Require-Exit $result 3 $name
    if (Test-Path -LiteralPath $output) { throw "$name wrote an MSI" }
}

$sourcePaths = @(
    'WindowsCoordinatorV3MsiBuilder.csproj', 'V3MsiProgram.cs', 'GraphV3.cs',
    'V3MsiRecipe.cs', 'V3MsiAudit.cs', 'V3MsiReadback.cs', '../v2/BoundedProcess.cs',
    '../NativeDatabase.cs', 'verify-msi-offline.ps1', 'MSI_OFFLINE.md'
)
$sourceHashes = [ordered]@{}
foreach ($name in $sourcePaths) { $sourceHashes[$name] = Digest (Join-Path $project $name) }
$sourceHashes['installers/windows-coordinator/v3/fixture.ts'] = Digest $fixtureScript
$recipeText = ($sourceHashes.Keys | ForEach-Object { "$_`:$($sourceHashes[$_])" }) -join "`n"
$recipeDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($recipeText))).ToLowerInvariant()
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$outcome = 'refused'
$failure = $null
$msi = $null
$msiDigest = $null
$graph = $null
$descriptorMasks = $null
$descriptorStructure = $null
try {
    foreach ($identity in @(
        @('LexRunnerCoordinator', 'S-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579'),
        @('LexRunnerWorkerSlot1', 'S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843')
    )) {
        $sid = Invoke-Bounded 'sc.exe' @('showsid', $identity[0]) 30000
        Require-Exit $sid 0 "Deterministic SID $($identity[0])"
        if ($sid.Stdout -cnotmatch [regex]::Escape($identity[1])) {
            throw "Service SID derivation mismatch: $($identity[0])"
        }
    }
    $builderObj = Join-Path $artifact 'builder-obj'
    $builderBin = Join-Path $artifact 'builder-bin'
    New-Item -ItemType Directory -Path $builderObj,$builderBin -ErrorAction Stop | Out-Null
    $compile = Invoke-Bounded 'dotnet.exe' @('build', $builderProject, '-c', 'Release',
        '--nologo', "-p:BaseIntermediateOutputPath=$builderObj\",
        "-p:BaseOutputPath=$builderBin\") 300000
    Require-Exit $compile 0 'V3 MSI source build'
    $builder = Join-Path $builderBin 'Release/net8.0/WindowsCoordinatorV3MsiBuilder.dll'
    if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw 'V3 builder DLL missing' }
    $assembly = [Reflection.Assembly]::LoadFrom($builder)
    $profile = $assembly.GetType('V3MsiProgram', $true)
    $coordinatorSid = 'S-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579'
    $workerSid = 'S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843'
    $expectedDescriptors = [ordered]@{
        ServiceSddl = [ordered]@{
            'S-1-5-18' = '10000000'; 'S-1-5-32-544' = '10000000';
            'S-1-5-32-545' = '00020085'
        }
        WorkerServiceSddl = [ordered]@{
            'S-1-5-18' = '10000000'; 'S-1-5-32-544' = '10000000';
            'S-1-5-32-545' = '00020085'; $coordinatorSid = '000200B5'
        }
        DirectorySddl = [ordered]@{
            'S-1-5-18' = '001F01FF'; 'S-1-5-32-544' = '001F01FF';
            'S-1-5-32-545' = 'A0000000'; $coordinatorSid = 'A0000000';
            $workerSid = 'A0000000'
        }
        FileSddl = [ordered]@{
            'S-1-5-18' = '001F01FF'; 'S-1-5-32-544' = '001F01FF';
            'S-1-5-32-545' = 'A0000000'; $coordinatorSid = 'A0000000';
            $workerSid = 'A0000000'
        }
    }
    $descriptorMasks = [ordered]@{}
    $descriptorStructure = [ordered]@{}
    foreach ($name in $expectedDescriptors.Keys) {
        $field = $profile.GetField($name, [Reflection.BindingFlags]'NonPublic,Static')
        if ($null -eq $field) { throw "Compiled descriptor missing: $name" }
        $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new(
            [string]$field.GetRawConstantValue())
        $present = [int][Security.AccessControl.ControlFlags]::DiscretionaryAclPresent
        $protected = [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected
        if ($descriptor.Owner.Value -cne 'S-1-5-18' -or
            $descriptor.Group.Value -cne 'S-1-5-18' -or
            (([int]$descriptor.ControlFlags -band $present) -eq 0) -or
            (([int]$descriptor.ControlFlags -band $protected) -eq 0) -or
            $null -ne $descriptor.SystemAcl) {
            throw "Descriptor owner/group/protection mismatch: $name"
        }
        $expectedFlags = if ($name -ceq 'DirectorySddl') {
            [int][Security.AccessControl.AceFlags]::ObjectInherit -bor
                [int][Security.AccessControl.AceFlags]::ContainerInherit
        } else { 0 }
        $actual = [ordered]@{}
        foreach ($ace in $descriptor.DiscretionaryAcl) {
            if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
                [int]$ace.AceFlags -ne $expectedFlags) {
                throw "Unexpected descriptor ACE kind or inheritance: $name"
            }
            $sid = $ace.SecurityIdentifier.Value
            if ($actual.Contains($sid)) { throw "Repeated descriptor SID: $name" }
            $actual[$sid] = '{0:X8}' -f $ace.AccessMask
        }
        $expected = $expectedDescriptors[$name]
        if ($actual.Count -ne $expected.Count) { throw "Descriptor ACE count mismatch: $name" }
        foreach ($sid in $expected.Keys) {
            if ($actual[$sid] -cne $expected[$sid]) {
                throw "Descriptor rights mismatch: $name $sid"
            }
        }
        $descriptorMasks[$name] = $actual
        $descriptorStructure[$name] = [ordered]@{
            ownerSid = $descriptor.Owner.Value
            groupSid = $descriptor.Group.Value
            daclProtected = $true
            systemAclAbsent = $true
            aceFlags = $expectedFlags
        }
    }

    $valid = New-Fixture 'valid-payload'
    $graph = $valid.graph
    $msi = Join-Path $artifact 'valid/offline-v3.msi'
    $positive = Invoke-Bounded 'dotnet.exe' @($builder, $msi, $valid.root,
        $graph.manifestSha256, $Version, $recipeDigest) 300000
    Require-Exit $positive 0 'V3 offline MSI authoring and readback'
    if (-not (Test-Path -LiteralPath $msi -PathType Leaf) -or
        (Get-Item -LiteralPath $msi).Length -gt 16MB) { throw 'Unexpected offline MSI size' }
    $msiDigest = Digest $msi

    $wrongDigest = '0' * 64
    if ($wrongDigest -ceq $graph.manifestSha256) { $wrongDigest = '1' * 64 }
    Expect-Rejected 'wrong-manifest-digest' $valid.root $wrongDigest $recipeDigest
    Expect-Rejected 'newline-recipe' $valid.root $graph.manifestSha256 ($recipeDigest + "`n")
    $changedWorker = New-Fixture 'changed-worker-payload'
    $workerPath = Join-Path $changedWorker.root 'service/LexRunner.WindowsCoordinator.WorkerSlot.exe'
    [IO.File]::WriteAllBytes($workerPath, [Text.Encoding]::UTF8.GetBytes('changed-worker-image'))
    Expect-Rejected 'changed-worker-image' $changedWorker.root $changedWorker.graph.manifestSha256 $recipeDigest
    $extra = New-Fixture 'extra-payload'
    [IO.File]::WriteAllText((Join-Path $extra.root 'unlisted.txt'), 'extra', [Text.UTF8Encoding]::new($false))
    Expect-Rejected 'extra-payload-member' $extra.root $extra.graph.manifestSha256 $recipeDigest
    $wrongWorkerSid = New-Fixture 'wrong-worker-sid-payload'
    $manifestPath = Join-Path $wrongWorkerSid.root 'generation-graph.json'
    $manifestText = [IO.File]::ReadAllText($manifestPath)
    $wrongText = $manifestText.Replace(
        'S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843',
        'S-1-5-80-0')
    if ($wrongText -ceq $manifestText) { throw 'Worker SID mutation failed' }
    [IO.File]::WriteAllText($manifestPath, $wrongText, [Text.UTF8Encoding]::new($false))
    Expect-Rejected 'wrong-worker-sid' $wrongWorkerSid.root (Digest $manifestPath) $recipeDigest
    $occupiedOutput = Join-Path $artifact 'occupied/should-not-exist.msi'
    New-Item -ItemType Directory -Path (Split-Path $occupiedOutput -Parent) | Out-Null
    [IO.File]::WriteAllText($occupiedOutput, 'preserve', [Text.UTF8Encoding]::new($false))
    $occupied = Invoke-Bounded 'dotnet.exe' @($builder, $occupiedOutput, $valid.root,
        $graph.manifestSha256, $Version, $recipeDigest) 300000
    Require-Exit $occupied 3 'Existing output refusal'
    if ([IO.File]::ReadAllText($occupiedOutput) -cne 'preserve') {
        throw 'Existing output was altered'
    }
    $outcome = 'pass'
} catch {
    $failure = $_.Exception.Message
    throw
} finally {
    $stopwatch.Stop()
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-v3-two-service-msi-offline/1'
        commit = $head
        artifact = $artifact
        durationMs = $stopwatch.ElapsedMilliseconds
        outcome = $outcome
        failure = $failure
        sourceHashes = $sourceHashes
        recipeSha256 = $recipeDigest
        graphDigest = $graph.graphDigest
        manifestSha256 = $graph.manifestSha256
        msi = $msi
        msiSha256 = $msiDigest
        descriptorMasks = $descriptorMasks
        descriptorStructure = $descriptorStructure
        installed = $false
        started = $false
        selected = $false
        productionReady = $false
        authorizesExecution = $false
        commands = $commands
    }
    [IO.File]::WriteAllText((Join-Path $artifact 'verification-receipt.json'),
        (($receipt | ConvertTo-Json -Depth 12) + [char]10), [Text.UTF8Encoding]::new($false))
}
Write-Output ([pscustomobject]@{
    outcome = $outcome; artifact = $artifact; msiSha256 = $msiDigest;
    installed = $false; authorizesExecution = $false
} | ConvertTo-Json -Compress)
