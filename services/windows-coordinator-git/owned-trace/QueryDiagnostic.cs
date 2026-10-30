// Copied finite diagnostics only. No result here grants ownership or cleanup.
internal sealed record QueryDiagnostic(uint? NativeResultCode, string FailureStage,
    string? ParseFailure = null, uint IdentityMismatchMask = 0,
    uint? ObservedMode = null, uint? ObservedFlags = null)
{
    internal static readonly string[] ParseFailures = ["capacity", "logger_offset", "logger_bounds",
        "logger_empty", "logger_termination", "file_offset", "file_bounds", "file_empty", "file_termination"];

    internal bool Valid(uint adapterCode)
    {
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
                ((IdentityMismatchMask & 8) != 0) == (ObservedMode != 0x02000001) &&
                ((IdentityMismatchMask & 16) != 0) == (ObservedFlags != 0x06000307),
            "gate" => adapterCode == 13 && NativeResultCode == 0 && ParseFailure is null &&
                IdentityMismatchMask == 0 && ObservedMode is not null && ObservedFlags is not null,
            _ => false,
        };
    }

    internal object Wire() => new { nativeResultCode = NativeResultCode, failureStage = FailureStage,
        parseFailure = ParseFailure, identityMismatchMask = IdentityMismatchMask,
        observedMode = ObservedMode, observedFlags = ObservedFlags };

    internal static object[] WireSamples() => new[] {
        new QueryDiagnostic(13, "native"), new QueryDiagnostic(0, "parse", "capacity"),
        new QueryDiagnostic(0, "identity", IdentityMismatchMask:1, ObservedMode:0x02000001, ObservedFlags:0x06000307)
    }.Select(diagnostic => ManualCaptureDiagnostic.Status("capture", "refused",
        "initial_ownership_uncertain", null, "initial_query", 13, diagnostic)).ToArray();

    internal static IReadOnlyList<QueryDiagnosticCase> SelfTest()
    {
        var cases = new List<QueryDiagnosticCase>();
        void Check(string name, bool passed) => cases.Add(new(name, passed));
        foreach (var failure in new[] { "capacity_low", "capacity_high", "logger_offset", "logger_bounds",
            "logger_empty", "logger_termination", "file_offset", "file_bounds", "file_empty", "file_termination" })
            Check(failure, NativeTraceAdapter.SyntheticParseFailure(failure));
        var expected = new TraceIdentity("LexRunner Windows Git Loader Qualification",
            Guid.Parse("f6a585fc-57f8-4805-8599-d671282184f5"), @"C:\private\file.etl", 0x02000001, 0x06000307);
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
        var parse = new QueryDiagnostic(0,"parse","capacity");
        var native = new QueryDiagnostic(13,"native");
        foreach (var stage in new[] { "native", "parse", "identity", "gate" })
        {
            var result = NativeTraceAdapter.SyntheticQueryResult(stage == "native" ? 13u : 0u, stage);
            Check("result_" + stage, result.Code == 13 && result.Observation is null &&
                result.Diagnostic is { } diagnostic && diagnostic.FailureStage == stage && diagnostic.Valid(13));
        }
        var success = NativeTraceAdapter.SyntheticQueryResult(0, "success");
        Check("result_success", success.Code == 0 && success.Observation is not null && success.Diagnostic is null);
        Check("native13", native.Valid(13)); Check("synthetic13", parse.Valid(13));
        Check("distinct13", native.NativeResultCode != parse.NativeResultCode && native.FailureStage != parse.FailureStage);
        foreach (var failure in ParseFailures) Check("grammar_" + failure, (parse with { ParseFailure = failure }).Valid(13));
        Check("precheck", new QueryDiagnostic(null,"precheck").Valid(87));
        Check("import", new QueryDiagnostic(null,"import").Valid(127));
        Check("gate", new QueryDiagnostic(0,"gate", ObservedMode:0, ObservedFlags:0).Valid(13));
        var invalid = new[] {
            parse with { NativeResultCode = null }, parse with { NativeResultCode = 13 },
            parse with { ParseFailure = null }, parse with { ParseFailure = "raw_path" },
            parse with { ObservedMode = 0 }, parse with { IdentityMismatchMask = 1 },
            native with { NativeResultCode = 0 }, native with { NativeResultCode = null },
            native with { NativeResultCode = 5 }, native with { ObservedFlags = 0 },
            new QueryDiagnostic(null,"unknown"), new QueryDiagnostic(0,"identity", IdentityMismatchMask:32,ObservedMode:0,ObservedFlags:0),
            new QueryDiagnostic(0,"identity", IdentityMismatchMask:1,ObservedMode:0,ObservedFlags:0),
            new QueryDiagnostic(0,"identity", IdentityMismatchMask:0,ObservedMode:0x02000001,ObservedFlags:0x06000307),
            new QueryDiagnostic(0,"gate",IdentityMismatchMask:1,ObservedMode:0,ObservedFlags:0),
            new QueryDiagnostic(0,"gate"),
        };
        for (var i = 0; i < invalid.Length; i++) Check("invalid_" + i, !invalid[i].Valid(13));
        Check("code_pair", !parse.Valid(0));
        Check("writer_query", ManualCaptureDiagnostic.ValidStatus("capture","refused","initial_ownership_uncertain",null,"initial_query",13,parse));
        Check("writer_final", ManualCaptureDiagnostic.ValidStatus("capture","refused","ownership_or_stop_uncertain",null,"final_query",13,native));
        foreach (var phase in new[] { "start", "stop", "other" })
            Check("writer_" + phase, !ManualCaptureDiagnostic.ValidStatus("capture","refused","initial_ownership_uncertain",null,phase,13,parse));
        Check("writer_summary", !ManualCaptureDiagnostic.ValidStatus("summary","refused","start_failed_or_occupied",new string('a',64),"start",13,parse));
        Check("writer_success", !ManualCaptureDiagnostic.ValidStatus("summary","calibration_observed","calibration_observed",new string('a',64),null,null,parse));
        return cases;
    }
}

internal sealed record QueryDiagnosticCase(string Name, bool Passed);
