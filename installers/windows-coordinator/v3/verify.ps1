param()

$ErrorActionPreference = 'Stop'
$started = Get-Date
$repoRoot = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw 'LexRunner root unavailable' }
$head = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'LexRunner HEAD unavailable' }
$tsx = Join-Path $repoRoot 'node_modules/.bin/tsx.CMD'
$vitest = Join-Path $repoRoot 'node_modules/.bin/vitest.CMD'
$fixtureProject = Join-Path $PSScriptRoot 'GraphV3Fixture.csproj'
$fixtureDll = Join-Path $PSScriptRoot 'bin/Release/net8.0/LexRunner.WindowsCoordinator.GraphV3Fixture.dll'
$draftRoot = Join-Path $repoRoot 'artifacts/windows-worker-graph-draft/20261028/overlay'
$draftMode = $PSScriptRoot.StartsWith($draftRoot, [System.StringComparison]::OrdinalIgnoreCase)
$vitestConfig = Join-Path $repoRoot 'artifacts/windows-worker-graph-draft/20261028/vitest.config.ts'
$vitestArgs = if ($draftMode) { @('run', '--config', $vitestConfig) } else {
  @('run', 'tests/workspaces/windows-coordinator-generation-graph-v3.spec.ts')
}
if (-not (Test-Path -LiteralPath $tsx) -or -not (Test-Path -LiteralPath $vitest)) {
  throw 'Direct local TypeScript test launchers unavailable'
}
$outputBase = if ($draftMode) {
  Join-Path $repoRoot 'artifacts/windows-worker-graph-draft/20261028'
} else {
  Join-Path $repoRoot 'artifacts/windows-coordinator-v3-graph-source'
}
New-Item -ItemType Directory -Path $outputBase -Force | Out-Null
$outputRoot = Join-Path $outputBase ('qualification-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $outputRoot -ErrorAction Stop | Out-Null
$checks = [System.Collections.Generic.List[object]]::new()
function Invoke-Recorded([string]$name, [string]$command, [scriptblock]$body, [int]$expectedExit = 0) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $output = @(& $body 2>&1 | ForEach-Object { [string]$_ })
  $exit = $LASTEXITCODE
  $watch.Stop()
  if ($null -eq $exit) { $exit = 0 }
  $bounded = (($output -join "`n").Substring(0, [Math]::Min(($output -join "`n").Length, 4096)))
  $checks.Add([ordered]@{
    name = $name; command = $command; cwd = $repoRoot; commit = $head;
    durationMs = $watch.ElapsedMilliseconds; exitCode = $exit; boundedOutput = $bounded
  })
  if ($exit -ne $expectedExit) { throw "$name returned $exit; expected $expectedExit" }
  return ($output -join "`n")
}

$null = Invoke-Recorded 'typescript-tests' 'node_modules/.bin/vitest.CMD run <v3 graph spec>' {
  & $vitest @vitestArgs
}
$null = Invoke-Recorded 'csharp-build' 'dotnet build GraphV3Fixture.csproj -c Release -v quiet' {
  & dotnet build $fixtureProject -c Release -v quiet
}
$fixtureJson = Invoke-Recorded 'synthetic-graph' 'node_modules/.bin/tsx.CMD fixture.ts <fresh absolute fixture root>' {
  & $tsx (Join-Path $PSScriptRoot 'fixture.ts') $outputRoot
}
$fixture = $fixtureJson | ConvertFrom-Json
$manifest = Join-Path $outputRoot 'generation-graph.json'
$csharpJson = Invoke-Recorded 'csharp-positive' 'dotnet GraphV3Fixture.dll --parse <synthetic graph> <expected digest>' {
  & dotnet $fixtureDll --parse $manifest $fixture.manifestSha256
}
$csharp = $csharpJson | ConvertFrom-Json
foreach ($field in @('graphDigest', 'manifestSha256', 'fileCount', 'serviceImage', 'workerServiceImage', 'authorizesLaunch')) {
  if ($csharp.$field -cne $fixture.$field) { throw "TypeScript/C# positive parity mismatch: $field" }
}
if ($csharp.installed -ne $false) { throw 'Fixture claimed installation' }
$negativeRoot = Join-Path $outputRoot 'negatives'
$negativeJson = Invoke-Recorded 'synthetic-negatives' 'node_modules/.bin/tsx.CMD negative-fixtures.ts <synthetic graph> <fresh output root>' {
  & $tsx (Join-Path $PSScriptRoot 'negative-fixtures.ts') $manifest $negativeRoot
}
$negatives = @($negativeJson | ConvertFrom-Json)
if ($negatives.Count -ne 6) { throw 'Unexpected negative fixture count' }
foreach ($negative in $negatives) {
  $refusal = Invoke-Recorded ('csharp-refusal-' + $negative.name) 'dotnet GraphV3Fixture.dll --parse <mutated graph> <matching mutated digest>' {
    & dotnet $fixtureDll --parse $negative.manifest $negative.manifestSha256
  } 3
  if ($refusal.Trim() -cne 'graph_v3_fixture_refused') { throw "Unexpected refusal output: $($negative.name)" }
}
$receipt = [ordered]@{
  schemaVersion = 'windows-coordinator-graph-v3-source-receipt/1'
  commit = $head
  startedUtc = $started.ToUniversalTime().ToString('o')
  completedUtc = (Get-Date).ToUniversalTime().ToString('o')
  fixtureRoot = $outputRoot
  graphDigest = $fixture.graphDigest
  manifestSha256 = $fixture.manifestSha256
  typescriptCsharpParity = $true
  negativeCount = $negatives.Count
  installed = $false
  authorizesLaunch = $false
  checks = $checks
}
$receiptPath = Join-Path $outputRoot 'verification-receipt.json'
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
Write-Output ([pscustomobject]@{
  schemaVersion = $receipt.schemaVersion
  commit = $head
  graphDigest = $fixture.graphDigest
  manifestSha256 = $fixture.manifestSha256
  negativeCount = $negatives.Count
  installed = $false
  authorizesLaunch = $false
} | ConvertTo-Json -Compress)
Write-Output "receipt=$receiptPath"
