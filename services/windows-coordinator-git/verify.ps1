[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows) { throw 'Windows PowerShell 7 required' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
if (-not $env:OS) { $env:OS = 'Windows_NT' }

function Require([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Write-Lf([string]$path, [string]$value) {
    [IO.File]::WriteAllText($path, $value.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}
function Sha([string]$path) {
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Sha-Text([string]$value) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($value))).ToLowerInvariant()
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FixtureSystemWindowsDirectory {
    [DllImport("kernel32.dll", EntryPoint="GetSystemWindowsDirectoryW", CharSet=CharSet.Unicode)]
    public static extern uint ReadWindows(StringBuilder buffer, uint capacity);
    [DllImport("kernel32.dll", EntryPoint="GetSystemDirectoryW", CharSet=CharSet.Unicode)]
    public static extern uint ReadSystem(StringBuilder buffer, uint capacity);
}
'@
function Trusted-OsDirectory([string]$which) {
    $buffer = [Text.StringBuilder]::new(32768)
    $length = if ($which -ceq 'windows') {
        [FixtureSystemWindowsDirectory]::ReadWindows($buffer, [uint32]$buffer.Capacity)
    } else {
        [FixtureSystemWindowsDirectory]::ReadSystem($buffer, [uint32]$buffer.Capacity)
    }
    Require ($length -gt 0 -and $length -lt $buffer.Capacity) 'OS root query failed in fixture'
    $value = $buffer.ToString()
    Require ($value.Length -eq $length -and [IO.Path]::IsPathFullyQualified($value)) 'OS root malformed in fixture'
    $value
}
function To-Msys([string]$path) {
    Require ($path -match '^([A-Za-z]):\\') 'Fixture path not on a drive'
    Require (-not $path.Contains("'")) 'Fixture path contains a shell quote'
    '/' + $Matches[1].ToLowerInvariant() + '/' + $path.Substring(3).Replace('\', '/')
}
Add-Type -Path (Join-Path $PSScriptRoot 'VerifierBoundedProcess.cs')
function Invoke-Bounded([string]$phase, [string]$cwd, [string]$image,
    [string[]]$argv, [int[]]$accepted, [int]$deadlineMs,
    [string]$expectedOutcome = 'Exited', [int]$maxOutputBytes = 65536,
    [int]$captureBytesPerStream = 16384) {
    $start = [Diagnostics.ProcessStartInfo]::new($image)
    $start.WorkingDirectory = $cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $argv) { [void]$start.ArgumentList.Add($argument) }
    $began = [DateTimeOffset]::UtcNow.ToString('o')
    $run = [GraphGitVerifierProcess]::Run($start, $deadlineMs,
        $maxOutputBytes, $captureBytesPerStream)
    $record = [pscustomobject]@{
        phase = $phase; executable = $image; cwd = $cwd; argv = $argv
        startedAt = $began; durationMs = $run.DurationMs
        outcome = $run.Outcome.ToString(); exitCode = $run.ExitCode
        totalOutputBytes = $run.TotalOutputBytes
        capturedOutputTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -in @('Exited', 'OutputOverflow', 'TimedOut')
        stdout = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.outcome -ceq $expectedOutcome -and
        $record.directChildExitedAndStreamsDrained) "Verifier child failed or was uncertain: $phase ($($record.outcome)/$($record.exitCode)) $($record.stderr)"
    if ($expectedOutcome -ceq 'Exited') {
        Require (-not $record.capturedOutputTruncated -and
            $record.totalOutputBytes -le $maxOutputBytes -and
            $run.ExitCode -in $accepted) "Verifier child output or exit failed: $phase ($($record.exitCode)) $($record.stderr)"
    }
    elseif ($expectedOutcome -ceq 'OutputOverflow') {
        Require ($record.totalOutputBytes -gt $maxOutputBytes) "Verifier overflow probe did not exceed budget: $phase"
    }
    $record
}
function Invoke-SetupGit([string]$phase, [string]$cwd, [string[]]$argv) {
    $run = Invoke-Bounded $phase $cwd $script:git (@('-C', $cwd) + $argv) @(0) 120000
    $run.stdout.TrimEnd("`r", "`n")
}
function Invoke-FixtureJson([string]$phase, [string]$cwd, [string]$image,
    [string[]]$argv, [int[]]$accepted) {
    Invoke-Bounded $phase $cwd $image $argv $accepted 120000 'Exited' 65536 32768
}
function Canary-Lines([string]$path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    Require ($bytes.Length -le 8192) 'Canary byte bound exceeded'
    if ($bytes.Length -eq 0) { return @() }
    @(([Text.Encoding]::UTF8.GetString($bytes).TrimEnd("`r", "`n")) -split "`r?`n")
}
function Assert-Cleanup([string]$root, [string]$parent, [string]$nonce) {
    $parentFull = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
    Require ([IO.Path]::GetDirectoryName($rootFull) -ieq $parentFull) 'Cleanup root not direct child of fixture tmp'
    Require ($rootFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Cleanup root escaped fixture tmp'
    foreach ($path in @($parentFull, $rootFull)) {
        $item = Get-Item -LiteralPath $path -Force
        Require ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Cleanup parent/root redirected'
        Require ((Resolve-Path -LiteralPath $path).Path -ieq $path) 'Cleanup path resolved elsewhere'
    }
    Require (([IO.File]::ReadAllText((Join-Path $rootFull '.fixture-marker')).Trim()) -ceq $nonce) 'Fixture marker mismatch'
    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($rootFull)
    while ($stack.Count -gt 0) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $stack.Pop() -Force)) {
            Require (-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Cleanup descendant redirected'
            Require ($entry.FullName.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Cleanup descendant escaped root'
            if ($entry.PSIsContainer) { $stack.Push($entry.FullName) }
        }
    }
}
function Copy-BuildSources([string]$root, [string]$repo) {
    $copyRoot = Join-Path $root 'source-copy'
    $files = @((Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cs').FullName) +
        @((Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.Git.csproj'),
          (Join-Path $repo 'installers\windows-coordinator\v2\GraphV2.cs'))
    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($repo, $file)
        Require (-not $relative.StartsWith('..')) 'Build source outside repository'
        $target = Join-Path $copyRoot $relative
        [void](New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force)
        Copy-Item -LiteralPath $file -Destination $target -ErrorAction Stop
        Require ((Sha $file) -ceq (Sha $target)) "Build source copy changed: $relative"
    }
    Join-Path $copyRoot 'services\windows-coordinator-git\LexRunner.WindowsCoordinator.Git.csproj'
}
function Read-SourceBuildSnapshot {
    $snapshot = [ordered]@{}
    $sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
    foreach ($leaf in @('bin', 'obj')) {
        $target = [IO.Path]::GetFullPath((Join-Path $sourceRoot $leaf)).TrimEnd('\')
        Require ([IO.Path]::GetDirectoryName($target) -ieq $sourceRoot) 'Source build root escaped project'
        if (-not (Test-Path -LiteralPath $target)) {
            $snapshot[$leaf] = [ordered]@{ exists = $false }
            continue
        }
        $item = Get-Item -LiteralPath $target -Force
        Require ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) "Source build root occupied or redirected: $leaf"
        Require ((Resolve-Path -LiteralPath $target).Path -ieq $target) "Source build root resolved elsewhere: $leaf"
        $stack = [Collections.Generic.Stack[string]]::new()
        $stack.Push($target)
        $files = [Collections.Generic.List[string]]::new()
        $directoryCount = 1
        while ($stack.Count -gt 0) {
            foreach ($entry in @(Get-ChildItem -LiteralPath $stack.Pop() -Force)) {
                Require (-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) "Source build descendant redirected: $leaf"
                Require ($entry.FullName.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) "Source build descendant escaped: $leaf"
                if ($entry.PSIsContainer) {
                    $directoryCount++
                    $stack.Push($entry.FullName)
                } else { [void]$files.Add($entry.FullName) }
            }
        }
        $first = @($files | Sort-Object -CaseSensitive | Select-Object -First 1)
        $sentinel = if ($first.Count -eq 1) {
            [ordered]@{
                path = [IO.Path]::GetRelativePath($sourceRoot, $first[0])
                sha256 = Sha $first[0]
            }
        } else { $null }
        $snapshot[$leaf] = [ordered]@{
            exists = $true; directories = $directoryCount
            files = $files.Count; sentinel = $sentinel
        }
    }
    $snapshot
}

$git = 'C:\Program Files\Git\mingw64\bin\git.exe'
Require (Test-Path -LiteralPath $git -PathType Leaf) 'Fixed Git image missing'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$tmp = Join-Path $PSScriptRoot 'tmp'
if (-not (Test-Path -LiteralPath $tmp)) { [void](New-Item -ItemType Directory -Path $tmp) }
$nonce = [guid]::NewGuid().ToString('N')
$root = Join-Path $tmp "import-$nonce"
Require (-not (Test-Path -LiteralPath $root)) 'Fixture root occupied'
$commands = [Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$result = 'failed'; $errorText = $null; $cleaned = $false
$import = $null; $negative = $null; $canceledBeforeCreate = $null; $canceledBeforeResume = $null
$stageOutcome = $null; $occupiedStageOutcome = $null; $publishedCleaned = $false
$publishOutcome = $null; $occupiedPublish = $null; $junctionPublish = $null
$canceledPublish = $null
$positive = @(); $safe = @(); $pin = $null; $bundleSha = $null
$normalImageSha = $null; $fixtureImageSha = $null
$harnessProbes = @(); $repoHead = $null
$sourceBuildBefore = $null; $sourceBuildAfter = $null; $sourceBuildUnchanged = $false
$trustedWindowsRoot = $null; $trustedSystemDirectory = $null; $poisonedSystemRoot = $null
$source = Join-Path $root 'source'
$bundle = Join-Path $root 'source.bundle'
$mirror = Join-Path $root 'mirror.git'
$stage = Join-Path $root 'stage-created'
$occupiedStage = Join-Path $root 'stage-occupied'
$finalParent = Join-Path $root 'final-parent'
$finalLeaf = 'published'
$final = Join-Path $finalParent $finalLeaf
$occupiedFinal = Join-Path $finalParent 'occupied'
$junctionFinal = Join-Path $finalParent 'junction'
$outside = Join-Path $root 'outside-canary'
$outsideMarker = Join-Path $outside 'owned-marker'
$control = Join-Path $root 'poison-control.git'
$hooks = Join-Path $root 'source-hooks'
$emptyHooks = Join-Path $root 'empty-hooks'
$template = Join-Path $root 'empty-template'
$homeDir = Join-Path $root 'home'
$tempDir = Join-Path $root 'temp'
$canary = Join-Path $root 'canary.txt'
$artifactRoot = Join-Path $repo 'artifacts\windows-coordinator-git-source'
if (-not (Test-Path -LiteralPath $artifactRoot)) {
    [void](New-Item -ItemType Directory -Path $artifactRoot -ErrorAction Stop)
}
$receiptPath = Join-Path $artifactRoot "receipt-$nonce.json"

try {
    $sourceBuildBefore = Read-SourceBuildSnapshot
    [void](New-Item -ItemType Directory -Path $root)
    Write-Lf (Join-Path $root '.fixture-marker') "$nonce`n"
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $noisyExit = Invoke-Bounded 'harness-noisy-exit-zero' $repo $node @(
        '-e', "process.stdout.write('x'.repeat(70000))") `
        @(0) 5000 'OutputOverflow' 69999 1024
    Require ($noisyExit.exitCode -eq 0 -and $noisyExit.totalOutputBytes -eq 70000 -and
        $noisyExit.stdout.Length -le 1024) 'Exited-zero noisy child escaped overflow'
    $harnessProbes += 'noisy-exit-zero-overflow'
    $noisyLive = Invoke-Bounded 'harness-noisy-live' $repo $node @(
        '-e', "setInterval(() => process.stdout.write('x'.repeat(4096)), 0)") `
        @(0) 5000 'OutputOverflow' 2048 1024
    Require ($noisyLive.stdout.Length -le 1024) 'Live noisy child escaped capture cap'
    $harnessProbes += 'noisy-live-overflow'
    $idle = Invoke-Bounded 'harness-idle' $repo $node @(
        '-e', 'setTimeout(() => {}, 30000)') `
        @(0) 500 'TimedOut' 2048 1024
    Require ($idle.totalOutputBytes -eq 0) 'Idle child unexpectedly wrote output'
    $harnessProbes += 'idle-timeout'
    foreach ($path in @($hooks, $emptyHooks, $template, $homeDir, $tempDir,
        $finalParent, $outside)) {
        [void](New-Item -ItemType Directory -Path $path)
    }
    Write-Lf $outsideMarker "outside-$nonce`n"
    Write-Lf $canary ''
    $null = Invoke-SetupGit 'source-init' $root @('init', '--initial-branch=main', $source)
    Write-Lf (Join-Path $source '.gitattributes') "tracked.txt filter=probe diff=probe`n"
    Write-Lf (Join-Path $source 'tracked.txt') "bundle bytes`n"
    $null = Invoke-SetupGit 'source-add' $source @('add', '--', '.gitattributes', 'tracked.txt')
    $null = Invoke-SetupGit 'source-commit' $source @('-c', 'commit.gpgsign=false', '-c', 'user.name=LexRunner Fixture', '-c', 'user.email=fixture@invalid.example', 'commit', '-m', 'fixture')
    $pin = (Invoke-SetupGit 'source-head' $source @('rev-parse', 'HEAD')).Trim()
    Require ($pin -match '^[0-9a-f]{40}$') 'Source pin malformed'
    $canaryPosix = To-Msys $canary
    $hookPath = Join-Path $hooks 'reference-transaction'
    Write-Lf $hookPath ((@('#!/bin/sh', "printf 'reference-transaction:%s\n' `"`$1`" >> '$canaryPosix'", 'exit 0') -join "`n") + "`n")
    $fsmonitorPath = Join-Path $hooks 'fsmonitor'
    Write-Lf $fsmonitorPath ((@('#!/bin/sh', "printf 'fsmonitor:%s\n' `"`$1`" >> '$canaryPosix'", "printf 'token\000/\000'", 'exit 0') -join "`n") + "`n")
    $filterPath = Join-Path $hooks 'filter-clean'
    Write-Lf $filterPath ((@('#!/bin/sh', "printf 'filter-clean\n' >> '$canaryPosix'", 'cat') -join "`n") + "`n")
    $sourceConfig = Join-Path $source '.git\config'
    $hostile = @('', '[core]', "    hooksPath = $($hooks.Replace('\','/'))",
        ('    fsmonitor = sh ' + (To-Msys $fsmonitorPath)),
        '[filter "probe"]', ('    clean = sh ' + (To-Msys $filterPath)),
        '    required = true', '') -join "`n"
    Write-Lf $sourceConfig ([IO.File]::ReadAllText($sourceConfig) + $hostile)
    Write-Lf (Join-Path $source '.git\info\attributes') "tracked.txt filter=probe diff=probe`n"
    $filter = Invoke-SetupGit 'source-filter-readback' $source @('config', '--local', '--get', 'filter.probe.clean')
    Require ($filter.Contains('filter-clean')) 'Source filter command did not resolve'
    $attributes = Invoke-SetupGit 'source-info-attributes-readback' $source @('check-attr', 'filter', '--', 'tracked.txt')
    Require ($attributes.Contains('filter: probe')) 'Source info attributes did not resolve'
    $null = Invoke-SetupGit 'source-filter-positive' $source @('add', '--renormalize', '--', 'tracked.txt')
    Require (@(Canary-Lines $canary | Where-Object { $_ -ceq 'filter-clean' }).Count -gt 0) 'Source filter canary did not execute'
    $null = Invoke-SetupGit 'source-index-flag' $source @('update-index', '--assume-unchanged', '--', 'tracked.txt')
    $index = Invoke-SetupGit 'source-index-readback' $source @('ls-files', '-v', '--', 'tracked.txt')
    Require ($index.StartsWith('h tracked.txt')) 'Hostile source index flag missing'
    $null = Invoke-SetupGit 'source-positive-status' $source @('status', '--porcelain=v1', '-z', '--untracked-files=all')
    Require (@(Canary-Lines $canary).Count -gt 0) 'Source canary did not execute'
    $null = Invoke-SetupGit 'bundle-create' $source @('bundle', 'create', $bundle, 'refs/heads/main')
    $bundleSha = Sha $bundle
    $null = Invoke-SetupGit 'control-init' $root @('init', '--bare', '--initial-branch=main', $control)
    Write-Lf $canary ''
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'core.hooksPath'
    $env:GIT_CONFIG_VALUE_0 = $hooks.Replace('\', '/')
    try {
        $null = Invoke-SetupGit 'ambient-poison-positive' $control @('fetch', '--no-tags', '--no-write-fetch-head', $bundle, 'refs/heads/main:refs/heads/control')
        $positive = @(Canary-Lines $canary)
        Require ($positive.Count -gt 0) 'Ambient poisoned control did not execute hook'
        Write-Lf $canary ''
        $project = Copy-BuildSources $root $repo
        $dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
        $normalPublish = Join-Path $root 'normal-publish'
        $null = Invoke-Bounded 'normal-native-publish' $repo $dotnet @('publish', $project,
            '-c', 'Release', '-r', 'win-x64', '-p:NuGetAudit=false',
            '-p:GitImportFixture=false', '-o', $normalPublish, '-v:q') @(0) 600000
        $normalImage = Join-Path $normalPublish 'LexRunner.WindowsCoordinator.Git.exe'
        Require (Test-Path -LiteralPath $normalImage -PathType Leaf) 'Normal native image missing'
        $normalImageSha = Sha $normalImage
        $normalRefusal = Invoke-Bounded 'normal-image-fixture-refusal' $repo $normalImage @(
            '--fixture-import', $root, $bundle, $mirror, $emptyHooks, $template, $homeDir,
            $tempDir, $pin, $bundleSha) @(2) 120000
        Require ($normalRefusal.stderr.Trim() -ceq 'no_production_git_entrypoint') 'Normal native image exposed fixture import'
        Require (-not (Test-Path -LiteralPath $mirror)) 'Normal native refusal changed mirror slot'
        $normalStageRefusal = Invoke-Bounded 'normal-image-stage-refusal' $repo $normalImage @(
            '--fixture-stage', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $stage) @(2) 120000
        Require ($normalStageRefusal.stderr.Trim() -ceq 'no_production_git_entrypoint') 'Normal native image exposed fixture stage'
        Require (-not (Test-Path -LiteralPath $stage)) 'Normal native stage refusal changed target'
        $normalPublishRefusal = Invoke-Bounded 'normal-image-publish-refusal' $repo $normalImage @(
            '--fixture-publish', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $stage, $finalParent, $finalLeaf) @(2) 120000
        Require ($normalPublishRefusal.stderr.Trim() -ceq 'no_production_git_entrypoint') 'Normal native image exposed fixture publish'
        Require (-not (Test-Path -LiteralPath $final)) 'Normal native publish refusal changed target'
        $fixturePublish = Join-Path $root 'fixture-publish'
        $null = Invoke-Bounded 'fixture-native-publish' $repo $dotnet @('publish', $project,
            '-c', 'Release', '-r', 'win-x64', '-p:NuGetAudit=false',
            '-p:GitImportFixture=true', '-o', $fixturePublish, '-v:q') @(0) 600000
        $image = Join-Path $fixturePublish 'LexRunner.WindowsCoordinator.Git.exe'
        Require (Test-Path -LiteralPath $image -PathType Leaf) 'Fixture native image missing'
        $fixtureImageSha = Sha $image
        $trustedWindowsRoot = Trusted-OsDirectory 'windows'
        $trustedSystemDirectory = Trusted-OsDirectory 'system'
        $poisonedSystemRoot = Join-Path $root 'poisoned-system-root'
        Require ($poisonedSystemRoot -cne $trustedWindowsRoot) 'Poison equals OS root'
        $previousSystemRoot = $env:SystemRoot
        $env:SystemRoot = $poisonedSystemRoot
        try {
        $child = Invoke-FixtureJson 'fixture-import-poisoned-systemroot' $repo $image @(
            '--fixture-import', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha) @(0)
        $import = $child.stdout.Trim() | ConvertFrom-Json -Depth 20
        Require ($import.Imported -and $import.ImportedCommit -ceq $pin) 'Imported HEAD did not match pin'
        Require ($import.UnknownEffects -and $import.Disposition -ceq 'fixture_imported_host_custody_unproven') 'Fixture success incorrectly claimed protected host custody'
        Require ($import.Commands.Count -eq 5) 'Import command count changed'
        Require (@($import.Commands | Where-Object {
            $_.ExitCode -ne 0 -or $_.TimedOut -or $_.Canceled -or $_.OutputExceeded -or
            -not $_.StreamsCompleted -or -not $_.JobAssignedAtCreation -or
            -not $_.ChildResumed -or
            -not $_.TerminalJobDrained -or -not $_.DescendantCleanupProven -or
            $_.HeldImageSha256 -cne (Sha $git) -or $null -ne $_.Error
        }).Count -eq 0) 'Import Job-bound child did not close terminally'
        Require (@($import.Commands | Where-Object { $_.JobTotalProcesses -ge 2 }).Count -gt 0) 'No Git child tree was observed in the Job'
        $expectedComSpec = Join-Path $trustedSystemDirectory 'cmd.exe'
        $expectedPath = 'C:\Program Files\Git\mingw64\bin;' + $trustedSystemDirectory + ';' + $trustedWindowsRoot
        $expectedExecPath = 'C:\Program Files\Git\mingw64\libexec\git-core'
        $expectedPathSha = Sha-Text $expectedPath
        Require (@($import.Commands | Where-Object {
            $_.ConfiguredSystemRoot -cne $trustedWindowsRoot -or
            $_.ConfiguredWindir -cne $trustedWindowsRoot -or
            $_.ConfiguredComSpec -cne $expectedComSpec -or
            $_.ConfiguredPathSha256 -cne $expectedPathSha -or
            $_.ConfiguredGitExecPath -cne $expectedExecPath
        }).Count -eq 0) 'Poisoned SystemRoot entered constructed launch environment'
        $safe = @(Canary-Lines $canary)
        Require ($safe.Count -eq 0) 'Safe import executed poisoned canary'
        Require (-not (Test-Path -LiteralPath (Join-Path $mirror 'index'))) 'Mirror inherited source index'
        Require (-not (Test-Path -LiteralPath (Join-Path $mirror 'info\attributes'))) 'Mirror inherited info attributes'
        Require (-not (Test-Path -LiteralPath (Join-Path $mirror 'FETCH_HEAD'))) 'Mirror wrote FETCH_HEAD'
        Require (-not ([IO.File]::ReadAllText((Join-Path $mirror 'config')).Contains('filter'))) 'Mirror inherited filter config'
        [void](New-Item -ItemType Directory -Path $occupiedStage)
        Write-Lf (Join-Path $occupiedStage 'owned-marker') "occupied-$nonce`n"
        $occupied = Invoke-FixtureJson 'fixture-stage-occupied' $repo $image @(
            '--fixture-stage', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $occupiedStage) @(1)
        $occupiedStageOutcome = $occupied.stdout.Trim() | ConvertFrom-Json -Depth 20
        Require (-not $occupiedStageOutcome.Staged -and -not $occupiedStageOutcome.StageMayExist -and
            $occupiedStageOutcome.UnknownEffects -and $occupiedStageOutcome.Commands.Count -eq 0 -and
            $occupiedStageOutcome.Disposition -ceq 'refused_before_stage_effect') 'Occupied stage disposition incorrect'
        Require (([IO.File]::ReadAllText((Join-Path $occupiedStage 'owned-marker')).Trim()) -ceq "occupied-$nonce") 'Occupied stage marker changed'
        $staged = Invoke-FixtureJson 'fixture-stage-job-bound' $repo $image @(
            '--fixture-stage', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $stage) @(0)
        $stageOutcome = $staged.stdout.Trim() | ConvertFrom-Json -Depth 20
        Require ($stageOutcome.Staged -and $stageOutcome.StageMayExist -and
            $stageOutcome.UnknownEffects -and $stageOutcome.StageHead -ceq $pin -and
            $stageOutcome.Disposition -ceq 'fixture_staged_host_custody_unproven' -and
            $stageOutcome.Commands.Count -eq 5) 'Stage did not preserve source-only disposition'
        Require (@($stageOutcome.Commands | Where-Object {
            $_.ExitCode -ne 0 -or $_.TimedOut -or $_.Canceled -or $_.OutputExceeded -or
            -not $_.StreamsCompleted -or -not $_.JobAssignedAtCreation -or
            -not $_.ChildResumed -or -not $_.TerminalJobDrained -or
            -not $_.DescendantCleanupProven -or $_.HeldImageSha256 -cne (Sha $git) -or
            $null -ne $_.Error
        }).Count -eq 0) 'Stage Git commands lacked terminal Job custody'
        Require (@(Canary-Lines $canary).Count -eq 0) 'Stage executed hostile source canary'
        Require (Test-Path -LiteralPath (Join-Path $stage '.git') -PathType Leaf) 'Stage Git pointer missing'
        $canceled = Invoke-FixtureJson 'fixture-publish-canceled-before-effect' $repo $image @(
            '--fixture-publish-canceled', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $stage, $finalParent, $finalLeaf) @(1)
        $canceledPublish = $canceled.stdout.Trim() | ConvertFrom-Json -Depth 20
        Require (-not $canceledPublish.Published -and $canceledPublish.UnknownEffects -and
            $null -eq $canceledPublish.Move -and $canceledPublish.Commands.Count -eq 0 -and
            (Test-Path -LiteralPath $stage) -and -not (Test-Path -LiteralPath $final)) 'Canceled publish ran an effect'
        [void](New-Item -ItemType Directory -Path $occupiedFinal)
        Write-Lf (Join-Path $occupiedFinal 'owned-marker') "occupied-final-$nonce`n"
        $occupied = Invoke-FixtureJson 'fixture-publish-occupied' $repo $image @(
            '--fixture-publish', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $stage, $finalParent, 'occupied') @(1)
        $occupiedPublish = $occupied.stdout.Trim() | ConvertFrom-Json -Depth 20
        Require (-not $occupiedPublish.Published -and $occupiedPublish.UnknownEffects -and
            $null -eq $occupiedPublish.Move -and $occupiedPublish.Commands.Count -eq 0) 'Occupied final attempted native move'
        Require (([IO.File]::ReadAllText((Join-Path $occupiedFinal 'owned-marker')).Trim()) -ceq "occupied-final-$nonce") 'Occupied final marker changed'
        [void](New-Item -ItemType Junction -Path $junctionFinal -Target $outside)
        Require ((Get-Item -LiteralPath $junctionFinal -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'Junction negative not a reparse point'
        $junction = Invoke-FixtureJson 'fixture-publish-junction' $repo $image @(
            '--fixture-publish', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $stage, $finalParent, 'junction') @(1)
        $junctionPublish = $junction.stdout.Trim() | ConvertFrom-Json -Depth 20
        Require (-not $junctionPublish.Published -and $junctionPublish.UnknownEffects -and
            $null -eq $junctionPublish.Move -and $junctionPublish.Commands.Count -eq 0) 'Junction final attempted native move'
        Require (([IO.File]::ReadAllText($outsideMarker).Trim()) -ceq "outside-$nonce") 'Junction target marker changed'
        Remove-Item -LiteralPath $junctionFinal -Force -ErrorAction Stop
        Require (-not (Test-Path -LiteralPath $junctionFinal)) 'Fixture junction remains'
        Require (([IO.File]::ReadAllText($outsideMarker).Trim()) -ceq "outside-$nonce") 'Junction cleanup changed target'
        $published = Invoke-FixtureJson 'fixture-publish-native-repair' $repo $image @(
            '--fixture-publish', $root, $bundle, $mirror, $emptyHooks, $template,
            $homeDir, $tempDir, $pin, $bundleSha, $stage, $finalParent, $finalLeaf) @(0)
        $publishOutcome = $published.stdout.Trim() | ConvertFrom-Json -Depth 30
        Require ($publishOutcome.Published -and $publishOutcome.UnknownEffects -and
            $publishOutcome.FinalHead -ceq $pin -and $publishOutcome.Move.MoveAttempted -and
            $publishOutcome.Move.Moved -and $publishOutcome.Move.Win32Code -eq 0 -and
            $publishOutcome.Move.NtStatus -ceq '0x00000000' -and
            $publishOutcome.Move.SourceBefore -ieq ('\\?\' + $stage) -and
            $publishOutcome.Move.SourceParentPathBefore -ieq ('\\?\' + $root) -and
            $publishOutcome.Move.FinalParentPathBefore -ieq ('\\?\' + $finalParent) -and
            $publishOutcome.Move.SourceAfter -ieq ('\\?\' + $final) -and
            $publishOutcome.Move.SourceIdentityBefore -ceq $publishOutcome.Move.SourceIdentityAfter -and
            $publishOutcome.Move.SourceIdentityBefore -ceq $publishOutcome.Move.FinalFreshIdentity -and
            $publishOutcome.Move.SourceParentIdentityBefore -ceq $publishOutcome.Move.SourceParentIdentityAfter -and
            $publishOutcome.Move.FinalParentIdentityBefore -ceq $publishOutcome.Move.FinalParentIdentityAfter -and
            $publishOutcome.Move.SourceIdentityBefore -ceq $publishOutcome.Move.SourceIdentityAfterRepair -and
            $publishOutcome.Move.SourceParentIdentityBefore -ceq $publishOutcome.Move.SourceParentIdentityAfterRepair -and
            $publishOutcome.Move.FinalParentIdentityBefore -ceq $publishOutcome.Move.FinalParentIdentityAfterRepair -and
            $publishOutcome.Move.SourceIdentityBefore -ceq $publishOutcome.Move.FinalFreshIdentityAfterRepair -and
            $publishOutcome.Commands.Count -eq 5) 'Native move identity or repair disposition incorrect'
        foreach ($identity in @(
            $publishOutcome.Move.SourceIdentityBefore,
            $publishOutcome.Move.SourceIdentityAfter,
            $publishOutcome.Move.SourceParentIdentityBefore,
            $publishOutcome.Move.SourceParentIdentityAfter,
            $publishOutcome.Move.FinalParentIdentityBefore,
            $publishOutcome.Move.FinalParentIdentityAfter,
            $publishOutcome.Move.FinalFreshIdentity,
            $publishOutcome.Move.SourceIdentityAfterRepair,
            $publishOutcome.Move.SourceParentIdentityAfterRepair,
            $publishOutcome.Move.FinalParentIdentityAfterRepair,
            $publishOutcome.Move.FinalFreshIdentityAfterRepair)) {
            Require ($identity -cmatch '^0x[0-9a-f]{16}:[0-9a-f]{32}$') 'Native identity is not full FILE_ID_INFO/volume serial'
        }
        Require (@($publishOutcome.Commands | Where-Object {
            $_.ExitCode -ne 0 -or $_.TimedOut -or $_.Canceled -or $_.OutputExceeded -or
            -not $_.StreamsCompleted -or -not $_.JobAssignedAtCreation -or
            -not $_.ChildResumed -or -not $_.TerminalJobDrained -or
            -not $_.DescendantCleanupProven -or $_.HeldImageSha256 -cne (Sha $git) -or
            $null -ne $_.Error
        }).Count -eq 0) 'Publish Git commands lacked terminal Job custody'
        Require ((Test-Path -LiteralPath (Join-Path $final '.git') -PathType Leaf) -and
            -not (Test-Path -LiteralPath $stage)) 'Published entry or old stage path wrong'
        Require (@(Canary-Lines $canary).Count -eq 0) 'Publish executed hostile source canary'
        $boundedRecords = @($import.Commands) + @($stageOutcome.Commands) + @($publishOutcome.Commands)
        Require ($boundedRecords.Count -eq 15) 'Bounded Git command count changed'
        $expectedStaticNames = @('git.exe', 'libiconv-2.dll', 'libintl-8.dll',
            'libpcre2-8-0.dll', 'libwinpthread-1.dll', 'zlib1.dll')
        foreach ($record in $boundedRecords) {
            Require ($record.StaticImports.Pinned -and
                $record.StaticImports.Scope -ceq 'offline_static_pe_imports_only' -and
                $record.StaticImports.Files.Count -eq $expectedStaticNames.Count) 'Static Git import pin missing'
            for ($i = 0; $i -lt $expectedStaticNames.Count; $i++) {
                $fixedPath = Join-Path 'C:\Program Files\Git\mingw64\bin' $expectedStaticNames[$i]
                Require ($record.StaticImports.Files[$i].Path -ceq $fixedPath -and
                    $record.StaticImports.Files[$i].Sha256 -ceq (Sha $fixedPath) -and
                    $record.StaticImports.Files[$i].ImportedDlls.Count -gt 0) 'Static Git file pin or imports changed'
            }
            $observed = @($record.ObservedJobProcesses)
            $rootProcess = @($observed | Where-Object { $_.ProcessId -eq $record.RootProcessId })
            Require ($record.RootProcessId -gt 0 -and $rootProcess.Count -eq 1 -and
                $rootProcess[0].ImageNativePath.EndsWith('\Program Files\Git\mingw64\bin\git.exe',
                    [StringComparison]::OrdinalIgnoreCase) -and
                $observed.Count -ge 1 -and $observed.Count -le $record.JobTotalProcesses) 'Job root process was not observed'
        }
        $fetch = @($import.Commands | Where-Object Phase -eq 'mirror-fetch')
        Require ($fetch.Count -eq 1) 'Mirror fetch record missing'
        $helperChildren = @($fetch[0].ObservedJobProcesses | Where-Object {
            $_.ParentProcessId -eq $fetch[0].RootProcessId -and
            $_.ImageNativePath.EndsWith('\Program Files\Git\mingw64\libexec\git-core\git.exe',
                [StringComparison]::OrdinalIgnoreCase)
        })
        Require ($helperChildren.Count -ge 1) 'Job did not observe the Git libexec child image'
        foreach ($case in @(
            [pscustomobject]@{ name = 'before-create'; route = '--fixture-canceled-before-create'; mirror = (Join-Path $root 'canceled-before-create.git') },
            [pscustomobject]@{ name = 'before-resume'; route = '--fixture-canceled-before-resume'; mirror = (Join-Path $root 'canceled-before-resume.git') }
        )) {
            $canceled = Invoke-FixtureJson "fixture-canceled-$($case.name)" $repo $image @(
                $case.route, $root, $bundle, $case.mirror, $emptyHooks, $template,
                $homeDir, $tempDir, $pin, $bundleSha) @(0)
            $canceledRecord = $canceled.stdout.Trim() | ConvertFrom-Json -Depth 20
            Require ($canceledRecord.Canceled -and -not $canceledRecord.TimedOut -and
                -not $canceledRecord.ChildResumed -and
                $null -eq $canceledRecord.ExitCode -and
                $canceledRecord.HeldImageSha256 -ceq (Sha $git) -and
                $canceledRecord.Error.Contains("git_child_canceled_$($case.name.Replace('-', '_'))")) "Cancellation boundary record invalid: $($case.name)"
            Require (-not (Test-Path -LiteralPath $case.mirror)) "Canceled child changed mirror slot: $($case.name)"
            Require (@(Canary-Lines $canary).Count -eq 0) "Canceled child executed poisoned canary: $($case.name)"
            if ($case.name -ceq 'before-create') {
                Require (-not $canceledRecord.JobAssignedAtCreation -and
                    -not $canceledRecord.ProcessExited -and
                    $canceledRecord.JobTotalProcesses -eq 0) 'Canceled pre-create child was created'
                $canceledBeforeCreate = $canceledRecord
            }
            else {
                Require ($canceledRecord.JobAssignedAtCreation -and
                    $canceledRecord.TerminalJobDrained -and
                    $canceledRecord.DescendantCleanupProven -and
                    $canceledRecord.ProcessExited -and
                    $canceledRecord.JobTotalProcesses -ge 1) 'Canceled suspended child did not drain'
                $canceledBeforeResume = $canceledRecord
            }
        }
        $wrongMirror = Join-Path $root 'wrong-pin.git'
        $wrongPin = ('0' + $pin.Substring(1))
        if ($wrongPin -ceq $pin) { $wrongPin = '1' + $pin.Substring(1) }
        $wrong = Invoke-FixtureJson 'fixture-wrong-pin-poisoned-systemroot' $repo $image @(
            '--fixture-import', $root, $bundle, $wrongMirror, $emptyHooks, $template,
            $homeDir, $tempDir, $wrongPin, $bundleSha) @(1)
        $negative = $wrong.stdout.Trim() | ConvertFrom-Json -Depth 20
        Require (-not $negative.Imported -and $negative.UnknownEffects -and
            $negative.MirrorMayExist -and $negative.Disposition -ceq 'preserve_unknown_effects') 'Wrong pin failure did not preserve uncertainty'
        Require (Test-Path -LiteralPath $wrongMirror -PathType Container) 'Wrong pin mirror was not retained'
        Require (@(Canary-Lines $canary).Count -eq 0) 'Wrong pin path executed canary'
        $inventory = Invoke-SetupGit 'fixture-publish-cleanup-inventory' $mirror @('worktree', 'list', '--porcelain')
        Require ($inventory.Replace('/', '\').Contains($final) -and
            -not $inventory.Replace('/', '\').Contains($stage)) 'Final registration missing before fixture cleanup'
        Require (-not ((Get-Item -LiteralPath $final -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Final redirected before fixture cleanup'
        Require (-not ((Get-Item -LiteralPath (Join-Path $final '.git') -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Final Git entry redirected before fixture cleanup'
        Require (([IO.File]::ReadAllText((Join-Path $root '.fixture-marker')).Trim()) -ceq $nonce) 'Fixture marker changed before final cleanup'
        Require (([IO.File]::ReadAllText($outsideMarker).Trim()) -ceq "outside-$nonce") 'Outside marker changed before cleanup'
        $finalMembers = @(Get-ChildItem -LiteralPath $final -Force)
        Require ($finalMembers.Count -eq 1 -and $finalMembers[0].Name -ceq '.git') 'Published fixture contains content; retain it'
        # --no-checkout leaves every tracked file absent, so Git requires force
        # even for this exact empty disposable fixture. Never use this for a
        # worker or production worktree.
        $null = Invoke-SetupGit 'fixture-final-remove' $mirror @('-c',
            "core.hooksPath=$($emptyHooks.Replace('\','/'))", '-c', 'core.fsmonitor=false',
            'worktree', 'remove', '--force', $final)
        Require (-not (Test-Path -LiteralPath $final)) 'Removed fixture final remains'
        Require (@(Canary-Lines $canary).Count -eq 0) 'Fixture stage cleanup executed canary'
        $publishedCleaned = $true
        }
        finally {
            if ($null -eq $previousSystemRoot) {
                Remove-Item Env:SystemRoot -ErrorAction SilentlyContinue
            }
            else { $env:SystemRoot = $previousSystemRoot }
        }
    }
    finally {
        Remove-Item Env:GIT_CONFIG_COUNT,Env:GIT_CONFIG_KEY_0,Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue
    }
    Assert-Cleanup $root $tmp $nonce
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    Require (-not (Test-Path -LiteralPath $root)) 'Checked fixture root remains'
    $cleaned = $true
    $result = 'source_fixture_pass'
}
catch { $errorText = $_.Exception.Message }
finally {
    try {
        $sourceBuildAfter = Read-SourceBuildSnapshot
        $sourceBuildUnchanged = $null -ne $sourceBuildBefore -and
            (($sourceBuildBefore | ConvertTo-Json -Depth 6 -Compress) -ceq
             ($sourceBuildAfter | ConvertTo-Json -Depth 6 -Compress))
        Require $sourceBuildUnchanged 'Preexisting source bin/obj snapshot changed'
    }
    catch {
        $result = 'failed'
        if (-not $errorText) { $errorText = "source_build_preservation_failed: $($_.Exception.Message)" }
    }
    $hashes = [ordered]@{}
    foreach ($file in @((Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cs').Name) +
        @('LexRunner.WindowsCoordinator.Git.csproj', 'verify.ps1', '.gitignore', 'README.md')) {
        $path = Join-Path $PSScriptRoot $file
        if (Test-Path -LiteralPath $path) { $hashes[$file] = Sha $path }
    }
    try {
        $hashes['../../installers/windows-coordinator/v2/GraphV2.cs'] =
            Sha (Join-Path $repo 'installers\windows-coordinator\v2\GraphV2.cs')
    }
    catch {
        $result = 'failed'
        $errorText = "source_hash_failed: $($_.Exception.Message)"
    }
    try {
        $repoHead = Invoke-SetupGit 'repo-head-readback' $repo @('rev-parse', 'HEAD')
    }
    catch {
        $result = 'failed'
        $errorText = "repo_head_readback_failed: $($_.Exception.Message)"
    }
    $clock.Stop()
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-git-source/1'; result = $result
        error = $errorText; cwd = $PSScriptRoot
        repoHead = $repoHead
        startedAt = $startedAt; durationMs = $clock.ElapsedMilliseconds
        filesystem = (Get-Volume -DriveLetter D).FileSystemType.ToString()
        fixtureRoot = $root; fixtureRemoved = $cleaned
        fixedGitImage = $git; fixedGitSha256 = Sha $git
        normalNativeImageSha256 = $normalImageSha
        fixtureImageSha256 = $fixtureImageSha
        osApiWindowsRoot = $trustedWindowsRoot
        osApiSystemDirectory = $trustedSystemDirectory
        poisonedParentSystemRoot = $poisonedSystemRoot
        pinnedCommit = $pin; bundleSha256 = $bundleSha
        poisonedCanary = $positive; safeCanary = $safe
        import = $import; wrongPin = $negative
        stage = $stageOutcome; occupiedStage = $occupiedStageOutcome
        publishedCleaned = $publishedCleaned
        publish = $publishOutcome; occupiedPublish = $occupiedPublish
        junctionPublish = $junctionPublish; canceledPublish = $canceledPublish
        canceledBeforeCreate = $canceledBeforeCreate
        canceledBeforeResume = $canceledBeforeResume
        commands = @($commands); harnessProbes = $harnessProbes
        buildIsolation = 'nonce_owned_source_copy; only checked fixture root is deleted'
        sourceBuildBefore = $sourceBuildBefore
        sourceBuildAfter = $sourceBuildAfter
        sourceBuildUnchanged = $sourceBuildUnchanged
        sourceSha256 = $hashes; installedServiceQualified = $false
        productionGitEnabled = $false
    }
    Write-Lf $receiptPath (($receipt | ConvertTo-Json -Depth 30).Replace("`r`n", "`n") + "`n")
}
if ($result -ne 'source_fixture_pass') { throw "Git import fixture failed; retained $root; receipt $receiptPath : $errorText" }
Write-Output "Git import source fixture passed; checked cleanup; receipt $receiptPath"
