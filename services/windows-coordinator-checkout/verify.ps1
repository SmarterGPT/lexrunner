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
    $run = [GraphGitVerifierProcess]::Run($start, $timeoutMs, 65536, 16384)
    $record = [pscustomobject]@{
        phase = $phase; executable = $image; cwd = $cwd; argv = $argv
        startedAt = $began; durationMs = $run.DurationMs; exitCode = $run.ExitCode
        outcome = $run.Outcome.ToString(); totalOutputBytes = $run.TotalOutputBytes
        captureTruncated = $run.CaptureTruncated
        directChildExitedAndStreamsDrained = $run.Outcome.ToString() -ceq 'Exited'
        output = $run.Stdout; stderr = $run.Stderr
    }
    [void]$script:commands.Add($record)
    Require ($record.directChildExitedAndStreamsDrained -and -not $record.captureTruncated -and
        $record.exitCode -in $accepted) "Fixture command failed: $phase ($($record.outcome)/$($record.exitCode)) $($run.Stderr)"
    $record
}
function New-FixtureRoot([string]$parent) {
    $nonce = [guid]::NewGuid().ToString('N')
    $root = Join-Path $parent "checkout-$nonce"
    Require (-not (Test-Path -LiteralPath $root)) 'Fixture root occupied'
    [void](New-Item -ItemType Directory -Path $root)
    [IO.File]::WriteAllText((Join-Path $root '.fixture-marker'), "$nonce`n", [Text.UTF8Encoding]::new($false))
    foreach ($name in @('empty-hooks','empty-template','home','temp')) {
        [void](New-Item -ItemType Directory -Path (Join-Path $root $name))
    }
    [pscustomobject]@{ root = $root; nonce = $nonce }
}
function Checked-Remove([string]$root, [string]$parent, [string]$nonce,
    [string]$workspace) {
    $parentFull = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
    $workspaceFull = [IO.Path]::GetFullPath($workspace).TrimEnd('\')
    Require ($rootFull.StartsWith($workspaceFull + '\', [StringComparison]::OrdinalIgnoreCase) -and
        $parentFull.StartsWith($workspaceFull + '\', [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetDirectoryName($rootFull) -ieq $parentFull -and
        $rootFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)) 'Cleanup target escaped workspace/fixture parent'
    Require (([IO.File]::ReadAllText((Join-Path $rootFull '.fixture-marker')).Trim()) -ceq $nonce) 'Fixture marker mismatch'
    foreach ($path in @($workspaceFull, $parentFull, $rootFull)) {
        $item = Get-Item -LiteralPath $path -Force
        Require ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Cleanup parent redirected'
        Require ((Resolve-Path -LiteralPath $path).Path -ieq $path) 'Cleanup path resolved elsewhere'
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
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
$graphAuthor = Join-Path $repo 'services\windows-coordinator-git\fixture-graph.ts'
$project = Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.Checkout.csproj'
$sourceFiles = @(
    'services/windows-coordinator-checkout/LexRunner.WindowsCoordinator.Checkout.csproj',
    'services/windows-coordinator-checkout/Program.cs',
    'services/windows-coordinator-checkout/CheckoutPopulation.cs',
    'services/windows-coordinator-checkout/HeldCheckout.cs',
    'services/windows-coordinator-checkout/verify.ps1',
    'services/windows-coordinator-git/BoundedGitChild.cs',
    'services/windows-coordinator-git/ManualEtwGitProfile.cs',
    'services/windows-coordinator-git/GitBundleImport.cs',
    'services/windows-coordinator-git/GitWorktreeStage.cs',
    'services/windows-coordinator-git/GraphSelectedGitProfile.cs',
    'services/windows-coordinator-git/StaticGitImports.cs',
    'services/windows-coordinator-git/VerifierBoundedProcess.cs',
    'services/windows-coordinator-git/fixture-graph.ts',
    'installers/windows-coordinator/v2/GraphV2.cs',
    'src/workspaces/windows-coordinator-generation-graph.ts',
    'src/workspaces/windows-boundary-protocol.ts',
    'src/workspaces/windows-removal-protocol.ts',
    'src/workspaces/windows-removal-git-environment.ts',
    'src/util/canonicalJson.ts'
)
$sourceHashes = [ordered]@{}
foreach ($relative in $sourceFiles) {
    $sourceHashes[$relative] = Sha (Join-Path $repo $relative)
}
Require (Test-Path -LiteralPath $git -PathType Leaf) 'Pinned fixture Git missing'
Require (Test-Path -LiteralPath $tsx -PathType Leaf) 'Repository tsx missing'
Require (Test-Path -LiteralPath $graphAuthor -PathType Leaf) 'Graph fixture author missing'
Add-Type -Path (Join-Path $repo 'services\windows-coordinator-git\VerifierBoundedProcess.cs')
$artifact = Join-Path $repo 'artifacts\windows-coordinator-checkout'
if (-not (Test-Path -LiteralPath $artifact)) { [void](New-Item -ItemType Directory -Path $artifact) }
$tmp = Join-Path $artifact 'tmp'
if (-not (Test-Path -LiteralPath $tmp)) { [void](New-Item -ItemType Directory -Path $tmp) }
Require ((Get-Item -LiteralPath $tmp).PSIsContainer -and
    -not ((Get-Item -LiteralPath $tmp).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Fixture parent redirected'
$fixture = New-FixtureRoot $tmp
$root = $fixture.root
$payload = Join-Path $root 'payload'
$source = Join-Path $root 'source'
$bundle = Join-Path $root 'source.bundle'
$mirror = Join-Path $root 'mirror.git'
$stage = Join-Path $root 'stage'
$hooks = Join-Path $root 'empty-hooks'
$template = Join-Path $root 'empty-template'
$homeDir = Join-Path $root 'home'
$tempDir = Join-Path $root 'temp'
$imageOut = Join-Path $root 'image'
$obj = Join-Path $root 'obj'
$bin = Join-Path $root 'bin'
$receiptPath = Join-Path $artifact "receipt-$($fixture.nonce).json"
$commands = [Collections.Generic.List[object]]::new()
$began = [DateTimeOffset]::UtcNow.ToString('o')
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = 'failed'; $failure = $null; $cleaned = $false
$graph = $null; $pin = $null; $bundleSha = $null; $positive = $null
$replay = $null; $tampered = $null; $negative = @()
$repoHead = $null; $repoHeadFinal = $null; $volume = $null
try {
    $repoHead = (Step 'repo-head-before' $repo $git @('-C',$repo,'rev-parse','HEAD')).output.Trim()
    Require ($repoHead -cmatch '^[0-9a-f]{40}$') 'Repository HEAD readback malformed'
    $driveRoot = [IO.Path]::GetPathRoot($root)
    Require ($driveRoot -cmatch '^[A-Za-z]:\\$') 'Fixture root drive invalid'
    $driveLetter = $driveRoot.Substring(0, 1).ToUpperInvariant()
    $volumeScript = '$v = Get-Volume -DriveLetter ' + $driveLetter +
        ' -ErrorAction Stop; [pscustomobject]@{ DriveLetter = [string]$v.DriveLetter; FileSystem = [string]$v.FileSystem; Path = [string]$v.Path } | ConvertTo-Json -Compress'
    $volume = (Step 'volume-readback' $repo $pwsh @('-NoLogo','-NoProfile',
        '-NonInteractive','-Command',$volumeScript)).output | ConvertFrom-Json
    Require ($volume.DriveLetter -ceq $driveLetter -and
        $volume.FileSystem -ceq 'ReFS' -and
        -not [string]::IsNullOrWhiteSpace($volume.Path)) 'Fixture volume is not recorded ReFS'
    $graphStep = Step 'author-synthetic-graph' $repo $node @($tsx, $graphAuthor, $payload)
    $graph = $graphStep.output | ConvertFrom-Json
    Require ($graph.memberCount -eq 13 -and -not $graph.authorizesLaunch) 'Synthetic graph contract failed'
    $null = Step 'source-init' $root $git @('init','--initial-branch=main',$source)
    [IO.File]::WriteAllText((Join-Path $source 'tracked.txt'), "checkout fixture`n", [Text.UTF8Encoding]::new($false))
    $null = Step 'source-add' $root $git @('-C',$source,'add','--','tracked.txt')
    $null = Step 'source-commit' $root $git @('-C',$source,'-c','commit.gpgsign=false',
        '-c','user.name=LexRunner Fixture','-c','user.email=fixture@invalid.example',
        'commit','-m','checkout fixture')
    $pin = (Step 'source-pin' $root $git @('-C',$source,'rev-parse','HEAD')).output.Trim()
    Require ($pin -match '^[0-9a-f]{40}$') 'Synthetic commit pin malformed'
    $null = Step 'source-bundle' $root $git @('-C',$source,'bundle','create',$bundle,'refs/heads/main')
    $bundleSha = Sha $bundle
    $null = Step 'publish-checkout-fixture' $repo 'dotnet.exe' @('publish',$project,'-c','Release',
        '-r','win-x64','-p:NuGetAudit=false','-p:CheckoutFixture=true',
        ('-p:BaseIntermediateOutputPath=' + $obj + '\'),
        ('-p:BaseOutputPath=' + $bin + '\'),'-o',$imageOut,'-v:q')
    $image = Join-Path $imageOut 'LexRunner.WindowsCoordinator.Checkout.exe'
    $normal = Step 'normal-route-refusal' $repo $image @('--execute') @(2)
    Require ($normal.stderr.Trim() -ceq 'no_production_checkout_entrypoint') 'Checkout fixture exposed normal route'
    $args = @('--fixture-populate',$root,$bundle,$mirror,$hooks,$template,$homeDir,
        $tempDir,$pin,$bundleSha,$stage,$payload,$graph.manifestSha256)
    $savedPath = $env:PATH; $savedExec = $env:GIT_EXEC_PATH
    $savedCount = $env:GIT_CONFIG_COUNT
    try {
        $env:PATH = 'C:\intentionally-poisoned-path'
        $env:GIT_EXEC_PATH = 'C:\intentionally-poisoned-git-core'
        $env:GIT_CONFIG_COUNT = '1'
        $run = Step 'populate' $repo $image $args
    } finally {
        $env:PATH = $savedPath; $env:GIT_EXEC_PATH = $savedExec
        $env:GIT_CONFIG_COUNT = $savedCount
    }
    $positive = $run.output | ConvertFrom-Json -Depth 30
    Require ($positive.Populated -and $positive.UnknownEffects -and
        $positive.Files.Count -eq 1 -and $positive.Files[0].Path -ceq 'tracked.txt' -and
        (Test-Path -LiteralPath (Join-Path $stage 'tracked.txt') -PathType Leaf)) 'Tracked-file population failed'
    $observeArgs = @($args); $observeArgs[0] = '--fixture-observe'
    $replay = (Step 'observe-exact' $repo $image $observeArgs).output | ConvertFrom-Json -Depth 30
    Require ($replay.Populated -and $replay.UnknownEffects -and
        $replay.Disposition -ceq 'fixture_observed_exact_no_replay_authority') 'Exact observation failed'
    [IO.File]::AppendAllText((Join-Path $stage 'tracked.txt'), 'tampered')
    $tampered = (Step 'observe-tampered' $repo $image $observeArgs @(1)).output | ConvertFrom-Json -Depth 30
    Require (-not $tampered.Populated -and $tampered.UnknownEffects -and
        $tampered.Disposition -ceq 'preserve_unknown_effects') 'Tampered stage was promoted'
    $negative += 'tampered-stage-observation'

    [IO.File]::WriteAllText((Join-Path $stage 'tracked.txt'),
        "checkout fixture`n", [Text.UTF8Encoding]::new($false))
    [void](New-Item -ItemType Directory -Path (Join-Path $stage 'unlisted-empty'))
    $emptyDirectory = (Step 'observe-unlisted-empty-directory' $repo $image $observeArgs @(1)).output | ConvertFrom-Json -Depth 30
    Require (-not $emptyDirectory.Populated -and $emptyDirectory.UnknownEffects -and
        $emptyDirectory.Error -match 'checkout_output_unlisted_directory') 'Unlisted empty directory was accepted as exact'
    $negative += 'unlisted-empty-directory-observation'

    # An exact tree preflight must refuse attributes, gitlinks and symlinks
    # before stage creation. The source repo's config/hooks never cross a
    # bundle; the positive run also poisoned inherited Git environment.
    [IO.File]::WriteAllText((Join-Path $source '.gitattributes'),
        "tracked.txt filter=hostile`n", [Text.UTF8Encoding]::new($false))
    $null = Step 'filter-source-add' $root $git @('-C',$source,'add','--','.gitattributes')
    $null = Step 'filter-source-commit' $root $git @('-C',$source,'-c','commit.gpgsign=false',
        '-c','user.name=LexRunner Fixture','-c','user.email=fixture@invalid.example',
        'commit','-m','hostile attributes')
    $filterPin = (Step 'filter-source-pin' $root $git @('-C',$source,'rev-parse','HEAD')).output.Trim()
    $filter = New-FixtureRoot $tmp
    $filterBundle = Join-Path $filter.root 'source.bundle'
    $null = Step 'filter-source-bundle' $root $git @('-C',$source,'bundle','create',
        $filterBundle,'refs/heads/main')
    $filterStage = Join-Path $filter.root 'stage'
    $filterArgs = @('--fixture-populate',$filter.root,$filterBundle,
        (Join-Path $filter.root 'mirror.git'),(Join-Path $filter.root 'empty-hooks'),
        (Join-Path $filter.root 'empty-template'),(Join-Path $filter.root 'home'),
        (Join-Path $filter.root 'temp'),$filterPin,(Sha $filterBundle),
        $filterStage,$payload,$graph.manifestSha256)
    $filterReport = (Step 'filter-tree-refusal' $repo $image $filterArgs @(1)).output | ConvertFrom-Json -Depth 30
    Require (-not $filterReport.Populated -and $filterReport.UnknownEffects -and
        -not $filterReport.StageMayContainTrackedFiles -and
        -not (Test-Path -LiteralPath $filterStage)) 'Filter tree reached checkout stage'
    Checked-Remove $filter.root $tmp $filter.nonce $repo
    $negative += 'filter-attributes-before-stage'

    $null = Step 'source-reset-for-symlink' $root $git @('-C',$source,'reset','--hard',$pin)
    [IO.File]::WriteAllText((Join-Path $source 'link-target.txt'),
        "tracked.txt`n", [Text.UTF8Encoding]::new($false))
    $linkBlob = (Step 'symlink-blob' $root $git @('-C',$source,'hash-object','-w',
        (Join-Path $source 'link-target.txt'))).output.Trim()
    Require ($linkBlob -match '^[0-9a-f]{40}$') 'Symlink fixture blob malformed'
    $null = Step 'symlink-index' $root $git @('-C',$source,'update-index','--add',
        '--cacheinfo',("120000,$linkBlob,link"))
    $null = Step 'symlink-source-commit' $root $git @('-C',$source,'-c','commit.gpgsign=false',
        '-c','user.name=LexRunner Fixture','-c','user.email=fixture@invalid.example',
        'commit','-m','hostile symlink')
    $symlinkPin = (Step 'symlink-source-pin' $root $git @('-C',$source,'rev-parse','HEAD')).output.Trim()
    $symlink = New-FixtureRoot $tmp
    $symlinkBundle = Join-Path $symlink.root 'source.bundle'
    $null = Step 'symlink-source-bundle' $root $git @('-C',$source,'bundle','create',
        $symlinkBundle,'refs/heads/main')
    $symlinkStage = Join-Path $symlink.root 'stage'
    $symlinkArgs = @('--fixture-populate',$symlink.root,$symlinkBundle,
        (Join-Path $symlink.root 'mirror.git'),(Join-Path $symlink.root 'empty-hooks'),
        (Join-Path $symlink.root 'empty-template'),(Join-Path $symlink.root 'home'),
        (Join-Path $symlink.root 'temp'),$symlinkPin,(Sha $symlinkBundle),
        $symlinkStage,$payload,$graph.manifestSha256)
    $symlinkReport = (Step 'symlink-tree-refusal' $repo $image $symlinkArgs @(1)).output | ConvertFrom-Json -Depth 30
    Require (-not $symlinkReport.Populated -and $symlinkReport.UnknownEffects -and
        -not $symlinkReport.StageMayContainTrackedFiles -and
        -not (Test-Path -LiteralPath $symlinkStage)) 'Symlink tree reached checkout stage'
    Checked-Remove $symlink.root $tmp $symlink.nonce $repo
    $negative += 'symlink-before-stage'

    $null = Step 'source-reset-for-gitlink' $root $git @('-C',$source,'reset','--hard',$pin)
    $null = Step 'gitlink-index' $root $git @('-C',$source,'update-index','--add',
        '--cacheinfo',("160000,$pin,module"))
    $null = Step 'gitlink-source-commit' $root $git @('-C',$source,'-c','commit.gpgsign=false',
        '-c','user.name=LexRunner Fixture','-c','user.email=fixture@invalid.example',
        'commit','-m','hostile gitlink')
    $gitlinkPin = (Step 'gitlink-source-pin' $root $git @('-C',$source,'rev-parse','HEAD')).output.Trim()
    $gitlink = New-FixtureRoot $tmp
    $gitlinkBundle = Join-Path $gitlink.root 'source.bundle'
    $null = Step 'gitlink-source-bundle' $root $git @('-C',$source,'bundle','create',
        $gitlinkBundle,'refs/heads/main')
    $gitlinkStage = Join-Path $gitlink.root 'stage'
    $gitlinkArgs = @('--fixture-populate',$gitlink.root,$gitlinkBundle,
        (Join-Path $gitlink.root 'mirror.git'),(Join-Path $gitlink.root 'empty-hooks'),
        (Join-Path $gitlink.root 'empty-template'),(Join-Path $gitlink.root 'home'),
        (Join-Path $gitlink.root 'temp'),$gitlinkPin,(Sha $gitlinkBundle),
        $gitlinkStage,$payload,$graph.manifestSha256)
    $gitlinkReport = (Step 'gitlink-tree-refusal' $repo $image $gitlinkArgs @(1)).output | ConvertFrom-Json -Depth 30
    Require (-not $gitlinkReport.Populated -and $gitlinkReport.UnknownEffects -and
        -not $gitlinkReport.StageMayContainTrackedFiles -and
        -not (Test-Path -LiteralPath $gitlinkStage)) 'Gitlink tree reached checkout stage'
    Checked-Remove $gitlink.root $tmp $gitlink.nonce $repo
    $negative += 'submodule-gitlink-before-stage'

    $hook = New-FixtureRoot $tmp
    $hookBundle = Join-Path $hook.root 'source.bundle'
    [IO.File]::Copy($bundle, $hookBundle)
    [IO.File]::WriteAllText((Join-Path $hook.root 'empty-hooks\canary'), 'refuse')
    $hookStage = Join-Path $hook.root 'stage'
    $hookArgs = @('--fixture-populate',$hook.root,$hookBundle,
        (Join-Path $hook.root 'mirror.git'),(Join-Path $hook.root 'empty-hooks'),
        (Join-Path $hook.root 'empty-template'),(Join-Path $hook.root 'home'),
        (Join-Path $hook.root 'temp'),$pin,(Sha $hookBundle),
        $hookStage,$payload,$graph.manifestSha256)
    $hookReport = (Step 'hook-directory-refusal' $repo $image $hookArgs @(1)).output | ConvertFrom-Json -Depth 30
    Require (-not $hookReport.Populated -and $hookReport.UnknownEffects -and
        -not (Test-Path -LiteralPath (Join-Path $hook.root 'mirror.git')) -and
        -not (Test-Path -LiteralPath $hookStage)) 'Occupied hook directory reached Git effects'
    Checked-Remove $hook.root $tmp $hook.nonce $repo
    $negative += 'occupied-hook-directory-before-import'

    foreach ($relative in $sourceFiles) {
        Require ((Sha (Join-Path $repo $relative)) -ceq $sourceHashes[$relative]) "Fixture source changed during run: $relative"
    }
    $repoHeadFinal = (Step 'repo-head-after' $repo $git @('-C',$repo,'rev-parse','HEAD')).output.Trim()
    Require ($repoHeadFinal -cmatch '^[0-9a-f]{40}$' -and
        $repoHeadFinal -ceq $repoHead) 'Repository HEAD changed during fixture'
    Checked-Remove $root $tmp $fixture.nonce $repo
    $cleaned = $true
    $result = 'source_fixture_pass'
} catch { $failure = $_.Exception.Message }
finally {
    $clock.Stop()
    $receipt = [ordered]@{
        schemaVersion = 'windows-coordinator-checkout-source/1'; result = $result
        error = $failure; cwd = $repo; repoHead = $repoHead
        repoHeadFinal = $repoHeadFinal; volume = $volume
        startedAt = $began; durationMs = $clock.ElapsedMilliseconds
        fixtureRoot = $root; fixtureRemoved = $cleaned
        graphDigest = $(if ($null -ne $graph) { $graph.graphDigest } else { $null })
        manifestSha256 = $(if ($null -ne $graph) { $graph.manifestSha256 } else { $null })
        pinnedCommit = $pin; bundleSha256 = $bundleSha
        positive = $positive; replay = $replay; tampered = $tampered
        negativeCases = $negative; commands = $commands
        sourceSha256 = $sourceHashes
        authorizesExecution = $false; installedServiceQualified = $false
    }
    [IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 35) + "`n"),
        [Text.UTF8Encoding]::new($false))
}
if ($failure) { throw "Checkout source fixture failed: $failure; receipt: $receiptPath" }
Write-Output "Checkout source fixture passed; receipt: $receiptPath"
