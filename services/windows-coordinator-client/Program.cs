using System.Text.Json;
using System.Text.Json.Serialization;
using LexRunner.WindowsCoordinator.Client;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
            return Emit(new Output { State = "unsupported_host" }, 2);
        try
        {
#if COORDINATOR_CLIENT_FIXTURE_TESTS
            if (args is ["--selftest"])
                return FixtureTests.RunAll();
            if (args is ["--v3-installed-fixture-selftest"])
                return V3InstalledFixtureTests.RunPure();
            if (args.Length == 3 && args[0] == "--fixture-server")
                return FixtureServer.Run(args[1], args[2]);
#endif
            // An optional protected selection source is not yet installed or
            // qualified. No production argument can construct SelectedEndpoint.
            // In particular, a caller cannot supply a pipe, PID, path or pin.
            if (args is ["--status"])
            {
                // Read-only v3 registry, held-byte and fixed-SCM comparison.
                // No source result can construct an endpoint or send a frame.
                var selection = CoordinatorV3InstalledObservation.Observe();
                var service = new ScmServiceSnapshots();
                var status = service.Read();
                return Emit(new Output { State = "helper_missing",
                    Reason = status is not null ? selection.Reason :
                        service.LastError == 1060 ? "service_missing" : "service_unavailable" }, 0);
            }
            return Emit(new Output { State = "helper_missing",
                Reason = "selection_unavailable" }, 3);
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or
            System.ComponentModel.Win32Exception or OutOfMemoryException)
        {
            return Emit(new Output { State = "client_error", ErrorType = error.GetType().Name }, 4);
        }
    }

    internal static int Emit(Output value, int code)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(value, OutputJsonContext.Default.Output));
        return code;
    }

#if COORDINATOR_CLIENT_FIXTURE_TESTS
    internal static int Emit(TestReport value, int code)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(value, OutputJsonContext.Default.TestReport));
        return code;
    }
#endif
}

internal sealed class Output
{
    [JsonPropertyName("state")] public required string State { get; init; }
    [JsonPropertyName("reason")] public string? Reason { get; init; }
    [JsonPropertyName("error_type")] public string? ErrorType { get; init; }
    [JsonPropertyName("error")] public int? Error { get; init; }
    [JsonPropertyName("pid")] public int? Pid { get; init; }
    [JsonPropertyName("bytes_read")] public uint? BytesRead { get; init; }
    [JsonPropertyName("bytes_written")] public uint? BytesWritten { get; init; }
}

#if COORDINATOR_CLIENT_FIXTURE_TESTS
internal sealed class TestCase
{
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("passed")] public required bool Passed { get; init; }
    [JsonPropertyName("state")] public string? State { get; init; }
    [JsonPropertyName("bytes_written")] public uint? BytesWritten { get; init; }
    [JsonPropertyName("server_bytes_read")] public int? ServerBytesRead { get; init; }
    [JsonPropertyName("second_instance_error")] public int? SecondInstanceError { get; init; }
    [JsonPropertyName("server_exit")] public int? ServerExit { get; init; }
    [JsonPropertyName("error")] public string? Error { get; init; }
}

internal sealed class TestReport
{
    [JsonPropertyName("state")] public required string State { get; init; }
    [JsonPropertyName("profile")] public required string Profile { get; init; }
    [JsonPropertyName("results")] public required List<TestCase> Results { get; init; }
    [JsonPropertyName("failures")] public required List<string> Failures { get; init; }
}
#endif

[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Output))]
#if COORDINATOR_CLIENT_FIXTURE_TESTS
[JsonSerializable(typeof(TestReport))]
#endif
internal partial class OutputJsonContext : JsonSerializerContext { }
