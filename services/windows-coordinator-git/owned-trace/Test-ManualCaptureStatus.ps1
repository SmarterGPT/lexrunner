param([string]$StatusPath, [int]$NativeExitCode = 3, [switch]$SelfTest)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-ManualStatus([byte[]]$Bytes, [int]$ExitCode) {
    if ($Bytes.Length -lt 1 -or $Bytes.Length -gt 2048) { throw 'manual_status_bounds' }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes) }
    catch { throw 'manual_status_utf8' }
    if ($text.StartsWith([char]0xFEFF) -or $text.Contains("`r") -or
        -not $text.EndsWith("`n") -or $text.EndsWith("`n`n")) { throw 'manual_status_encoding' }
    $document = $null
    try {
        $document = [Text.Json.JsonDocument]::Parse($text)
        $root = $document.RootElement
        if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'manual_status_shape' }
        $expected = @('schemaVersion','phase','result','reasonCode','summarySha256',
            'rawEtlDeleted','authorizesLoaderClosure','authorizesExecution','nativePhase','nativeCode')
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $root.EnumerateObject()) {
            if ($property.Name -cnotin $expected -or -not $names.Add($property.Name)) {
                throw 'manual_status_keys'
            }
        }
        if ($names.Count -ne $expected.Count) { throw 'manual_status_keys' }
        foreach ($key in @('schemaVersion','phase','result','reasonCode')) {
            if ($root.GetProperty($key).ValueKind -ne [Text.Json.JsonValueKind]::String) {
                throw 'manual_status_type'
            }
        }
        foreach ($key in @('authorizesLoaderClosure','authorizesExecution')) {
            if ($root.GetProperty($key).ValueKind -ne [Text.Json.JsonValueKind]::False) {
                throw 'manual_status_authority'
            }
        }
        if ($root.GetProperty('schemaVersion').GetString() -cne 'lexrunner-owned-etw-manual-status/2') {
            throw 'manual_status_schema'
        }
        $phase = $root.GetProperty('phase').GetString()
        $reason = $root.GetProperty('reasonCode').GetString()
        $result = $root.GetProperty('result').GetString()
        $preflight = @('arguments_invalid','offline_census_preflight_required',
            'preflight_os','preflight_x64','preflight_event','preflight_source_head',
            'preflight_runner_identity','preflight_numeric_ids','preflight_elevation',
            'preflight_native_layout','preflight_runner_temp_root','preflight_workspace_root',
            'preflight_git_image_digest','preflight_fixture_image')
        $capture = @('initial_ownership_uncertain','ownership_or_stop_uncertain',
            'job_terminal_uncertain','census_terminal_uncertain','cleanup_uncertain',
            'summary_bounds_refused','summary_output_occupied','summary_write_unavailable')
        $summary = @('calibration_observed','capture_unstarted','start_failed_or_occupied',
            'probe_observed','probe_refused',
            'etl_missing_or_cap_refused','owned_loss_refused','etl_census_or_loss_refused',
            'capture_deadline_refused','capture_exception')
        $nativePhase = $null
        $nativeCode = $null
        $nativeField = $root.GetProperty('nativePhase')
        $codeField = $root.GetProperty('nativeCode')
        if ($nativeField.ValueKind -eq [Text.Json.JsonValueKind]::Null) {
            if ($codeField.ValueKind -ne [Text.Json.JsonValueKind]::Null) { throw 'manual_status_native_pair' }
        } else {
            if ($nativeField.ValueKind -ne [Text.Json.JsonValueKind]::String -or
                $codeField.ValueKind -ne [Text.Json.JsonValueKind]::Number -or $phase -ceq 'preflight') {
                throw 'manual_status_native_type'
            }
            $nativePhase = $nativeField.GetString()
            if ($nativePhase -cnotin @('start','initial_query','final_query','stop')) { throw 'manual_status_native_phase' }
            $nativeCode = $codeField.GetUInt32()
        }
        # Match the writer's reachable native-failure combinations. A zero code
        # can accompany invalid handle/observation readback; it is never success proof.
        if ($null -ne $nativePhase) {
            $nativeAllowed = switch ($reason) {
                'initial_ownership_uncertain' { $nativePhase -ceq 'initial_query' -or ($nativePhase -ceq 'start' -and $nativeCode -eq 0) }
                'ownership_or_stop_uncertain' { $nativePhase -cin @('final_query','stop') }
                { $_ -cin @('cleanup_uncertain','summary_bounds_refused','summary_output_occupied','summary_write_unavailable','start_failed_or_occupied') } {
                    $nativePhase -ceq 'start' -and $nativeCode -ne 0
                }
                default { $false }
            }
            if (-not $nativeAllowed -or $result -cne 'refused') { throw 'manual_status_native_consistency' }
        } elseif ($reason -ceq 'start_failed_or_occupied') { throw 'manual_status_start_code_required' }
        $summaryAvailable = $phase -ceq 'summary'
        if ($phase -ceq 'preflight') { $allowed = $preflight }
        elseif ($phase -ceq 'capture') { $allowed = $capture }
        elseif ($summaryAvailable) { $allowed = $summary }
        else { throw 'manual_status_phase' }
        if ($reason -cnotin $allowed) { throw 'manual_status_reason' }
        if ($result -cnotin @('refused','calibration_observed') -or
            ($result -ceq 'calibration_observed' -and
                ($phase -cne 'summary' -or $reason -cne 'calibration_observed' -or $ExitCode -ne 0)) -or
            ($result -ceq 'refused' -and ($reason -ceq 'calibration_observed' -or $ExitCode -ne 3))) {
            throw 'manual_status_exit_or_result'
        }
        if ($summaryAvailable) {
            if ($root.GetProperty('summarySha256').ValueKind -ne [Text.Json.JsonValueKind]::String -or
                $root.GetProperty('summarySha256').GetString() -cnotmatch '^[0-9a-f]{64}$' -or
                $root.GetProperty('rawEtlDeleted').ValueKind -ne [Text.Json.JsonValueKind]::True) {
                throw 'manual_status_summary'
            }
        } elseif ($root.GetProperty('summarySha256').ValueKind -ne [Text.Json.JsonValueKind]::Null -or
            $root.GetProperty('rawEtlDeleted').ValueKind -ne [Text.Json.JsonValueKind]::False) {
            throw 'manual_status_uncertain_claim'
        }
        # Emit only constants or finite validated codes. Never return the input text or digest.
        return [pscustomobject]@{
            schemaVersion = 'lexrunner-etw-sanitized-status/1'
            phase = $phase
            result = $result
            reasonCode = $reason
            nativePhase = $nativePhase
            nativeCode = $nativeCode
            summaryAvailable = $summaryAvailable
            authorizesExecution = $false
        }
    } catch { throw 'manual_status_refused' }
    finally { if ($null -ne $document) { $document.Dispose() } }
}

if ($SelfTest) {
    $base = '{"schemaVersion":"lexrunner-owned-etw-manual-status/2","phase":"preflight","result":"refused","reasonCode":"preflight_elevation","summarySha256":null,"rawEtlDeleted":false,"authorizesLoaderClosure":false,"authorizesExecution":false,"nativePhase":null,"nativeCode":null}' + "`n"
    $encode = [Text.UTF8Encoding]::new($false, $true)
    $cases = [Collections.Generic.List[object]]::new()
    $valid = Read-ManualStatus ($encode.GetBytes($base)) 3
    if ($valid.reasonCode -cne 'preflight_elevation' -or $valid.summaryAvailable) { throw 'manual_status_selftest' }
    $cases.Add(@{name='valid_preflight';passed=$true})
    $observed = $base.Replace('"phase":"preflight"','"phase":"summary"').Replace('"result":"refused"','"result":"calibration_observed"').Replace('preflight_elevation','calibration_observed').Replace('"summarySha256":null',('"summarySha256":"' + ('a'*64) + '"')).Replace('"rawEtlDeleted":false','"rawEtlDeleted":true')
    $valid = Read-ManualStatus ($encode.GetBytes($observed)) 0
    if (-not $valid.summaryAvailable) { throw 'manual_status_selftest' }
    $cases.Add(@{name='valid_summary';passed=$true})
    $uncertain = $base.Replace('"phase":"preflight"','"phase":"capture"').Replace('preflight_elevation','cleanup_uncertain')
    $valid = Read-ManualStatus ($encode.GetBytes($uncertain)) 3
    if ($valid.summaryAvailable) { throw 'manual_status_selftest' }
    $cases.Add(@{name='valid_uncertain';passed=$true})
    $nativeUncertain = $uncertain.Replace('cleanup_uncertain','ownership_or_stop_uncertain')
    $withNative = $nativeUncertain.Replace('"nativePhase":null','"nativePhase":"stop"').Replace('"nativeCode":null','"nativeCode":5')
    $valid = Read-ManualStatus ($encode.GetBytes($withNative)) 3
    if ($valid.nativePhase -cne 'stop' -or $valid.nativeCode -ne 5) { throw 'manual_status_native_selftest' }
    $cases.Add(@{name='valid_observed_native_code';passed=$true})
    $bad = @(
        @{name='native_overflow';text=$withNative.Replace('"nativeCode":5','"nativeCode":4294967296');exit=3},
        @{name='preflight_native_claim';text=$base.Replace('"nativePhase":null','"nativePhase":"start"').Replace('"nativeCode":null','"nativeCode":5');exit=3},
        @{name='native_unknown_phase';text=$withNative.Replace('"nativePhase":"stop"','"nativePhase":"unknown"');exit=3},
        @{name='native_pair_missing';text=$withNative.Replace('"nativeCode":5','"nativeCode":null');exit=3},
        @{name='native_string_code';text=$withNative.Replace('"nativeCode":5','"nativeCode":"5"');exit=3},
        @{name='overflow';text=('x'*2049);exit=3},
        @{name='duplicate';text=$base.Replace('"phase":"preflight"','"phase":"preflight","phase":"capture"');exit=3},
        @{name='unknown_key';text=$base.Replace('"phase":"preflight"','"unexpected":"C:\\secret.etl","phase":"preflight"');exit=3},
        @{name='authority_true';text=$base.Replace('"authorizesExecution":false','"authorizesExecution":true');exit=3},
        @{name='authority_string';text=$base.Replace('"authorizesExecution":false','"authorizesExecution":"false"');exit=3},
        @{name='unknown_reason';text=$base.Replace('preflight_elevation','C:\\secret.etl');exit=3},
        @{name='no_lf';text=$base.TrimEnd("`n");exit=3},
        @{name='two_lf';text=($base+"`n");exit=3},
        @{name='crlf';text=$base.Replace("`n","`r`n");exit=3},
        @{name='bom';text=([char]0xFEFF+$base);exit=3},
        @{name='noise';text=('noise'+$base);exit=3},
        @{name='two_objects';text=($base+$base);exit=3},
        @{name='schema1';text=$base.Replace('manual-status/2','manual-status/1');exit=3},
        @{name='deletion_claim';text=$base.Replace('"rawEtlDeleted":false','"rawEtlDeleted":true');exit=3},
        @{name='exit_mismatch';text=$base;exit=0},
        @{name='summary_missing_digest';text=$base.Replace('"phase":"preflight"','"phase":"summary"').Replace('preflight_elevation','probe_refused');exit=3}
    )
    # Cross-field controls target the exact forgery rejected in independent review.
    foreach ($reason in @('initial_ownership_uncertain','ownership_or_stop_uncertain',
        'job_terminal_uncertain','census_terminal_uncertain','cleanup_uncertain',
        'final_ownership_uncertain','stop_disposition_uncertain','ownership_or_stop_exception')) {
        $bad += @{name=('uncertain_summary_'+$reason);text=$observed.Replace('"result":"calibration_observed"','"result":"refused"').Replace('"reasonCode":"calibration_observed"',('"reasonCode":"'+$reason+'"'));exit=3}
    }
    foreach ($phase in @('start','initial_query','final_query','stop')) {
        foreach ($code in @(0,5)) {
            $bad += @{name=('observed_native_'+$phase+'_'+$code);text=$observed.Replace('"nativePhase":null',('"nativePhase":"'+$phase+'"')).Replace('"nativeCode":null',('"nativeCode":'+$code));exit=0}
        }
    }
    $bad += @{name='refused_probe_native_stop';text=$observed.Replace('"result":"calibration_observed"','"result":"refused"').Replace('"reasonCode":"calibration_observed"','"reasonCode":"probe_refused"').Replace('"nativePhase":null','"nativePhase":"stop"').Replace('"nativeCode":null','"nativeCode":5');exit=3}
    $bad += @{name='cleanup_native_stop';text=$withNative.Replace('ownership_or_stop_uncertain','cleanup_uncertain');exit=3}
    $bad += @{name='ownership_native_start';text=$withNative.Replace('"nativePhase":"stop"','"nativePhase":"start"');exit=3}
    $bad += @{name='initial_native_stop';text=$withNative.Replace('ownership_or_stop_uncertain','initial_ownership_uncertain');exit=3}
    $startFailure = $observed.Replace('"result":"calibration_observed"','"result":"refused"').Replace('"reasonCode":"calibration_observed"','"reasonCode":"start_failed_or_occupied"').Replace('"nativePhase":null','"nativePhase":"start"').Replace('"nativeCode":null','"nativeCode":5')
    $valid = Read-ManualStatus ($encode.GetBytes($startFailure)) 3
    if (-not $valid.summaryAvailable -or $valid.nativePhase -cne 'start' -or $valid.nativeCode -ne 5) { throw 'manual_status_start_selftest' }
    $cases.Add(@{name='valid_start_failure_summary';passed=$true})
    $bad += @{name='summary_start_missing_code';text=$startFailure.Replace('"nativePhase":"start"','"nativePhase":null').Replace('"nativeCode":5','"nativeCode":null');exit=3}
    $bad += @{name='summary_start_zero_code';text=$startFailure.Replace('"nativeCode":5','"nativeCode":0');exit=3}
    foreach ($row in $bad) {
        $refused = $false
        try { $null = Read-ManualStatus ($encode.GetBytes($row.text)) $row.exit } catch { $refused = $true }
        if (-not $refused) { throw 'manual_status_selftest_accepted_bad_record' }
        $cases.Add(@{name=$row.name;passed=$true})
    }
    $refused = $false
    try { $null = Read-ManualStatus ([byte[]]@(0xC3,0x28,0x0A)) 3 } catch { $refused = $true }
    if (-not $refused) { throw 'manual_status_selftest_utf8' }
    $cases.Add(@{name='invalid_utf8';passed=$true})
    return [pscustomobject]@{result='source_status_pass';caseCount=$cases.Count;cases=@($cases.ToArray());authorizesExecution=$false}
}

if (-not [IO.Path]::IsPathFullyQualified($StatusPath) -or -not [IO.File]::Exists($StatusPath)) {
    throw 'manual_status_file_unavailable'
}
$file = [IO.FileInfo]::new($StatusPath)
if ($file.Length -lt 1 -or $file.Length -gt 2048 -or
    ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'manual_status_file_bound' }
Read-ManualStatus ([IO.File]::ReadAllBytes($StatusPath)) $NativeExitCode
