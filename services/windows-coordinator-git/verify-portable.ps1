[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 required' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
if (-not $env:OS) { $env:OS = 'Windows_NT' }

function Require([bool]$ok, [string]$message) { if (-not $ok) { throw $message } }
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Source-Hashes([string]$repository, [string[]]$paths) {
    $result = [ordered]@{}
    foreach ($relative in $paths) {
        $full = Join-Path $repository ($relative.Replace('/', '\'))
        Require (Test-Path -LiteralPath $full -PathType Leaf) "Portable source missing: $relative"
        $result[$relative] = Sha $full
    }
    $result
}
function Run-Bounded([string]$phase, [string]$cwd, [string]$image,
    [string[]]$argv, [int[]]$accepted, [int]$deadlineMs) {
    $start = [Diagnostics.ProcessStartInfo]::new($image)
    $start.WorkingDirectory = $cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $argv) { [void]$start.ArgumentList.Add($argument) }
    $began = [DateTimeOffset]::UtcNow.ToString('o')
    $run = [GraphGitVerifierProcess]::Run($start, $deadlineMs, 65536, 16384)
    $record = [pscustomobject]@{
        phase = $phase; executable = $image; cwd = $cwd; argv = $argv
        startedAt = $began; durationMs = $run.DurationMs
        outcome = $run.Outcome.ToString(); exitCode = $run.ExitCode
        totalOutputBytes = $run.TotalOutputBytes
        capturedOutputTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -eq 'Exited'
        stdout = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.directChildExitedAndStreamsDrained -and
        -not $record.capturedOutputTruncated -and $record.totalOutputBytes -le 65536 -and
        $run.ExitCode -in $accepted) "Portable child failed or was uncertain: $phase ($($record.outcome)/$($record.exitCode)) $($record.stderr)"
    $record
}
function Checked-Remove([string]$root, [string]$parent, [string]$nonce) {
    $parentFull = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
    Require ([IO.Path]::GetDirectoryName($rootFull) -ieq $parentFull) 'Portable cleanup root not direct child'
    Require ($rootFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Portable cleanup escaped tmp'
    Require (([IO.File]::ReadAllText((Join-Path $rootFull '.fixture-marker')).Trim()) -ceq $nonce) 'Portable marker mismatch'
    foreach ($path in @($parentFull, $rootFull)) {
        $item = Get-Item -LiteralPath $path -Force
        Require ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Portable cleanup root redirected'
        Require ((Resolve-Path -LiteralPath $path).Path -ieq $path) 'Portable cleanup path resolved elsewhere'
    }
    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($rootFull)
    while ($stack.Count -gt 0) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $stack.Pop() -Force)) {
            Require (-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Portable cleanup descendant redirected'
            Require ($entry.FullName.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Portable cleanup descendant escaped root'
            if ($entry.PSIsContainer) { $stack.Push($entry.FullName) }
        }
    }
    Remove-Item -LiteralPath $rootFull -Recurse -Force -ErrorAction Stop
    Require (-not (Test-Path -LiteralPath $rootFull)) 'Portable cleanup incomplete'
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
$sourcePaths = @(
    'services/windows-coordinator-git/BoundedGitChild.cs',
    'services/windows-coordinator-git/GitBundleImport.cs',
    'services/windows-coordinator-git/GitWorktreePublish.cs',
    'services/windows-coordinator-git/GitWorktreeStage.cs',
    'services/windows-coordinator-git/GraphSelectedGitProfile.cs',
    'services/windows-coordinator-git/NativeWorktreePublication.cs',
    'services/windows-coordinator-git/Program.cs',
    'services/windows-coordinator-git/StaticGitImports.cs',
    'services/windows-coordinator-git/VerifierBoundedProcess.cs',
    'services/windows-coordinator-git/LexRunner.WindowsCoordinator.Git.csproj',
    'services/windows-coordinator-git/verify-portable.ps1',
    'services/windows-coordinator-git/PORTABLE_SOURCE.md',
    'installers/windows-coordinator/v2/GraphV2.cs'
)
$expectedCSharp = @($sourcePaths | Where-Object { $_ -like 'services/windows-coordinator-git/*.cs' } |
    ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
$actualCSharp = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cs' |
    ForEach-Object Name | Sort-Object)
Require (($expectedCSharp -join '|') -ceq ($actualCSharp -join '|')) 'Portable Git C# source inventory changed'
$before = Source-Hashes $repo $sourcePaths
Add-Type -Path (Join-Path $PSScriptRoot 'VerifierBoundedProcess.cs')
$artifact = Join-Path $repo 'artifacts\windows-coordinator-git-portable'
if (-not (Test-Path -LiteralPath $artifact)) { [void](New-Item -ItemType Directory -Path $artifact) }
$tmp = Join-Path $artifact 'tmp'
if (-not (Test-Path -LiteralPath $tmp)) { [void](New-Item -ItemType Directory -Path $tmp) }
$nonce = [guid]::NewGuid().ToString('N')
$root = Join-Path $tmp "portable-$nonce"
Require (-not (Test-Path -LiteralPath $root)) 'Portable fixture root occupied'
[void](New-Item -ItemType Directory -Path $root)
[IO.File]::WriteAllText((Join-Path $root '.fixture-marker'), "$nonce`n", [Text.UTF8Encoding]::new($false))
$receiptPath = Join-Path $artifact "receipt-$nonce.json"
$commands = [Collections.Generic.List[object]]::new()
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = 'failed'; $failure = $null; $cleaned = $false
$normalImageSha256 = $null; $fixtureImageSha256 = $null
$normalDenied = $false; $fixtureDenied = $false
$copyPaths = @()
try {
    $copyRoot = Join-Path $root 'source-copy'
    $copyPaths = @($sourcePaths | Where-Object {
        $_ -like 'services/windows-coordinator-git/*.cs' -or
        $_ -eq 'services/windows-coordinator-git/LexRunner.WindowsCoordinator.Git.csproj' -or
        $_ -eq 'installers/windows-coordinator/v2/GraphV2.cs'
    })
    foreach ($relative in $copyPaths) {
        $target = Join-Path $copyRoot ($relative.Replace('/', '\'))
        [void](New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force)
        Copy-Item -LiteralPath (Join-Path $repo ($relative.Replace('/', '\'))) -Destination $target
        Require ((Sha $target) -ceq $before[$relative]) "Portable copied source mismatch: $relative"
    }
    $project = Join-Path $copyRoot 'services\windows-coordinator-git\LexRunner.WindowsCoordinator.Git.csproj'
    $normalOut = Join-Path $root 'normal-publish'
    $fixtureOut = Join-Path $root 'fixture-publish'
    $null = Run-Bounded 'normal-nativeaot-publish' $repo $dotnet @('publish', $project,
        '-c', 'Release', '-r', 'win-x64', '-p:NuGetAudit=false',
        '-p:GitImportFixture=false', '-o', $normalOut, '-v:q') @(0) 600000
    $null = Run-Bounded 'fixture-nativeaot-publish' $repo $dotnet @('publish', $project,
        '-c', 'Release', '-r', 'win-x64', '-p:NuGetAudit=false',
        '-p:GitImportFixture=true', '-o', $fixtureOut, '-v:q') @(0) 600000
    $normalImage = Join-Path $normalOut 'LexRunner.WindowsCoordinator.Git.exe'
    $fixtureImage = Join-Path $fixtureOut 'LexRunner.WindowsCoordinator.Git.exe'
    Require ((Test-Path -LiteralPath $normalImage -PathType Leaf) -and
        (Test-Path -LiteralPath $fixtureImage -PathType Leaf)) 'Portable native image missing'
    $normalImageSha256 = Sha $normalImage
    $fixtureImageSha256 = Sha $fixtureImage
    $dummySlot = @($root, (Join-Path $root 'absent.bundle'), (Join-Path $root 'absent-mirror'),
        (Join-Path $root 'absent-hooks'), (Join-Path $root 'absent-template'),
        (Join-Path $root 'absent-home'), (Join-Path $root 'absent-temp'),
        ('0' * 40), ('0' * 64))
    $graphFlag = @('--fixture-graph-import') + $dummySlot +
        @((Join-Path $root 'absent-payload'), ('0' * 64))
    $legacyFlag = @('--fixture-import') + $dummySlot
    $normalGraph = Run-Bounded 'normal-refuses-graph-flag' $repo $normalImage $graphFlag @(2) 10000
    $normalLegacy = Run-Bounded 'normal-refuses-legacy-flag' $repo $normalImage $legacyFlag @(2) 10000
    $normalParser = Run-Bounded 'normal-refuses-parser-selftest' $repo $normalImage @('--fixture-graph-parser-selftest') @(2) 10000
    $normalDenied = $normalGraph.stderr.Trim() -ceq 'no_production_git_entrypoint' -and
        $normalLegacy.stderr.Trim() -ceq 'no_production_git_entrypoint' -and
        $normalParser.stderr.Trim() -ceq 'no_production_git_entrypoint'
    Require $normalDenied 'Normal Git image accepted a fixture flag'
    $parser = Run-Bounded 'fixture-native-parser-selftest' $repo $fixtureImage @('--fixture-graph-parser-selftest') @(0) 10000
    Require ($parser.stdout.Trim() -ceq 'graph_parser_selftest_pass') 'Native graph parser accepted newline alias'
    $fixtureGraph = Run-Bounded 'fixture-refuses-absent-graph' $repo $fixtureImage $graphFlag @(3) 10000
    $parsed = $fixtureGraph.stdout | ConvertFrom-Json
    $fixtureDenied = -not $parsed.ProfileAccepted -and -not $parsed.AuthorizesLaunch -and
        $null -eq $parsed.Import -and $parsed.Error.Contains('graph_git_payload_root_not_canonical')
    Require $fixtureDenied 'Fixture image did not type-refuse absent graph'
    Require (-not (Test-Path -LiteralPath (Join-Path $root 'absent-mirror'))) 'Portable refusal created mirror'
    $result = 'portable_source_pass'
    Checked-Remove $root $tmp $nonce
    $cleaned = $true
} catch { $failure = $_.Exception.Message }
finally {
    $clock.Stop()
    $after = $null; $sourcesUnchanged = $false
    try {
        $after = Source-Hashes $repo $sourcePaths
        $sourcesUnchanged = $true
        foreach ($relative in $sourcePaths) {
            if ($before[$relative] -cne $after[$relative]) { $sourcesUnchanged = $false; break }
        }
    } catch { if (-not $failure) { $failure = 'source_recheck_failed:' + $_.Exception.Message } }
    if (-not $sourcesUnchanged) {
        if (-not $failure) { $failure = 'source_changed_during_portable_verification' }
        $result = 'failed'
    }
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-git-portable-source/1'
        result = $result; error = $failure; cwd = $repo
        ciEventSha = $env:GITHUB_SHA
        startedAt = $startedAt; durationMs = $clock.ElapsedMilliseconds
        fixtureRoot = $root; fixtureRemoved = $cleaned
        copiedSourceCount = $(if ($null -ne $copyPaths) { $copyPaths.Count } else { 0 })
        normalImageSha256 = $normalImageSha256
        fixtureImageSha256 = $fixtureImageSha256
        normalFixtureFlagsRefused = $normalDenied
        fixtureAbsentGraphRefused = $fixtureDenied
        commands = $commands
        sourceHashScope = 'complete first-party C# compile inputs, linked GraphV2 parser, bounded harness, and portable verifier; external .NET toolchain/packages not attested'
        sourceSha256Before = $before
        sourceSha256After = $after
        sourceHashesUnchanged = $sourcesUnchanged
        gitInvoked = $false; authorizesLaunch = $false
        installedServiceQualified = $false
    }
    [IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 15) + "`n"),
        [Text.UTF8Encoding]::new($false))
}
if ($failure) { throw "Portable Git source verifier failed: $failure; receipt: $receiptPath" }
Write-Output "Portable Git source verifier passed; receipt: $receiptPath"
