$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $env:OS) { $env:OS = 'Windows_NT' }
$project = Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.Service.csproj'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$artifactRoot = Join-Path $repo 'artifacts\windows-coordinator-service-source'
$normal = Join-Path $artifactRoot 'publish'
$fixture = Join-Path $artifactRoot 'fixture'
$image = 'LexRunner.WindowsCoordinator.Service.exe'
$clock = [Diagnostics.Stopwatch]::StartNew()

function Invoke-Publish([string]$destination, [bool]$fixtureBuild) {
    $publishArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64',
        '-p:NuGetAudit=false', ('-p:CoordinatorServiceFixtureTests=' + $fixtureBuild.ToString().ToLowerInvariant()),
        '-o', $destination)
    $output = & dotnet @publishArgs 2>&1 | Select-Object -Last 12
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed: $($output -join ' | ')" }
}

Invoke-Publish $normal $false
$normalImage = Join-Path $normal $image
if (-not (Test-Path -LiteralPath $normalImage -PathType Leaf)) { throw 'normal image missing' }
$normalHash = (Get-FileHash -LiteralPath $normalImage -Algorithm SHA256).Hash.ToLowerInvariant()

$normalProbe = & $normalImage --protocol-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed fixture mode'
}
$normalLifecycleProbe = & $normalImage --lifecycle-selftest 2>&1
if ($LASTEXITCODE -ne 2 -or ($normalLifecycleProbe -join '') -ne 'scm_only') {
    throw 'normal image exposed lifecycle fixture mode'
}
$consoleProbe = & $normalImage --service 2>&1
if ($LASTEXITCODE -ne 3 -or ($consoleProbe -join '') -ne 'scm_required') {
    throw 'normal image did not refuse direct service launch'
}

Invoke-Publish $fixture $true
$fixtureImage = Join-Path $fixture $image
if (-not (Test-Path -LiteralPath $fixtureImage -PathType Leaf)) { throw 'fixture image missing' }
$fixtureHash = (Get-FileHash -LiteralPath $fixtureImage -Algorithm SHA256).Hash.ToLowerInvariant()
$fixtureProbe = & $fixtureImage --protocol-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or ($fixtureProbe -join '') -ne 'protocol_selftest_pass') {
    throw 'fixture protocol selftest failed'
}
$lifecycleProbe = & $fixtureImage --lifecycle-selftest 2>&1
if ($LASTEXITCODE -ne 0 -or ($lifecycleProbe -join '') -ne 'lifecycle_selftest_pass') {
    throw 'fixture lifecycle selftest failed'
}

$sources = @('CoordinatorPipe.cs', 'CoordinatorProtocol.cs', 'Program.cs', 'ServiceLifecycle.cs',
    'LexRunner.WindowsCoordinator.Service.csproj', 'global.json', '.gitignore',
    'README.md', 'verify.ps1')
$hashes = [ordered]@{}
foreach ($source in $sources) {
    $hashes[$source] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $source) -Algorithm SHA256).Hash.ToLowerInvariant()
}

# The build tools write bin/obj even when they are ignored by Git. Remove only
# these two exact project-owned roots after image and source hashes are captured
# so repository-wide formatters cannot scan stale generated JSON.
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$cleanup = [ordered]@{}
foreach ($leaf in @('bin', 'obj')) {
    $expected = [IO.Path]::GetFullPath((Join-Path $sourceRoot $leaf))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($expected), $sourceRoot,
            [StringComparison]::OrdinalIgnoreCase)) { throw 'build cleanup escaped source root' }
    if (-not (Test-Path -LiteralPath $expected)) {
        $cleanup[$leaf] = 'absent'
        continue
    }
    $item = Get-Item -LiteralPath $expected -Force
    if (-not $item.PSIsContainer -or
        -not [string]::Equals($item.FullName, $expected, [StringComparison]::OrdinalIgnoreCase) -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "unsafe build cleanup target: $leaf"
    }
    $links = @(Get-ChildItem -LiteralPath $item.FullName -Force -Recurse |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($links.Count -gt 0) { throw "reparse point in build cleanup target: $leaf" }
    Remove-Item -LiteralPath $item.FullName -Force -Recurse
    if (Test-Path -LiteralPath $expected) { throw "build cleanup failed: $leaf" }
    $cleanup[$leaf] = 'removed'
}
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
    fixtureLifecycleSelfTest = 'lifecycle_selftest_pass'
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
    fixtureLifecycleSelfTest = $receipt.fixtureLifecycleSelfTest
    buildCleanup = $receipt.buildCleanup
    receiptPath = $receiptPath
} | ConvertTo-Json -Depth 3 -Compress
