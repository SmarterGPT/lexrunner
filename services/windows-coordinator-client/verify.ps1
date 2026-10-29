$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The Windows coordinator client verifier requires native Windows.'
}

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..\..'))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts\windows-coordinator-client'))
$normalRoot = Join-Path $artifactRoot 'publish'
$fixtureRoot = Join-Path $artifactRoot 'fixture-publish'
$normalImage = Join-Path $normalRoot 'lexrunner-windows-coordinator-client.exe'
$fixtureImage = Join-Path $fixtureRoot 'lexrunner-windows-coordinator-client.exe'
$receiptPath = Join-Path $artifactRoot 'verification-receipt.json'
$oldOS = $env:OS
$oldWindir = $env:WINDIR
$steps = [Collections.Generic.List[object]]::new()
$failure = $null
$testCount = 0
$heldCount = 0
$clock = [Diagnostics.Stopwatch]::StartNew()

function Invoke-CheckedStep([string] $name, [string] $file, [string[]] $arguments,
    [string] $cwd, [int] $expectedExit) {
  $stepClock = [Diagnostics.Stopwatch]::StartNew()
  $hash = [Security.Cryptography.IncrementalHash]::CreateHash(
    [Security.Cryptography.HashAlgorithmName]::SHA256)
  $tail = [Text.StringBuilder]::new()
  $lineCount = 0
  $outputBytes = 0
  Push-Location $cwd
  try {
    & $file @arguments 2>&1 | ForEach-Object {
      $line = [string] $_
      $bytes = [Text.Encoding]::UTF8.GetBytes($line + "`n")
      $hash.AppendData($bytes)
      $outputBytes += $bytes.Length
      $lineCount++
      [void] $tail.AppendLine($line)
      if ($tail.Length -gt 16000) { [void] $tail.Remove(0, $tail.Length - 16000) }
    }
    $exitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
    $stepClock.Stop()
  }
  $record = [ordered]@{
    name = $name
    command = @($file) + $arguments
    cwd = $cwd
    duration_ms = $stepClock.ElapsedMilliseconds
    exit_code = $exitCode
    output_lines = $lineCount
    output_bytes = $outputBytes
    output_sha256 = [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()
    output_tail = $tail.ToString()
  }
  $hash.Dispose()
  $steps.Add($record)
  if ($exitCode -ne $expectedExit) {
    throw "$name returned $exitCode instead of $expectedExit"
  }
  return $record.output_tail
}

function Remove-CheckedBuildDirectory([string] $name) {
  $target = [IO.Path]::GetFullPath((Join-Path $projectRoot $name))
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $projectRoot,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build cleanup escaped the client project.'
  }
  if (-not (Test-Path -LiteralPath $target)) { return }
  $item = Get-Item -LiteralPath $target -Force
  $resolved = (Resolve-Path -LiteralPath $target).ProviderPath
  if (-not $item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      -not [string]::Equals([IO.Path]::GetFullPath($resolved), $target,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build cleanup target is not an exact ordinary client directory.'
  }
  $descendants = Get-ChildItem -LiteralPath $target -Recurse -Force
  if ($descendants | Where-Object {
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }) {
    throw 'Build cleanup contains a reparse point.'
  }
  Remove-Item -LiteralPath $target -Recurse -Force
}

try {
  $env:OS = 'Windows_NT'
  if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
  New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
  $buildArgs = @('publish', '.\LexRunner.WindowsCoordinator.Client.csproj',
    '-c', 'Release', '-r', 'win-x64', '-p:NuGetAudit=false',
    '-p:TreatWarningsAsErrors=true')
  Invoke-CheckedStep 'normal_publish' 'dotnet' ($buildArgs + @('-o', $normalRoot)) `
    $projectRoot 0 | Out-Null
  $statusText = Invoke-CheckedStep 'normal_status' $normalImage @('--status') `
    $projectRoot 0
  $status = $statusText.Trim() | ConvertFrom-Json
  if ($status.state -ne 'helper_missing' -or
      $status.reason -notin @('service_missing', 'service_unavailable',
          'publisher_unavailable', 'unsupported_host',
          'registry_unavailable', 'registry_link', 'owner_or_dacl_mismatch',
          'shape_mismatch', 'selection_unavailable', 'selection_invalid',
          'high_water_invalid', 'high_water_mismatch', 'catalog_mismatch',
          'generation_unqualified', 'selection_changed',
          'registry_structural_match_only', 'graph_unavailable', 'graph_invalid',
          'graph_mismatch', 'image_unavailable', 'image_mismatch',
          'scm_unavailable', 'scm_config_mismatch', 'scm_config_changed',
          'installed_file_unavailable', 'generation_path_unavailable',
          'generation_path_changed',
          'installed_readback_unavailable', 'installed_structural_match_only') -or
      ((@($status.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'reason,state')) {
    throw 'Ordinary status did not retain helper_missing.'
  }
  $excludedText = Invoke-CheckedStep 'fixture_excluded' $normalImage @('--selftest') `
    $projectRoot 3
  if (($excludedText.Trim() | ConvertFrom-Json).state -ne 'helper_missing') {
    throw 'Fixture mode was available in the ordinary image.'
  }
  $v3ExcludedText = Invoke-CheckedStep 'v3_fixture_excluded' $normalImage `
    @('--v3-installed-fixture-selftest') $projectRoot 3
  if (($v3ExcludedText.Trim() | ConvertFrom-Json).state -ne 'helper_missing') {
    throw 'V3 installed fixture mode was available in the ordinary image.'
  }
  $heldExcludedText = Invoke-CheckedStep 'v3_held_fixture_excluded' $normalImage `
    @('--v3-held-installed-fixture-selftest') $projectRoot 3
  if (($heldExcludedText.Trim() | ConvertFrom-Json).state -ne 'helper_missing') {
    throw 'V3 held installed fixture mode was available in the ordinary image.'
  }
  $sendText = Invoke-CheckedStep 'ordinary_send_refused' $normalImage @('--execute') `
    $projectRoot 3
  if (($sendText.Trim() | ConvertFrom-Json).state -ne 'helper_missing') {
    throw 'Ordinary image accepted an execution argument.'
  }
  Invoke-CheckedStep 'fixture_publish' 'dotnet' ($buildArgs + @(
      '-p:CoordinatorClientFixtureTests=true', '-o', $fixtureRoot)) `
    $projectRoot 0 | Out-Null
  $pureText = Invoke-CheckedStep 'v3_installed_pure_selftest' $fixtureImage `
    @('--v3-installed-fixture-selftest') $projectRoot 0
  $pure = $pureText.Trim() | ConvertFrom-Json
  if ($pure.state -ne 'pass' -or
      $pure.profile -ne 'v3_installed_source_only_pure' -or
      $pure.results.Count -ne 19 -or $pure.failures.Count -ne 0 -or
      @($pure.results | Where-Object { -not $_.passed }).Count -ne 0) {
    throw 'V3 installed pure fixture tests did not all pass.'
  }
  $heldText = Invoke-CheckedStep 'v3_held_installed_selftest' $fixtureImage `
    @('--v3-held-installed-fixture-selftest') $projectRoot 0
  $held = $heldText.Trim() | ConvertFrom-Json
  $heldCount = $held.results.Count
  if ($held.state -ne 'pass' -or
      $held.profile -ne 'v3_held_installed_source_only' -or
      $held.results.Count -lt 2 -or $held.results.Count -gt 3 -or
      $held.failures.Count -ne 0 -or
      @($held.results | Where-Object { -not $_.passed }).Count -ne 0 -or
      $held.results[0].name -ne 'fixture_image_root' -or
      $held.results[1].name -ne 'process_temp_root' -or
      $held.results[0].state -notin @('NTFS', 'ReFS') -or
      $held.results[1].state -notin @('NTFS', 'ReFS') -or
      -not [string]::Equals(
        [IO.Path]::GetDirectoryName($held.results[0].fixture_path),
        $fixtureRoot, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals(
        [IO.Path]::GetDirectoryName($held.results[1].fixture_path),
        [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\'),
        [StringComparison]::OrdinalIgnoreCase)) {
    throw 'V3 held installed native fixture tests did not all pass.'
  }
  $testText = Invoke-CheckedStep 'native_selftest' $fixtureImage @('--selftest') `
    $projectRoot 0
  $test = $testText.Trim() | ConvertFrom-Json
  $testCount = $test.results.Count
  if ($test.state -ne 'pass' -or
      $test.profile -ne 'synthetic_same_user_non_authorizing' -or
      $test.failures.Count -ne 0 -or $test.results.Count -ne 51 -or
      @($test.results | Where-Object { -not $_.passed }).Count -ne 0) {
    throw 'Native fixture tests did not all pass.'
  }
  Invoke-CheckedStep 'npm_package_boundary' 'npm.cmd' @('run', 'validate:package') `
    $repoRoot 0 | Out-Null
}
catch {
  $failure = $_.Exception.Message
}
finally {
  $clock.Stop()
  try {
    Remove-CheckedBuildDirectory 'bin'
    Remove-CheckedBuildDirectory 'obj'
  }
  catch {
    if (-not $failure) { $failure = 'client_build_cleanup_failed: ' + $_.Exception.Message }
  }
  $sources = [ordered]@{}
  foreach ($name in @('.gitignore', 'LexRunner.WindowsCoordinator.Client.csproj',
      'global.json', 'Program.cs', 'NativeClient.cs', 'FixtureTests.cs',
      'CoordinatorSelection.cs', 'CoordinatorSources.cs',
      'CoordinatorAcquisition.cs', 'CoordinatorSelectionFixtureTests.cs',
      'CoordinatorV2RegistryObservation.cs', 'CoordinatorV2RegistryFixtureTests.cs',
      'CoordinatorV3RegistryObservation.cs', 'CoordinatorV3RegistryFixtureTests.cs',
      'CoordinatorV3InstalledObservation.cs', 'V3InstalledFixtureTests.cs',
      'V3HeldInstalledFiles.cs', 'V3HeldInstalledFixtureTests.cs',
      'README.md', 'verify.ps1')) {
    $path = Join-Path $projectRoot $name
    if (Test-Path -LiteralPath $path) {
      $sources[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  foreach ($name in @('CustodyContract.cs', 'NativeRegistryReader.cs',
      'CustodyContractV3.cs', 'NativeRegistryReaderV3.cs')) {
    $path = Join-Path $repoRoot "services/windows-coordinator-selection-custody/$name"
    $sources["selection-custody/$name"] =
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $graphSource = Join-Path $repoRoot 'installers/windows-coordinator/v3/GraphV3.cs'
  $sources['graph-v3/GraphV3.cs'] =
    (Get-FileHash -LiteralPath $graphSource -Algorithm SHA256).Hash.ToLowerInvariant()
  foreach ($name in @('package.json', 'scripts/validate-package-boundary.ts')) {
    $path = Join-Path $repoRoot $name
    $sources[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $sourceLines = @($sources.Keys | Sort-Object | ForEach-Object {
      "$_ $($sources[$_])"
    })
  $sourceDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
      [Text.Encoding]::UTF8.GetBytes(($sourceLines -join "`n") + "`n"))).ToLowerInvariant()
  $receipt = [ordered]@{
    state = if ($failure) { 'fail' } else { 'pass' }
    source_head = (& git -C $repoRoot rev-parse HEAD).Trim()
    source_sha256 = $sources
    source_candidate_sha256 = $sourceDigest
    normal_image_sha256 = if (Test-Path -LiteralPath $normalImage) {
      (Get-FileHash -LiteralPath $normalImage -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { $null }
    fixture_image_sha256 = if (Test-Path -LiteralPath $fixtureImage) {
      (Get-FileHash -LiteralPath $fixtureImage -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { $null }
    profile = 'synthetic_same_user_non_authorizing'
    native_test_count = $testCount
    held_test_count = $heldCount
    total_duration_ms = $clock.ElapsedMilliseconds
    steps = $steps
    failure = $failure
  }
  $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
  $env:OS = $oldOS
  $env:WINDIR = $oldWindir
  Write-Output ([ordered]@{
    state = $receipt.state
    receipt = $receiptPath
    native_test_count = $testCount
    held_test_count = $heldCount
    total_duration_ms = $clock.ElapsedMilliseconds
    failure = $failure
  } | ConvertTo-Json -Compress)
}
if ($failure) { exit 1 }
