[CmdletBinding()]
param([switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-SelectedReceipt([object]$receipt, [long]$byteCount) {
    if ($byteCount -lt 1 -or $byteCount -gt 131072) { throw 'selected_git_receipt_bounds_invalid' }
    if ($receipt.schemaVersion -cne 'windows-git-view-transition-source/1' -or
        $receipt.authorizesExecution -ne $false -or
        $receipt.installedCrossAccountProof -ne $false -or
        $receipt.loaderGraphQualified -ne $false -or
        $receipt.fixedGitSha256 -cne '3b64043b9e4dc225225f43ff9c1173b57493ff72e5b729accfae051eb160cca3' -or
        @($receipt.commands).Count -gt 40) { throw 'selected_git_receipt_contract_invalid' }
    foreach ($command in @($receipt.commands)) {
        if ($command.stdoutTail.Length -gt 512 -or $command.stderrTail.Length -gt 512) {
            throw 'selected_git_receipt_command_unbounded'
        }
    }
}

if ($SelfTest) {
    function New-Receipt([int]$count) {
        [pscustomobject]@{ schemaVersion='windows-git-view-transition-source/1'
          authorizesExecution=$false; installedCrossAccountProof=$false; loaderGraphQualified=$false
          fixedGitSha256='3b64043b9e4dc225225f43ff9c1173b57493ff72e5b729accfae051eb160cca3'
          commands=@(1..$count | ForEach-Object { [pscustomobject]@{stdoutTail='';stderrTail=''} }) }
    }
    function Expect-Refusal([object]$receipt,[long]$bytes,[string]$reason) {
        $refused=$false
        try { Assert-SelectedReceipt $receipt $bytes }
        catch { if ($_.Exception.Message -cne $reason) { throw }; $refused=$true }
        if (-not $refused) { throw 'negative_control_accepted' }
    }
    Assert-SelectedReceipt (New-Receipt 34) 131072
    Assert-SelectedReceipt (New-Receipt 40) 131072
    Expect-Refusal (New-Receipt 41) 131072 'selected_git_receipt_contract_invalid'
    Expect-Refusal (New-Receipt 34) 131073 'selected_git_receipt_bounds_invalid'
    $tail=New-Receipt 34; $tail.commands[0].stdoutTail='x'*513
    Expect-Refusal $tail 131072 'selected_git_receipt_command_unbounded'
    $authority=New-Receipt 34; $authority.authorizesExecution=$true
    Expect-Refusal $authority 131072 'selected_git_receipt_contract_invalid'
    'selected_git_receipt_guard_selftest_pass six_cases no_git_started'
    exit 0
}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$files=@(Get-ChildItem (Join-Path $repo 'artifacts/windows-coordinator-git-selected-transition') -Filter receipt-*.json -File -ErrorAction SilentlyContinue)
if ($files.Count -ne 1) { throw 'selected_git_receipt_count_invalid' }
# Inspect the size before reading; refusal does not allocate an oversized receipt.
$size=$files[0].Length
if ($size -lt 1 -or $size -gt 131072) { throw 'selected_git_receipt_bounds_invalid' }
$bytes=[IO.File]::ReadAllBytes($files[0].FullName)
Assert-SelectedReceipt ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json) $bytes.Length
'selected_git_receipt_bounds_pass'
