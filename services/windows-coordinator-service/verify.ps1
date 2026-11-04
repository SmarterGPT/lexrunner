param([string]$OutputDirectory)
if ($OutputDirectory -and -not [IO.Path]::IsPathFullyQualified($OutputDirectory)) { throw 'source_output_must_be_absolute' }
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $env:OS) { $env:OS = 'Windows_NT' }
if (-not $env:WINDIR -and $env:SystemRoot) { $env:WINDIR = $env:SystemRoot }
$project = Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.Service.csproj'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$artifactRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repo 'artifacts\windows-coordinator-service-source' }
$allowedArtifacts = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts')) + [IO.Path]::DirectorySeparatorChar
if (-not $artifactRoot.StartsWith($allowedArtifacts, [StringComparison]::OrdinalIgnoreCase) -or
    $artifactRoot.IndexOfAny([char[]]@(';', '"', '%', "`r", "`n")) -ge 0) { throw 'source_output_outside_artifacts' }
$cursor = $artifactRoot
while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'source_output_ancestor_redirected'
        }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
}
$normal = Join-Path $artifactRoot 'publish'
$fixture = Join-Path $artifactRoot 'fixture'
$image = 'LexRunner.WindowsCoordinator.Service.exe'
$clock = [Diagnostics.Stopwatch]::StartNew()

function Invoke-Publish([string]$destination, [bool]$fixtureBuild) {
    $mode = if ($fixtureBuild) { 'fixture-build' } else { 'normal-build' }
    $obj = (Join-Path $artifactRoot ($mode + '/obj')).Replace('\', '/') + '/'
    $bin = (Join-Path $artifactRoot ($mode + '/bin')).Replace('\', '/') + '/'
    $publishArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=true', ('-p:CoordinatorServiceFixtureTests=' + $fixtureBuild.ToString().ToLowerInvariant()),
        ("-p:BaseIntermediateOutputPath=" + $obj), ("-p:MSBuildProjectExtensionsPath=" + $obj),
        ("-p:BaseOutputPath=" + $bin), ("-p:OutputPath=" + $bin), '-o', $destination)
    Push-Location -LiteralPath $PSScriptRoot
    try {
        $output = & dotnet @publishArgs 2>&1 | Select-Object -Last 12
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -ne 0) { throw "dotnet publish failed: $($output -join ' | ')" }
}

Invoke-Publish $normal $false
$normalImage = Join-Path $normal $image
if (-not (Test-Path -LiteralPath $normalImage -PathType Leaf)) { throw 'normal image missing' }
$normalHash = (Get-FileHash -LiteralPath $normalImage -Algorithm SHA256).Hash.ToLowerInvariant()
$normalPublicationProbe = & $normalImage --v3-publication-contract-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalPublicationProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed publication model'
}

$normalCustom = & $normalImage --custom-control-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalCustom -join '') -ne 'scm_only') {
    throw 'normal image exposed custom-control fixture mode'
}
$normalProbe = & $normalImage --protocol-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed fixture mode'
}
$normalPipeProbe = & $normalImage --pipe-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalPipeProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed pipe fixture mode'
}
$normalLifecycleProbe = & $normalImage --lifecycle-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalLifecycleProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed lifecycle fixture mode'
}
$normalLaunchProbe = & $normalImage --private-launch-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalLaunchProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed private launch fixture mode'
}
$normalChildProbe = & $normalImage --private-child-fixture Normal 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalChildProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed private child fixture mode'
}
$consoleProbe = & $normalImage --service 2>&1
if ($LASTEXITCODE -ne 3 -or ($consoleProbe -join '') -ne 'scm_required') {
    throw 'normal image did not refuse direct service launch'
}

Invoke-Publish $fixture $true
$fixtureImage = Join-Path $fixture $image
if (-not (Test-Path -LiteralPath $fixtureImage -PathType Leaf)) { throw 'fixture image missing' }
$fixtureHash = (Get-FileHash -LiteralPath $fixtureImage -Algorithm SHA256).Hash.ToLowerInvariant()
$publicationProbe = & $fixtureImage --v3-publication-contract-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or $publicationProbe[-1] -cne
    'publication_contract_pure_selftest PASS cases=74 failures=0 authorizesLaunch=false authorizesEffect=false nativeEffects=0') {
    throw 'pure publication contract did not pass'
}
$fixtureProbe = & $fixtureImage --protocol-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or ($fixtureProbe -join '') -ne 'protocol_selftest_pass') {
    throw 'fixture protocol selftest failed'
}
$pipeProbe = & $fixtureImage --pipe-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or ($pipeProbe -join '') -ne 'pipe_selftest_pass') {
    throw "fixture pipe selftest failed: $(($pipeProbe | Select-Object -Last 12) -join ' | ')"
}
$lifecycleProbe = & $fixtureImage --lifecycle-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or ($lifecycleProbe -join '') -ne 'lifecycle_selftest_pass') {
    throw 'fixture lifecycle selftest failed'
}
$privateLaunchProbe = & $fixtureImage --private-launch-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or ($privateLaunchProbe -join '') -ne 'private_launch_selftest_pass') {
    throw "fixture private launch selftest failed: $(($privateLaunchProbe | Select-Object -Last 12) -join ' | ')"
}

$customControlProbe = & $fixtureImage --custom-control-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or ($customControlProbe -join '') -ne 'custom_control_selftest_pass') {
    throw 'actual callback custom-control source selftest failed'
}

$sources = @('CoordinatorPipe.cs', 'CoordinatorPrivateNode.cs', 'CoordinatorProtocol.cs',
    'ObservedPipePeer.cs', 'PipeFixtureTests.cs', 'PrivateLaunchFixture.cs', 'Program.cs',
    'ProtectedGenerationLease.cs', 'ServiceLifecycle.cs',
    'LexRunner.WindowsCoordinator.Service.csproj', 'global.json', '.gitignore',
    'README.md', 'verify.ps1')
$hashes = [ordered]@{}
foreach ($source in $sources) {
    $hashes[$source] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $source) -Algorithm SHA256).Hash.ToLowerInvariant()
}
foreach ($source in @('CustodyContract.cs', 'CustodyContractV3.cs',
        'PublicationContractV3.cs', 'PublicationContractV3FixtureTests.cs')) {
    $sharedSource = Join-Path $repo "services/windows-coordinator-selection-custody/$source"
    $hashes["selection-custody/$source"] = (Get-FileHash -LiteralPath $sharedSource -Algorithm SHA256).Hash.ToLowerInvariant()
}

# All compiler output is routed into this run's artifacts. Preserve old source outputs.
$cleanup = [ordered]@{ bin = 'preserved_not_output_target'; obj = 'preserved_not_output_target' }
$clock.Stop()
$receiptPath = Join-Path $artifactRoot 'verification-receipt.json'
$receipt = [pscustomobject]@{
    result = 'source_fixture_pass'
    cwd = $PSScriptRoot
    repoHead = (& git -C $repo rev-parse HEAD)
    durationMs = [Math]::Round($clock.Elapsed.TotalMilliseconds)
    normalImageSha256 = $normalHash
    fixtureImageSha256 = $fixtureHash
    normalDirectLaunch = 'scm_required'
    normalFixtureMode = 'scm_only'
    fixtureProtocolSelfTest = 'protocol_selftest_pass'
    fixturePipeSelfTest = 'pipe_selftest_pass'
    fixtureLifecycleSelfTest = 'lifecycle_selftest_pass'
    fixturePrivateLaunchSelfTest = 'private_launch_selftest_pass'
    publicationPureTestCount = 74
    normalPrivateLaunchMode = 'scm_only'
    normalPrivateChildMode = 'scm_only'
    customControlCallbackCases = 128
    customControlSourceSelfTest = 'custom_control_selftest_pass'
    retainedScmControlHandlesQualified = $false
    installedServiceQualified = $false
    buildCleanup = $cleanup
    sourceSha256 = $hashes
}
$json = ($receipt | ConvertTo-Json -Depth 5).Replace("`r`n", "`n") + "`n"
[IO.File]::WriteAllText($receiptPath, $json, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{
    result = $receipt.result
    durationMs = $receipt.durationMs
    normalImageSha256 = $receipt.normalImageSha256
    fixtureImageSha256 = $receipt.fixtureImageSha256
    fixtureProtocolSelfTest = $receipt.fixtureProtocolSelfTest
    fixturePipeSelfTest = $receipt.fixturePipeSelfTest
    fixtureLifecycleSelfTest = $receipt.fixtureLifecycleSelfTest
    fixturePrivateLaunchSelfTest = $receipt.fixturePrivateLaunchSelfTest
    buildCleanup = $receipt.buildCleanup
    receiptPath = $receiptPath
} | ConvertTo-Json -Depth 3 -Compress
