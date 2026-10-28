[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [ValidatePattern('\A\d+\.\d+\.\d+\z')][string]$Version = '2.5.0'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    -not [Environment]::Is64BitProcess) { throw 'V2 offline MSI verification requires native Windows x64' }
if (-not $env:WINDIR -and $env:SystemRoot) { $env:WINDIR = $env:SystemRoot }
$env:OS = 'Windows_NT'

$project = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$repository = [IO.Path]::GetFullPath((Join-Path $project '../../..')).TrimEnd('\')
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repository 'artifacts/windows-coordinator-v2-msi-offline')).TrimEnd('\')
$artifact = [IO.Path]::GetFullPath($ArtifactDirectory).TrimEnd('\')
$nonce = [IO.Path]::GetFileName($artifact)
if (-not [IO.Path]::IsPathFullyQualified($ArtifactDirectory) -or
    -not [string]::Equals([IO.Path]::GetDirectoryName($artifact), $artifactRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $nonce -cnotmatch '\Asource-[a-f0-9]{32}\z' -or
    (Test-Path -LiteralPath $artifact)) {
    throw 'Select one fresh direct source-<32 lowercase hex> child of the ignored v2 MSI artifact root'
}

function Digest([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path,
        (($Value | ConvertTo-Json -Depth 12 -Compress) + [char]10),
        [Text.UTF8Encoding]::new($false))
}
function Own([string]$Name) {
    $path = Join-Path $artifact $Name
    if (Test-Path -LiteralPath $path) { throw "Owned build path already exists: $path" }
    New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $path '.v2-msi-owner'), $nonce + [char]10,
        [Text.UTF8Encoding]::new($false))
    return $path
}
function Assert-PlainAncestors([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($true) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Ancestor disappeared: $cursor" }
        if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Ancestor is a reparse point: $cursor"
        }
        $parent = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Remove-Owned([string]$Name) {
    $path = [IO.Path]::GetFullPath((Join-Path $artifact $Name)).TrimEnd('\')
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($path), $artifact, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Cleanup target escaped exact artifact'
    }
    $owner = Join-Path $path '.v2-msi-owner'
    Assert-PlainAncestors $owner
    $artifactOwner = Join-Path $artifact '.v2-msi-owner'
    Assert-PlainAncestors $artifactOwner
    if ((Get-Content -LiteralPath $artifactOwner -Raw) -cne ($nonce + [char]10) -or
        (Get-Content -LiteralPath $owner -Raw) -cne ($nonce + [char]10)) {
        throw 'Cleanup ownership marker changed'
    }
    $pending = [Collections.Generic.Stack[object]]::new()
    $pending.Push(@($path, 0))
    $visited = 0
    while ($pending.Count -gt 0) {
        $entry = $pending.Pop()
        $directory = [string]$entry[0]
        $depth = [int]$entry[1]
        if ($depth -ge 64) { throw 'Cleanup tree exceeds bounded depth' }
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $visited++
            if ($visited -gt 8192) { throw 'Cleanup tree exceeds bounded entry count' }
            $attributes = [IO.File]::GetAttributes($child)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Cleanup tree contains a reparse entry'
            }
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $pending.Push(@($child, $depth + 1))
            }
        }
    }
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
}

Add-Type -Path (Join-Path $project 'BoundedProcess.cs') -ErrorAction Stop
$commands = [Collections.Generic.List[object]]::new()
function Invoke-Bounded([string]$Exe, [string[]]$Arguments, [int]$TimeoutMs = 300000) {
    $executable = (Get-Command $Exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $start = [Diagnostics.ProcessStartInfo]::new($executable)
    $start.WorkingDirectory = $repository
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    $result = [QualificationBoundedProcess]::Run($start, $TimeoutMs, 262144, 4096)
    $commands.Add([ordered]@{
        command = @($executable) + $Arguments
        cwd = $repository
        durationMs = $result.DurationMs
        outcome = $result.Outcome.ToString()
        exitCode = $result.ExitCode
        outputBytes = $result.TotalOutputBytes
        outputTruncated = $result.OutputTruncated
        output = $result.Stdout + $result.Stderr
    })
    return $result
}
function Require-Exit($Result, [int]$Code, [string]$Name) {
    if ($Result.Outcome -ne [QualificationProcessOutcome]::Exited -or $Result.ExitCode -ne $Code) {
        throw "$Name did not finish with expected bounded exit $Code"
    }
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$outcome = 'fail'
$failure = $null
$cleanup = 'not_run'
$head = $null
$sourceHashes = [ordered]@{}
$recipeSha = $null
$manifestSha = $null
$graphDigest = $null
$msiSha = $null
try {
    New-Item -ItemType Directory -Path $artifactRoot -Force -ErrorAction Stop | Out-Null
    Assert-PlainAncestors $artifactRoot
    New-Item -ItemType Directory -Path $artifact -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $artifact '.v2-msi-owner'), $nonce + [char]10,
        [Text.UTF8Encoding]::new($false))

    $gitHead = Invoke-Bounded 'git.exe' @('-C', $repository, 'rev-parse', 'HEAD') 30000
    Require-Exit $gitHead 0 'Repository HEAD read'
    $head = $gitHead.Stdout.Trim()
    if ($head -cnotmatch '\A[0-9a-f]{40}\z') { throw 'Repository HEAD unavailable' }
    $sources = @(
        'installers/windows-coordinator/NativeDatabase.cs',
        'installers/windows-coordinator/v2/Program.cs',
        'installers/windows-coordinator/v2/GraphV2.cs',
        'installers/windows-coordinator/v2/V2Recipe.cs',
        'installers/windows-coordinator/v2/V2Audit.cs',
        'installers/windows-coordinator/v2/V2Readback.cs',
        'installers/windows-coordinator/v2/BoundedProcess.cs',
        'installers/windows-coordinator/v2/WindowsCoordinatorV2MsiBuilder.csproj',
        'installers/windows-coordinator/v2/fixture.ts',
        'installers/windows-coordinator/v2/verify.ps1',
        'installers/windows-coordinator/v2/preflight.ps1',
        'installers/windows-coordinator/v2/README.md',
        'src/workspaces/windows-coordinator-generation-graph.ts',
        'src/workspaces/windows-boundary-protocol.ts',
        'src/workspaces/windows-removal-protocol.ts',
        'scripts/verify-windows-coordinator-generation-payload.ts'
    )
    foreach ($name in $sources) { $sourceHashes[$name] = Digest (Join-Path $repository $name) }
    $parseTokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $project 'preflight.ps1'), [ref]$parseTokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -ne 0) { throw 'V2 read-only preflight has syntax errors' }
    $recipeText = ($sources | ForEach-Object { "$($_):$($sourceHashes[$_])" }) -join "`n"
    $recipeSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($recipeText))).ToLowerInvariant()
    $sidProbe = Invoke-Bounded 'sc.exe' @('showsid', 'LexRunnerCoordinator') 30000
    Require-Exit $sidProbe 0 'Production service SID derivation'
    if ($sidProbe.Stdout -cnotmatch '\bS-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579\b') {
        throw 'Authored restricted-service ACL SID differs from Windows SCM derivation'
    }

    $noisy = Invoke-Bounded 'pwsh.exe' @('-NoLogo','-NoProfile','-Command',
        'while($true){[Console]::Out.Write("x"*4096);[Console]::Error.Write("x"*4096)}') 5000
    if ($noisy.Outcome -ne [QualificationProcessOutcome]::OutputOverflow) {
        throw 'Noisy child did not produce typed output-overflow refusal'
    }
    $idle = Invoke-Bounded 'pwsh.exe' @('-NoLogo','-NoProfile','-Command',
        'while($true){Start-Sleep -Seconds 1}') 300
    if ($idle.Outcome -ne [QualificationProcessOutcome]::TimedOut) {
        throw 'Idle child did not produce typed timeout refusal'
    }

    $builderObj = Own 'builder-obj'
    $builderBin = Own 'builder-bin'
    $builderProject = Join-Path $project 'WindowsCoordinatorV2MsiBuilder.csproj'
    $build = Invoke-Bounded 'dotnet.exe' @('build', $builderProject, '--configuration', 'Release', '--nologo',
        "-p:BaseIntermediateOutputPath=$builderObj\", "-p:BaseOutputPath=$builderBin\")
    Require-Exit $build 0 'V2 builder compilation'
    $builder = Join-Path $builderBin 'Release/net8.0/WindowsCoordinatorV2MsiBuilder.dll'
    if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw 'V2 builder output missing' }
    $tsx = Join-Path $repository 'node_modules/tsx/dist/cli.mjs'
    if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) { throw 'Local tsx dependency missing' }
    $fixture = Join-Path $project 'fixture.ts'
    function New-Fixture([string]$Name) {
        $payload = Join-Path $artifact $Name
        New-Item -ItemType Directory -Path $payload -ErrorAction Stop | Out-Null
        $result = Invoke-Bounded 'node.exe' @($tsx, $fixture, $payload)
        Require-Exit $result 0 "$Name fixture"
        $graph = $result.Stdout.Trim() | ConvertFrom-Json
        if ($graph.fileCount -ne 7 -or $graph.authorizesLaunch -ne $false -or
            $graph.manifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
            $graph.graphDigest -cnotmatch '\A[a-f0-9]{64}\z') {
            throw "$Name synthetic graph shape invalid"
        }
        return [pscustomobject]@{ Path = $payload; Graph = $graph }
    }
    $positiveFixture = New-Fixture 'payload'
    $payload = $positiveFixture.Path
    $manifestSha = $positiveFixture.Graph.manifestSha256
    $graphDigest = $positiveFixture.Graph.graphDigest
    $preflight = Invoke-Bounded 'node.exe' @($tsx,
        (Join-Path $repository 'scripts/verify-windows-coordinator-generation-payload.ts'),
        $payload, $manifestSha)
    Require-Exit $preflight 0 'Synthetic payload byte preflight'
    $msiRoot = Join-Path $artifact 'msi'
    New-Item -ItemType Directory -Path $msiRoot -ErrorAction Stop | Out-Null
    $msi = Join-Path $msiRoot 'LexRunner.WindowsCoordinator.v2.synthetic.msi'
    $positive = Invoke-Bounded 'dotnet.exe' @($builder, $msi, $payload, $manifestSha, $Version, $recipeSha)
    Require-Exit $positive 0 'V2 MSI committed build/readback/audit'
    if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) { throw 'V2 synthetic MSI missing' }
    $msiSha = Digest $msi

    $wrongManifest = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'wrong-manifest/out.msi'),
        $payload, ('0' * 64), $Version, $recipeSha)
    Require-Exit $wrongManifest 3 'Wrong manifest digest refusal'
    $trailingManifest = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'trailing-manifest/out.msi'),
        $payload, ($manifestSha + [char]10), $Version, $recipeSha)
    Require-Exit $trailingManifest 3 'Trailing-LF manifest digest refusal'
    $trailingRecipe = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'trailing-recipe/out.msi'),
        $payload, $manifestSha, $Version, ($recipeSha + [char]10))
    Require-Exit $trailingRecipe 3 'Trailing-LF recipe digest refusal'
    $trailingVersion = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'trailing-version/out.msi'),
        $payload, $manifestSha, ($Version + [char]10), $recipeSha)
    Require-Exit $trailingVersion 3 'Trailing-LF version refusal'
    $overwrite = Invoke-Bounded 'dotnet.exe' @($builder, $msi, $payload, $manifestSha, $Version, $recipeSha)
    Require-Exit $overwrite 3 'MSI output overwrite refusal'

    $extra = New-Fixture 'extra-payload'
    [IO.File]::WriteAllText((Join-Path $extra.Path 'node/unlisted.dll'), 'unlisted', [Text.UTF8Encoding]::new($false))
    $extraResult = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'extra/out.msi'),
        $extra.Path, $manifestSha, $Version, $recipeSha)
    Require-Exit $extraResult 3 'Unexpected payload refusal'
    $missing = New-Fixture 'missing-payload'
    Remove-Item -LiteralPath (Join-Path $missing.Path 'client/client.exe') -ErrorAction Stop
    $missingResult = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'missing/out.msi'),
        $missing.Path, $manifestSha, $Version, $recipeSha)
    Require-Exit $missingResult 3 'Missing payload refusal'
    $noncanonical = New-Fixture 'noncanonical-payload'
    $noncanonicalManifest = Join-Path $noncanonical.Path 'generation-graph.json'
    [IO.File]::AppendAllText($noncanonicalManifest, "`n", [Text.UTF8Encoding]::new($false))
    $noncanonicalResult = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'noncanonical/out.msi'),
        $noncanonical.Path, (Digest $noncanonicalManifest), $Version, $recipeSha)
    Require-Exit $noncanonicalResult 3 'Noncanonical graph refusal'
    $wrongGraph = New-Fixture 'wrong-graph-payload'
    $wrongGraphManifest = Join-Path $wrongGraph.Path 'generation-graph.json'
    $original = [IO.File]::ReadAllText($wrongGraphManifest)
    $changed = $original.Replace(('"graphDigest":"' + $graphDigest + '"'),
        ('"graphDigest":"' + ('0' * 64) + '"'))
    if ($changed -ceq $original) { throw 'Wrong-graph mutation did not change manifest' }
    [IO.File]::WriteAllText($wrongGraphManifest, $changed, [Text.UTF8Encoding]::new($false))
    $wrongGraphResult = Invoke-Bounded 'dotnet.exe' @($builder, (Join-Path $artifact 'wrong-graph/out.msi'),
        $wrongGraph.Path, (Digest $wrongGraphManifest), $Version, $recipeSha)
    Require-Exit $wrongGraphResult 3 'Wrong graph digest refusal'

    foreach ($name in @('wrong-manifest','trailing-manifest','trailing-recipe',
        'trailing-version','extra','missing','noncanonical','wrong-graph')) {
        if (Test-Path -LiteralPath (Join-Path $artifact "$name/out.msi")) {
            throw "Refused $name build left an MSI output"
        }
    }

    if ((Digest $msi) -cne $msiSha) { throw 'V2 MSI changed during offline verification' }
    foreach ($name in $sources) {
        if ((Digest (Join-Path $repository $name)) -cne $sourceHashes[$name]) {
            throw "V2 source changed during verification: $name"
        }
    }
    $outcome = 'synthetic_source_offline_pass'
}
catch {
    $failure = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message
    throw
}
finally {
    $clock.Stop()
    if (Test-Path -LiteralPath $artifact -PathType Container) {
        try {
            foreach ($name in @('builder-obj', 'builder-bin')) {
                if (Test-Path -LiteralPath (Join-Path $artifact $name)) { Remove-Owned $name }
            }
            $cleanup = 'checked_nonce_owned_build_trees_removed'
        }
        catch {
            $cleanup = 'uncertain_retained'
            if (-not $failure) { $failure = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message }
        }
        Json (Join-Path $artifact 'verification-receipt.json') ([ordered]@{
            kind = 'windows-coordinator-v2-msi-synthetic-source-qualification/2'
            repository = $repository
            head = $head
            sourceHashes = $sourceHashes
            recipeSha256 = $recipeSha
            graphDigest = $graphDigest
            manifestSha256 = $manifestSha
            msiSha256 = $msiSha
            msiPath = if ($msiSha) { $msi } else { $null }
            outcome = $outcome
            failure = $failure
            cleanup = $cleanup
            durationMs = $clock.ElapsedMilliseconds
            commands = $commands
            installed = $false
            started = $false
            selected = $false
            productionReady = $false
        })
    }
}
if ($cleanup -eq 'uncertain_retained') { throw "Offline v2 cleanup uncertain: $failure" }
Write-Output "Synthetic offline v2 MSI source qualification passed: $msi"
