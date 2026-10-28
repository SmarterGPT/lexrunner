[CmdletBinding()]
param(
    [switch]$SelfTest,
    [string]$ExpectedImageSha256,
    [string]$ExpectedManifestSha256,
    [string]$ExpectedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
$serviceName = 'LexRunnerCoordinator'
$imageName = 'LexRunner.WindowsCoordinator.Service.exe'
$expectedAccount = 'NT SERVICE\LexRunnerCoordinator'
$result = [ordered]@{
    schemaVersion = 'windows-coordinator-installed-readback/1'
    state = 'unavailable'
    reason = 'not_observed'
    authorizesExecution = $false
    productionReady = $false
    helperMissingCleared = $false
    sourceOnly = $true
    serviceName = $serviceName
    cwd = (Get-Location).Path
    observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    expected = $null
    observations = [ordered]@{}
    durationMs = 0
}

function Digest([byte[]]$bytes) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Valid-Version([string]$value) {
    if ($null -eq $value -or $value.Length -lt 5 -or $value.Length -gt 13 -or
        $value -cnotmatch '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,5}$') {
        return $false
    }
    $parts = $value.Split('.')
    [int]$parts[0] -le 255 -and [int]$parts[1] -le 255 -and
        [int]$parts[2] -le 65535
}
function Compact-Json([string]$value) {
    $output = [Text.StringBuilder]::new($value.Length)
    $quoted = $false
    $escaped = $false
    foreach ($character in $value.ToCharArray()) {
        if ($quoted) {
            [void]$output.Append($character)
            if ($escaped) { $escaped = $false }
            elseif ($character -eq '\') { $escaped = $true }
            elseif ($character -eq '"') { $quoted = $false }
        }
        elseif ($character -eq '"') {
            $quoted = $true
            [void]$output.Append($character)
        }
        elseif (-not [char]::IsWhiteSpace($character)) {
            [void]$output.Append($character)
        }
    }
    $output.ToString()
}
function Expected-Manifest([string]$imageDigest, [string]$version) {
    '{"schemaVersion":"lexrunner-windows-coordinator-generation/1",' +
    '"profile":"windows-coordinator-service-msi/1",' +
    '"generationId":"' + $imageDigest + '","serviceName":"LexRunnerCoordinator",' +
    '"serviceImageSha256":"' + $imageDigest + '","serviceVersion":"' +
    $version + '","state":"provisioned-unqualified","productionReady":false}'
}
function Read-HeldFile([string]$file, [int]$maximum) {
    $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'file_identity_unavailable'
    }
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt $maximum) {
            throw 'file_size_unavailable'
        }
        $bytes = [byte[]]::new([int]$stream.Length)
        $stream.ReadExactly($bytes, 0, $bytes.Length)
        if ($stream.Length -ne $bytes.Length) { throw 'file_size_changed' }
        [pscustomobject]@{ bytes = $bytes; sha256 = (Digest $bytes); length = $bytes.Length }
    }
    finally { $stream.Dispose() }
}
function Read-AclObservation([string]$path) {
    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor
        [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group
    $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
    if ($sddl.Length -gt 4096) { throw 'acl_output_exceeded' }
    [ordered]@{
        sddl = $sddl
        sha256 = (Digest ([Text.Encoding]::UTF8.GetBytes($sddl)))
        owner = $acl.Owner
        inheritanceProtected = $acl.AreAccessRulesProtected
    }
}
function Assess-Config($cim, $registry, [string]$expectedPath,
    [bool]$activeSelectionPresent) {
    if ($activeSelectionPresent) { return 'active_selection_present' }
    if ($null -eq $cim -or $null -eq $registry) { return 'service_config_unavailable' }
    $expectedCommand = '"' + $expectedPath + '" --service'
    if ($registry.Kinds.Type -cne 'DWord' -or
        $registry.Kinds.Start -cne 'DWord' -or
        $registry.Kinds.ErrorControl -cne 'DWord' -or
        $registry.Kinds.ServiceSidType -cne 'DWord' -or
        $registry.Kinds.RequiredPrivileges -cne 'MultiString' -or
        $registry.Kinds.ObjectName -cne 'String' -or
        $registry.Kinds.ImagePath -cnotin @('String', 'ExpandString') -or
        [uint32]$registry.Type -ne 16 -or [uint32]$registry.Start -ne 3 -or
        [uint32]$registry.ErrorControl -ne 1 -or
        [uint32]$registry.ServiceSidType -ne 3 -or
        @($registry.RequiredPrivileges).Count -ne 1 -or
        @($registry.RequiredPrivileges)[0] -cne 'SeChangeNotifyPrivilege' -or
        $registry.ObjectName -ine $expectedAccount -or
        $registry.ImagePath -ine $expectedCommand -or
        $cim.PathName -ine $expectedCommand -or
        $cim.StartName -ine $expectedAccount -or
        $cim.StartMode -cne 'Manual' -or
        $cim.ServiceType -cne 'Own Process' -or
        $cim.State -cne 'Stopped' -or [uint32]$cim.ProcessId -ne 0) {
        return 'service_config_mismatch'
    }
    return 'observed_unqualified'
}
function Serialize-BoundedResult($value) {
    $json = $value | ConvertTo-Json -Compress -Depth 12
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 32768) {
        return '{"schemaVersion":"windows-coordinator-installed-readback/1",' +
            '"state":"unavailable","reason":"readback_output_exceeded",' +
            '"authorizesExecution":false,"productionReady":false,' +
            '"helperMissingCleared":false,"sourceOnly":true,' +
            '"serviceName":"LexRunnerCoordinator"}'
    }
    return $json
}

try {
    if ($SelfTest) {
        $fixtureDigest = 'a' * 64
        $fixturePath = 'C:\Program Files\SmarterGPT.LexRunner.WindowsCoordinator\generations\' +
            $fixtureDigest + '\' + $imageName
        $command = '"' + $fixturePath + '" --service'
        $registry = [pscustomobject]@{
            Type = 16; Start = 3; ErrorControl = 1; ServiceSidType = 3
            RequiredPrivileges = @('SeChangeNotifyPrivilege')
            ObjectName = $expectedAccount; ImagePath = $command
            Kinds = [pscustomobject]@{
                Type = 'DWord'; Start = 'DWord'; ErrorControl = 'DWord'
                ServiceSidType = 'DWord'; RequiredPrivileges = 'MultiString'
                ObjectName = 'String'; ImagePath = 'ExpandString'
            }
        }
        $cim = [pscustomobject]@{
            PathName = $command; StartName = $expectedAccount; StartMode = 'Manual'
            ServiceType = 'Own Process'; State = 'Stopped'; ProcessId = 0
        }
        $cases = [ordered]@{
            exact = (Assess-Config $cim $registry $fixturePath $false) -ceq
                'observed_unqualified'
            selection = (Assess-Config $cim $registry $fixturePath $true) -ceq
                'active_selection_present'
        }
        $registry.Start = 2
        $cases.startMismatch = (Assess-Config $cim $registry $fixturePath $false) -ceq
            'service_config_mismatch'
        $registry.Start = 3
        $registry.Kinds.Start = 'String'
        $cases.startKindMismatch = (Assess-Config $cim $registry $fixturePath $false) -ceq
            'service_config_mismatch'
        $registry.Kinds.Start = 'DWord'
        $expected = Expected-Manifest $fixtureDigest '2.5.0'
        $cases.manifest = (Compact-Json ($expected + [char]10)) -ceq $expected
        $cases.escapedName = (Compact-Json ($expected.Replace(
            '"schemaVersion"', '"s\u0063hemaVersion"'))) -cne $expected
        $cases.longVersionRefused = -not (Valid-Version ('9' * 4096))
        $cases.msiVersionLimitRefused = -not (Valid-Version '256.0.0')
        $oversized = [ordered]@{
            schemaVersion = 'windows-coordinator-installed-readback/1'
            state = 'unavailable'; reason = 'synthetic'; authorizesExecution = $false
            productionReady = $false; helperMissingCleared = $false
            sourceOnly = $true; serviceName = $serviceName
            observations = 'x' * 40000
        }
        $bounded = Serialize-BoundedResult $oversized
        $cases.boundedFallback =
            [Text.Encoding]::UTF8.GetByteCount($bounded) -lt 32768 -and
            $bounded.Contains('"reason":"readback_output_exceeded"') -and
            -not $bounded.Contains('observations')
        $passed = @($cases.Values | Where-Object { -not $_ }).Count -eq 0
        $result.reason = if ($passed) { 'synthetic_contract_pass' }
            else { 'synthetic_contract_failed' }
        $result.observations.syntheticCases = $cases
    }
    else {
        if (-not $IsWindows -or -not [Environment]::Is64BitProcess) {
            throw 'native_windows_x64_required'
        }
        if ($ExpectedImageSha256.Length -ne 64 -or
            $ExpectedImageSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $ExpectedManifestSha256.Length -ne 64 -or
            $ExpectedManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            -not (Valid-Version $ExpectedVersion)) {
            throw 'invalid_expected_artifact'
        }
        $result.expected = [ordered]@{
            imageSha256 = $ExpectedImageSha256
            manifestSha256 = $ExpectedManifestSha256
            version = $ExpectedVersion
        }
        $system = [Environment]::SystemDirectory
        $volume = [IO.Path]::GetPathRoot($system)
        if ($volume -cnotmatch '^[A-Za-z]:\\$' -or
            [IO.Path]::GetFullPath($system) -ine $system -or
            [IO.Path]::GetFileName($system) -ine 'System32') {
            throw 'system_root_unavailable'
        }
        $app = [IO.Path]::Combine($volume, 'Program Files',
            'SmarterGPT.LexRunner.WindowsCoordinator')
        $generations = [IO.Path]::Combine($app, 'generations')
        $generation = [IO.Path]::Combine($generations, $ExpectedImageSha256)
        $image = [IO.Path]::Combine($generation, $imageName)
        $manifest = [IO.Path]::Combine($generation, 'generation.json')
        $result.observations.expectedImagePath = $image

        $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::LocalMachine,
            [Microsoft.Win32.RegistryView]::Registry64)
        try {
            $selectionKey = $machine.OpenSubKey(
                'Software\SmarterGPT.LexRunner.WindowsCoordinator', $false)
            try {
                $activeSelectionPresent = $null -ne $selectionKey -and
                    @($selectionKey.GetValueNames()) -ccontains 'ActiveSelection'
            }
            finally { if ($null -ne $selectionKey) { $selectionKey.Dispose() } }
            $result.observations.activeSelectionPresent = $activeSelectionPresent
            $serviceKey = $machine.OpenSubKey(
                'SYSTEM\CurrentControlSet\Services\LexRunnerCoordinator', $false)
            if ($null -eq $serviceKey) {
                $services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name='LexRunnerCoordinator'" -ErrorAction Stop)
                if ($activeSelectionPresent -or $services.Count -ne 0) {
                    $result.state = 'inconsistent'
                    $result.reason = 'selection_or_scm_without_service_key'
                }
                else { $result.reason = 'service_absent' }
            }
            else {
                try {
                    $kinds = [ordered]@{}
                    foreach ($name in @('Type', 'Start', 'ErrorControl',
                            'ServiceSidType', 'RequiredPrivileges', 'ObjectName',
                            'ImagePath')) {
                        $kinds[$name] = $serviceKey.GetValueKind($name).ToString()
                    }
                    $required = $serviceKey.GetValue('RequiredPrivileges', $null,
                        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    $registry = [pscustomobject]@{
                        Kinds = [pscustomobject]$kinds
                        Type = $serviceKey.GetValue('Type')
                        Start = $serviceKey.GetValue('Start')
                        ErrorControl = $serviceKey.GetValue('ErrorControl')
                        ServiceSidType = $serviceKey.GetValue('ServiceSidType')
                        RequiredPrivileges = @($required)
                        ObjectName = $serviceKey.GetValue('ObjectName', $null,
                            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        ImagePath = $serviceKey.GetValue('ImagePath', $null,
                            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    }
                    $result.observations.registry = $registry
                }
                finally { $serviceKey.Dispose() }
                $services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name='LexRunnerCoordinator'" -ErrorAction Stop)
                if ($services.Count -ne 1) { throw 'scm_service_unavailable' }
                $cim = $services[0]
                $result.observations.scm = [ordered]@{
                    PathName = $cim.PathName; StartName = $cim.StartName
                    StartMode = $cim.StartMode; ServiceType = $cim.ServiceType
                    State = $cim.State; ProcessId = $cim.ProcessId
                }
                $reason = Assess-Config $cim $registry $image $activeSelectionPresent
                if ($reason -ne 'observed_unqualified') {
                    $result.state = 'inconsistent'
                    $result.reason = $reason
                }
                else {
                    foreach ($part in @($volume, ([IO.Path]::Combine($volume, 'Program Files')),
                            $app, $generations, $generation)) {
                        $item = Get-Item -LiteralPath $part -Force -ErrorAction Stop
                        if (-not $item.PSIsContainer -or
                            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                            throw 'generation_path_unavailable'
                        }
                    }
                    $observedImage = Read-HeldFile $image (128 * 1024 * 1024)
                    $observedManifest = Read-HeldFile $manifest 16384
                    $result.observations.imageSha256 = $observedImage.sha256
                    $result.observations.manifestSha256 = $observedManifest.sha256
                    if ($observedImage.sha256 -cne $ExpectedImageSha256 -or
                        $observedManifest.sha256 -cne $ExpectedManifestSha256) {
                        $result.state = 'inconsistent'
                        $result.reason = 'generation_digest_mismatch'
                    }
                    else {
                        $manifestText = [Text.UTF8Encoding]::new($false, $true).GetString(
                            $observedManifest.bytes)
                        if ((Compact-Json $manifestText) -cne
                            (Expected-Manifest $ExpectedImageSha256 $ExpectedVersion)) {
                            $result.state = 'inconsistent'
                            $result.reason = 'manifest_contract_mismatch'
                        }
                        else {
                            $sc = [IO.Path]::Combine($system, 'sc.exe')
                            if (-not (Test-Path -LiteralPath $sc -PathType Leaf)) {
                                throw 'scm_acl_probe_unavailable'
                            }
                            $lines = @(& $sc sdshow $serviceName 2>&1 |
                                ForEach-Object { $_.ToString() })
                            $code = $LASTEXITCODE
                            $scOutput = $lines -join [char]10
                            if ($code -ne 0 -or $scOutput.Length -gt 4096) {
                                throw 'scm_acl_probe_unavailable'
                            }
                            $serviceSddl = @($lines | Where-Object { $_ -match '^[OGDS]:' } |
                                Select-Object -Last 1)
                            if ($serviceSddl.Count -ne 1 -or
                                $serviceSddl[0].Length -gt 2048) {
                                throw 'scm_acl_probe_unavailable'
                            }
                            $result.observations.serviceAcl = [ordered]@{
                                sddl = $serviceSddl[0]
                                sha256 = (Digest ([Text.Encoding]::UTF8.GetBytes(
                                    $serviceSddl[0])))
                            }
                            $result.observations.pathAcls = [ordered]@{}
                            foreach ($part in @($app, $generations, $generation,
                                    $image, $manifest)) {
                                $result.observations.pathAcls[$part] =
                                    Read-AclObservation $part
                            }
                            $result.state = 'observed_unqualified'
                            $result.reason = 'structural_readback_only'
                        }
                    }
                }
            }
        }
        finally { $machine.Dispose() }
    }
}
catch {
    $result.state = 'unavailable'
    $result.reason = $_.Exception.Message
}
finally {
    $clock.Stop()
    $result.durationMs = $clock.ElapsedMilliseconds
}

Write-Output (Serialize-BoundedResult $result)
if ($SelfTest -and $result.reason -ne 'synthetic_contract_pass') { exit 1 }
