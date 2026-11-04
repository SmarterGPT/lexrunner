[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 required' }
if (-not $env:OS) { $env:OS = 'Windows_NT' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }

Add-Type -Path (Join-Path $PSScriptRoot 'VerifierBoundedProcess.cs')

function Require([bool]$ok, [string]$message) { if (-not $ok) { throw $message } }
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Source-Hashes([string]$repo) {
    $hashes = [ordered]@{}
    foreach ($name in @('LexRunner.WindowsCoordinator.SelectionPublisher.csproj', 'Program.cs',
            'FixtureRegistry.cs', 'FixtureTests.cs', 'VerifierBoundedProcess.cs', 'verify.ps1', 'README.md', 'global.json')) {
        $path = Join-Path $PSScriptRoot $name
        Require (Test-Path -LiteralPath $path -PathType Leaf) "Missing source: $name"
        $hashes[$name] = Sha $path
    }
    foreach ($name in @('CustodyContract.cs', 'CustodyContractV3.cs',
            'PublicationContractV3.cs', 'PublicationContractV3FixtureTests.cs')) {
        $hashes["selection-custody/$name"] = Sha (Join-Path $repo "services/windows-coordinator-selection-custody/$name")
    }
    $hashes
}
function Step([string]$phase, [string]$cwd, [string]$image, [string[]]$argv,
    [int[]]$accepted = @(0), [int]$timeoutMs = 120000) {
    $began = [DateTimeOffset]::UtcNow.ToString('o')
    $start = [Diagnostics.ProcessStartInfo]::new($image)
    $start.WorkingDirectory = $cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $argv) { [void]$start.ArgumentList.Add($argument) }
    $run = [SelectionPublisherVerifierProcess]::Run($start, $timeoutMs, 65536, 16384)
    $record = [pscustomobject]@{
        phase = $phase; executable = $image; cwd = $cwd; argv = $argv
        startedAt = $began; durationMs = $run.DurationMs
        exitCode = $run.ExitCode; outcome = $run.Outcome.ToString()
        totalOutputBytes = $run.TotalOutputBytes; captureTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -eq 'Exited'
        stdout = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.directChildExitedAndStreamsDrained -and -not $record.captureTruncated -and
        $run.ExitCode -in $accepted) "Publisher fixture step failed: $phase ($($record.outcome), $($run.ExitCode)) $($run.Stdout) $($run.Stderr)"
    $record
}
function Fixture-Key-Count {
    @(Get-ChildItem -LiteralPath 'HKCU:\Software' -ErrorAction Stop |
        Where-Object { $_.PSChildName -like 'LexRunnerCoordinatorSelectionFixture-*' }).Count
}
function Assert-PlainDirectoryChain([string]$path) {
    $cursor = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($path))
    while ($true) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Require ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
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
    $stream = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}
function Assert-OwnedRun {
    Require ([IO.Path]::GetDirectoryName($runRoot) -ieq $artifactParent) 'Run root escaped artifact parent'
    Require ($runRoot.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) 'Run root escaped repository'
    Assert-PlainDirectoryChain $runRoot
    Require (Test-Path -LiteralPath $markerPath -PathType Leaf) 'Run owner marker missing'
    $markerItem = Get-Item -LiteralPath $markerPath -Force
    Require (-not ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        $markerItem.FullName -ieq $markerPath -and
        [IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8) -ceq $marker) 'Run owner marker changed'
}
function New-OutputChild([string]$leaf) {
    Require ($leaf -in @('normal', 'fixture', 'normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj')) 'Unknown output child'
    Assert-OwnedRun
    $path = [IO.Path]::GetFullPath((Join-Path $runRoot $leaf))
    Require ([IO.Path]::GetDirectoryName($path) -ieq $runRoot) 'Output child escaped run root'
    Require (-not (Test-Path -LiteralPath $path)) 'Output child already occupied'
    [SelectionPublisherVerifierFiles]::CreateNewDirectory($path)
    [void]$script:createdDirs.Add($leaf)
    Assert-PlainDirectoryChain $path
    $path
}
function Checked-RemoveOwnedChild([string]$leaf) {
    Require ($leaf -in @('normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj') -and
        $createdDirs.Contains($leaf)) 'Cleanup target was not created by this run'
    Assert-OwnedRun
    $target = [IO.Path]::GetFullPath((Join-Path $runRoot $leaf))
    Require ([IO.Path]::GetDirectoryName($target) -ieq $runRoot) 'Cleanup escaped run root'
    Assert-PlainDirectoryChain $target
    $items = @(Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction Stop)
    foreach ($item in $items) {
        Require (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            $item.FullName.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) 'Cleanup child changed or linked'
    }
    Remove-Item -LiteralPath $target -Force -Recurse -ErrorAction Stop
    Require (-not (Test-Path -LiteralPath $target)) 'Build cleanup incomplete'
    'removed'
}

$sourceRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($PSScriptRoot))
$repo = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath((Join-Path $sourceRoot '..\..')))
Require ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($sourceRoot)) -ieq $repo) 'Unexpected source location'
Assert-PlainDirectoryChain $sourceRoot
$artifactParent = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts'))
Assert-PlainDirectoryChain $artifactParent
$project = Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.SelectionPublisher.csproj'
$runNonce = [Guid]::NewGuid().ToString('N')
$runRoot = [IO.Path]::GetFullPath((Join-Path $artifactParent ('windows-selection-publisher-' + $runNonce)))
Require ([IO.Path]::GetDirectoryName($runRoot) -ieq $artifactParent) 'Run root escaped artifact parent'
Require (-not (Test-Path -LiteralPath $runRoot)) 'Run root already occupied'
[SelectionPublisherVerifierFiles]::CreateNewDirectory($runRoot)
$markerPath = Join-Path $runRoot '.selection-publisher-fixture-owner'
$marker = "selection-publisher-fixture-v1`n$runNonce`n$sourceRoot`n"
Write-NewText $markerPath $marker
Assert-OwnedRun
$createdDirs = [Collections.Generic.List[string]]::new()
$normalDir = New-OutputChild 'normal'
$fixtureDir = New-OutputChild 'fixture'
$normalBin = New-OutputChild 'normal-bin'
$normalObj = New-OutputChild 'normal-obj'
$fixtureBin = New-OutputChild 'fixture-bin'
$fixtureObj = New-OutputChild 'fixture-obj'
$imageName = 'LexRunner.WindowsCoordinator.SelectionPublisher.exe'
$dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
$commands = [Collections.Generic.List[object]]::new()
$started = [DateTimeOffset]::UtcNow.ToString('o')
$clock = [Diagnostics.Stopwatch]::StartNew()
$failure = $null
$normalSha = $null; $fixtureSha = $null
$cleanup = [ordered]@{}; $before = $null; $after = $null; $keysBefore = $null; $keysAfter = $null
$repoHead = $null
try {
    Require (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'bin')) -and
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'obj'))) 'Source build path occupied; preserve it'
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $headRead = Step 'repo-head' $repo $git @('rev-parse', 'HEAD') @(0) 30000
    Require ($headRead.stdout -cmatch '\A[0-9a-f]{40}\r?\n\z' -and
        $headRead.stderr.Length -eq 0) 'Exact repository HEAD unavailable'
    $repoHead = $headRead.stdout.Substring(0, 40)
    $keysBefore = Fixture-Key-Count
    Require ($keysBefore -eq 0) 'Preexisting publisher fixture key; refuse live test'
    $before = Source-Hashes $repo
    $normalBuildProps = @("-p:BaseIntermediateOutputPath=$normalObj\",
        "-p:MSBuildProjectExtensionsPath=$normalObj\", "-p:BaseOutputPath=$normalBin\",
        "-p:OutputPath=$normalBin\")
    $normalArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:SelectionPublisherFixture=false') + $normalBuildProps + @('-o', $normalDir, '-v:q')
    $null = Step 'publish-normal' $PSScriptRoot $dotnet $normalArgs
    Require (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'bin')) -and
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'obj'))) 'Native build escaped nonce output'
    $normalImage = Join-Path $normalDir $imageName
    $normalSha = Sha $normalImage
    $normal = Step 'normal-fixture-switch-refusal' $repo $normalImage @('--fixture-hkcu-selftest') @(2) 30000
    Require ($normal.stdout.Trim() -ceq 'no_production_publisher_entrypoint') 'Normal image exposed fixture route'
    $pureExcluded = Step 'normal-publication-model-refusal' $repo $normalImage @('--v3-publication-contract-selftest') @(2) 30000
    Require ($pureExcluded.stdout.Trim() -ceq 'no_production_publisher_entrypoint') 'Normal image exposed publication model'
    $fixtureBuildProps = @("-p:BaseIntermediateOutputPath=$fixtureObj\",
        "-p:MSBuildProjectExtensionsPath=$fixtureObj\", "-p:BaseOutputPath=$fixtureBin\",
        "-p:OutputPath=$fixtureBin\")
    $fixtureArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:SelectionPublisherFixture=true') + $fixtureBuildProps + @('-o', $fixtureDir, '-v:q')
    $null = Step 'publish-fixture' $PSScriptRoot $dotnet $fixtureArgs
    Require (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'bin')) -and
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'obj'))) 'Native build escaped nonce output'
    $fixtureImage = Join-Path $fixtureDir $imageName
    $fixtureSha = Sha $fixtureImage
    $pure = Step 'pure-v3-publication-contract' $repo $fixtureImage @('--v3-publication-contract-selftest') @(0) 30000
    Require ($pure.stdout.TrimEnd().EndsWith('publication_contract_pure_selftest PASS cases=74 failures=0 authorizesLaunch=false authorizesEffect=false nativeEffects=0', [StringComparison]::Ordinal) -and
        $pure.stderr.Length -eq 0) 'Pure publication contract did not pass'
    $wrong = Step 'fixture-unknown-switch-refusal' $repo $fixtureImage @('--publish') @(2) 30000
    Require ($wrong.stdout.Trim() -ceq 'no_production_publisher_entrypoint') 'Fixture exposed arbitrary publish route'
    $live = Step 'disposable-hkcu-publication-recovery' $repo $fixtureImage @('--fixture-hkcu-selftest') @(0) 60000
    Require ($live.stdout.Trim() -ceq 'fixture_hkcu_selftest_pass' -and $live.stderr.Length -eq 0) 'HKCU source fixture did not pass'
    $keysAfter = Fixture-Key-Count
    Require ($keysAfter -eq 0) 'HKCU fixture key retained after test'
    $after = Source-Hashes $repo
    Require (($before | ConvertTo-Json -Compress) -ceq ($after | ConvertTo-Json -Compress)) 'Source changed during native build'
} catch { $failure = $_.Exception.Message }
finally {
    foreach ($leaf in @('normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj')) {
        try { $cleanup[$leaf] = Checked-RemoveOwnedChild $leaf }
        catch { $cleanup[$leaf] = 'uncertain'; if (-not $failure) { $failure = $_.Exception.Message } }
    }
    $clock.Stop()
    if ($null -eq $keysAfter) {
        try { $keysAfter = Fixture-Key-Count }
        catch { $keysAfter = -1 }
    }
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-selection-publisher-source/1'
        result = $(if ($failure) { 'failed' } else { 'source_fixture_pass' })
        error = $failure; cwd = $repo; repoHead = $repoHead; runNonce = $runNonce
        startedAt = $started; durationMs = $clock.ElapsedMilliseconds
        commands = $commands; fixtureKeysBefore = $keysBefore; fixtureKeysAfter = $keysAfter
        normalImageSha256 = $normalSha; fixtureImageSha256 = $fixtureSha
        sourceSha256Before = $before; sourceSha256After = $after
        buildCleanup = $cleanup; authorizesLaunch = $false
        installedSelectionQualified = $false; productionHklmWritten = $false
    }
    $receiptPath = Join-Path $runRoot 'verification-receipt.json'
    Assert-OwnedRun
    Write-NewText $receiptPath (($receipt | ConvertTo-Json -Depth 8).Replace("`r`n", "`n") + "`n")
}
if ($failure) { throw "Selection publisher source fixture failed: $failure; receipt: $receiptPath" }
Write-Output "Selection publisher source fixture passed; receipt: $receiptPath"
