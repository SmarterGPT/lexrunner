[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 required' }
if (-not $env:OS) { $env:OS = 'Windows_NT' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helper = Join-Path $repo 'services/windows-coordinator-selection-publisher/VerifierBoundedProcess.cs'
Add-Type -Path $helper
function Require([bool]$condition, [string]$reason) { if (-not $condition) { throw $reason } }
function Plain-Chain([string]$path) {
    $cursor = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($path))
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        Require ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Source output ancestor redirected'
        $next = [IO.Path]::GetDirectoryName($cursor)
        if (-not $next -or $next -ieq $cursor) { break }
        $cursor = $next
    }
}
function Source-Hashes {
    $hashes = [ordered]@{}
    foreach ($relative in @(
        'tests/PublicationStoragePure.cs', 'tests/PublicationStoragePure.csproj', 'tests/global.json',
        'tests/.gitignore', 'tests/Verify-PublicationStorageSource.ps1',
        'services/windows-coordinator-selection-custody/CustodyContract.cs',
        'services/windows-coordinator-selection-custody/CustodyContractV3.cs',
        'services/windows-coordinator-selection-custody/PublicationContractV3.cs',
        'services/windows-coordinator-selection-custody/PublicationContractV3FixtureTests.cs',
        'services/windows-coordinator-selection-custody/NativeRegistryReaderV3.cs',
        'services/windows-coordinator-selection-custody/NativeInstalledPublicationReader.cs',
        'services/windows-coordinator-selection-publisher/NativeProtectedPublicationStore.cs',
        'services/windows-coordinator-selection-publisher/NativePublicationAdministration.cs',
        'services/windows-coordinator-selection-publisher/NativePublicationMutex.cs',
        'services/windows-coordinator-selection-publisher/PublicationAdminEntrypoint.cs',
        'services/windows-coordinator-selection-publisher/VerifierBoundedProcess.cs')) {
        $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $repo $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $hashes
}
$commands = [Collections.Generic.List[object]]::new()
function Step([string]$name, [string]$executable, [string[]]$arguments, [int]$timeout) {
    $start = [Diagnostics.ProcessStartInfo]::new($executable)
    $start.WorkingDirectory = $PSScriptRoot
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in $arguments) { [void]$start.ArgumentList.Add($argument) }
    $result = [SelectionPublisherVerifierProcess]::Run($start, $timeout, 65536, 16384)
    $row = [ordered]@{name=$name;command=@($executable)+$arguments;cwd=$PSScriptRoot;head=$script:head;
        durationMs=$result.DurationMs;outcome=$result.Outcome.ToString();exitCode=$result.ExitCode;
        stdout=$result.Stdout;stderr=$result.Stderr;outputBytes=$result.TotalOutputBytes;
        captureTruncated=$result.CaptureTruncated;directChildExitedAndStreamsDrained=($result.Outcome.ToString() -eq 'Exited')}
    $commands.Add($row)
    Require ($row.directChildExitedAndStreamsDrained -and -not $row.captureTruncated -and $row.exitCode -eq 0) "Pure source step failed: $name"
    $row
}
$parent = Join-Path $repo 'artifacts/windows-publication-storage-source'
Plain-Chain (Split-Path -Parent $parent)
if (-not (Test-Path -LiteralPath $parent)) { [SelectionPublisherVerifierFiles]::CreateNewDirectory($parent) }
Plain-Chain $parent
$nonce = [Guid]::NewGuid().ToString('N')
$run = Join-Path $parent ('qualification-' + $nonce)
Require (-not (Test-Path -LiteralPath $run)) 'Pure source output occupied'
[SelectionPublisherVerifierFiles]::CreateNewDirectory($run)
Plain-Chain $run
$watch = [Diagnostics.Stopwatch]::StartNew()
$head = $null; $before = $null; $after = $null; $failure = $null; $pureSha = $null
try {
    $git = (Get-Command git.exe).Source
    $headRead = Step 'head-before' $git @('-C', $repo, 'rev-parse', 'HEAD') 30000
    Require ($headRead.stdout -cmatch '\A[0-9a-f]{40}\r?\n\z' -and $headRead.stderr.Length -eq 0) 'Exact source head unavailable'
    $head = $headRead.stdout.Substring(0, 40)
    $commands[0]['head'] = $head
    $before = Source-Hashes
    $publish = Join-Path $run 'publish'; $bin = Join-Path $run 'build-bin'; $obj = Join-Path $run 'build-obj'
    foreach ($path in @($publish, $bin, $obj)) { [SelectionPublisherVerifierFiles]::CreateNewDirectory($path) }
    $publishArguments = @('publish', (Join-Path $PSScriptRoot 'PublicationStoragePure.csproj'), '-c', 'Release', '-r', 'win-x64', '-p:NuGetAudit=true',
        "-p:BaseIntermediateOutputPath=$obj\", "-p:MSBuildProjectExtensionsPath=$obj\", "-p:BaseOutputPath=$bin\", "-p:OutputPath=$bin\", '-o', $publish, '-v:q')
    $null = Step 'publish-pure-harness' (Get-Command dotnet.exe).Source $publishArguments 120000
    $image = Join-Path $publish 'PublicationStoragePure.exe'
    $pureSha = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant()
    # The only test executable invoked here uses fake storage/mutex ports and
    # data parsers. No admin/preview/service/registry/mutex/native route runs.
    $result = Step 'publication-storage-fake-only' $image @() 30000
    Require ($result.stderr.Length -eq 0 -and $result.stdout.TrimEnd().EndsWith(
        'publication_storage_pure PASS cases=120 historicalModel=74 nativeEffects=0 authority=false', [StringComparison]::Ordinal)) 'Exact pure result missing'
    $headAfter = Step 'head-after' $git @('-C', $repo, 'rev-parse', 'HEAD') 30000
    Require ($headAfter.stdout -cmatch '\A[0-9a-f]{40}\r?\n\z' -and $headAfter.stdout.Substring(0,40) -ceq $head -and $headAfter.stderr.Length -eq 0) 'Source head changed'
    $after = Source-Hashes
    Require (($before|ConvertTo-Json -Compress) -ceq ($after|ConvertTo-Json -Compress)) 'Pure source changed'
} catch { $failure = $_.Exception.Message }
finally {
    $watch.Stop()
    $receipt = [ordered]@{schemaVersion='windows-publication-storage-pure/1';result=$(if($failure){'failed'}else{'pure_source_pass'});
        cwd=$PSScriptRoot;repoHead=$head;runNonce=$nonce;durationMs=$watch.ElapsedMilliseconds;error=$failure;
        commands=$commands;sourceSha256Before=$before;sourceSha256After=$after;pureImageSha256=$pureSha;
        storagePureCases=$(if($failure){$null}else{120});historicalModelCases=$(if($failure){$null}else{74});
        nativePublicationEntryPointsInvokedByVerifier=$false;authorizesExecution=$false;installedAuthority=$false;helperMissingCleared=$false;outputsRetained=$true}
    $destination = Join-Path $run 'verification-receipt.json'
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Depth 12).Replace("`r`n","`n")+"`n")
    $stream = [IO.FileStream]::new($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
}
if ($failure) { throw "Publication pure source failed: $failure; receipt: $destination" }
Write-Output "Publication pure source passed; receipt: $destination"
