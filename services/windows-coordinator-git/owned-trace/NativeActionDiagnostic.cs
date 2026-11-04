// Copied finite diagnostics only. No result here grants ownership or cleanup.
internal sealed record NativeActionDiagnostic(uint? NativeResultCode, string FailureStage,
    string? ParseFailure = null, uint IdentityMismatchMask = 0,
    uint? ObservedMode = null, uint? ObservedFlags = null)
{
    internal static readonly string[] ParseFailures = ["capacity", "logger_offset", "logger_bounds",
        "logger_empty", "logger_termination", "file_offset", "file_bounds", "file_empty", "file_termination"];

    internal bool Valid(uint adapterCode, string nativePhase)
    {
        uint expectedFlags;
        if (nativePhase is "initial_query" or "final_query") expectedFlags = 0x16000307;
        else if (nativePhase == "stop") expectedFlags = NativeTraceAdapter.ExpectedTerminalFlags;
        else return false;
        var empty = ParseFailure is null && IdentityMismatchMask == 0 &&
            ObservedMode is null && ObservedFlags is null;
        return FailureStage switch
        {
            "precheck" => adapterCode == 87 && NativeResultCode is null && empty,
            "import" => adapterCode == 127 && NativeResultCode is null && empty,
            "native" => NativeResultCode is > 0 && adapterCode == NativeResultCode && empty,
            "parse" => adapterCode == 13 && NativeResultCode == 0 &&
                ParseFailures.Contains(ParseFailure, StringComparer.Ordinal) && IdentityMismatchMask == 0 &&
                ObservedMode is null && ObservedFlags is null,
            "identity" => adapterCode == 13 && NativeResultCode == 0 && ParseFailure is null &&
                IdentityMismatchMask is >= 1 and <= 31 && ObservedMode is not null && ObservedFlags is not null &&
                ((IdentityMismatchMask & 8) != 0) == (ObservedMode != 0x02400001) &&
                ((IdentityMismatchMask & 16) != 0) == (ObservedFlags != expectedFlags),
            "gate" => nativePhase != "stop" && adapterCode == 13 && NativeResultCode == 0 && ParseFailure is null &&
                IdentityMismatchMask == 0 && ObservedMode is not null && ObservedFlags is not null,
            _ => false,
        };
    }

    internal object Wire() => new { nativeResultCode = NativeResultCode, failureStage = FailureStage,
        parseFailure = ParseFailure, identityMismatchMask = IdentityMismatchMask,
        observedMode = ObservedMode, observedFlags = ObservedFlags };

    internal static object[] WireSamples() => new[] {
        new NativeActionDiagnostic(13, "native"), new NativeActionDiagnostic(0, "parse", "capacity"),
        new NativeActionDiagnostic(0, "identity", IdentityMismatchMask:1, ObservedMode:0x02400001, ObservedFlags:0x16000307)
    }.SelectMany(diagnostic => new[] {
        ManualCaptureDiagnostic.Status("capture", "refused", "initial_ownership_uncertain", null, "initial_query", 13, diagnostic),
        ManualCaptureDiagnostic.Status("capture", "refused", "ownership_or_stop_uncertain", null, "stop", 13,
            diagnostic with { ObservedFlags = diagnostic.ObservedFlags is null ? null : NativeTraceAdapter.ExpectedTerminalFlags })
    }).ToArray();

    internal static IReadOnlyList<NativeActionDiagnosticCase> SelfTest()
    {
        var cases = new List<NativeActionDiagnosticCase>();
        void Check(string name, bool passed) => cases.Add(new(name, passed));
        foreach (var failure in new[] { "capacity_low", "capacity_high", "logger_offset", "logger_bounds",
            "logger_empty", "logger_termination", "file_offset", "file_bounds", "file_empty", "file_termination" })
            Check(failure, NativeTraceAdapter.SyntheticParseFailure(failure));
        var expected = new TraceIdentity("LexRunner Windows Git Loader Qualification",
            Guid.Parse("f6a585fc-57f8-4805-8599-d671282184f5"), @"C:\private\file.etl", 0x02400001, 0x16000307);
        Check("fixed_mode_accepted", NativeTraceAdapter.IdentityIsBounded(expected) &&
            SchemaCensus.CaptureModeIsExpected(expected.Mode));
        foreach (var mode in new uint[] { 0x02000001, 0x02800001, 0x02c00001,
            0x82400001, 0x02400000, 0x02400003 })
        {
            var gate = new OwnedHandleGate(expected); gate.BeginStart(); gate.CompleteStart(new(0,42));
            var began = gate.BeginQuery(42);
            var observed = new TraceObservation(expected.Name, expected.Guid, expected.EtlPath,
                mode, expected.Flags, 0, 0, 0);
            var accepted = gate.CompleteQuery(42, new(0, observed), out var mismatch, out var stateMatched);
            var diagnostic = new NativeActionDiagnostic(0, "identity", IdentityMismatchMask:8,
                ObservedMode:mode, ObservedFlags:expected.Flags);
            Check("fixed_mode_refused_" + mode, began && !accepted && stateMatched && mismatch == 8 &&
                !gate.BeginStop(42) && !gate.BeginQuery(42) &&
                !NativeTraceAdapter.IdentityIsBounded(expected with { Mode = mode }) &&
                !SchemaCensus.CaptureModeIsExpected(mode) && diagnostic.Valid(13, "initial_query") &&
                !(diagnostic with { IdentityMismatchMask = 1 }).Valid(13, "initial_query"));
        }
        {
            var flags = expected.Flags | 0x80000000;
            var gate = new OwnedHandleGate(expected); gate.BeginStart(); gate.CompleteStart(new(0,42)); gate.BeginQuery(42);
            var observed = new TraceObservation(expected.Name, expected.Guid, expected.EtlPath,
                expected.Mode, flags, 0, 0, 0);
            Check("fixed_flags_unknown_refused", !NativeTraceAdapter.IdentityIsBounded(expected with { Flags = flags }) &&
                !gate.CompleteQuery(42, new(0, observed), out var mismatch, out var stateMatched) && stateMatched &&
                mismatch == 16 && !gate.BeginStop(42));
        }
        for (uint mask = 0; mask < 32; mask++)
        {
            var seen = new TraceObservation((mask & 1) == 0 ? expected.Name : "other",
                (mask & 2) == 0 ? expected.Guid : Guid.Empty,
                (mask & 4) == 0 ? expected.EtlPath : "other",
                (mask & 8) == 0 ? expected.Mode : 0, (mask & 16) == 0 ? expected.Flags : 0, 0, 0, 0);
            var gate = new OwnedHandleGate(expected);
            var began = gate.BeginStart(); gate.CompleteStart(new(0, 42));
            began &= gate.BeginQuery(42);
            var accepted = gate.CompleteQuery(42, new(0, seen), out var actual, out var stateMatched);
            Check("mask_" + mask, began && stateMatched && actual == mask && accepted == (mask == 0) &&
                (mask == 0 || (!gate.BeginStop(42) && !gate.BeginQuery(42))));
        }
        var unused = new OwnedHandleGate(expected);
        Check("gate_without_query", !unused.CompleteQuery(42, new(0, null), out var bits, out var matched) && !matched && bits == 0);
        var owned = new OwnedHandleGate(expected); owned.BeginStart(); owned.CompleteStart(new(0,42)); owned.BeginQuery(42);
        Check("gate_wrong_handle", !owned.CompleteQuery(43, new(0, null), out bits, out matched) && !matched && bits == 0);
        foreach (var code in new uint[] { 0, 5, 13 })
        {
            var gate = new OwnedHandleGate(expected); gate.BeginStart(); gate.CompleteStart(new(0,42)); gate.BeginQuery(42);
            Check("missing_" + code, !gate.CompleteQuery(42, new(code, null), out bits, out matched) && matched && bits == 0 && !gate.BeginStop(42));
        }
        var parse = new NativeActionDiagnostic(0,"parse","capacity");
        var native = new NativeActionDiagnostic(13,"native");
        foreach (var stage in new[] { "native", "parse", "identity", "gate" })
        {
            var result = NativeTraceAdapter.SyntheticQueryResult(stage == "native" ? 13u : 0u, stage);
            Check("result_" + stage, result.Code == 13 && result.Observation is null &&
                result.Diagnostic is { } diagnostic && diagnostic.FailureStage == stage && diagnostic.Valid(13, "initial_query"));
        }
        var success = NativeTraceAdapter.SyntheticQueryResult(0, "success");
        Check("result_success", success.Code == 0 && success.Observation is not null && success.Diagnostic is null);
        Check("native13", native.Valid(13, "initial_query")); Check("synthetic13", parse.Valid(13, "initial_query"));
        Check("distinct13", native.NativeResultCode != parse.NativeResultCode && native.FailureStage != parse.FailureStage);
        foreach (var failure in ParseFailures) Check("grammar_" + failure, (parse with { ParseFailure = failure }).Valid(13, "initial_query"));
        Check("precheck", new NativeActionDiagnostic(null,"precheck").Valid(87, "initial_query"));
        Check("import", new NativeActionDiagnostic(null,"import").Valid(127, "initial_query"));
        Check("gate", new NativeActionDiagnostic(0,"gate", ObservedMode:0, ObservedFlags:0).Valid(13, "initial_query"));
        var invalid = new[] {
            parse with { NativeResultCode = null }, parse with { NativeResultCode = 13 },
            parse with { ParseFailure = null }, parse with { ParseFailure = "raw_path" },
            parse with { ObservedMode = 0 }, parse with { IdentityMismatchMask = 1 },
            native with { NativeResultCode = 0 }, native with { NativeResultCode = null },
            native with { NativeResultCode = 5 }, native with { ObservedFlags = 0 },
            new NativeActionDiagnostic(null,"unknown"), new NativeActionDiagnostic(0,"identity", IdentityMismatchMask:32,ObservedMode:0,ObservedFlags:0),
            new NativeActionDiagnostic(0,"identity", IdentityMismatchMask:1,ObservedMode:0,ObservedFlags:0),
            new NativeActionDiagnostic(0,"identity", IdentityMismatchMask:0,ObservedMode:0x02400001,ObservedFlags:0x16000307),
            new NativeActionDiagnostic(0,"gate",IdentityMismatchMask:1,ObservedMode:0,ObservedFlags:0),
            new NativeActionDiagnostic(0,"gate"),
        };
        for (var i = 0; i < invalid.Length; i++) Check("invalid_" + i, !invalid[i].Valid(13, "initial_query"));
        Check("code_pair", !parse.Valid(0, "initial_query"));
        Check("writer_query", ManualCaptureDiagnostic.ValidStatus("capture","refused","initial_ownership_uncertain",null,"initial_query",13,parse));
        Check("writer_final", ManualCaptureDiagnostic.ValidStatus("capture","refused","ownership_or_stop_uncertain",null,"final_query",13,native));
        foreach (var phase in new[] { "start", "stop", "other" })
            Check("writer_" + phase, !ManualCaptureDiagnostic.ValidStatus("capture","refused","initial_ownership_uncertain",null,phase,13,parse));
        Check("writer_summary", !ManualCaptureDiagnostic.ValidStatus("summary","refused","start_failed_or_occupied",new string('a',64),"start",13,parse));
        Check("writer_success", !ManualCaptureDiagnostic.ValidStatus("summary","calibration_observed","calibration_observed",new string('a',64),null,null,parse));
        foreach (var failure in ParseFailures)
        {
            var stopped = NativeTraceAdapter.SyntheticStopResult(0, parseFailure: failure);
            Check("stop_" + failure, stopped.OneShot && stopped.MatchedQueries == 2 &&
                stopped.Result.Code == 13 && stopped.Result.Observation is null &&
                stopped.Result.Diagnostic is { } detail && detail.FailureStage == "parse" &&
                detail.NativeResultCode == 0 && detail.ParseFailure == failure && detail.Valid(13, "stop"));
        }
        var allMasks = true;
        for (uint mask = 0; mask < 32; mask++)
        {
            var stopped = NativeTraceAdapter.SyntheticStopResult(0, mask);
            allMasks &= stopped.OneShot && stopped.MatchedQueries == 2 &&
                (mask == 0 ? stopped.Result.Code == 0 && stopped.Result.Observation is not null && stopped.Result.Diagnostic is null :
                 stopped.Result.Code == 13 && stopped.Result.Observation is null && stopped.Result.Diagnostic is { } detail &&
                 detail.IdentityMismatchMask == mask && detail.FailureStage == "identity" && detail.Valid(13, "stop"));
        }
        Check("stop_all_32_masks", allMasks);
        foreach (var code in new uint[] { 5, 13, 234 })
        {
            var stopped = NativeTraceAdapter.SyntheticStopResult(code);
            Check("stop_raw_" + code, stopped.OneShot && stopped.MatchedQueries == 2 &&
                stopped.Result.Code == code && stopped.Result.Observation is null &&
                stopped.Result.Diagnostic is { } detail && detail.FailureStage == "native" &&
                detail.NativeResultCode == code && detail.Valid(code, "stop"));
        }
        var stopParse = new NativeActionDiagnostic(0, "parse", "capacity");
        Check("writer_stop_parse", ManualCaptureDiagnostic.ValidStatus("capture", "refused", "ownership_or_stop_uncertain", null, "stop", 13, stopParse));
        Check("writer_stop_native", ManualCaptureDiagnostic.ValidStatus("capture", "refused", "ownership_or_stop_uncertain", null, "stop", 13, native));
        Check("writer_stop_gate_bad", !ManualCaptureDiagnostic.ValidStatus("capture", "refused", "ownership_or_stop_uncertain", null, "stop", 13,
            new NativeActionDiagnostic(0, "gate", ObservedMode:0, ObservedFlags:0)));
        Check("writer_stop_summary_bad", !ManualCaptureDiagnostic.ValidStatus("summary", "refused", "ownership_or_stop_uncertain", new string('a',64), "stop", 13, native));
        Check("writer_stop_initial_bad", !ManualCaptureDiagnostic.ValidStatus("capture", "refused", "initial_ownership_uncertain", null, "stop", 13, native));
        var terminalZero = NativeTraceAdapter.SyntheticStopResult(0, terminalFlags:0);
        Check("terminal_zero", terminalZero.OneShot && terminalZero.MatchedQueries == 2 &&
            terminalZero.Result.Code == 0 && terminalZero.Result.Observation?.Flags == 0);
        var terminalRefusals = true;
        foreach (var flags in new uint[] { 0x06000307, 0x16000307, 1, 0x16000306, 0x80000000, uint.MaxValue })
        {
            var value = NativeTraceAdapter.SyntheticStopResult(0, terminalFlags:flags);
            terminalRefusals &= value.OneShot && value.MatchedQueries == 2 && value.Result.Code == 13 &&
                value.Result.Observation is null && value.Result.Diagnostic is { } detail &&
                detail.IdentityMismatchMask == 16 && detail.ObservedFlags == flags && detail.Valid(13, "stop");
        }
        Check("terminal_nonzero_refused", terminalRefusals);
        var activeFlags = new NativeActionDiagnostic(0,"identity",IdentityMismatchMask:1,ObservedMode:0x02400001,ObservedFlags:0x16000307);
        var zeroFlags = activeFlags with { ObservedFlags = 0 };
        Check("active_query_phase", activeFlags.Valid(13,"initial_query") && activeFlags.Valid(13,"final_query") && !activeFlags.Valid(13,"stop"));
        Check("terminal_stop_phase", zeroFlags.Valid(13,"stop") && !zeroFlags.Valid(13,"initial_query") && !zeroFlags.Valid(13,"final_query"));
        Check("active_flagbit", (activeFlags with { IdentityMismatchMask = 16 }).Valid(13,"stop") && !(activeFlags with { IdentityMismatchMask = 16 }).Valid(13,"final_query"));
        Check("zero_flagbit", (zeroFlags with { IdentityMismatchMask = 16 }).Valid(13,"initial_query") && !(zeroFlags with { IdentityMismatchMask = 16 }).Valid(13,"stop"));
        Check("unknown_action_phase", !native.Valid(13,"other"));
        Check("no_sysconfig_required_bits", expected.Flags == 0x16000307 &&
            (expected.Flags & 0x06000307) == 0x06000307 &&
            (expected.Flags ^ 0x06000307) == 0x10000000 &&
            NativeTraceAdapter.IdentityIsBounded(expected));
        bool RefusesActiveFlags(uint flags)
        {
            if (NativeTraceAdapter.IdentityIsBounded(expected with { Flags = flags })) return false;
            foreach (var priorMatch in new[] { false, true })
            {
                var gate = new OwnedHandleGate(expected);
                if (!gate.BeginStart()) return false;
                gate.CompleteStart(new(0, 42));
                if (priorMatch)
                {
                    if (!gate.BeginQuery(42) || !gate.CompleteQuery(42,
                        new(0, new(expected.Name, expected.Guid, expected.EtlPath,
                            expected.Mode, expected.Flags, 0, 0, 0)))) return false;
                }
                if (!gate.BeginQuery(42)) return false;
                var seen = new TraceObservation(expected.Name, expected.Guid, expected.EtlPath,
                    expected.Mode, flags, 0, 0, 0);
                if (gate.CompleteQuery(42, new(0, seen), out var mismatch, out var matched) ||
                    !matched || mismatch != 16 || gate.BeginStop(42) || gate.BeginQuery(42)) return false;
            }
            return true;
        }
        Check("old_active_profile_refused", RefusesActiveFlags(0x06000307));
        var removalsRefuse = true;
        var additionsRefuse = true;
        for (var bit = 0; bit < 32; bit++)
        {
            var mask = 1u << bit;
            if ((expected.Flags & mask) != 0) removalsRefuse &= RefusesActiveFlags(expected.Flags & ~mask);
            else additionsRefuse &= RefusesActiveFlags(expected.Flags | mask);
        }
        Check("required_bit_removals_refused", removalsRefuse);
        Check("unknown_bit_additions_refused", additionsRefuse);
        var oldProfileMismatch = new NativeActionDiagnostic(0, "identity", IdentityMismatchMask:16,
            ObservedMode:expected.Mode, ObservedFlags:0x06000307);
        Check("old_profile_mismatch_grammar", oldProfileMismatch.Valid(13, "initial_query") &&
            oldProfileMismatch.Valid(13, "final_query") &&
            !(oldProfileMismatch with { IdentityMismatchMask = 1 }).Valid(13, "initial_query") &&
            !(oldProfileMismatch with { IdentityMismatchMask = 1 }).Valid(13, "final_query"));
        return cases;
    }
}

internal sealed record NativeActionDiagnosticCase(string Name, bool Passed);
