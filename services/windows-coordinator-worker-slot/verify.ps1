$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $env:OS) { $env:OS = 'Windows_NT' }
if (-not $env:WINDIR -and $env:SystemRoot) { $env:WINDIR = $env:SystemRoot }
if (-not [OperatingSystem]::IsWindows() -or [IntPtr]::Size -ne 8) {
    throw 'Windows x64 source gate required'
}

$project = Join-Path $PSScriptRoot 'LexRunner.WindowsCoordinator.WorkerSlot.csproj'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$artifact = Join-Path $repo 'artifacts\windows-coordinator-worker-slot-source'
$normal = Join-Path $artifact 'normal'
$fixture = Join-Path $artifact 'fixture'
$image = 'LexRunner.WindowsCoordinator.WorkerSlot.exe'
New-Item -ItemType Directory -Path $artifact -Force | Out-Null
$commands = [Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()

function Invoke-Recorded([string]$file, [string[]]$arguments, [string]$cwd) {
    Push-Location -LiteralPath $cwd
    try {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $output = (& $file @arguments 2>&1 | Out-String)
        $code = $LASTEXITCODE
        $watch.Stop()
    }
    finally { Pop-Location }
    $bytes = [Text.Encoding]::UTF8.GetBytes($output)
    if ($bytes.Length -gt 65536) { throw 'worker slot verification output bound exceeded' }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $result = [pscustomobject]@{
        command = $file
        arguments = $arguments
        cwd = $cwd
        durationMs = [Math]::Round($watch.Elapsed.TotalMilliseconds)
        exitCode = $code
        outputBytes = $bytes.Length
        outputSha256 = $hash
        outputTail = $output.Substring([Math]::Max(0, $output.Length - 384))
    }
    $commands.Add($result)
    return $result
}

$normalBuild = Invoke-Recorded 'dotnet' @('publish', $project, '-c', 'Release',
    '-r', 'win-x64', '-p:NuGetAudit=false', '-p:WorkerSlotFixtureTests=false',
    '-o', $normal, '--nologo') $PSScriptRoot
if ($normalBuild.exitCode -ne 0) { throw 'normal NativeAOT worker slot publish failed' }
$normalImage = Join-Path $normal $image
if (-not (Test-Path -LiteralPath $normalImage -PathType Leaf)) { throw 'normal worker slot image missing' }
$normalHash = (Get-FileHash -LiteralPath $normalImage -Algorithm SHA256).Hash.ToLowerInvariant()

$normalPolicy = Invoke-Recorded $normalImage @('--policy-selftest') $PSScriptRoot
$normalToken = Invoke-Recorded $normalImage @('--token-refusal-selftest') $PSScriptRoot
$normalConsole = Invoke-Recorded $normalImage @('--service') $PSScriptRoot
if ($normalPolicy.exitCode -ne 2 -or $normalPolicy.outputTail.Trim() -cne 'scm_only' -or
    $normalToken.exitCode -ne 2 -or $normalToken.outputTail.Trim() -cne 'scm_only' -or
    $normalConsole.exitCode -ne 3 -or $normalConsole.outputTail.Trim() -cne 'scm_required') {
    throw 'normal worker slot image exposed a fixture or direct-launch route'
}

$fixtureBuild = Invoke-Recorded 'dotnet' @('publish', $project, '-c', 'Release',
    '-r', 'win-x64', '-p:NuGetAudit=false', '-p:WorkerSlotFixtureTests=true',
    '-o', $fixture, '--nologo') $PSScriptRoot
if ($fixtureBuild.exitCode -ne 0) { throw 'fixture NativeAOT worker slot publish failed' }
$fixtureImage = Join-Path $fixture $image
if (-not (Test-Path -LiteralPath $fixtureImage -PathType Leaf)) { throw 'fixture worker slot image missing' }
$fixtureHash = (Get-FileHash -LiteralPath $fixtureImage -Algorithm SHA256).Hash.ToLowerInvariant()

$policy = Invoke-Recorded $fixtureImage @('--policy-selftest') $PSScriptRoot
$token = Invoke-Recorded $fixtureImage @('--token-refusal-selftest') $PSScriptRoot
$fixtureConsole = Invoke-Recorded $fixtureImage @('--service') $PSScriptRoot
if ($policy.exitCode -ne 0 -or $policy.outputTail.Trim() -cne 'policy_selftest_pass' -or
    $token.exitCode -ne 0 -or $token.outputTail.Trim() -cne 'token_refusal_selftest_pass' -or
    $fixtureConsole.exitCode -ne 3 -or $fixtureConsole.outputTail.Trim() -cne 'scm_required') {
    throw 'fixture worker slot source gate failed'
}

$sources = @('.gitignore', 'global.json', 'LexRunner.WindowsCoordinator.WorkerSlot.csproj',
    'Program.cs', 'WorkerSlotTokenPolicy.cs', 'WorkerSlotFixtureTests.cs', 'README.md', 'verify.ps1')
$hashes = [ordered]@{}
foreach ($source in $sources) {
    $hashes[$source] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $source) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$clock.Stop()
$receipt = [pscustomobject]@{
    schemaVersion = 'lexrunner-worker-slot-source/1'
    result = 'source_fixture_pass'
    sourceHead = (& git -C $repo rev-parse HEAD)
    sourceCwd = $PSScriptRoot
    durationMs = [Math]::Round($clock.Elapsed.TotalMilliseconds)
    normalImageSha256 = $normalHash
    fixtureImageSha256 = $fixtureHash
    commands = $commands
    sourceSha256 = $hashes
    installed = $false
    serviceInstalled = $false
    workerLaunched = $false
    filesystemQualified = $false
    authorizesExecution = $false
    helperMissingCleared = $false
}
$receiptPath = Join-Path $artifact 'verification-receipt.json'
$json = ($receipt | ConvertTo-Json -Depth 8).Replace("`r`n", "`n") + "`n"
[IO.File]::WriteAllText($receiptPath, $json, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{
    result = $receipt.result
    durationMs = $receipt.durationMs
    normalImageSha256 = $normalHash
    fixtureImageSha256 = $fixtureHash
    commandCount = $commands.Count
    installed = $receipt.installed
    serviceInstalled = $receipt.serviceInstalled
    authorizesExecution = $receipt.authorizesExecution
    receiptPath = $receiptPath
} | ConvertTo-Json -Compress
