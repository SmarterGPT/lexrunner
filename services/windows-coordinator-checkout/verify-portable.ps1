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
        Require (-not ((Get-Item -LiteralPath $full).Attributes -band [IO.FileAttributes]::ReparsePoint)) "Portable source redirected: $relative"
        $result[$relative] = Sha $full
    }
    $result
}
function Run-Bounded([string]$phase, [string]$cwd, [string]$image,
    [string[]]$argv, [int[]]$accepted, [int]$deadlineMs) {
    $began = [DateTimeOffset]::UtcNow.ToString('o')
    $start = [Diagnostics.ProcessStartInfo]::new($image)
    $start.WorkingDirectory = $cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $argv) { [void]$start.ArgumentList.Add($argument) }
    $run = [GraphGitVerifierProcess]::Run($start, $deadlineMs, 65536, 16384)
    $record = [pscustomobject]@{
        phase = $phase; executable = $image; cwd = $cwd; argv = $argv
        startedAt = $began; durationMs = $run.DurationMs
        outcome = $run.Outcome.ToString(); exitCode = $run.ExitCode
        totalOutputBytes = $run.TotalOutputBytes
        captureTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -ceq 'Exited'
        stdout = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.directChildExitedAndStreamsDrained -and
        -not $record.captureTruncated -and $record.totalOutputBytes -le 65536 -and
        $run.ExitCode -in $accepted) "Portable child failed or uncertain: $phase ($($record.outcome)/$($record.exitCode)) $($record.stderr)"
    $record
}
function Require-Plain-Ancestry([string]$directory, [string]$repository) {
    $repoFull = [IO.Path]::GetFullPath($repository).TrimEnd('\')
    $current = [IO.Path]::GetFullPath($directory).TrimEnd('\')
    Require ($current -ieq $repoFull -or
        $current.StartsWith($repoFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Portable ancestry escaped workspace'
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force
        Require ($item.PSIsContainer -and
            -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            (Resolve-Path -LiteralPath $current).Path -ieq $current) 'Portable ancestry redirected'
        if ($current -ieq $repoFull) { break }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}
function Checked-Remove([string]$root, [string]$parent, [string]$nonce,
    [string]$repository) {
    $repoFull = [IO.Path]::GetFullPath($repository).TrimEnd('\')
    $parentFull = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
    Require ($parentFull.StartsWith($repoFull + '\', [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetDirectoryName($rootFull) -ieq $parentFull -and
        $rootFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Portable cleanup escaped workspace/fixture parent'
    Require (([IO.File]::ReadAllText((Join-Path $rootFull '.fixture-marker')).Trim()) -ceq $nonce) 'Portable marker mismatch'
    Require-Plain-Ancestry $rootFull $repoFull
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
    'services/windows-coordinator-checkout/LexRunner.WindowsCoordinator.Checkout.csproj',
    'services/windows-coordinator-checkout/Program.cs',
    'services/windows-coordinator-checkout/CheckoutPopulation.cs',
    'services/windows-coordinator-checkout/HeldCheckout.cs',
    'services/windows-coordinator-git/BoundedGitChild.cs',
    'services/windows-coordinator-git/GitBundleImport.cs',
    'services/windows-coordinator-git/GitWorktreeStage.cs',
    'services/windows-coordinator-git/GraphSelectedGitProfile.cs',
    'services/windows-coordinator-git/StaticGitImports.cs',
    'installers/windows-coordinator/v2/GraphV2.cs',
    'services/windows-coordinator-git/VerifierBoundedProcess.cs',
    'services/windows-coordinator-checkout/verify-portable.ps1',
    'services/windows-coordinator-checkout/PORTABLE_SOURCE.md'
)
$copyPaths = @($sourcePaths | Where-Object {
    $_ -eq 'services/windows-coordinator-checkout/LexRunner.WindowsCoordinator.Checkout.csproj' -or
    $_ -eq 'installers/windows-coordinator/v2/GraphV2.cs' -or
    $_ -like 'services/windows-coordinator-checkout/*.cs' -or
    ($_ -like 'services/windows-coordinator-git/*.cs' -and
        $_ -ne 'services/windows-coordinator-git/VerifierBoundedProcess.cs')
})
$artifact = Join-Path $repo 'artifacts\windows-coordinator-checkout-portable'
if (-not (Test-Path -LiteralPath $artifact)) { [void](New-Item -ItemType Directory -Path $artifact) }
$tmp = Join-Path $artifact 'tmp'
if (-not (Test-Path -LiteralPath $tmp)) { [void](New-Item -ItemType Directory -Path $tmp) }
Require-Plain-Ancestry $tmp $repo
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
$before = $null; $after = $null; $sourcesUnchanged = $false
$normalImageSha256 = $null; $fixtureImageSha256 = $null
$normalRefused = $false; $fixtureRefused = $false
try {
    $expectedLocalCSharp = @('CheckoutPopulation.cs','HeldCheckout.cs','Program.cs') | Sort-Object
    $actualLocalCSharp = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cs' |
        ForEach-Object Name | Sort-Object)
    Require (($expectedLocalCSharp -join '|') -ceq ($actualLocalCSharp -join '|')) 'Portable checkout C# inventory changed'
    $expectedLinks = @(
        '../windows-coordinator-git/BoundedGitChild.cs',
        '../windows-coordinator-git/GitBundleImport.cs',
        '../windows-coordinator-git/GitWorktreeStage.cs',
        '../windows-coordinator-git/GraphSelectedGitProfile.cs',
        '../windows-coordinator-git/StaticGitImports.cs',
        '../../installers/windows-coordinator/v2/GraphV2.cs'
    ) | Sort-Object
    [xml]$projectXml = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.Checkout.csproj'))
    $actualLinks = @($projectXml.Project.ItemGroup.Compile |
        Where-Object { $_.HasAttribute('Include') } |
        ForEach-Object { $_.GetAttribute('Include').Replace('\','/') } | Sort-Object)
    Require (($expectedLinks -join '|') -ceq ($actualLinks -join '|')) 'Portable checkout linked C# inventory changed'
    $before = Source-Hashes $repo $sourcePaths
    Add-Type -Path (Join-Path $repo 'services\windows-coordinator-git\VerifierBoundedProcess.cs')
    $copyRoot = Join-Path $root 'source-copy'
    foreach ($relative in $copyPaths) {
        $target = Join-Path $copyRoot ($relative.Replace('/', '\'))
        [void](New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force)
        Copy-Item -LiteralPath (Join-Path $repo ($relative.Replace('/', '\'))) -Destination $target
        Require ((Sha $target) -ceq $before[$relative]) "Portable copied source mismatch: $relative"
    }
    $project = Join-Path $copyRoot 'services\windows-coordinator-checkout\LexRunner.WindowsCoordinator.Checkout.csproj'
    $normalOut = Join-Path $root 'normal-publish'
    $fixtureOut = Join-Path $root 'fixture-publish'
    $normalObj = Join-Path $root 'normal-obj'
    $fixtureObj = Join-Path $root 'fixture-obj'
    $normalBin = Join-Path $root 'normal-bin'
    $fixtureBin = Join-Path $root 'fixture-bin'
    $null = Run-Bounded 'normal-nativeaot-publish' $repo $dotnet @('publish',$project,
        '-c','Release','-r','win-x64','-p:NuGetAudit=false',
        ('-p:BaseIntermediateOutputPath=' + $normalObj + '\'),
        ('-p:BaseOutputPath=' + $normalBin + '\'),'-o',$normalOut,'-v:q') @(0) 600000
    $null = Run-Bounded 'fixture-nativeaot-publish' $repo $dotnet @('publish',$project,
        '-c','Release','-r','win-x64','-p:NuGetAudit=false','-p:CheckoutFixture=true',
        ('-p:BaseIntermediateOutputPath=' + $fixtureObj + '\'),
        ('-p:BaseOutputPath=' + $fixtureBin + '\'),'-o',$fixtureOut,'-v:q') @(0) 600000
    $normalImage = Join-Path $normalOut 'LexRunner.WindowsCoordinator.Checkout.exe'
    $fixtureImage = Join-Path $fixtureOut 'LexRunner.WindowsCoordinator.Checkout.exe'
    Require ((Test-Path -LiteralPath $normalImage -PathType Leaf) -and
        (Test-Path -LiteralPath $fixtureImage -PathType Leaf)) 'Portable checkout image missing'
    $normalImageSha256 = Sha $normalImage
    $fixtureImageSha256 = Sha $fixtureImage
    Require ($normalImageSha256 -cne $fixtureImageSha256) 'Normal and fixture images identical'
    $args = @('--fixture-populate',$root,(Join-Path $root 'absent.bundle'),
        (Join-Path $root 'absent-mirror'),(Join-Path $root 'absent-hooks'),
        (Join-Path $root 'absent-template'),(Join-Path $root 'absent-home'),
        (Join-Path $root 'absent-temp'),('0' * 40),('0' * 64),
        (Join-Path $root 'absent-stage'),(Join-Path $root 'absent-payload'),('0' * 64))
    $normalLaunch = Run-Bounded 'normal-route-refusal' $repo $normalImage @('--execute') @(2) 10000
    $normalPopulate = Run-Bounded 'normal-refuses-populate' $repo $normalImage $args @(2) 10000
    $observeArgs = @($args); $observeArgs[0] = '--fixture-observe'
    $normalObserve = Run-Bounded 'normal-refuses-observe' $repo $normalImage $observeArgs @(2) 10000
    $normalRefused = @(@($normalLaunch,$normalPopulate,$normalObserve) | Where-Object {
        $_.stderr.Trim() -cne 'no_production_checkout_entrypoint'
    }).Count -eq 0
    Require $normalRefused 'Normal checkout image accepted a route or fixture flag'
    $fixturePopulate = Run-Bounded 'fixture-refuses-absent-graph-populate' $repo $fixtureImage $args @(3) 10000
    $fixtureObserve = Run-Bounded 'fixture-refuses-absent-graph-observe' $repo $fixtureImage $observeArgs @(3) 10000
    $reports = @(@($fixturePopulate.stdout,$fixtureObserve.stdout) |
        ForEach-Object { $_ | ConvertFrom-Json -Depth 20 })
    $fixtureRefused = @($reports | Where-Object {
        $_.Populated -or $_.UnknownEffects -or $_.StageMayContainTrackedFiles -or
        $_.Disposition -cne 'refused_before_checkout_entry' -or
        $_.Error -cne 'InvalidDataException:graph_git_payload_root_not_canonical' -or
        $_.Commands.Count -ne 0
    }).Count -eq 0
    Require $fixtureRefused 'Fixture checkout image did not refuse absent graph before effects'
    Require (-not (Test-Path -LiteralPath (Join-Path $root 'absent-mirror')) -and
        -not (Test-Path -LiteralPath (Join-Path $root 'absent-stage'))) 'Portable refusal created Git stage or mirror'
    $after = Source-Hashes $repo $sourcePaths
    $sourcesUnchanged = @($sourcePaths | Where-Object { $before[$_] -cne $after[$_] }).Count -eq 0
    Require $sourcesUnchanged 'Portable source changed during run'
    Checked-Remove $root $tmp $nonce $repo
    $cleaned = $true
    $result = 'portable_source_pass'
} catch { $failure = $_.Exception.Message }
finally {
    $clock.Stop()
    if ($null -eq $after) {
        try {
            $after = Source-Hashes $repo $sourcePaths
            if ($null -ne $before) {
                $sourcesUnchanged = @($sourcePaths | Where-Object { $before[$_] -cne $after[$_] }).Count -eq 0
            }
        } catch {
            if (-not $failure) { $failure = 'source_recheck_failed:' + $_.Exception.Message }
        }
    }
    if (-not $sourcesUnchanged) {
        if (-not $failure) { $failure = 'source_changed_during_portable_verification' }
        $result = 'failed'
    }
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-checkout-portable-source/1'
        result = $result; error = $failure; cwd = $repo
        ciEventSha = $env:GITHUB_SHA
        startedAt = $startedAt; durationMs = $clock.ElapsedMilliseconds
        fixtureRoot = $root; fixtureRemoved = $cleaned
        copiedSourceCount = $copyPaths.Count
        normalImageSha256 = $normalImageSha256
        fixtureImageSha256 = $fixtureImageSha256
        normalRoutesRefused = $normalRefused
        fixtureAbsentGraphRefused = $fixtureRefused
        commands = $commands
        sourceHashScope = 'complete first-party C# compile inputs, linked GraphV2 parser, bounded harness, portable verifier and its contract; external .NET toolchain/packages not attested'
        sourceSha256Before = $before
        sourceSha256After = $after
        sourceHashesUnchanged = $sourcesUnchanged
        authorizesExecution = $false
        installedServiceQualified = $false
    }
    [IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 20) + "`n"),
        [Text.UTF8Encoding]::new($false))
}
if ($failure) { throw "Portable checkout source verifier failed: $failure; receipt: $receiptPath" }
Write-Output "Portable checkout source verifier passed; receipt: $receiptPath"
