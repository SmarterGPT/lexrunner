$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The Windows coordinator console probe must run on Windows.'
}

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..\..'))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts\windows-coordinator-host-probe'))
$publishRoot = Join-Path $artifactRoot 'publish'
$image = Join-Path $publishRoot 'lexrunner-windows-coordinator-host.exe'
$bridgePublishRoot = Join-Path $artifactRoot 'bridge-publish'
$bridgeImage = Join-Path $bridgePublishRoot 'lexrunner-windows-coordinator-host.exe'
$nodeArtifactRoot = Join-Path $artifactRoot 'node'
$workerImage = Join-Path $nodeArtifactRoot 'private-admission-worker.mjs'
$receiptPath = Join-Path $artifactRoot 'verification-receipt.json'
$oldOS = $env:OS
$oldWindir = $env:WINDIR
$oldImage = $env:LEXRUNNER_TEST_COORDINATOR_HOST
$oldBridgeImage = $env:LEXRUNNER_TEST_COORDINATOR_BRIDGE_HOST
$oldNodeImage = $env:LEXRUNNER_TEST_COORDINATOR_NODE
$oldWorkerImage = $env:LEXRUNNER_TEST_COORDINATOR_WORKER
$oldFixtureRoot = $env:LEXRUNNER_TEST_COORDINATOR_ROOT
$oldFixtureVolume = $env:LEXRUNNER_TEST_COORDINATOR_VOLUME
$sourceHead = $null
$sourceDirty = $null
$sourceSnapshot = $null
$sourceUnchanged = $null
$ciWorkflowSha256 = $null
$publishResult = $null
$bridgePublishResult = $null
$workerTypecheckResult = $null
$workerBuildResult = $null
$testResult = $null
$packageResult = $null
$imageSha256 = $null
$imageBytes = $null
$bridgeImageSha256 = $null
$bridgeImageBytes = $null
$workerSha256 = $null
$workerBytes = $null
$fixtureVolume = $null
$failure = $null
$started = [Diagnostics.Stopwatch]::StartNew()

function Assert-ExactArtifactDirectory([string] $directory) {
  $absolute = [IO.Path]::GetFullPath($directory)
  if (-not (Test-Path -LiteralPath $absolute)) {
    New-Item -ItemType Directory -Path $absolute -Force | Out-Null
  }
  $item = Get-Item -LiteralPath $absolute -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Artifact directory is not an ordinary directory.'
  }
  $resolved = (Resolve-Path -LiteralPath $absolute).ProviderPath
  if (-not [string]::Equals([IO.Path]::GetFullPath($resolved), $absolute,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Artifact directory resolved outside its exact target.'
  }
}

function Clear-ExactArtifactFile([string] $target, [string] $parent) {
  $absolute = [IO.Path]::GetFullPath($target)
  $expectedParent = [IO.Path]::GetFullPath($parent)
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($absolute), $expectedParent,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Artifact file escaped its intended directory.'
  }
  if (-not (Test-Path -LiteralPath $absolute)) { return }
  $item = Get-Item -LiteralPath $absolute -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Artifact file is not an ordinary file.'
  }
  $resolved = (Resolve-Path -LiteralPath $absolute).ProviderPath
  if (-not [string]::Equals([IO.Path]::GetFullPath($resolved), $absolute,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Artifact file resolved outside its exact target.'
  }
  Remove-Item -LiteralPath $absolute -Force
}

function Remove-CheckedBuildDirectory([string] $name) {
  $target = [IO.Path]::GetFullPath((Join-Path $projectRoot $name))
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $projectRoot,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build output cleanup escaped the project directory.'
  }
  if (-not (Test-Path -LiteralPath $target)) { return }
  $resolved = (Resolve-Path -LiteralPath $target).ProviderPath
  if (-not [string]::Equals([IO.Path]::GetFullPath($resolved), $target,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build output cleanup resolved outside its exact target.'
  }
  $item = Get-Item -LiteralPath $target -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Build output cleanup target is a reparse point.'
  }
  $descendants = Get-ChildItem -LiteralPath $target -Recurse -Force
  if ($descendants | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }) {
    throw 'Build output cleanup contains a reparse point.'
  }
  Remove-Item -LiteralPath $target -Recurse -Force
}

function Invoke-BoundedNative([string] $file, [string[]] $arguments, [string] $cwd) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $hasher = [Security.Cryptography.IncrementalHash]::CreateHash(
    [Security.Cryptography.HashAlgorithmName]::SHA256)
  $tail = [Text.StringBuilder]::new()
  $lineCount = 0
  $outputBytes = 0
  Push-Location $cwd
  try {
    & $file @arguments 2>&1 | ForEach-Object {
      $line = [string]$_
      $encoded = [Text.Encoding]::UTF8.GetBytes($line + "`n")
      $hasher.AppendData($encoded)
      $lineCount++
      $outputBytes += $encoded.Length
      [void]$tail.AppendLine($line)
      if ($tail.Length -gt 4096) { [void]$tail.Remove(0, $tail.Length - 4096) }
    }
    $code = $LASTEXITCODE
  }
  finally {
    Pop-Location
    $clock.Stop()
  }
  $outputHash = [Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant()
  $hasher.Dispose()
  return [ordered]@{
    command = @($file) + $arguments
    cwd = $cwd
    duration_ms = $clock.ElapsedMilliseconds
    exit_code = $code
    output_line_count = $lineCount
    output_bytes = $outputBytes
    output_sha256 = $outputHash
    output_tail = $tail.ToString()
  }
}

function Get-SourceSnapshot {
  # Fixed review surface for this console probe. The candidate digest covers
  # exact source/test bytes, including this verifier, even before git staging.
  $paths = @(
    'services/windows-coordinator-host/.gitignore',
    'services/windows-coordinator-host/LexRunner.WindowsCoordinator.Host.csproj',
    'services/windows-coordinator-host/PrivateNodeChild.cs',
    'services/windows-coordinator-host/Program.cs',
    'services/windows-coordinator-host/README.md',
    'services/windows-coordinator-host/global.json',
    'services/windows-coordinator-host/node/private-admission-worker.ts',
    'services/windows-coordinator-host/verify.ps1',
    'package.json',
    'scripts/validate-package-boundary.ts',
    'src/schemas/agent-work.ts',
    'src/util/canonicalJson.ts',
    'src/windows-coordinator/admission-contract.ts',
    'src/windows-coordinator/client-protocol.ts',
    'src/windows-coordinator/deny-first-dispatcher.ts',
    'src/windows-coordinator/private-admission-bridge.ts',
    'src/windows-coordinator/private-peer-protocol.ts',
    'src/windows-coordinator/sqlite-admission-store.ts',
    'tests/windows-coordinator/client-protocol.spec.ts',
    'tests/windows-coordinator/native-peer-probe.spec.ts',
    'tests/windows-coordinator/native-private-admission.spec.ts',
    'tests/windows-coordinator/private-admission-bridge.spec.ts',
    'tsup.config.ts'
  )
  $files = @()
  $digestInput = [Text.StringBuilder]::new()
  foreach ($relative in $paths) {
    $absolute = [IO.Path]::GetFullPath((Join-Path $repoRoot $relative))
    if (-not $absolute.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Source file escaped the repository.'
    }
    $item = Get-Item -LiteralPath $absolute -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Source file is not an ordinary file: $relative"
    }
    $resolved = (Resolve-Path -LiteralPath $absolute).ProviderPath
    if (-not [string]::Equals([IO.Path]::GetFullPath($resolved), $absolute,
        [StringComparison]::OrdinalIgnoreCase)) {
      throw "Source file resolved outside its exact target: $relative"
    }
    $bytes = [IO.File]::ReadAllBytes($absolute)
    $sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $files += [ordered]@{ path = $relative; bytes = $bytes.Length; sha256 = $sha256 }
    [void]$digestInput.Append("$relative`0$($bytes.Length)`0$sha256`n")
  }
  $candidate = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
      [Text.Encoding]::UTF8.GetBytes($digestInput.ToString()))).ToLowerInvariant()
  return [ordered]@{ candidate_sha256 = $candidate; files = $files }
}

try {
  # Correct only this process's Windows environment; never change machine state.
  $env:OS = 'Windows_NT'
  if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
  if (-not $env:WINDIR) { throw 'Windows directory is unavailable.' }

  # A caller's GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* must not redirect the
  # advisory commit and dirty-state readback to a different repository.
  $savedGitEnvironment = @(Get-ChildItem Env: | Where-Object {
      $_.Name.StartsWith('GIT_', [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { [pscustomobject]@{ name = $_.Name; value = $_.Value } })
  foreach ($entry in $savedGitEnvironment) {
    [Environment]::SetEnvironmentVariable($entry.name, $null, 'Process')
  }
  Push-Location $repoRoot
  try {
    $topLevel = @(& git rev-parse --show-toplevel)
    if ($LASTEXITCODE -ne 0 -or $topLevel.Count -ne 1 -or
        -not [string]::Equals([IO.Path]::GetFullPath($topLevel[0]), $repoRoot,
          [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Git top-level directory did not match the probe repository.'
    }
    $headOutput = @(& git rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $headOutput.Count -ne 1 -or
        $headOutput[0] -notmatch '^[0-9a-f]{40}$') {
      throw 'Source HEAD could not be read.'
    }
    $sourceHead = $headOutput[0]
    $statusOutput = @(& git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Source dirty state could not be read.' }
    $sourceDirty = $statusOutput.Count -gt 0
  }
  finally {
    Pop-Location
    foreach ($entry in $savedGitEnvironment) {
      [Environment]::SetEnvironmentVariable($entry.name, $entry.value, 'Process')
    }
  }

  $sourceSnapshot = Get-SourceSnapshot
  $ciWorkflowSha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot '.github/workflows/ci.yml') -Algorithm SHA256).Hash.ToLowerInvariant()

  Assert-ExactArtifactDirectory (Join-Path $repoRoot 'artifacts')
  Assert-ExactArtifactDirectory $artifactRoot
  Assert-ExactArtifactDirectory $publishRoot
  Assert-ExactArtifactDirectory $bridgePublishRoot
  Assert-ExactArtifactDirectory $nodeArtifactRoot
  # An earlier successful image or receipt must never stand in for this run.
  Clear-ExactArtifactFile $image $publishRoot
  Clear-ExactArtifactFile $bridgeImage $bridgePublishRoot
  Clear-ExactArtifactFile $workerImage $nodeArtifactRoot
  Clear-ExactArtifactFile $receiptPath $artifactRoot

  $publishResult = Invoke-BoundedNative 'dotnet' @(
    'publish', '.\LexRunner.WindowsCoordinator.Host.csproj', '-c', 'Release',
    '-r', 'win-x64', '--nologo', '-p:NuGetAudit=false', '-o', $publishRoot
  ) $projectRoot
  if ($publishResult.exit_code -ne 0) { throw "NativeAOT publish failed ($($publishResult.exit_code))." }
  if (-not (Test-Path -LiteralPath $image -PathType Leaf)) { throw 'NativeAOT image was not produced.' }
  $item = Get-Item -LiteralPath $image -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'NativeAOT image is a reparse point.'
  }
  $imageSha256 = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant()
  $imageBytes = $item.Length

  $bridgePublishResult = Invoke-BoundedNative 'dotnet' @(
    'publish', '.\LexRunner.WindowsCoordinator.Host.csproj', '-c', 'Release',
    '-r', 'win-x64', '--nologo', '-p:NuGetAudit=false',
    '-p:CoordinatorAdmissionBridgeTests=true', '-o', $bridgePublishRoot
  ) $projectRoot
  if ($bridgePublishResult.exit_code -ne 0) { throw "NativeAOT bridge publish failed ($($bridgePublishResult.exit_code))." }
  if (-not (Test-Path -LiteralPath $bridgeImage -PathType Leaf)) { throw 'NativeAOT bridge image was not produced.' }
  $bridgeItem = Get-Item -LiteralPath $bridgeImage -Force
  if (($bridgeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'NativeAOT bridge image is a reparse point.'
  }
  $bridgeImageSha256 = (Get-FileHash -LiteralPath $bridgeImage -Algorithm SHA256).Hash.ToLowerInvariant()
  $bridgeImageBytes = $bridgeItem.Length

  # The root tsconfig excludes this service fixture; check its source directly.
  $workerTypecheckResult = Invoke-BoundedNative 'npx' @(
    '--no-install', 'tsc', '--ignoreConfig', '--noEmit', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node',
    '--skipLibCheck', 'services/windows-coordinator-host/node/private-admission-worker.ts'
  ) $repoRoot
  if ($workerTypecheckResult.exit_code -ne 0) { throw "Private Node worker typecheck failed ($($workerTypecheckResult.exit_code))." }

  $workerBuildResult = Invoke-BoundedNative 'npx' @(
    '--no-install', 'esbuild', 'services/windows-coordinator-host/node/private-admission-worker.ts',
    '--bundle', '--platform=node', '--target=node24', '--format=esm', '--packages=external',
    "--outfile=$workerImage"
  ) $repoRoot
  if ($workerBuildResult.exit_code -ne 0) { throw "Private Node worker bundle failed ($($workerBuildResult.exit_code))." }
  if (-not (Test-Path -LiteralPath $workerImage -PathType Leaf)) { throw 'Private Node worker was not produced.' }
  $workerItem = Get-Item -LiteralPath $workerImage -Force
  if (($workerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Private Node worker is a reparse point.'
  }
  $workerSha256 = (Get-FileHash -LiteralPath $workerImage -Algorithm SHA256).Hash.ToLowerInvariant()
  $workerBytes = $workerItem.Length

  $env:LEXRUNNER_TEST_COORDINATOR_HOST = $image
  $env:LEXRUNNER_TEST_COORDINATOR_BRIDGE_HOST = $bridgeImage
  $env:LEXRUNNER_TEST_COORDINATOR_NODE = (Get-Command node.exe -ErrorAction Stop).Source
  $env:LEXRUNNER_TEST_COORDINATOR_WORKER = $workerImage
  $env:LEXRUNNER_TEST_COORDINATOR_ROOT = $artifactRoot
  $fixtureVolume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($artifactRoot)).DriveFormat
  if ($fixtureVolume -notin @('NTFS', 'ReFS')) {
    throw 'Private fixture requires NTFS or ReFS.'
  }
  $env:LEXRUNNER_TEST_COORDINATOR_VOLUME = $fixtureVolume
  $testResult = Invoke-BoundedNative 'npx' @(
    '--no-install', 'vitest', 'run', 'tests/windows-coordinator/client-protocol.spec.ts',
    'tests/windows-coordinator/native-peer-probe.spec.ts',
    'tests/windows-coordinator/native-private-admission.spec.ts',
    'tests/windows-coordinator/private-admission-bridge.spec.ts'
  ) $repoRoot
  if ($testResult.exit_code -ne 0) { throw "Focused console-probe tests failed ($($testResult.exit_code))." }

  $packageResult = Invoke-BoundedNative 'npm' @('run', 'validate:package') $repoRoot
  if ($packageResult.exit_code -ne 0) { throw "Package boundary validation failed ($($packageResult.exit_code))." }
  $sourceUnchanged = ((Get-SourceSnapshot).candidate_sha256 -eq $sourceSnapshot.candidate_sha256)
  if (-not $sourceUnchanged) { throw 'Probe source changed during verification.' }
}
catch {
  $failure = $_.Exception.Message
}
finally {
  try {
    Remove-CheckedBuildDirectory 'bin'
    Remove-CheckedBuildDirectory 'obj'
    if ($failure -and -not $imageSha256) { Clear-ExactArtifactFile $image $publishRoot }
    if ($failure -and -not $bridgeImageSha256) { Clear-ExactArtifactFile $bridgeImage $bridgePublishRoot }
    if ($failure -and -not $workerSha256) { Clear-ExactArtifactFile $workerImage $nodeArtifactRoot }
  }
  catch {
    $failure = if ($failure) { "$failure; cleanup: $($_.Exception.Message)" } else { "cleanup: $($_.Exception.Message)" }
  }
  if ($null -eq $oldOS) { Remove-Item Env:OS -ErrorAction SilentlyContinue } else { $env:OS = $oldOS }
  if ($null -eq $oldWindir) { Remove-Item Env:WINDIR -ErrorAction SilentlyContinue } else { $env:WINDIR = $oldWindir }
  if ($null -eq $oldImage) { Remove-Item Env:LEXRUNNER_TEST_COORDINATOR_HOST -ErrorAction SilentlyContinue } else { $env:LEXRUNNER_TEST_COORDINATOR_HOST = $oldImage }
  if ($null -eq $oldBridgeImage) { Remove-Item Env:LEXRUNNER_TEST_COORDINATOR_BRIDGE_HOST -ErrorAction SilentlyContinue } else { $env:LEXRUNNER_TEST_COORDINATOR_BRIDGE_HOST = $oldBridgeImage }
  if ($null -eq $oldNodeImage) { Remove-Item Env:LEXRUNNER_TEST_COORDINATOR_NODE -ErrorAction SilentlyContinue } else { $env:LEXRUNNER_TEST_COORDINATOR_NODE = $oldNodeImage }
  if ($null -eq $oldWorkerImage) { Remove-Item Env:LEXRUNNER_TEST_COORDINATOR_WORKER -ErrorAction SilentlyContinue } else { $env:LEXRUNNER_TEST_COORDINATOR_WORKER = $oldWorkerImage }
  if ($null -eq $oldFixtureRoot) { Remove-Item Env:LEXRUNNER_TEST_COORDINATOR_ROOT -ErrorAction SilentlyContinue } else { $env:LEXRUNNER_TEST_COORDINATOR_ROOT = $oldFixtureRoot }
  if ($null -eq $oldFixtureVolume) { Remove-Item Env:LEXRUNNER_TEST_COORDINATOR_VOLUME -ErrorAction SilentlyContinue } else { $env:LEXRUNNER_TEST_COORDINATOR_VOLUME = $oldFixtureVolume }
}

$started.Stop()
$receipt = [ordered]@{
  schema_version = 'windows-coordinator-console-probe-verification/1'
  status = if ($failure) { 'failed' } else { 'completed' }
  source_head = $sourceHead
  source_head_advisory = $true
  source_dirty = $sourceDirty
  source_candidate_sha256 = if ($sourceSnapshot) { $sourceSnapshot.candidate_sha256 } else { $null }
  source_candidate_algorithm = 'SHA256 of UTF-8 path + NUL + decimal bytes + NUL + file SHA256 + LF, in listed order'
  source_files = if ($sourceSnapshot) { $sourceSnapshot.files } else { @() }
  source_unchanged_during_verification = $sourceUnchanged
  ci_workflow = [ordered]@{
    path = '.github/workflows/ci.yml'
    sha256 = $ciWorkflowSha256
    build_input = $false
  }
  project = $projectRoot
  fixture_volume = $fixtureVolume
  publish = $publishResult
  bridge_publish = $bridgePublishResult
  worker_typecheck = $workerTypecheckResult
  worker_build = $workerBuildResult
  tests = $testResult
  package_boundary = $packageResult
  image = [ordered]@{
    path = $image
    sha256 = $imageSha256
    bytes = $imageBytes
    retained = (Test-Path -LiteralPath $image -PathType Leaf)
  }
  bridge_image = [ordered]@{
    path = $bridgeImage
    sha256 = $bridgeImageSha256
    bytes = $bridgeImageBytes
    retained = (Test-Path -LiteralPath $bridgeImage -PathType Leaf)
  }
  private_worker = [ordered]@{
    path = $workerImage
    sha256 = $workerSha256
    bytes = $workerBytes
    retained = (Test-Path -LiteralPath $workerImage -PathType Leaf)
  }
  cleanup_bin_absent = -not (Test-Path -LiteralPath (Join-Path $projectRoot 'bin'))
  cleanup_obj_absent = -not (Test-Path -LiteralPath (Join-Path $projectRoot 'obj'))
  duration_ms = $started.ElapsedMilliseconds
  failure = $failure
}
$json = $receipt | ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText($receiptPath, $json + "`n", [Text.UTF8Encoding]::new($false))
[Console]::Out.WriteLine($json)
if ($failure) { exit 1 }
