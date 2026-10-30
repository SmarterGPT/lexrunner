using System.Text.Json;

// Ordinary capture remains refused. The separately guarded manual calibration
// route may instantiate the native adapter only on a disposable hosted runner;
// selftest uses only fake adapters and synthetic ABI/serialization checks.
internal static class Program
{
    private const string SessionName = "LexRunner Windows Git Loader Qualification";
    private const uint ExpectedMode = 0x02000001; // system logger + sequential file
    private const uint ExpectedFlags = 0x06000307; // process/thread/image/file IO + disk/file name

    private static int Main(string[] args)
    {
        if (args is ["--query-diagnostic-selftest"])
        {
            var queryCases = QueryDiagnostic.SelfTest();
            var queryPassed = queryCases.All(value => value.Passed);
            Console.WriteLine(JsonSerializer.Serialize(new { result = queryPassed ? "pass" : "refused",
                cases = queryCases, samples = QueryDiagnostic.WireSamples(), authorizesExecution = false }));
            return queryPassed ? 0 : 3;
        }
        if (args is ["--preflight-selftest"])
        {
            var preflightCases = ManualCaptureDiagnostic.SelfTest();
            var wire = JsonSerializer.Serialize(preflightCases);
            using var parsed = JsonDocument.Parse(wire);
            var preflightPassed = parsed.RootElement.EnumerateArray().All(value =>
                value.GetProperty("passed").GetBoolean());
            Console.WriteLine(JsonSerializer.Serialize(new {
                schemaVersion = "lexrunner-etw-preflight-source/1", cases = preflightCases,
                result = preflightPassed ? "pass" : "refused", authorizesExecution = false,
            }));
            return preflightPassed ? 0 : 3;
        }
        if (args.Length == 2 && args[0] == "--census-offline")
        {
            var temp = Environment.GetEnvironmentVariable("RUNNER_TEMP");
            if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
                Environment.GetEnvironmentVariable("GITHUB_EVENT_NAME") != "workflow_dispatch" ||
                string.IsNullOrWhiteSpace(temp) ||
                !Path.IsPathFullyQualified(args[1]) ||
                !Path.GetFullPath(args[1]).StartsWith(Path.GetFullPath(temp) +
                    Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return CaptureCalibration.RefuseNoTrace("offline_census_preflight_required");
            var result = SchemaCensus.Parse(args[1], 128L * 1024 * 1024,
                TimeSpan.FromSeconds(30));
            Console.WriteLine(JsonSerializer.Serialize(result));
            return result.Accepted ? 0 : 3;
        }
        if (args.Length > 0 && args[0] == "--capture-calibrate")
            return CaptureCalibration.Run(args);
        if (args is not ["--selftest"])
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                schemaVersion = "lexrunner-owned-etw-policy-draft/1",
                result = "refused",
                reasonCode = "source_only_selftest_required",
                traceStarted = false,
                traceStopped = false,
                authorizesLoaderClosure = false,
                authorizesExecution = false,
            }));
            return 3;
        }

        var cases = SelfTest();
        var layout = NativeTraceAdapter.LayoutIsExpected();
        var passed = layout && cases.All(c => c.Passed);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            schemaVersion = "lexrunner-owned-etw-policy-draft/1",
            result = passed ? "source_fixture_pass" : "source_fixture_refused",
            nativeLayoutVerified = layout,
            cases,
            traceStarted = false,
            traceStopped = false,
            authorizesLoaderClosure = false,
            authorizesExecution = false,
        }));
        return passed ? 0 : 3;
    }

    private static IReadOnlyList<TestCase> SelfTest()
    {
        var expected = new TraceIdentity(SessionName, Guid.Parse("f6a585fc-57f8-4805-8599-d671282184f5"),
            @"C:\private\fresh\git-loader.etl", ExpectedMode, ExpectedFlags);
        var matching = new TraceObservation(expected.Name, expected.Guid,
            expected.EtlPath, expected.Mode, expected.Flags, 0, 0, 0);
        var cases = new List<TestCase>();

        void Check(string label, StartResult start, QueryResult query, StopResult stop,
            int expectedQueries, int expectedStops, string expectedReason)
        {
            var fake = new FakeAdapter(start, query, stop);
            var result = OwnedTraceTransaction.Run(fake, expected);
            cases.Add(new TestCase(label,
                result.ReasonCode == expectedReason &&
                fake.StartCount == 1 && fake.QueryCount == expectedQueries &&
                fake.StopCount == expectedStops &&
                !result.AuthorizesLoaderClosure && !result.AuthorizesExecution,
                result.ReasonCode, fake.QueryCount, fake.StopCount));
        }

        Check("start_failed_never_stop", new StartResult(183, 0),
            new QueryResult(0, matching), new StopResult(0), 0, 0, "start_failed_or_occupied");
        Check("start_success_zero_handle_never_stop", new StartResult(0, 0),
            new QueryResult(0, matching), new StopResult(0), 0, 0, "start_handle_invalid");
        Check("query_failed_never_stop", new StartResult(0, 42),
            new QueryResult(5, matching), new StopResult(0), 1, 0, "ownership_query_failed");
        Check("query_more_data_never_stop", new StartResult(0, 42),
            new QueryResult(234, matching), new StopResult(0), 1, 0, "ownership_query_failed");
        Check("query_missing_data_never_stop", new StartResult(0, 42),
            new QueryResult(0, null), new StopResult(0), 1, 0, "ownership_query_missing");
        Check("foreign_guid_never_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { Guid = Guid.NewGuid() }),
            new StopResult(0), 1, 0, "ownership_mismatch");
        Check("foreign_path_never_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { EtlPath = @"C:\foreign\trace.etl" }),
            new StopResult(0), 1, 0, "ownership_mismatch");
        Check("changed_flags_never_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { Flags = 0 }),
            new StopResult(0), 1, 0, "ownership_mismatch");
        Check("changed_mode_never_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { Mode = 0 }),
            new StopResult(0), 1, 0, "ownership_mismatch");
        Check("changed_name_never_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { Name = "other" }),
            new StopResult(0), 1, 0, "ownership_mismatch");
        Check("zero_loss_one_stop", new StartResult(0, 42),
            new QueryResult(0, matching), new StopResult(0), 1, 1, "stopped_unqualified");
        Check("nonzero_loss_still_cleanup_one_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { EventsLost = 1 }),
            new StopResult(0), 1, 1, "live_loss_refused");
        Check("log_buffer_loss_still_cleanup_one_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { LogBuffersLost = 1 }),
            new StopResult(0), 1, 1, "live_loss_refused");
        Check("real_time_buffer_loss_still_cleanup_one_stop", new StartResult(0, 42),
            new QueryResult(0, matching with { RealTimeBuffersLost = 1 }),
            new StopResult(0), 1, 1, "live_loss_refused");
        Check("stop_more_data_no_retry", new StartResult(0, 42),
            new QueryResult(0, matching), new StopResult(234), 1, 1, "stop_disposition_uncertain");
        Check("stop_failed_no_retry", new StartResult(0, 42),
            new QueryResult(0, matching), new StopResult(5), 1, 1, "stop_disposition_uncertain");

        void CheckGate(string label, bool passed) =>
            cases.Add(new TestCase(label, passed, passed ? "gate_refused_or_consumed" : "gate_failed", 0, 0));

        var neverStarted = new NativeTraceAdapter(expected);
        CheckGate("native_foreign_handle_before_start",
            neverStarted.Query(42).Code == 87 && neverStarted.Stop(42).Code == 87);
        var longestAllowed = expected with { EtlPath = @"C:\" + new string('x', 1020) };
        var unterminatedAtLimit = expected with { EtlPath = @"C:\" + new string('x', 1021) };
        CheckGate("path_1023_utf16_units_accepted",
            longestAllowed.EtlPath.Length == 1023 && NativeTraceAdapter.IdentityIsBounded(longestAllowed));
        var tooLongAdapter = new NativeTraceAdapter(unterminatedAtLimit);
        CheckGate("native_start_refuses_1024_utf16_units",
            unterminatedAtLimit.EtlPath.Length == 1024 &&
            !NativeTraceAdapter.IdentityIsBounded(unterminatedAtLimit) &&
            tooLongAdapter.Start(unterminatedAtLimit).Code == 87);

        var failed = new OwnedHandleGate(expected);
        var failedBegan = failed.BeginStart();
        failed.CompleteStart(new StartResult(183, 42));
        CheckGate("failed_start_cannot_query_stop_or_restart",
            failedBegan && !failed.BeginQuery(42) && !failed.BeginStop(42) && !failed.BeginStart());

        var zero = new OwnedHandleGate(expected);
        var zeroBegan = zero.BeginStart();
        zero.CompleteStart(new StartResult(0, 0));
        CheckGate("zero_handle_not_owned",
            zeroBegan && !zero.BeginQuery(0) && !zero.BeginStop(0));
        var invalid = new OwnedHandleGate(expected);
        var invalidBegan = invalid.BeginStart();
        invalid.CompleteStart(new StartResult(0, ulong.MaxValue));
        CheckGate("max_handle_not_owned",
            invalidBegan && !invalid.BeginQuery(ulong.MaxValue) && !invalid.BeginStop(ulong.MaxValue));

        var foreign = new OwnedHandleGate(expected);
        var foreignBegan = foreign.BeginStart();
        foreign.CompleteStart(new StartResult(0, 42));
        CheckGate("foreign_query_taints_owned_session",
            foreignBegan && !foreign.BeginQuery(43) &&
            !foreign.BeginQuery(42) && !foreign.BeginStop(42));

        var matched = new OwnedHandleGate(expected);
        var matchedBegan = matched.BeginStart();
        matched.CompleteStart(new StartResult(0, 42));
        CheckGate("matching_query_one_stop_only",
            matchedBegan && matched.BeginQuery(42) &&
            matched.CompleteQuery(42, new QueryResult(0, matching)) &&
            matched.BeginStop(42) && !matched.BeginStop(42) &&
            !matched.BeginQuery(42) && !matched.BeginStart());

        var mismatch = new OwnedHandleGate(expected);
        var mismatchBegan = mismatch.BeginStart();
        mismatch.CompleteStart(new StartResult(0, 42));
        CheckGate("mismatched_readback_cannot_stop_or_retry",
            mismatchBegan && mismatch.BeginQuery(42) &&
            !mismatch.CompleteQuery(42, new QueryResult(0, matching with { Guid = Guid.NewGuid() })) &&
            !mismatch.BeginStop(42) && !mismatch.BeginQuery(42));

        var concurrent = new OwnedHandleGate(expected);
        var concurrentBegan = concurrent.BeginStart();
        concurrent.CompleteStart(new StartResult(0, 42));
        CheckGate("concurrent_query_refused",
            concurrentBegan && concurrent.BeginQuery(42) &&
            !concurrent.BeginQuery(42) &&
            concurrent.CompleteQuery(42, new QueryResult(0, matching)) &&
            concurrent.BeginStop(42));

        var stale = new OwnedHandleGate(expected);
        var staleBegan = stale.BeginStart();
        stale.CompleteStart(new StartResult(0, 42));
        CheckGate("later_failed_query_invalidates_old_match",
            staleBegan && stale.BeginQuery(42) &&
            stale.CompleteQuery(42, new QueryResult(0, matching)) &&
            stale.BeginQuery(42) &&
            !stale.CompleteQuery(42, new QueryResult(5, null)) &&
            !stale.BeginStop(42));

        var badStop = new OwnedHandleGate(expected);
        var badStopBegan = badStop.BeginStart();
        badStop.CompleteStart(new StartResult(0, 42));
        CheckGate("foreign_stop_taints_owned_session",
            badStopBegan && badStop.BeginQuery(42) &&
            badStop.CompleteQuery(42, new QueryResult(0, matching)) &&
            !badStop.BeginStop(43) && !badStop.BeginStop(42));
        foreach (var check in SchemaCensus.SelfTest())
            CheckGate("census_" + check.Name, check.Passed);
        CheckGate("calibration_bare_route_refused_before_trace",
            !CaptureCalibration.ValidArguments(["--capture-calibrate"], out _, out _));
        CheckGate("calibration_exact_shape_accepted_for_preflight",
            CaptureCalibration.ValidArguments(
                ["--capture-calibrate", "--manual-disposable-runner", "--expected-head",
                    new string('a', 40), "--expected-git-sha256", new string('b', 64)],
                out _, out _));
        CheckGate("calibration_uppercase_digest_refused_before_trace",
            !CaptureCalibration.ValidArguments(
                ["--capture-calibrate", "--manual-disposable-runner", "--expected-head",
                    new string('a', 40), "--expected-git-sha256", new string('B', 64)],
                out _, out _));
        CheckGate("native_stop_counter_and_offset_readback",
            NativeTraceAdapter.SyntheticObservationReadback());
        CheckGate("census_result_wire_roundtrip",
            CaptureCalibration.SyntheticCensusWireRoundTrip());
        return cases;
    }
}

internal sealed record TraceIdentity(string Name, Guid Guid, string EtlPath, uint Mode, uint Flags);
internal sealed record TraceObservation(string Name, Guid Guid, string EtlPath, uint Mode,
    uint Flags, uint EventsLost, uint LogBuffersLost, uint RealTimeBuffersLost);
internal sealed record StartResult(uint Code, ulong Handle);
internal sealed record QueryResult(uint Code, TraceObservation? Observation, QueryDiagnostic? Diagnostic = null);
internal sealed record StopResult(uint Code, TraceObservation? Observation = null);
internal sealed record TraceDisposition(string ReasonCode, bool StopAttempted,
    bool StopConfirmed, bool HasLiveLoss, bool AuthorizesLoaderClosure, bool AuthorizesExecution);
internal sealed record TestCase(string Name, bool Passed, string ReasonCode, int QueryCount, int StopCount);

internal interface ITraceAdapter
{
    StartResult Start(TraceIdentity expected);
    QueryResult Query(ulong returnedHandle);
    StopResult Stop(ulong returnedHandle);
}

internal static class OwnedTraceTransaction
{
    // The adapter contract requires Query/Stop to use the exact successful
    // StartTraceW handle with InstanceName = null, never a caller-supplied name.
    // A future native adapter must prove this and be independently reviewed.
    internal static TraceDisposition Run(ITraceAdapter adapter, TraceIdentity expected)
    {
        StartResult start;
        try { start = adapter.Start(expected); }
        catch { return Refuse("start_exception"); }
        if (start.Code != 0)
            return Refuse("start_failed_or_occupied");
        if (start.Handle == 0)
            return Refuse("start_handle_invalid");

        QueryResult query;
        try { query = adapter.Query(start.Handle); }
        catch { return Refuse("ownership_query_exception"); }
        if (query.Code != 0)
            return Refuse("ownership_query_failed");
        if (query.Observation is not { } observed)
            return Refuse("ownership_query_missing");
        if (observed.Name != expected.Name || observed.Guid != expected.Guid ||
            observed.EtlPath != expected.EtlPath || observed.Mode != expected.Mode ||
            observed.Flags != expected.Flags)
            return Refuse("ownership_mismatch");

        var hasLoss = observed.EventsLost != 0 || observed.LogBuffersLost != 0 ||
            observed.RealTimeBuffersLost != 0;
        StopResult stop;
        try { stop = adapter.Stop(start.Handle); }
        catch { return new("stop_disposition_uncertain", true, false, hasLoss, false, false); }
        // ControlTraceW STOP may already have stopped on ERROR_MORE_DATA. A
        // failed STOP never authorizes a second STOP against a reused handle.
        if (stop.Code != 0)
            return new("stop_disposition_uncertain", true, false, hasLoss, false, false);
        return new(hasLoss ? "live_loss_refused" : "stopped_unqualified",
            true, true, hasLoss, false, false);
    }

    private static TraceDisposition Refuse(string reason) =>
        new(reason, false, false, false, false, false);
}

internal sealed class FakeAdapter(StartResult start, QueryResult query, StopResult stop) : ITraceAdapter
{
    internal int StartCount { get; private set; }
    internal int QueryCount { get; private set; }
    internal int StopCount { get; private set; }

    public StartResult Start(TraceIdentity _)
    {
        StartCount++;
        return start;
    }
    public QueryResult Query(ulong returnedHandle)
    {
        QueryCount++;
        if (returnedHandle != start.Handle) throw new InvalidOperationException("unowned_query_handle");
        return query;
    }
    public StopResult Stop(ulong returnedHandle)
    {
        StopCount++;
        if (returnedHandle != start.Handle) throw new InvalidOperationException("unowned_stop_handle");
        return stop;
    }
}
