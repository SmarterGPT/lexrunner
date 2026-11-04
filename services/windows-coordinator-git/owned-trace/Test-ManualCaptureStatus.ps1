param([string]$StatusPath, [int]$NativeExitCode = 3, [switch]$SelfTest)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-NativeActionDiagnostic($Value, [uint32]$AdapterCode, [string]$NativePhase) {
    if ($NativePhase -ceq 'stop') { $expectedFlags = [uint32]0 }
    elseif ($NativePhase -cin @('initial_query','final_query')) { $expectedFlags = [uint32]0x16000307 }
    else { throw 'action_phase' }
    if ($Value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'query_shape' }
    $keys = @('nativeResultCode','failureStage','parseFailure','identityMismatchMask','observedMode','observedFlags')
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $Value.EnumerateObject()) {
        if ($property.Name -cnotin $keys -or -not $names.Add($property.Name)) { throw 'query_keys' }
    }
    if ($names.Count -ne $keys.Count) { throw 'query_keys' }
    $values = @{}
    foreach ($key in @('nativeResultCode','observedMode','observedFlags')) {
        $field = $Value.GetProperty($key)
        if ($field.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $values[$key] = $null }
        elseif ($field.ValueKind -eq [Text.Json.JsonValueKind]::Number) { $values[$key] = $field.GetUInt32() }
        else { throw 'query_number' }
    }
    $maskField = $Value.GetProperty('identityMismatchMask')
    if ($maskField.ValueKind -ne [Text.Json.JsonValueKind]::Number) { throw 'query_mask' }
    $mask = $maskField.GetUInt32()
    $stageField = $Value.GetProperty('failureStage')
    if ($stageField.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw 'query_stage' }
    $stage = $stageField.GetString()
    $parseField = $Value.GetProperty('parseFailure')
    if ($parseField.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $parse = $null }
    elseif ($parseField.ValueKind -eq [Text.Json.JsonValueKind]::String) { $parse = $parseField.GetString() }
    else { throw 'query_parse' }
    $raw = $values.nativeResultCode; $mode = $values.observedMode; $flags = $values.observedFlags
    $empty = $null -eq $parse -and $mask -eq 0 -and $null -eq $mode -and $null -eq $flags
    $valid = switch -CaseSensitive ($stage) {
        'precheck' { $AdapterCode -eq 87 -and $null -eq $raw -and $empty }
        'import' { $AdapterCode -eq 127 -and $null -eq $raw -and $empty }
        'native' { $null -ne $raw -and $raw -gt 0 -and $AdapterCode -eq $raw -and $empty }
        'parse' { $AdapterCode -eq 13 -and $null -ne $raw -and $raw -eq 0 -and
            $parse -cin @('capacity','logger_offset','logger_bounds','logger_empty','logger_termination',
                'file_offset','file_bounds','file_empty','file_termination') -and $mask -eq 0 -and
            $null -eq $mode -and $null -eq $flags }
        'identity' { $AdapterCode -eq 13 -and $null -ne $raw -and $raw -eq 0 -and $null -eq $parse -and
            $mask -ge 1 -and $mask -le 31 -and $null -ne $mode -and $null -ne $flags -and
            ((($mask -band 8) -ne 0) -eq ($mode -ne 0x02400001)) -and
            ((($mask -band 16) -ne 0) -eq ($flags -ne $expectedFlags)) }
        'gate' { $NativePhase -cne 'stop' -and $AdapterCode -eq 13 -and $null -ne $raw -and $raw -eq 0 -and $null -eq $parse -and
            $mask -eq 0 -and $null -ne $mode -and $null -ne $flags }
        default { $false }
    }
    if (-not $valid) { throw 'query_consistency' }
    [pscustomobject]@{nativeResultCode=$raw;failureStage=$stage;parseFailure=$parse;
        identityMismatchMask=$mask;observedMode=$mode;observedFlags=$flags}
}

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
            'rawEtlDeleted','authorizesLoaderClosure','authorizesExecution','nativePhase','nativeCode','nativeActionDiagnostic')
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
        if ($root.GetProperty('schemaVersion').GetString() -cne 'lexrunner-owned-etw-manual-status/6') {
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
        $nativeActionDiagnostic = $null
        $queryField = $root.GetProperty('nativeActionDiagnostic')
        if ($queryField.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
            if ($phase -cne 'capture' -or $result -cne 'refused' -or
                $nativePhase -cnotin @('initial_query','final_query','stop') -or $null -eq $nativeCode) {
                throw 'query_phase'
            }
            $nativeActionDiagnostic = Read-NativeActionDiagnostic $queryField $nativeCode $nativePhase
            if ($nativePhase -ceq 'stop' -and $nativeActionDiagnostic.failureStage -ceq 'gate') { throw 'action_stop_gate' }
        }
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
            nativeActionDiagnostic = $nativeActionDiagnostic
            summaryAvailable = $summaryAvailable
            authorizesExecution = $false
        }
    } catch { throw 'manual_status_refused' }
    finally { if ($null -ne $document) { $document.Dispose() } }
}

if ($SelfTest) {
    $base = '{"schemaVersion":"lexrunner-owned-etw-manual-status/6","phase":"preflight","result":"refused","reasonCode":"preflight_elevation","summarySha256":null,"rawEtlDeleted":false,"authorizesLoaderClosure":false,"authorizesExecution":false,"nativePhase":null,"nativeCode":null,"nativeActionDiagnostic":null}' + "`n"
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
        @{name='schema1';text=$base.Replace('manual-status/6','manual-status/1');exit=3},
        @{name='schema2';text=$base.Replace('manual-status/6','manual-status/2');exit=3},
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
    $queryBase = $base.Replace('"phase":"preflight"','"phase":"capture"').Replace('preflight_elevation','initial_ownership_uncertain').Replace('"nativePhase":null','"nativePhase":"initial_query"').Replace('"nativeCode":null','"nativeCode":13')
    $query = '{"nativeResultCode":0,"failureStage":"parse","parseFailure":"capacity","identityMismatchMask":0,"observedMode":null,"observedFlags":null}'
    function Check-Query([string]$Name, [string]$Json, [int]$Code = 13) {
        $wire = $queryBase.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $Json)).Replace('"nativeCode":13',('"nativeCode":' + $Code))
        $read = Read-ManualStatus ($encode.GetBytes($wire)) 3
        if ($null -eq $read.nativeActionDiagnostic -or $read.summaryAvailable) { throw 'query_selftest' }
        $cases.Add(@{name=$Name;passed=$true})
    }
    foreach ($failure in @('capacity','logger_offset','logger_bounds','logger_empty','logger_termination','file_offset','file_bounds','file_empty','file_termination')) {
        Check-Query ('query_' + $failure) ($query.Replace('capacity',$failure))
    }
    $rawNative = $query.Replace('"nativeResultCode":0','"nativeResultCode":13').Replace('"failureStage":"parse"','"failureStage":"native"').Replace('"parseFailure":"capacity"','"parseFailure":null')
    Check-Query 'query_native13' $rawNative
    foreach ($stage in @('precheck','import')) {
        $code = if ($stage -ceq 'precheck') {87} else {127}
        Check-Query ('query_' + $stage) ($rawNative.Replace('"nativeResultCode":13','"nativeResultCode":null').Replace('native"',($stage + '"'))) $code
    }
    $identity = $query.Replace('"failureStage":"parse"','"failureStage":"identity"').Replace('"parseFailure":"capacity"','"parseFailure":null').Replace('"identityMismatchMask":0','"identityMismatchMask":1').Replace('"observedMode":null','"observedMode":37748737').Replace('"observedFlags":null','"observedFlags":369099527')
    for ($mask = 1; $mask -le 31; $mask++) {
        $wire = $identity.Replace('"identityMismatchMask":1',('"identityMismatchMask":' + $mask))
        if ($mask -band 8) { $wire = $wire.Replace('"observedMode":37748737','"observedMode":0') }
        if ($mask -band 16) { $wire = $wire.Replace('"observedFlags":369099527','"observedFlags":0') }
        Check-Query ('query_mask_' + $mask) $wire
    }
    Check-Query 'query_gate' ($identity.Replace('identity"','gate"').Replace('"identityMismatchMask":1','"identityMismatchMask":0'))
    foreach ($mode in @(33554433,41943041,46137345,2185232385,37748736,37748739)) {
        $modeWire = $identity.Replace('"identityMismatchMask":1','"identityMismatchMask":8').Replace('"observedMode":37748737',('"observedMode":' + $mode))
        Check-Query ('fixed_mode_mismatch_report_' + $mode) $modeWire
        $bad += @{name=('fixed_mode_missing_bit_' + $mode);text=$queryBase.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $modeWire.Replace('"identityMismatchMask":8','"identityMismatchMask":1')));exit=3}
    }
    $mutations = @(
        $query.Replace('"failureStage":"parse"','"failureStage":"Parse"'),
        $query.Replace('"failureStage":"parse"','"failureStage":"unknown"'),
        $query.Replace('"nativeResultCode":0','"nativeResultCode":null'),
        $query.Replace('"nativeResultCode":0','"nativeResultCode":13'),
        $query.Replace('"nativeResultCode":0','"nativeResultCode":-1'),
        $query.Replace('"nativeResultCode":0','"nativeResultCode":4294967296'),
        $query.Replace('"nativeResultCode":0','"nativeResultCode":"0"'),
        $query.Replace('"parseFailure":"capacity"','"parseFailure":null'),
        $query.Replace('capacity','C:\not_logged.etl'),
        $query.Replace('"identityMismatchMask":0','"identityMismatchMask":1'),
        $query.Replace('"identityMismatchMask":0','"identityMismatchMask":null'),
        $query.Replace('"observedMode":null','"observedMode":0'),
        $query.Replace('"observedFlags":null','"observedFlags":true'),
        $query.Replace('"failureStage":"parse"','"failureStage":"parse","failureStage":"native"'),
        $query.Replace('"failureStage":"parse"','"extra":"hidden","failureStage":"parse"'),
        $query.Replace(',"parseFailure":"capacity"',''),
        $rawNative.Replace('"nativeResultCode":13','"nativeResultCode":0'),
        $rawNative.Replace('"nativeResultCode":13','"nativeResultCode":5'),
        $identity.Replace('"identityMismatchMask":1','"identityMismatchMask":32'),
        $identity.Replace('"identityMismatchMask":1','"identityMismatchMask":0'),
        $identity.Replace('"observedMode":37748737','"observedMode":null'),
        $identity.Replace('"observedMode":37748737','"observedMode":0'),
        $identity.Replace('"observedFlags":369099527','"observedFlags":0'),
        $identity.Replace('identity"','gate"'),
        '[]', '"opaque"', 'true'
    )
    for ($i = 0; $i -lt $mutations.Count; $i++) {
        $bad += @{name=('query_bad_' + $i);text=$queryBase.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $mutations[$i]));exit=3}
    }
    foreach ($template in @($base,$observed,$withNative,$startFailure)) {
        $bad += @{name='query_wrong_phase';text=$template.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $query));exit=3}
    }
    $bad += @{name='schema3';text=$base.Replace('manual-status/6','manual-status/3');exit=3}
    $bad += @{name='old_query_field';text=$base.Replace('"nativeActionDiagnostic":null','"queryDiagnostic":null');exit=3}
    foreach ($failure in @('capacity','logger_offset','logger_bounds','logger_empty','logger_termination','file_offset','file_bounds','file_empty','file_termination')) {
        $wire = $queryBase.Replace('"nativePhase":"initial_query"','"nativePhase":"stop"').Replace('initial_ownership_uncertain','ownership_or_stop_uncertain').Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $query.Replace('capacity',$failure)))
        $validStop = Read-ManualStatus ($encode.GetBytes($wire)) 3
        if ($validStop.summaryAvailable -or $validStop.nativeActionDiagnostic.parseFailure -cne $failure) { throw 'stop_parse_selftest' }
        $cases.Add(@{name=('stop_parse_' + $failure);passed=$true})
    }
    $terminalIdentity = $identity.Replace('"observedFlags":369099527','"observedFlags":0')
    foreach ($detail in @($rawNative,$terminalIdentity)) {
        $wire = $queryBase.Replace('"nativePhase":"initial_query"','"nativePhase":"stop"').Replace('initial_ownership_uncertain','ownership_or_stop_uncertain').Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $detail))
        $validStop = Read-ManualStatus ($encode.GetBytes($wire)) 3
        if ($validStop.summaryAvailable) { throw 'stop_native_selftest' }
        $cases.Add(@{name='stop_diagnostic';passed=$true})
        $bad += @{name='stop_initial_reason';text=$wire.Replace('ownership_or_stop_uncertain','initial_ownership_uncertain');exit=3}
        $bad += @{name='stop_summary_claim';text=$wire.Replace('"phase":"capture"','"phase":"summary"');exit=3}
    }
    $stopGate = $queryBase.Replace('"nativePhase":"initial_query"','"nativePhase":"stop"').Replace('initial_ownership_uncertain','ownership_or_stop_uncertain').Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $identity.Replace('identity"','gate"').Replace('"identityMismatchMask":1','"identityMismatchMask":0')))
    $bad += @{name='stop_impossible_post_gate';text=$stopGate;exit=3}
    $bad += @{name='schema4';text=$base.Replace('manual-status/6','manual-status/4');exit=3}
    $bad += @{name='schema5';text=$base.Replace('manual-status/6','manual-status/5');exit=3}
    $stopBase = $queryBase.Replace('"nativePhase":"initial_query"','"nativePhase":"stop"').Replace('initial_ownership_uncertain','ownership_or_stop_uncertain')
    foreach ($flags in @([uint32]369099527,[uint32]1,[uint32]369099526,[uint32]2147483648,[uint32]4294967295)) {
        $detail = $terminalIdentity.Replace('"identityMismatchMask":1','"identityMismatchMask":16').Replace('"observedFlags":0',('"observedFlags":' + $flags))
        $wire = $stopBase.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $detail))
        $read = Read-ManualStatus ($encode.GetBytes($wire)) 3
        if ($read.summaryAvailable -or $read.nativeActionDiagnostic.identityMismatchMask -ne 16) { throw 'terminal_nonzero_diagnostic' }
        $cases.Add(@{name=('terminal_flag_refusal_' + $flags);passed=$true})
        $bad += @{name=('terminal_flagbit_missing_' + $flags);text=$wire.Replace('"identityMismatchMask":16','"identityMismatchMask":1');exit=3}
    }
    $bad += @{name='active_query_zero_no_bit';text=$queryBase.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $terminalIdentity));exit=3}
    $bad += @{name='final_query_zero_no_bit';text=$queryBase.Replace('"nativePhase":"initial_query"','"nativePhase":"final_query"').Replace('initial_ownership_uncertain','ownership_or_stop_uncertain').Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $terminalIdentity));exit=3}
    $bad += @{name='terminal_zero_extra_bit';text=$stopBase.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $terminalIdentity.Replace('"identityMismatchMask":1','"identityMismatchMask":16')));exit=3}
    # The old profile and every single-bit deviation are valid observations of
    # refusal only when the active-query flags mismatch bit is present.
    $variants = [Collections.Generic.List[uint32]]::new()
    $variants.Add([uint32]0x06000307)
    $profile = [uint32]0x16000307
    for ($bit = 0; $bit -lt 32; $bit++) {
        $mask = [uint32]([uint64]1 -shl $bit)
        if (($profile -band $mask) -ne 0) { $variants.Add($profile -bxor $mask) }
        else { $variants.Add($profile -bor $mask) }
    }
    foreach ($flags in $variants) {
        foreach ($phase in @('initial_query','final_query')) {
            $detail = $identity.Replace('"identityMismatchMask":1','"identityMismatchMask":16').Replace('"observedFlags":369099527',('"observedFlags":' + $flags))
            $wire = $queryBase.Replace('"nativeActionDiagnostic":null',('"nativeActionDiagnostic":' + $detail))
            if ($phase -ceq 'final_query') {
                $wire = $wire.Replace('"nativePhase":"initial_query"','"nativePhase":"final_query"').Replace('initial_ownership_uncertain','ownership_or_stop_uncertain')
            }
            $read = Read-ManualStatus ($encode.GetBytes($wire)) 3
            if ($read.summaryAvailable -or $read.nativeActionDiagnostic.identityMismatchMask -ne 16 -or $read.nativeActionDiagnostic.observedFlags -ne $flags) { throw 'active_profile_mismatch_selftest' }
            $rejected = $false
            try { $null = Read-ManualStatus ($encode.GetBytes($wire.Replace('"identityMismatchMask":16','"identityMismatchMask":1'))) 3 } catch { $rejected = $true }
            if (-not $rejected) { throw 'active_profile_missing_bit_selftest' }
        }
    }
    $cases.Add(@{name='active_profile_variants_reported';passed=$true})
    $cases.Add(@{name='active_profile_variants_forgery_refused';passed=$true})
    foreach ($row in $bad) {
        $refused = $false
        try { $null = Read-ManualStatus ($encode.GetBytes($row.text)) $row.exit } catch { $refused = $true }
        if (-not $refused) { throw ('manual_status_selftest_accepted_bad_record:' + $row.name) }
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
