[CmdletBinding()]
param(
    [string]$FixtureParent = [IO.Path]::GetTempPath(),
    [string]$GitExecutable = (Get-Command git.exe -ErrorAction Stop).Source,
    [string]$HelperExecutable = ''
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows is required' }
if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This qualification profile requires native Windows x64' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
$proofRoot = $PSScriptRoot
$repoRoot = [IO.Path]::GetFullPath((Join-Path $proofRoot '..\..'))
$fixtureRoot = [IO.Path]::GetFullPath($FixtureParent)
$filesystem = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($fixtureRoot)).DriveFormat
if ($filesystem -notin @('NTFS', 'ReFS')) { throw "Unsupported qualification filesystem: $filesystem" }
$artifacts = Join-Path $proofRoot "artifacts\removal\$($filesystem.ToLowerInvariant())"
if (-not [IO.Path]::IsPathFullyQualified($FixtureParent) -or -not (Test-Path -LiteralPath $fixtureRoot -PathType Container)) {
    throw 'FixtureParent must be an explicitly selected existing absolute directory'
}
if (-not [IO.Path]::IsPathFullyQualified($GitExecutable) -or -not (Test-Path -LiteralPath $GitExecutable -PathType Leaf)) {
    throw 'GitExecutable must name an existing absolute native executable'
}
if ($HelperExecutable -and (-not [IO.Path]::IsPathFullyQualified($HelperExecutable) -or -not (Test-Path -LiteralPath $HelperExecutable -PathType Leaf))) {
    throw 'HelperExecutable must name an explicitly selected existing absolute executable'
}
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$sourceHead = (& git.exe -C $repoRoot rev-parse HEAD).Trim()
$sourceDirty = @(& git.exe -C $repoRoot status --porcelain).Count -gt 0
$commands = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{
    schemaVersion = 'windows-native-removal-qualification/1'
    sourceHead = $sourceHead
    sourceDirty = $sourceDirty
    fixtureParent = $fixtureRoot
    filesystem = $filesystem
    architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    operatingSystem = [Runtime.InteropServices.RuntimeInformation]::OSDescription
    osVersion = [Environment]::OSVersion.Version.ToString()
    nodeVersion = (& node.exe --version).Trim()
    gitVersion = (& $GitExecutable --version).Trim()
    productionReady = $false
    verificationAuthority = 'not_established'
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    outcome = 'failed'
    commands = $commands
}
function Invoke-Recorded([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
    $log = Join-Path $artifacts "$Name.log"
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $started = [DateTimeOffset]::UtcNow.ToString('o')
    Push-Location $WorkingDirectory
    try { & $Executable @Arguments *> $log; $code = $LASTEXITCODE }
    finally { Pop-Location; $clock.Stop() }
    $tail = (Get-Content -LiteralPath $log -Tail 12) -join "`n"
    if ($tail.Length -gt 2048) { $tail = $tail.Substring($tail.Length - 2048) }
    $commands.Add([ordered]@{
        command = @($Executable) + $Arguments; cwd = $WorkingDirectory; commit = $sourceHead
        startedAt = $started; durationMs = $clock.ElapsedMilliseconds; exitCode = $code
        outputTail = $tail; log = $log; logSha256 = (Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLowerInvariant()
    })
    if ($code -ne 0) { throw "$Name failed with exit $code; inspect $log" }
}
$names = @('LEXRUNNER_TEST_NATIVE_HELPER', 'LEXRUNNER_TEST_REMOVAL_FAULT_HELPER', 'LEXRUNNER_TEST_GIT_EXE', 'LEXRUNNER_TEST_GIT', 'LEXRUNNER_TEST_REMOVAL_ROOT')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    if (-not $HelperExecutable) {
        Invoke-Recorded 'publish-helper' 'dotnet.exe' @('publish', 'src/LexRunner.WindowsBoundary.Helper/LexRunner.WindowsBoundary.Helper.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', (Join-Path $artifacts 'helper')) $proofRoot
        $HelperExecutable = Join-Path $artifacts 'helper\lexrunner-windows-boundary-helper.exe'
    }
    Invoke-Recorded 'publish-fault-probe' 'dotnet.exe' @('publish', 'tests/RemovalSessionProbe/RemovalSessionProbe.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', (Join-Path $artifacts 'fault-probe')) $proofRoot
    Invoke-Recorded 'build-tree-probe' 'dotnet.exe' @('build', 'tests/RemovalLeaseProbe/RemovalLeaseProbe.csproj', '-c', 'Release', '--nologo') $proofRoot
    $treeProbe = Join-Path $proofRoot 'tests\RemovalLeaseProbe\bin\Release\net8.0\RemovalLeaseProbe.exe'
    Invoke-Recorded 'tree-probe' $treeProbe @($fixtureRoot, $GitExecutable) $proofRoot
    $env:LEXRUNNER_TEST_NATIVE_HELPER = $HelperExecutable
    $env:LEXRUNNER_TEST_REMOVAL_FAULT_HELPER = Join-Path $artifacts 'fault-probe\lexrunner-windows-removal-session-probe.exe'
    $env:LEXRUNNER_TEST_GIT_EXE = $GitExecutable
    $env:LEXRUNNER_TEST_GIT = $GitExecutable
    $env:LEXRUNNER_TEST_REMOVAL_ROOT = $fixtureRoot
    $receipt.helperSha256 = (Get-FileHash -LiteralPath $env:LEXRUNNER_TEST_NATIVE_HELPER -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.faultProbeSha256 = (Get-FileHash -LiteralPath $env:LEXRUNNER_TEST_REMOVAL_FAULT_HELPER -Algorithm SHA256).Hash.ToLowerInvariant()
    $testReport = Join-Path $artifacts 'native-tests.json'
    Invoke-Recorded 'native-session-tests' 'npx.cmd' @('vitest', 'run', 'tests/workspaces/windows-native-removal.spec.ts', 'tests/workspaces/windows-native-helper.spec.ts', 'tests/workspaces/windows-native-directory.spec.ts', 'tests/workspaces/node-git-worktree-native.spec.ts', 'tests/workspaces/owned-windows-workspace-lease.spec.ts', 'tests/workspaces/owned-windows-directory-session.spec.ts', 'tests/workspaces/owned-windows-directory.spec.ts', '--maxWorkers=1', '--reporter=verbose', '--reporter=json', "--outputFile.json=$testReport") $repoRoot
    $tests = Get-Content -LiteralPath $testReport -Raw | ConvertFrom-Json
    $removalCases = @($tests.testResults | Where-Object { $_.name.EndsWith('windows-native-removal.spec.ts') } | ForEach-Object { $_.assertionResults })
    if ($removalCases.Count -lt 18 -or @($removalCases | Where-Object { $_.status -ne 'passed' }).Count -ne 0) {
        throw 'Actual removal qualification must execute every required case without skips'
    }
    $receipt.nativeRemovalTests = $removalCases.Count
    $receipt.nativeTestsPassed = $tests.numPassedTests
    $receipt.nativeTestsPending = $tests.numPendingTests
    $receipt.outcome = 'passed'
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    $receipt.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $artifacts 'qualification-receipt.json') -Encoding utf8NoBOM
}
Write-Output "Native removal qualification passed ($($receipt.filesystem)); receipt: $(Join-Path $artifacts 'qualification-receipt.json')"
