[CmdletBinding()]
param([switch]$PreEffectOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 required' }
if (-not $env:OS) { $env:OS = 'Windows_NT' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }

Add-Type -Path (Join-Path $PSScriptRoot 'VerifierBoundedProcess.cs')

function Require([bool]$ok, [string]$message) { if (-not $ok) { throw $message } }
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Source-Hashes {
    $hashes = [ordered]@{}
    foreach ($name in @('.gitignore', 'global.json',
            'LexRunner.WindowsCoordinator.RootProvisioner.csproj', 'Program.cs',
            'ProtectedRootPlan.cs',
            'VerifierBoundedProcess.cs', 'verify.ps1', 'verify-portable.ps1',
            'README.md', 'PORTABLE_SOURCE.md')) {
        $path = Join-Path $sourceRoot $name
        Require (Test-Path -LiteralPath $path -PathType Leaf) "Missing source: $name"
        $hashes[$name] = Sha $path
    }
    $hashes
}
function Assert-PlainDirectoryChain([string]$path) {
    $cursor = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($path))
    while ($true) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Require ($item.PSIsContainer -and
            -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            [IO.Path]::TrimEndingDirectorySeparator($item.FullName) -ieq $cursor) "Unsafe directory ancestor: $cursor"
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (-not $parent) { break }
        $next = [IO.Path]::TrimEndingDirectorySeparator($parent)
        if ($next -ieq $cursor) { break }
        $cursor = $next
    }
}
function Write-NewText([string]$path, [string]$content) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($content)
    $stream = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}
function Assert-OwnedRun {
    Require ([IO.Path]::GetDirectoryName($runRoot) -ieq $artifactParent) 'Run root escaped artifact parent'
    Require ($runRoot.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) 'Run root escaped repo'
    Assert-PlainDirectoryChain $runRoot
    $item = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    Require (-not $item.PSIsContainer -and
        -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        $item.FullName -ieq $markerPath -and
        [IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8) -ceq $marker) 'Run owner marker changed'
}
function New-OutputChild([string]$leaf) {
    Require ($leaf -in @('normal-image', 'fixture-image', 'normal-bin', 'normal-obj',
            'fixture-bin', 'fixture-obj')) 'Unknown output child'
    Assert-OwnedRun
    $path = [IO.Path]::GetFullPath((Join-Path $runRoot $leaf))
    Require ([IO.Path]::GetDirectoryName($path) -ieq $runRoot) 'Output child escaped run root'
    Require (-not (Test-Path -LiteralPath $path)) 'Output child already occupied'
    [RootVerifierFiles]::CreateNewDirectory($path)
    [void]$script:createdDirs.Add($leaf)
    Assert-PlainDirectoryChain $path
    $path
}
function Step([string]$phase, [string]$cwd, [string]$image,
    [string[]]$argv, [int[]]$accepted = @(0), [int]$timeoutMs = 120000) {
    $began = [DateTimeOffset]::UtcNow.ToString('o')
    $start = [Diagnostics.ProcessStartInfo]::new($image)
    $start.WorkingDirectory = $cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $argv) { [void]$start.ArgumentList.Add($argument) }
    $run = [RootVerifierProcess]::Run($start, $timeoutMs, 65536, 16384)
    $record = [pscustomobject]@{
        phase = $phase; executable = $image; cwd = $cwd; argv = $argv
        startedAt = $began; durationMs = $run.DurationMs
        exitCode = $run.ExitCode; outcome = $run.Outcome.ToString()
        totalOutputBytes = $run.TotalOutputBytes; captureTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -eq 'Exited'
        stdout = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.directChildExitedAndStreamsDrained -and
        -not $record.captureTruncated -and $run.ExitCode -in $accepted) "Root fixture step failed: $phase ($($record.outcome), $($run.ExitCode)) $($run.Stdout) $($run.Stderr)"
    $record
}
function Build-Snapshot {
    $rows = [Collections.Generic.List[string]]::new()
    foreach ($name in @('bin', 'obj')) {
        $target = Join-Path $sourceRoot $name
        if (-not (Test-Path -LiteralPath $target)) {
            [void]$rows.Add("$name absent")
            continue
        }
        Assert-PlainDirectoryChain $target
        $items = @(Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction Stop |
            Select-Object -First 20001)
        Require ($items.Count -le 20000) 'Source build tree too large to snapshot'
        foreach ($item in $items | Sort-Object FullName) {
            Require (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                $item.FullName.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) 'Source build tree changed or linked'
            $relative = [IO.Path]::GetRelativePath($sourceRoot, $item.FullName)
            if ($item.PSIsContainer) { [void]$rows.Add("D $relative") }
            else { [void]$rows.Add("F $relative $($item.Length) $(Sha $item.FullName)") }
        }
    }
    $body = [Text.Encoding]::UTF8.GetBytes(($rows -join "`n") + "`n")
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($body)).ToLowerInvariant()
}
function Assert-FixtureTree {
    Assert-OwnedRun
    $fixture = Join-Path $runRoot 'fixture'
    Assert-PlainDirectoryChain $fixture
    $expected = @('store', 'c-anchor', 'c-anchor\stage', 'c-anchor\final',
        'd-anchor', 'd-anchor\stage', 'd-anchor\final') |
        ForEach-Object { [IO.Path]::GetFullPath((Join-Path $fixture $_)) }
    $actual = @(Get-ChildItem -LiteralPath $fixture -Recurse -Force -ErrorAction Stop |
        Select-Object -First 8)
    Require ($actual.Count -eq 7) 'Fixture tree has unexpected entry count'
    foreach ($item in $actual) {
        Require ($item.PSIsContainer -and
            -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            $expected -icontains [IO.Path]::GetFullPath($item.FullName)) "Unexpected fixture entry: $($item.FullName)"
    }
}
function Remove-FixtureTree {
    Assert-FixtureTree
    $fixture = Join-Path $runRoot 'fixture'
    foreach ($relative in @('c-anchor\stage', 'c-anchor\final',
            'd-anchor\stage', 'd-anchor\final', 'c-anchor', 'd-anchor', 'store', '.')) {
        $target = if ($relative -eq '.') { $fixture } else { Join-Path $fixture $relative }
        $target = [IO.Path]::GetFullPath($target)
        Require ($target -ieq $fixture -or
            $target.StartsWith($fixture + '\', [StringComparison]::OrdinalIgnoreCase)) 'Fixture cleanup escaped run root'
        $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
        Require ($item.PSIsContainer -and
            -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            @(Get-ChildItem -LiteralPath $target -Force -ErrorAction Stop |
                Select-Object -First 1).Count -eq 0) 'Fixture cleanup target changed or occupied'
        Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        Require (-not (Test-Path -LiteralPath $target)) 'Fixture cleanup incomplete'
    }
    'removed'
}
function Checked-RemoveBuildChild([string]$leaf) {
    Require ($leaf -in @('normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj') -and
        $createdDirs.Contains($leaf)) 'Build cleanup target not created by this run'
    Assert-OwnedRun
    $target = [IO.Path]::GetFullPath((Join-Path $runRoot $leaf))
    Require ([IO.Path]::GetDirectoryName($target) -ieq $runRoot) 'Build cleanup escaped run root'
    Assert-PlainDirectoryChain $target
    $items = @(Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction Stop |
        Select-Object -First 20001)
    Require ($items.Count -le 20000) 'Build cleanup tree too large'
    foreach ($item in $items) {
        Require (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            $item.FullName.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) 'Build cleanup entry changed or linked'
    }
    foreach ($item in $items | Sort-Object { $_.FullName.Length } -Descending) {
        Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
    }
    Remove-Item -LiteralPath $target -Force -ErrorAction Stop
    Require (-not (Test-Path -LiteralPath $target)) 'Build cleanup incomplete'
    'removed'
}

$sourceRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($PSScriptRoot))
$repo = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath((Join-Path $sourceRoot '..\..')))
Require (Test-Path -LiteralPath (Join-Path $repo 'AGENTS.md') -PathType Leaf) 'Repository marker absent'
Require (Test-Path -LiteralPath (Join-Path $repo 'package.json') -PathType Leaf) 'Package marker absent'
Assert-PlainDirectoryChain $sourceRoot
$artifactParent = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts\windows-coordinator-root-provisioner'))
$artifactRoot = [IO.Path]::GetDirectoryName($artifactParent)
Assert-PlainDirectoryChain $repo
if (-not (Test-Path -LiteralPath $artifactRoot)) {
    [RootVerifierFiles]::CreateNewDirectory($artifactRoot)
}
Assert-PlainDirectoryChain $artifactRoot
if (-not (Test-Path -LiteralPath $artifactParent)) {
    [RootVerifierFiles]::CreateNewDirectory($artifactParent)
}
Assert-PlainDirectoryChain $artifactParent
$runNonce = [Guid]::NewGuid().ToString('N')
$runRoot = [IO.Path]::GetFullPath((Join-Path $artifactParent ('run-' + $runNonce)))
Require ([IO.Path]::GetDirectoryName($runRoot) -ieq $artifactParent -and
    -not (Test-Path -LiteralPath $runRoot)) 'Run root occupied or escaped'
[RootVerifierFiles]::CreateNewDirectory($runRoot)
$markerPath = Join-Path $runRoot '.root-fixture-owner'
$marker = "root-fixture-v1`n$runNonce`n$repo`n"
Write-NewText $markerPath $marker
Assert-OwnedRun
$createdDirs = [Collections.Generic.List[string]]::new()
$normalImageDir = New-OutputChild 'normal-image'
$fixtureImageDir = New-OutputChild 'fixture-image'
$normalBin = New-OutputChild 'normal-bin'
$normalObj = New-OutputChild 'normal-obj'
$fixtureBin = New-OutputChild 'fixture-bin'
$fixtureObj = New-OutputChild 'fixture-obj'
$commands = [Collections.Generic.List[object]]::new()
$started = [DateTimeOffset]::UtcNow.ToString('o')
$clock = [Diagnostics.Stopwatch]::StartNew()
$failure = $null
$sourceBefore = $null; $sourceAfter = $null
$buildBefore = $null; $buildAfter = $null
$normalSha = $null; $fixtureSha = $null
$fixtureCreated = $false; $fixtureCleaned = $false
$cleanup = [ordered]@{}
$repoHead = $null
$imageName = 'LexRunner.WindowsCoordinator.RootProvisioner.exe'
$project = Join-Path $sourceRoot 'LexRunner.WindowsCoordinator.RootProvisioner.csproj'
$dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source

try {
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $headRead = Step 'repo-head' $repo $git @('rev-parse', 'HEAD') @(0) 30000
    Require ($headRead.stdout -cmatch '\A[0-9a-f]{40}\r?\n\z' -and
        $headRead.stderr.Length -eq 0) 'Repository HEAD unavailable'
    $repoHead = $headRead.stdout.Substring(0, 40)
    $sourceBefore = Source-Hashes
    $buildBefore = Build-Snapshot
    $normalProps = @("-p:BaseIntermediateOutputPath=$normalObj\",
        "-p:MSBuildProjectExtensionsPath=$normalObj\", "-p:BaseOutputPath=$normalBin\",
        "-p:OutputPath=$normalBin\")
    $normalArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:TreatWarningsAsErrors=true',
        '-p:CoordinatorRootFixtureTests=false') + $normalProps + @('-o', $normalImageDir, '-v:q')
    $null = Step 'publish-normal' $sourceRoot $dotnet $normalArgs
    Require ((Build-Snapshot) -ceq $buildBefore) 'Normal build touched source bin/obj'
    $normalImage = Join-Path $normalImageDir $imageName
    $normalSha = Sha $normalImage
    $normal = Step 'normal-fixture-refused' $repo $normalImage @('--fixture', $runNonce) @(3) 30000
    Require ($normal.stderr.Trim() -ceq 'protected_provisioning_unavailable' -and
        $normal.stdout.Length -eq 0) 'Normal image exposed fixture route'
    $normalProfile = Step 'normal-profile-refused' $repo $normalImage @('--profile-selftest') @(3) 30000
    Require ($normalProfile.stderr.Trim() -ceq 'protected_provisioning_unavailable' -and
        $normalProfile.stdout.Length -eq 0) 'Normal image exposed profile fixture route'
    $normalVolume = Step 'normal-volume-refused' $repo $normalImage @('--host-volume-selftest') @(3) 30000
    Require ($normalVolume.stderr.Trim() -ceq 'protected_provisioning_unavailable' -and
        $normalVolume.stdout.Length -eq 0) 'Normal image exposed volume fixture route'
    $fixtureProps = @("-p:BaseIntermediateOutputPath=$fixtureObj\",
        "-p:MSBuildProjectExtensionsPath=$fixtureObj\", "-p:BaseOutputPath=$fixtureBin\",
        "-p:OutputPath=$fixtureBin\")
    $fixtureArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:TreatWarningsAsErrors=true',
        '-p:CoordinatorRootFixtureTests=true') + $fixtureProps + @('-o', $fixtureImageDir, '-v:q')
    $null = Step 'publish-fixture' $sourceRoot $dotnet $fixtureArgs
    Require ((Build-Snapshot) -ceq $buildBefore) 'Fixture build touched source bin/obj'
    $fixtureImage = Join-Path $fixtureImageDir $imageName
    $fixtureSha = Sha $fixtureImage
    Require ($fixtureSha -cne $normalSha) 'Fixture and normal image bytes match'
    $profile = Step 'protected-profile-source' $repo $fixtureImage @('--profile-selftest') @(0) 30000
    Require ($profile.stdout.Trim() -ceq 'protected_root_profile_source_pass' -and
        $profile.stderr.Length -eq 0) 'Protected root profile source check failed'
    if (-not $PreEffectOnly) {
        $volume = Step 'held-volume-source' $repo $fixtureImage @('--host-volume-selftest') @(0) 30000
        Require ($volume.stdout.Trim() -cmatch '\Aprotected_volume_source_pass:(NTFS|ReFS):(NTFS|ReFS)\z' -and
            $volume.stderr.Length -eq 0) 'Held supported C:/D: volume profile check failed'
    }
    $invalid = Step 'fixture-invalid-nonce-refused' $repo $fixtureImage @('--fixture', ($runNonce + "`n")) @(3) 30000
    Require ($invalid.stderr.Trim() -ceq 'protected_provisioning_unavailable' -and
        $invalid.stdout.Length -eq 0) 'Fixture accepted trailing-LF nonce'
    $missing = Step 'fixture-missing-run-refused' $repo $fixtureImage @('--fixture', ([Guid]::NewGuid().ToString('N'))) @(4) 30000
    Require ($missing.stderr.Trim() -ceq 'fixture_refused:fixture_run_unavailable' -and
        $missing.stdout.Length -eq 0) 'Fixture accepted absent run root'
    if (-not $PreEffectOnly) {
        $live = Step 'fixture-create' $repo $fixtureImage @('--fixture', $runNonce) @(0) 30000
        $fixtureCreated = $true
        Require ($live.stderr.Length -eq 0) 'Fixture create wrote stderr'
        $result = $live.stdout.Trim() | ConvertFrom-Json
        $fixturePath = Join-Path $runRoot 'fixture'
        Require ($result.State -ceq 'fixture_created_unqualified' -and
            $result.Fixture -ceq $fixturePath -and @($result.Rows).Count -eq 7 -and
            $result.OccupiedRootRefused -eq $true -and
            $result.AuthorizesProvisioning -eq $false -and
            $result.AuthorizesExecution -eq $false) 'Fixture receipt contract failed'
        foreach ($row in $result.Rows) {
            Require ($row.Consistent -eq $true -and $row.Sddl -ceq $result.Policy -and
                $row.VolumeSerial -match '\A0x[0-9a-f]{16}\z' -and
                $row.FileId -match '\A[0-9a-f]{32}\z' -and
                $row.Attributes -match '\A0x[0-9a-f]{8}\z') 'Held identity or ACL readback failed'
        }
        Require (@($result.Rows | Select-Object -ExpandProperty FileId -Unique).Count -eq 7) 'Fixture IDs not distinct'
        Assert-FixtureTree
        $occupied = Step 'occupied-fixture-refused' $repo $fixtureImage @('--fixture', $runNonce) @(4) 30000
        Require ($occupied.stderr.Trim() -ceq 'fixture_refused:fixture_occupied' -and
            $occupied.stdout.Length -eq 0) 'Occupied fixture not refused'
        Assert-FixtureTree
        $cleanup['fixture'] = Remove-FixtureTree
        $fixtureCleaned = $cleanup['fixture'] -ceq 'removed'
    } else {
        Require (-not (Test-Path -LiteralPath (Join-Path $runRoot 'fixture'))) 'Portable mode created fixture root'
    }
    $sourceAfter = Source-Hashes
    Require (($sourceBefore | ConvertTo-Json -Compress) -ceq
        ($sourceAfter | ConvertTo-Json -Compress)) 'Source changed during native verification'
} catch { $failure = $_.Exception.Message }
finally {
    foreach ($leaf in @('normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj')) {
        try { $cleanup[$leaf] = Checked-RemoveBuildChild $leaf }
        catch { $cleanup[$leaf] = 'uncertain'; if (-not $failure) { $failure = $_.Exception.Message } }
    }
    try { $buildAfter = Build-Snapshot }
    catch { if (-not $failure) { $failure = 'source build snapshot failed: ' + $_.Exception.Message } }
    if ($buildBefore -and $buildAfter -cne $buildBefore -and -not $failure) {
        $failure = 'Source bin/obj changed during verification'
    }
    try { $sourceAfter = Source-Hashes }
    catch { if (-not $failure) { $failure = 'source hash readback failed: ' + $_.Exception.Message } }
    if ($sourceBefore -and $sourceAfter -and
        ($sourceBefore | ConvertTo-Json -Compress) -cne
        ($sourceAfter | ConvertTo-Json -Compress) -and -not $failure) {
        $failure = 'Source changed during verification'
    }
    $clock.Stop()
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-root-source/2'
        result = if ($failure) { 'failed' } elseif ($PreEffectOnly) { 'portable_pre_effect_pass' } else { 'source_fixture_pass' }
        error = $failure; mode = if ($PreEffectOnly) { 'portable-pre-effect' } else { 'disposable-root-fixture' }
        repoHead = $repoHead; cwd = $repo; runNonce = $runNonce
        startedAt = $started; durationMs = $clock.ElapsedMilliseconds
        commands = $commands; normalImageSha256 = $normalSha; fixtureImageSha256 = $fixtureSha
        sourceSha256Before = $sourceBefore; sourceSha256After = $sourceAfter
        sourceBuildBefore = $buildBefore; sourceBuildAfter = $buildAfter
        fixtureCreated = $fixtureCreated; fixtureCleaned = $fixtureCleaned
        fixturePresent = (Test-Path -LiteralPath (Join-Path $runRoot 'fixture'))
        checkedCleanup = $cleanup; fixedRootsTouched = $false
        installedServiceQualified = $false; authorizesProvisioning = $false
        authorizesExecution = $false
    }
    $receiptPath = Join-Path $runRoot 'verification-receipt.json'
    Assert-OwnedRun
    Write-NewText $receiptPath (($receipt | ConvertTo-Json -Depth 12).Replace("`r`n", "`n") + "`n")
}
if ($failure) { throw "Root source fixture failed: $failure; receipt: $receiptPath" }
Write-Output "Root source fixture passed; receipt: $receiptPath"
