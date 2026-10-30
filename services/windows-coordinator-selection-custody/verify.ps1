[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 required' }
if (-not $env:OS) { $env:OS = 'Windows_NT' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }

$sourceRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($PSScriptRoot))
$repo = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath((Join-Path $sourceRoot '..\..')))
$artifactParent = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts'))
$boundedSource = Join-Path $repo 'services\windows-coordinator-selection-publisher\VerifierBoundedProcess.cs'
Add-Type -Path $boundedSource

function Require([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-PlainChain([string]$path) {
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
function Source-Hashes {
    $hashes = [ordered]@{}
    foreach ($name in @('global.json', 'LexRunner.WindowsCoordinator.SelectionCustody.csproj',
            'Program.cs', 'CustodyContract.cs', 'NativeRegistryReader.cs', 'FixtureTests.cs',
            'CustodyContractV3.cs', 'NativeRegistryReaderV3.cs', 'FixtureTestsV3.cs',
            'PublicationContractV3.cs', 'PublicationContractV3FixtureTests.cs',
            'README.md', 'verify.ps1')) {
        $path = Join-Path $sourceRoot $name
        Require (Test-Path -LiteralPath $path -PathType Leaf) "Missing source: $name"
        $hashes[$name] = Sha $path
    }
    $hashes['../windows-coordinator-selection-publisher/VerifierBoundedProcess.cs'] = Sha $boundedSource
    $hashes
}
function Step([string]$phase, [string]$cwd, [string]$image, [string[]]$argv,
    [int[]]$accepted = @(0), [int]$timeoutMs = 120000) {
    $startedAt = [DateTimeOffset]::UtcNow.ToString('o')
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
        startedAt = $startedAt; durationMs = $run.DurationMs
        exitCode = $run.ExitCode; outcome = $run.Outcome.ToString()
        totalOutputBytes = $run.TotalOutputBytes; captureTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -eq 'Exited'
        stdout = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.directChildExitedAndStreamsDrained -and -not $record.captureTruncated -and
        $run.ExitCode -in $accepted) "Custody step failed: $phase ($($record.outcome), $($run.ExitCode)) $($run.Stdout) $($run.Stderr)"
    $record
}
function Assert-OwnedRun {
    Require ([IO.Path]::GetDirectoryName($runRoot) -ieq $artifactParent) 'Run root escaped artifact parent'
    Require ($runRoot.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) 'Run root escaped repository'
    Assert-PlainChain $runRoot
    Require (Test-Path -LiteralPath $markerPath -PathType Leaf) 'Run owner marker missing'
    $item = Get-Item -LiteralPath $markerPath -Force
    Require (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        $item.FullName -ieq $markerPath -and
        [IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8) -ceq $marker) 'Run owner marker changed'
}
function New-Child([string]$leaf) {
    Require ($leaf -in @('normal', 'fixture', 'normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj')) 'Unknown output child'
    Assert-OwnedRun
    $path = [IO.Path]::GetFullPath((Join-Path $runRoot $leaf))
    Require ([IO.Path]::GetDirectoryName($path) -ieq $runRoot) 'Output child escaped run root'
    Require (-not (Test-Path -LiteralPath $path)) 'Output child occupied'
    [SelectionPublisherVerifierFiles]::CreateNewDirectory($path)
    [void]$script:createdDirs.Add($leaf)
    Assert-PlainChain $path
    $path
}
function Checked-RemoveBuild([string]$leaf) {
    Require ($leaf -in @('normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj') -and
        $createdDirs.Contains($leaf)) 'Cleanup target not owned by this run'
    Assert-OwnedRun
    $target = [IO.Path]::GetFullPath((Join-Path $runRoot $leaf))
    Require ([IO.Path]::GetDirectoryName($target) -ieq $runRoot) 'Cleanup escaped run root'
    Assert-PlainChain $target
    $options = [IO.EnumerationOptions]::new()
    $options.AttributesToSkip = [IO.FileAttributes]0
    $options.IgnoreInaccessible = $false
    $options.RecurseSubdirectories = $false
    $options.ReturnSpecialDirectories = $false
    $pending = [Collections.Generic.Stack[object]]::new()
    $pending.Push([pscustomobject]@{ path = $target; depth = 0 })
    $files = [Collections.Generic.List[string]]::new()
    $directories = [Collections.Generic.List[string]]::new()
    $visited = 0
    $cleanupClock = [Diagnostics.Stopwatch]::StartNew()
    while ($pending.Count -gt 0) {
        Require ($cleanupClock.ElapsedMilliseconds -le 60000) 'Cleanup traversal timed out'
        $current = $pending.Pop()
        Assert-PlainChain $current.path
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current.path, '*', $options)) {
            $visited++
            Require ($visited -le 10000 -and $cleanupClock.ElapsedMilliseconds -le 60000) 'Cleanup traversal budget exceeded'
            $full = [IO.Path]::GetFullPath($entry)
            Require ($full.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -and
                [IO.Path]::GetDirectoryName($full) -ieq $current.path) 'Cleanup entry escaped parent'
            $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
            Require (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                $item.FullName -ieq $full) 'Cleanup child changed or linked'
            if ($item.PSIsContainer) {
                Require ($current.depth -lt 32) 'Cleanup directory depth exceeded'
                [void]$directories.Add($full)
                $pending.Push([pscustomobject]@{ path = $full; depth = $current.depth + 1 })
            } else {
                [void]$files.Add($full)
            }
        }
    }
    foreach ($file in $files) {
        Require ($cleanupClock.ElapsedMilliseconds -le 60000) 'Cleanup deletion timed out'
        $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
        Require (-not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            $item.FullName -ieq $file) 'Cleanup file changed or linked'
        [IO.File]::Delete($file)
    }
    for ($index = $directories.Count - 1; $index -ge 0; $index--) {
        Require ($cleanupClock.ElapsedMilliseconds -le 60000) 'Cleanup deletion timed out'
        $directory = $directories[$index]
        Assert-PlainChain $directory
        [IO.Directory]::Delete($directory, $false)
    }
    Assert-OwnedRun
    Assert-PlainChain $target
    [IO.Directory]::Delete($target, $false)
    Require (-not (Test-Path -LiteralPath $target)) 'Build cleanup incomplete'
    'removed'
}
function Parse-Frame([string]$output) {
    Require ($output.Length -le 512) 'Observation frame too large'
    $frame = $output.Trim() | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    Require ($frame.Count -eq 6 -and
        $frame.schemaVersion -ceq 'windows-coordinator-selection-custody-observation/1' -and
        $frame.state -in @('observed', 'unavailable') -and
        $frame.authorizesLaunch -ceq $false -and
        $frame.productionReady -ceq $false -and
        $frame.helperMissingCleared -ceq $false) 'Observation claimed authority or malformed frame'
    $frame
}

Require ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($sourceRoot)) -ieq $repo) 'Unexpected source location'
Assert-PlainChain $sourceRoot
Require ([IO.Path]::GetDirectoryName($artifactParent) -ieq $repo) 'Artifact parent escaped repository'
if (-not (Test-Path -LiteralPath $artifactParent)) {
    [SelectionPublisherVerifierFiles]::CreateNewDirectory($artifactParent)
}
Assert-PlainChain $artifactParent
Require (Test-Path -LiteralPath $boundedSource -PathType Leaf) 'Bounded process helper missing'
$runNonce = [Guid]::NewGuid().ToString('N')
$runRoot = [IO.Path]::GetFullPath((Join-Path $artifactParent ('windows-selection-custody-' + $runNonce)))
Require ([IO.Path]::GetDirectoryName($runRoot) -ieq $artifactParent) 'Run root escaped artifact parent'
Require (-not (Test-Path -LiteralPath $runRoot)) 'Run root occupied'
[SelectionPublisherVerifierFiles]::CreateNewDirectory($runRoot)
$markerPath = Join-Path $runRoot '.selection-custody-observer-owner'
$marker = "selection-custody-observer-v1`n$runNonce`n$sourceRoot`n"
Write-NewText $markerPath $marker
Assert-OwnedRun
$createdDirs = [Collections.Generic.List[string]]::new()
$normalDir = New-Child 'normal'; $fixtureDir = New-Child 'fixture'
$normalBin = New-Child 'normal-bin'; $normalObj = New-Child 'normal-obj'
$fixtureBin = New-Child 'fixture-bin'; $fixtureObj = New-Child 'fixture-obj'
$commands = [Collections.Generic.List[object]]::new()
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$clock = [Diagnostics.Stopwatch]::StartNew()
$failure = $null; $head = $null; $before = $null; $after = $null
$normalSha = $null; $fixtureSha = $null; $hostObservation = $null
$cleanup = [ordered]@{}
try {
    Require (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'bin')) -and
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'obj'))) 'Source build path occupied; preserve it'
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $headRead = Step 'repo-head-before' $repo $git @('rev-parse', 'HEAD') @(0) 30000
    Require ($headRead.stdout -cmatch '\A[0-9a-f]{40}\r?\n\z' -and
        $headRead.stderr.Length -eq 0) 'Exact repository HEAD unavailable'
    $head = $headRead.stdout.Substring(0, 40)
    $before = Source-Hashes
    $dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
    $project = Join-Path $sourceRoot 'LexRunner.WindowsCoordinator.SelectionCustody.csproj'
    $imageName = 'LexRunner.WindowsCoordinator.SelectionCustody.exe'
    $normalProps = @("-p:BaseIntermediateOutputPath=$normalObj\", "-p:MSBuildProjectExtensionsPath=$normalObj\",
        "-p:BaseOutputPath=$normalBin\", "-p:OutputPath=$normalBin\")
    $normalArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:SelectionCustodyFixture=false') + $normalProps + @('-o', $normalDir, '-v:q')
    $null = Step 'publish-normal' $sourceRoot $dotnet $normalArgs
    Require (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'bin')) -and
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'obj'))) 'Native build escaped nonce output'
    $normalImage = Join-Path $normalDir $imageName
    $normalSha = Sha $normalImage
    $normalFixture = Step 'normal-fixture-route-refusal' $repo $normalImage @('--fixture-selftest') @(2) 30000
    $normalPublish = Step 'normal-publish-route-refusal' $repo $normalImage @('--publish') @(2) 30000
    foreach ($result in @($normalFixture, $normalPublish)) {
        $frame = Parse-Frame $result.stdout
        Require ($frame.state -ceq 'unavailable' -and $frame.reason -ceq 'publisher_unavailable' -and
            $result.stderr.Length -eq 0) 'Normal image exposed an effect route'
    }
    $hostRead = Step 'normal-read-only-fixed-hklm-observation' $repo $normalImage @('--observe') @(0, 2) 30000
    $hostObservation = Parse-Frame $hostRead.stdout
    Require ($hostRead.stderr.Length -eq 0 -and
        (($hostObservation.state -ceq 'observed' -and $hostRead.exitCode -eq 0) -or
         ($hostObservation.state -ceq 'unavailable' -and $hostRead.exitCode -eq 2))) 'Read-only observation status mismatch'
    $fixtureProps = @("-p:BaseIntermediateOutputPath=$fixtureObj\", "-p:MSBuildProjectExtensionsPath=$fixtureObj\",
        "-p:BaseOutputPath=$fixtureBin\", "-p:OutputPath=$fixtureBin\")
    $fixtureArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:SelectionCustodyFixture=true') + $fixtureProps + @('-o', $fixtureDir, '-v:q')
    $null = Step 'publish-fixture' $sourceRoot $dotnet $fixtureArgs
    Require (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'bin')) -and
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'obj'))) 'Fixture build escaped nonce output'
    $fixtureImage = Join-Path $fixtureDir $imageName
    $fixtureSha = Sha $fixtureImage
    $fixturePublish = Step 'fixture-publish-route-refusal' $repo $fixtureImage @('--publish') @(2) 30000
    $frame = Parse-Frame $fixturePublish.stdout
    Require ($frame.state -ceq 'unavailable' -and $frame.reason -ceq 'publisher_unavailable' -and
        $fixturePublish.stderr.Length -eq 0) 'Fixture exposed a publish route'
    $fixtureRun = Step 'pure-in-memory-negative-fixtures' $repo $fixtureImage @('--fixture-selftest') @(0) 30000
    Require ($fixtureRun.stdout.Trim() -ceq 'selection_custody_fixture_pass' -and
        $fixtureRun.stderr.Length -eq 0) 'Synthetic fixture failed'
    $headAfter = Step 'repo-head-after' $repo $git @('rev-parse', 'HEAD') @(0) 30000
    Require ($headAfter.stdout -cmatch '\A[0-9a-f]{40}\r?\n\z' -and
        $headAfter.stderr.Length -eq 0 -and
        $headAfter.stdout.Substring(0, 40) -ceq $head) 'Repository HEAD changed or malformed during verification'
    $after = Source-Hashes
    Require (($before | ConvertTo-Json -Compress) -ceq ($after | ConvertTo-Json -Compress)) 'Source changed during verification'
} catch { $failure = $_.Exception.Message }
finally {
    foreach ($leaf in @('normal-bin', 'normal-obj', 'fixture-bin', 'fixture-obj')) {
        try { $cleanup[$leaf] = Checked-RemoveBuild $leaf }
        catch { $cleanup[$leaf] = 'uncertain'; if (-not $failure) { $failure = $_.Exception.Message } }
    }
    $clock.Stop()
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-selection-custody-source/1'
        result = $(if ($failure) { 'failed' } else { 'source_fixture_pass' })
        error = $failure; cwd = $repo; repoHead = $head; runNonce = $runNonce
        startedAt = $startedAt; durationMs = $clock.ElapsedMilliseconds
        commands = $commands; hostObservation = $hostObservation
        normalImageSha256 = $normalSha; fixtureImageSha256 = $fixtureSha
        sourceSha256Before = $before; sourceSha256After = $after
        buildCleanup = $cleanup; productionHklmWritten = $false
        authorizesLaunch = $false; installedSelectionQualified = $false
    }
    $receiptPath = Join-Path $runRoot 'verification-receipt.json'
    Assert-OwnedRun
    Write-NewText $receiptPath (($receipt | ConvertTo-Json -Depth 8).Replace("`r`n", "`n") + "`n")
}
if ($failure) { throw "Selection custody source verification failed: $failure; receipt: $receiptPath" }
Write-Output "Selection custody source fixture passed; receipt: $receiptPath"
