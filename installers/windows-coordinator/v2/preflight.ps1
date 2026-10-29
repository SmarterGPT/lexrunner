[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('FreshInstall', 'RetiredUninstall')][string]$Mode,
    [ValidatePattern('\A[a-f0-9]{64}\z')][string]$ExpectedGenerationId,
    [ValidatePattern('\A[a-f0-9]{64}\z')][string]$ExpectedManifestSha256,
    [ValidatePattern('\A\d+\.\d+\.\d+\z')][string]$ExpectedVersion,
    [ValidatePattern('\A\{[A-F0-9-]{36}\}\z')][string]$ExpectedProductCode
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    -not [Environment]::Is64BitProcess) {
    throw 'Coordinator v2 preflight requires native 64-bit PowerShell on Windows x64'
}
if ($Mode -eq 'RetiredUninstall' -and
    ([string]::IsNullOrEmpty($ExpectedGenerationId) -or
     [string]::IsNullOrEmpty($ExpectedManifestSha256) -or
     [string]::IsNullOrEmpty($ExpectedVersion) -or
     [string]::IsNullOrEmpty($ExpectedProductCode))) {
    throw 'Retired uninstall requires exact reviewed generation, manifest, version and ProductCode'
}

# This read-only snapshot is an operator gate, not an authority token or an
# atomic guarantee across a later Windows Installer process.
$service = $null
try { $service = Get-Service -Name LexRunnerCoordinator -ErrorAction Stop }
catch {
    if ($_.FullyQualifiedErrorId -cne
        'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.GetServiceCommand') {
        throw "Coordinator SCM state unavailable: $($_.Exception.Message)"
    }
}
if ($null -ne $service) { throw 'Coordinator SCM service still exists' }

$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64)
try {
    $serviceKey = $registry.OpenSubKey('SYSTEM\CurrentControlSet\Services\LexRunnerCoordinator', $false)
    if ($null -ne $serviceKey) {
        $serviceKey.Dispose()
        throw 'Coordinator 64-bit service registry key still exists'
    }
    $selection = $registry.OpenSubKey('SOFTWARE\SmarterGPT.LexRunner.WindowsCoordinator', $false)
    if ($null -ne $selection) {
        try {
            if ($Mode -eq 'FreshInstall' -or
                @($selection.GetValueNames() | Where-Object { $_ -ceq 'ActiveSelection' }).Count -ne 0) {
                throw 'Coordinator protected selection state is occupied'
            }
        }
        finally { $selection.Dispose() }
    }
    $uninstall = $registry.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', $false)
    if ($null -eq $uninstall) { throw '64-bit installer registration unavailable' }
    try {
        $products = [Collections.Generic.List[object]]::new()
        foreach ($name in $uninstall.GetSubKeyNames()) {
            $entry = $uninstall.OpenSubKey($name, $false)
            if ($null -eq $entry) { throw "Installer registration changed: $name" }
            try {
                $display = [string]$entry.GetValue('DisplayName', '')
                if ($display -like 'LexRunner Windows coordinator*') {
                    $products.Add([pscustomobject]@{
                        key = $name
                        display = $display
                        version = [string]$entry.GetValue('DisplayVersion', '')
                    })
                }
            }
            finally { $entry.Dispose() }
        }
        if ($Mode -eq 'FreshInstall') {
            if ($products.Count -ne 0) { throw 'Coordinator installer product already registered' }
        }
        elseif ($products.Count -ne 1 -or
            $products[0].key -cne $ExpectedProductCode -or
            $products[0].display -cne 'LexRunner Windows coordinator v2 qualification' -or
            $products[0].version -cne $ExpectedVersion) {
            throw 'Retired product registration does not match exact reviewed MSI'
        }
    }
    finally { $uninstall.Dispose() }
}
finally { $registry.Dispose() }

$application = Join-Path ([IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\')) 'SmarterGPT.LexRunner.WindowsCoordinator'
if ($Mode -eq 'FreshInstall') {
    $entry = $null
    try { $entry = Get-Item -LiteralPath $application -Force -ErrorAction Stop }
    catch {
        if ($_.Exception -isnot [System.Management.Automation.ItemNotFoundException]) { throw }
    }
    if ($null -ne $entry) { throw 'Coordinator Program Files root is occupied' }
}
else {
    $generation = Join-Path (Join-Path $application 'generations') $ExpectedGenerationId
    foreach ($path in @($application, (Join-Path $application 'generations'), $generation)) {
        if (-not (Test-Path -LiteralPath $path -PathType Container) -or
            ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Installed generation path is absent or redirected'
        }
    }
    $manifest = Join-Path $generation 'generation-graph.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf) -or
        ([IO.File]::GetAttributes($manifest) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (Get-Item -LiteralPath $manifest).Length -gt 262144 -or
        (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedManifestSha256) {
        throw 'Installed generation manifest differs from reviewed artifact'
    }
    $graph = Get-Content -LiteralPath $manifest -Raw -Encoding utf8 | ConvertFrom-Json
    if ($graph.graphDigest -cne $ExpectedGenerationId -or
        $graph.profile -cne 'windows-coordinator-service-msi/2' -or
        $graph.serviceName -cne 'LexRunnerCoordinator') {
        throw 'Installed generation graph profile differs'
    }
}

[pscustomobject]@{
    kind = 'windows-coordinator-v2-readonly-preflight/1'
    mode = $Mode
    serviceAbsent = $true
    activeSelectionAbsent = $true
    productState = if ($Mode -eq 'FreshInstall') { 'absent' } else { 'exact_retired_candidate' }
    observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    authorizesInstallation = $false
    authorizesRetirement = $false
    authorizesExecution = $false
} | ConvertTo-Json -Compress
