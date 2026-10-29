# Calibration preflight artifact gate. Copies only bounded files into a fresh
# staging directory; the workflow uploads that staging directory only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Copy-BoundedFile([string]$source, [string]$destination, [long]$limit) {
    $inputStream = [IO.FileStream]::new($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $outputStream = [IO.FileStream]::new($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $buffer = [byte[]]::new(8192)
            $copied = 0L
            while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if (($copied + $read) -gt $limit) { throw 'artifact_size_limit' }
                $outputStream.Write($buffer, 0, $read)
                $copied += $read
            }
            $outputStream.Flush($true)
            return $copied
        }
        finally { $outputStream.Dispose() }
    }
    finally { $inputStream.Dispose() }
}

$uploadRoot = $null
try {
    if ($env:GITHUB_RUN_ID -notmatch '^[0-9]{1,20}$' -or
        $env:GITHUB_RUN_ATTEMPT -notmatch '^[0-9]{1,5}$' -or
        -not [IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP)) {
        throw 'artifact_host_identity_unavailable'
    }
    $suffix = $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT
    $sourceRoot = Join-Path $env:RUNNER_TEMP ('lexrunner-etw-calibration-' + $suffix)
    $uploadRoot = Join-Path $env:RUNNER_TEMP ('lexrunner-etw-upload-' + $suffix)
    if (-not [IO.Directory]::Exists($sourceRoot)) { throw 'source_receipt_unavailable' }
    $sourceInfo = [IO.DirectoryInfo]::new($sourceRoot)
    if (($sourceInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'source_reparse_refused'
    }
    if ([IO.Directory]::Exists($uploadRoot) -or [IO.File]::Exists($uploadRoot)) {
        throw 'upload_staging_occupied'
    }
    $candidates = @(Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object {
        $_.Name -eq 'preflight-receipt.json' -or $_.Name -match '^help-.*\.(stdout|stderr)$'
    })
    if (-not ($candidates | Where-Object Name -EQ 'preflight-receipt.json')) {
        throw 'source_receipt_unavailable'
    }
    if ($candidates.Count -gt 9) { throw 'artifact_count_limit' }
    foreach ($file in $candidates) {
        if ($file.PSIsContainer -or
            ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($file.Name -ne 'preflight-receipt.json' -and
                $file.Name -notmatch '^help-(start|stop|processing|tracestats)\.(stdout|stderr)$')) {
            throw 'artifact_name_or_type_refused'
        }
    }
    [IO.Directory]::CreateDirectory($uploadRoot) | Out-Null
    $total = 0L
    foreach ($file in $candidates) {
        $limit = if ($file.Name -eq 'preflight-receipt.json') { 32768L } else { 65536L }
        $destination = Join-Path $uploadRoot $file.Name
        $total += Copy-BoundedFile $file.FullName $destination $limit
        if ($total -gt 557056) { throw 'artifact_total_size_limit' }
    }
    $receipt = Get-Content -LiteralPath (Join-Path $uploadRoot 'preflight-receipt.json') -Raw | ConvertFrom-Json -AsHashtable
    if ($receipt.schemaVersion -ne 'lexrunner-windows-etw-calibration-preflight/1') {
        throw 'artifact_receipt_schema_refused'
    }
    foreach ($field in @('lostCountersVerified', 'traceCaptured', 'authorizesLoaderClosure', 'authorizesExecution')) {
        if ($receipt[$field] -isnot [bool] -or $receipt[$field]) {
            throw 'artifact_receipt_authority_refused'
        }
    }
    Write-Output ('etw_artifact_bounds_ok bytes=' + $total + ' files=' + $candidates.Count)
    exit 0
}
catch {
    if ($null -ne $uploadRoot -and [IO.Directory]::Exists($uploadRoot)) {
        foreach ($file in @(Get-ChildItem -LiteralPath $uploadRoot -File -Force -ErrorAction SilentlyContinue)) {
            try { $file.Delete() } catch { }
        }
    }
    [Console]::Error.WriteLine('etw_artifact_bounds_refused')
    exit 3
}
