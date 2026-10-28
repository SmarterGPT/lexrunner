[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 required' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
if (-not $env:OS) { $env:OS = 'Windows_NT' }

function Require([bool]$ok, [string]$message) { if (-not $ok) { throw $message } }
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-SourceHashes([string]$repository, [string[]]$relativePaths) {
    $hashes = [ordered]@{}
    foreach ($relative in $relativePaths) {
        $full = Join-Path $repository ($relative.Replace('/', '\'))
        Require (Test-Path -LiteralPath $full -PathType Leaf) "Source input missing: $relative"
        $hashes[$relative] = Sha $full
    }
    $hashes
}
function Step([string]$phase, [string]$cwd, [string]$image, [string[]]$argv,
    [int[]]$accepted = @(0), [string]$expectedOutcome = 'Exited',
    [int]$timeoutMs = 120000, [int]$maxOutputBytes = 65536,
    [int]$captureBytesPerStream = 16384) {
    $began = [DateTimeOffset]::UtcNow.ToString('o')
    $start = [Diagnostics.ProcessStartInfo]::new($image)
    $start.WorkingDirectory = $cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $argv) { [void]$start.ArgumentList.Add($argument) }
    $run = [GraphGitVerifierProcess]::Run($start, $timeoutMs,
        $maxOutputBytes, $captureBytesPerStream)
    $record = [pscustomobject]@{
        phase = $phase; executable = $image; cwd = $cwd; argv = $argv
        startedAt = $began; durationMs = $run.DurationMs
        exitCode = $run.ExitCode; outcome = $run.Outcome.ToString()
        totalOutputBytes = $run.TotalOutputBytes
        captureTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -in @('Exited','OutputOverflow','TimedOut')
        output = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.outcome -ceq $expectedOutcome -and
        $record.directChildExitedAndStreamsDrained) "Fixture direct child or streams uncertain: $phase ($($record.outcome))"
    if ($expectedOutcome -ceq 'Exited') {
        Require (-not $record.captureTruncated -and $run.TotalOutputBytes -le $maxOutputBytes) "Fixture output exceeded capture: $phase"
        Require ($run.ExitCode -in $accepted) "Fixture command failed: $phase ($($run.ExitCode)) $($run.Stdout) $($run.Stderr)"
    }
    $record
}
function Checked-Remove([string]$root, [string]$parent, [string]$nonce) {
    $parentFull = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
    Require ([IO.Path]::GetDirectoryName($rootFull) -ieq $parentFull) 'Cleanup root not a direct child'
    Require ($rootFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Cleanup escaped root'
    Require (([IO.File]::ReadAllText((Join-Path $rootFull '.fixture-marker')).Trim()) -ceq $nonce) 'Fixture marker mismatch'
    foreach ($path in @($parentFull, $rootFull)) {
        $item = Get-Item -LiteralPath $path -Force
        Require ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Cleanup root redirected'
        Require ((Resolve-Path -LiteralPath $path).Path -ieq $path) 'Cleanup root resolved elsewhere'
    }
    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($rootFull)
    while ($stack.Count -gt 0) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $stack.Pop() -Force)) {
            Require (-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Cleanup descendant redirected'
            Require ($entry.FullName.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Cleanup descendant escaped root'
            if ($entry.PSIsContainer) { $stack.Push($entry.FullName) }
        }
    }
    Remove-Item -LiteralPath $rootFull -Recurse -Force -ErrorAction Stop
    Require (-not (Test-Path -LiteralPath $rootFull)) 'Fixture cleanup incomplete'
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$git = 'C:\Program Files\Git\mingw64\bin\git.exe'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
$project = Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.Git.csproj'
Require (Test-Path -LiteralPath $git -PathType Leaf) 'Pinned fixture Git missing'
Require (Test-Path -LiteralPath $tsx -PathType Leaf) 'Repository tsx missing'
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
    'services/windows-coordinator-git/fixture-graph.ts',
    'services/windows-coordinator-git/verify-graph.ps1',
    'services/windows-coordinator-git/GRAPH_SELECTED_GIT.md',
    'installers/windows-coordinator/v2/GraphV2.cs',
    'src/workspaces/windows-coordinator-generation-graph.ts',
    'src/workspaces/windows-boundary-protocol.ts',
    'src/workspaces/windows-removal-protocol.ts',
    'src/workspaces/windows-removal-git-environment.ts',
    'src/util/canonicalJson.ts',
    'package.json', 'package-lock.json', 'tsconfig.json'
)
$expectedCSharp = @($sourcePaths | Where-Object { $_ -like 'services/windows-coordinator-git/*.cs' } |
    ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
$actualCSharp = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cs' |
    ForEach-Object Name | Sort-Object)
Require (($expectedCSharp -join '|') -ceq ($actualCSharp -join '|')) 'Git C# source inventory changed'
$sourceHashBefore = Read-SourceHashes $repo $sourcePaths
Add-Type -Path (Join-Path $PSScriptRoot 'VerifierBoundedProcess.cs')
$tmp = Join-Path $PSScriptRoot 'tmp'
if (-not (Test-Path -LiteralPath $tmp)) { [void](New-Item -ItemType Directory -Path $tmp) }
$nonce = [guid]::NewGuid().ToString('N')
$root = Join-Path $tmp "graph-$nonce"
Require (-not (Test-Path -LiteralPath $root)) 'Fixture root occupied'
[void](New-Item -ItemType Directory -Path $root)
[IO.File]::WriteAllText((Join-Path $root '.fixture-marker'), "$nonce`n", [Text.UTF8Encoding]::new($false))
$payload = Join-Path $root 'payload'
$source = Join-Path $root 'source'
$bundle = Join-Path $root 'source.bundle'
$mirror = Join-Path $root 'mirror.git'
$hooks = Join-Path $root 'empty-hooks'
$template = Join-Path $root 'empty-template'
$homeDir = Join-Path $root 'home'
$tempDir = Join-Path $root 'temp'
$normalOut = Join-Path $root 'normal-image'
$fixtureOut = Join-Path $root 'fixture-image'
$artifact = Join-Path $repo 'artifacts\windows-coordinator-git-graph'
if (-not (Test-Path -LiteralPath $artifact)) { [void](New-Item -ItemType Directory -Path $artifact) }
$receiptPath = Join-Path $artifact "receipt-$nonce.json"
$commands = [Collections.Generic.List[object]]::new()
$began = [DateTimeOffset]::UtcNow.ToString('o')
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = 'failed'; $failure = $null; $cleaned = $false
$graph = $null; $positive = $null; $negative = @(); $pin = $null; $bundleSha = $null
$harnessProbes = @()
$normalImageSha = $null; $fixtureImageSha = $null
$repoHeadAtStart = $null; $repoHeadAtEnd = $null
try {
    $headStart = Step 'repo-head-start' $repo $git @('-C', $repo, 'rev-parse', 'HEAD') `
        @(0) 'Exited' 10000 1024 1024
    $repoHeadAtStart = $headStart.output.Trim()
    Require ($repoHeadAtStart -cmatch '^[0-9a-f]{40}$') 'Initial repository HEAD malformed'
    foreach ($path in @($hooks, $template, $homeDir, $tempDir)) {
        [void](New-Item -ItemType Directory -Path $path)
    }
    $noisyExit = Step 'harness-noisy-exit-zero' $repo $node @('-e',
        "process.stdout.write('x'.repeat(70000))") @(0) 'OutputOverflow' 5000 69999 1024
    Require ($noisyExit.exitCode -eq 0 -and $noisyExit.totalOutputBytes -eq 70000 -and
        $noisyExit.output.Length -le 1024 -and
        $noisyExit.directChildExitedAndStreamsDrained) 'Exited-zero noisy child escaped overflow'
    $harnessProbes += 'noisy-exit-zero-overflow'
    $noisyLive = Step 'harness-noisy-live' $repo $node @('-e',
        "setInterval(() => process.stdout.write('x'.repeat(4096)), 0)") @(0) 'OutputOverflow' 5000 2048 1024
    Require ($noisyLive.totalOutputBytes -gt 2048 -and
        $noisyLive.output.Length -le 1024 -and
        $noisyLive.directChildExitedAndStreamsDrained) 'Live noisy child escaped overflow'
    $harnessProbes += 'live-output-overflow'
    $idle = Step 'harness-idle-timeout' $repo $node @('-e',
        'setTimeout(() => {}, 5000)') @(0) 'TimedOut' 300 2048 1024
    Require ($idle.directChildExitedAndStreamsDrained -and $idle.durationMs -ge 300 -and
        $idle.durationMs -lt 5000) 'Idle child did not stop at deadline'
    $harnessProbes += 'idle-timeout'
    $graphStep = Step 'author-synthetic-graph' $repo $node @($tsx, (Join-Path $PSScriptRoot 'fixture-graph.ts'), $payload)
    $graph = $graphStep.output | ConvertFrom-Json
    Require ($graph.memberCount -eq 13 -and -not $graph.authorizesLaunch) 'Synthetic graph contract failed'
    $null = Step 'source-init' $root $git @('init', '--initial-branch=main', $source)
    [IO.File]::WriteAllText((Join-Path $source 'tracked.txt'), "graph fixture`n", [Text.UTF8Encoding]::new($false))
    $null = Step 'source-add' $root $git @('-C', $source, 'add', '--', 'tracked.txt')
    $null = Step 'source-commit' $root $git @('-C', $source, '-c', 'commit.gpgsign=false',
        '-c', 'user.name=LexRunner Fixture', '-c', 'user.email=fixture@invalid.example',
        'commit', '-m', 'graph fixture')
    $pin = (Step 'source-pin' $root $git @('-C', $source, 'rev-parse', 'HEAD')).output.Trim()
    Require ($pin -match '^[0-9a-f]{40}$') 'Synthetic commit pin malformed'
    $null = Step 'source-bundle' $root $git @('-C', $source, 'bundle', 'create', $bundle, 'refs/heads/main')
    $bundleSha = Sha $bundle
    $null = Step 'publish-normal-image' $repo 'dotnet.exe' @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:GitImportFixture=false', '-o', $normalOut, '-v:q')
    $null = Step 'publish-fixture-image' $repo 'dotnet.exe' @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', '-p:GitImportFixture=true', '-o', $fixtureOut, '-v:q')
    $normalImage = Join-Path $normalOut 'LexRunner.WindowsCoordinator.Git.exe'
    $fixtureImage = Join-Path $fixtureOut 'LexRunner.WindowsCoordinator.Git.exe'
    $normalImageSha = Sha $normalImage; $fixtureImageSha = Sha $fixtureImage
    $fixtureArgv = @('--fixture-graph-import', $root, $bundle, $mirror, $hooks, $template,
        $homeDir, $tempDir, $pin, $bundleSha, $payload, $graph.manifestSha256)
    $normal = Step 'normal-image-refusal' $repo $normalImage $fixtureArgv @(2)
    Require ($normal.stderr.Trim() -ceq 'no_production_git_entrypoint') 'Normal image exposed graph route'
    $normalParser = Step 'normal-parser-selftest-refusal' $repo $normalImage @('--fixture-graph-parser-selftest') @(2)
    Require ($normalParser.stderr.Trim() -ceq 'no_production_git_entrypoint') 'Normal image exposed parser fixture route'
    $parser = Step 'native-graph-parser-selftest' $repo $fixtureImage @(
        '--fixture-graph-parser-selftest', (Join-Path $payload 'generation-graph.json'), $graph.manifestSha256)
    Require ($parser.output.Trim() -ceq 'graph_parser_selftest_pass') 'Native graph parser accepted newline alias'
    $savedPath = $env:PATH; $savedExec = $env:GIT_EXEC_PATH; $savedCount = $env:GIT_CONFIG_COUNT
    try {
        $env:PATH = 'C:\intentionally-poisoned-path'
        $env:GIT_EXEC_PATH = 'C:\intentionally-poisoned-git-core'
        $env:GIT_CONFIG_COUNT = '1'
        $run = Step 'graph-import' $repo $fixtureImage $fixtureArgv
    } finally {
        $env:PATH = $savedPath; $env:GIT_EXEC_PATH = $savedExec; $env:GIT_CONFIG_COUNT = $savedCount
    }
    $positive = $run.output | ConvertFrom-Json -Depth 20
    Require ($positive.ProfileAccepted -and $positive.Import.Imported -and
        $positive.Import.UnknownEffects -and -not $positive.AuthorizesLaunch) 'Graph import not safely uncertain'
    Require ($positive.MemberCount -eq 13 -and $positive.ManifestSha256 -ceq $graph.manifestSha256) 'Graph identity readback mismatch'
    $expectedImage = Join-Path $payload 'git\mingw64\bin\git.exe'
    $expectedExec = Join-Path $payload 'git\mingw64\libexec\git-core'
    $records = @($positive.Import.Commands)
    Require ($records.Count -eq 5) 'Graph import fixed command count changed'
    foreach ($record in $records) {
        Require ($record.Executable -ceq $expectedImage -and
            $record.ConfiguredGitExecPath -ceq $expectedExec -and
            $record.HeldImageSha256 -ceq $graph.gitImageSha256 -and
            $record.JobAssignedAtCreation -and $record.TerminalJobDrained -and
            $record.DescendantCleanupProven -and $record.StreamsCompleted -and
            $record.ExitCode -eq 0) "Graph Git launch not bound/drained: $($record.Phase)"
    }
    $fetch = @($records | Where-Object Phase -eq 'mirror-fetch')
    Require ($fetch.Count -eq 1 -and $fetch[0].JobTotalProcesses -ge 2) 'Graph fetch child tree not observed'
    $selectedChild = @($fetch[0].ObservedJobProcesses | Where-Object {
        $_.ImageNativePath.EndsWith(($expectedExec + '\git.exe').Substring(2),
            [StringComparison]::OrdinalIgnoreCase)
    })
    Require ($selectedChild.Count -ge 1) 'Graph-selected libexec child path not observed'

    $wrong = @($fixtureArgv); $wrong[3] = Join-Path $root 'mirror-wrong'; $wrong[11] = '0' * 64
    $wrongResult = Step 'wrong-manifest-refusal' $repo $fixtureImage $wrong @(3)
    $wrongJson = $wrongResult.output | ConvertFrom-Json
    Require (-not $wrongJson.ProfileAccepted -and -not (Test-Path -LiteralPath $wrong[3])) 'Wrong manifest changed mirror'
    $negative += 'wrong-manifest'

    $libexec = Join-Path $expectedExec 'git.exe'
    [IO.File]::AppendAllText($libexec, 'changed')
    $changed = @($fixtureArgv); $changed[3] = Join-Path $root 'mirror-changed'
    $changedResult = Step 'changed-libexec-refusal' $repo $fixtureImage $changed @(3)
    $changedJson = $changedResult.output | ConvertFrom-Json
    Require (-not $changedJson.ProfileAccepted -and -not (Test-Path -LiteralPath $changed[3])) 'Changed libexec changed mirror'
    $negative += 'changed-libexec'

    Copy-Item -LiteralPath $git -Destination $libexec -Force
    [IO.File]::WriteAllText((Join-Path $payload 'git\mingw64\bin\unlisted.dll'), 'unlisted')
    $extra = @($fixtureArgv); $extra[3] = Join-Path $root 'mirror-extra'
    $extraResult = Step 'unlisted-member-refusal' $repo $fixtureImage $extra @(3)
    $extraJson = $extraResult.output | ConvertFrom-Json
    Require (-not $extraJson.ProfileAccepted -and -not (Test-Path -LiteralPath $extra[3])) 'Unlisted member changed mirror'
    $negative += 'unlisted-member'

    $result = 'source_fixture_pass'
    Checked-Remove $root $tmp $nonce
    $cleaned = $true
} catch { $failure = $_.Exception.Message }
finally {
    $sourceHashAfter = $null
    $sourceHashesUnchanged = $false
    try {
        $sourceHashAfter = Read-SourceHashes $repo $sourcePaths
        $sourceHashesUnchanged = $true
        foreach ($relative in $sourcePaths) {
            if ($sourceHashBefore[$relative] -cne $sourceHashAfter[$relative]) {
                $sourceHashesUnchanged = $false
                break
            }
        }
    } catch {
        if (-not $failure) { $failure = 'source_hash_recheck_failed:' + $_.Exception.Message }
    }
    try {
        $headEnd = Step 'repo-head-end' $repo $git @('-C', $repo, 'rev-parse', 'HEAD') `
            @(0) 'Exited' 10000 1024 1024
        $repoHeadAtEnd = $headEnd.output.Trim()
        Require ($repoHeadAtEnd -cmatch '^[0-9a-f]{40}$') 'Final repository HEAD malformed'
    } catch {
        $result = 'failed'
        $headFailure = 'repo_head_end_readback_failed:' + $_.Exception.Message
        if ($failure) { $failure += '; ' + $headFailure }
        else { $failure = $headFailure }
    }
    if (-not $sourceHashesUnchanged -or $repoHeadAtEnd -cne $repoHeadAtStart) {
        if (-not $failure) { $failure = 'source_or_head_changed_during_verification' }
        $result = 'failed'
    }
    $clock.Stop()
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-graph-git-source/1'; result = $result
        error = $failure; cwd = $repo; repoHead = $repoHeadAtEnd
        repoHeadAtStart = $repoHeadAtStart
        startedAt = $began; durationMs = $clock.ElapsedMilliseconds
        fixtureRoot = $root; fixtureRemoved = $cleaned
        graphDigest = $(if ($null -ne $graph) { $graph.graphDigest } else { $null })
        manifestSha256 = $(if ($null -ne $graph) { $graph.manifestSha256 } else { $null })
        memberCount = $(if ($null -ne $graph) { $graph.memberCount } else { $null })
        fixedSourceGitSha256 = (Sha $git)
        normalImageSha256 = $normalImageSha; fixtureImageSha256 = $fixtureImageSha
        pinnedCommit = $pin; bundleSha256 = $bundleSha
        graphImport = $positive; negativeCases = $negative
        harnessProbes = $harnessProbes; commands = $commands
        sourceHashScope = 'first-party compiled C#, linked parser, verifier, transitive first-party graph-author TS, and package lock/config; external toolchains and node_modules bytes not attested'
        sourceSha256Before = $sourceHashBefore
        sourceSha256After = $sourceHashAfter
        sourceHashesUnchanged = $sourceHashesUnchanged
        authorizesLaunch = $false; installedServiceQualified = $false
    }
    [IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 25) + "`n"),
        [Text.UTF8Encoding]::new($false))
}
if ($failure) { throw "Graph-selected Git source fixture failed: $failure; receipt: $receiptPath" }
Write-Output "Graph-selected Git source fixture passed; receipt: $receiptPath"
