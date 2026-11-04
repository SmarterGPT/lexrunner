[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# CI hygiene only: environment labels are not authentication or installation authority.
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:ImageOS -cne 'win22' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'disposable_windows_2022_runner_required'
}
$root = 'C:\LexRunner.Qualification.Git'
$uri = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip'
$archiveSha = 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877'
$archiveBytes = 39846926L
$imageSha = '9c75f3f41eb5686bacde4b7c4fdfcd7970e8b699ee05c8d7a0cc9c8a7ddaffe8'
$imageBytes = 4412760L
if (-not $env:GITHUB_OUTPUT) { throw 'workflow_output_required' }
if (Test-Path -LiteralPath $root) { throw 'fixed_git_fixture_root_occupied' }
if (-not [IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP) -or
    -not [IO.Directory]::Exists($env:RUNNER_TEMP)) { throw 'runner_temp_required' }
$stage = Join-Path $env:RUNNER_TEMP ('lexrunner-fixed-git-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $stage
$archive = Join-Path $stage 'MinGit-2.56.0.4-64-bit.zip'
$started = [DateTimeOffset]::UtcNow.ToString('o')
$watch = [Diagnostics.Stopwatch]::StartNew()
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(120)
$cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(120))
$response = $null; $inputStream = $null; $outputStream = $null
try {
    $response = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead,
        $cancel.Token).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    if ($response.Content.Headers.ContentLength -ne $archiveBytes) { throw 'fixed_git_archive_size_header_mismatch' }
    $inputStream = $response.Content.ReadAsStreamAsync($cancel.Token).GetAwaiter().GetResult()
    $outputStream = [IO.FileStream]::new($archive, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = [byte[]]::new(65536); $total = 0L
    while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length,
        $cancel.Token).GetAwaiter().GetResult()) -gt 0) {
        $total += $count
        if ($total -gt $archiveBytes) { throw 'fixed_git_archive_size_exceeded' }
        $outputStream.Write($buffer, 0, $count)
    }
    $outputStream.Flush($true)
    if ($total -ne $archiveBytes) { throw 'fixed_git_archive_truncated' }
} finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
    if ($response) { $response.Dispose() }
    $cancel.Dispose(); $client.Dispose()
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $archiveSha) {
    throw 'fixed_git_archive_digest_mismatch'
}
# Only independently pinned release data is extracted. Never adopt an occupied root.
if (Test-Path -LiteralPath $root) { throw 'fixed_git_fixture_root_occupied' }
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $root, $false)
$image = Join-Path $root 'ucrt64\bin\git.exe'
$item = Get-Item -LiteralPath $image -Force
if ($item.Length -ne $imageBytes -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -cne $imageSha) {
    throw 'fixed_git_release_image_mismatch'
}
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $env:GITHUB_SHA) { throw 'fixture_source_head_mismatch' }
$watch.Stop()
$receipt = [ordered]@{
    schemaVersion = 'lexrunner-disposable-fixed-git-provision/1'
    sourceHead = $head; startedUtc = $started; durationMs = $watch.ElapsedMilliseconds
    release = 'v2.56.0.windows.4'; url = $uri
    archiveSha256 = $archiveSha; archiveBytes = $archiveBytes
    root = $root; image = $image; imageSha256 = $imageSha; imageBytes = $imageBytes
    gitExecutedByPreparation = $false; installedCrossAccountProof = $false
    loaderGraphQualified = $false; authorizesExecution = $false; helperInstalled = $false
}
$receiptPath = Join-Path $stage 'provision-receipt.json'
[IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 4).Replace("`r`n", "`n") + "`n"),
    [Text.UTF8Encoding]::new($false))
[IO.File]::AppendAllText($env:GITHUB_OUTPUT, ('receipt=' + $receiptPath + "`n"), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 4 -Compress
