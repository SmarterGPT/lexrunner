using System.Text.Json;
using System.Text.Json.Serialization;

namespace LexRunner.WindowsCoordinator.Git;

internal static class Program
{
    private static int Main(string[] args)
    {
#if GIT_IMPORT_FIXTURE
        if (args.Length == 3 && args[0] == "--fixture-etw-version")
        {
            try
            {
                var runnerTemp = Environment.GetEnvironmentVariable("RUNNER_TEMP");
                var scratch = Path.GetFullPath(args[1]);
                var expectedGitSha = args[2];
                if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
                    Environment.GetEnvironmentVariable("GITHUB_EVENT_NAME") != "workflow_dispatch" ||
                    string.IsNullOrWhiteSpace(runnerTemp) ||
                    !scratch.StartsWith(Path.GetFullPath(runnerTemp) + Path.DirectorySeparatorChar,
                        StringComparison.OrdinalIgnoreCase) ||
                    !Directory.Exists(scratch) ||
                    expectedGitSha.Length != 64 ||
                    !expectedGitSha.All(value => value is >= '0' and <= '9' or >= 'a' and <= 'f'))
                    throw new InvalidOperationException("etw_probe_preflight_refused");
                var home = Path.Combine(scratch, "home");
                var template = Path.Combine(scratch, "template");
                Directory.CreateDirectory(home);
                Directory.CreateDirectory(template);
                var slot = new ImportSlot(scratch, scratch, scratch, template,
                    template, home, scratch, new string('0', 40), expectedGitSha);
                var env = GitBundleImport.ConstructEnvironment(slot);
                var record = BoundedGitChild.RunAsync("etw-version", scratch,
                    ["--version"], env, CancellationToken.None, null, expectedGitSha)
                    .GetAwaiter().GetResult();
                var root = record.ObservedJobProcesses.SingleOrDefault(value =>
                    value.ProcessId == record.RootProcessId);
                var observed = record.ExitCode == 0 && !record.TimedOut &&
                    !record.Canceled && !record.OutputExceeded &&
                    record.StreamsCompleted && record.JobAssignedAtCreation &&
                    record.ChildResumed && record.TerminalJobDrained &&
                    record.DescendantCleanupProven && record.JobTotalProcesses == 1 &&
                    record.HeldImageSha256 == expectedGitSha &&
                    record.Stdout.StartsWith("git version ", StringComparison.Ordinal) &&
                    root is { CreationFileTimeUtc: > 0 };
                var result = new EtwVersionProbeReport(
                    "lexrunner-etw-version-probe/1", observed ? "observed" : "refused",
                    observed ? "fixed_git_version_observed" : "fixed_git_version_refused",
                    record.RootProcessId, root?.CreationFileTimeUtc,
                    record.JobTotalProcesses, record.JobAssignedAtCreation,
                    record.TerminalJobDrained, record.ExitCode, record.DurationMs,
                    record.HeldImageSha256, record.StdoutBytes, record.StdoutSha256,
                    false, false);
                Console.WriteLine(JsonSerializer.Serialize(result,
                    FixtureJsonContext.Default.EtwVersionProbeReport));
                return observed ? 0 : 3;
            }
            catch
            {
                var result = new EtwVersionProbeReport(
                    "lexrunner-etw-version-probe/1", "refused", "probe_exception",
                    null, null, 0, false, false, null, 0, "", 0, "", false, false);
                Console.WriteLine(JsonSerializer.Serialize(result,
                    FixtureJsonContext.Default.EtwVersionProbeReport));
                return 3;
            }
        }
        if ((args.Length == 1 || args.Length == 3) &&
            args[0] == "--fixture-graph-parser-selftest")
        {
            var validHex = new string('a', 64);
            if (!GraphV2.ValidHex(validHex) || GraphV2.ValidHex(validHex + "\n") ||
                !GraphV2.SafePath("bin/service.exe") ||
                GraphV2.SafePath("bin\n/service.exe") ||
                GraphV2.SafePath("bin/CON\n") ||
                !GraphV2.ReservedDevice("CON") || GraphV2.ReservedDevice("CON\n"))
            {
                Console.Error.WriteLine("graph_parser_selftest_failed");
                return 4;
            }
            if (args.Length == 3)
            {
                try
                {
                    var manifest = File.ReadAllBytes(args[1]);
                    _ = GraphV2.Parse(manifest, args[2]);
                    try
                    {
                        _ = GraphV2.Parse(manifest, args[2] + "\n");
                        Console.Error.WriteLine("graph_parser_digest_newline_accepted");
                        return 4;
                    }
                    catch (InvalidDataException) { }
                }
                catch (Exception)
                {
                    Console.Error.WriteLine("graph_parser_selftest_unavailable");
                    return 4;
                }
            }
            Console.WriteLine("graph_parser_selftest_pass");
            return 0;
        }
        if (args.Length == 12 && args[0] == "--fixture-graph-import")
        {
            try
            {
                var slot = new ImportSlot(args[1], args[2], args[3], args[4], args[5],
                    args[6], args[7], args[8], args[9]);
                using var profile = GraphSelectedGitProfile.Open(args[10], args[11]);
                var import = GitBundleImport.ImportAsync(slot, CancellationToken.None, profile)
                    .GetAwaiter().GetResult();
                profile.AssertUnchanged();
                var result = new GraphSelectedImportReport(true, profile.GenerationId,
                    profile.ManifestSha256, profile.MemberCount, false, import, null);
                Console.WriteLine(JsonSerializer.Serialize(result,
                    FixtureJsonContext.Default.GraphSelectedImportReport));
                return import.Imported ? 0 : 1;
            }
            catch (Exception exception)
            {
                var result = new GraphSelectedImportReport(false, null, null, 0, false, null,
                    exception.GetType().Name + ":" + exception.Message);
                Console.WriteLine(JsonSerializer.Serialize(result,
                    FixtureJsonContext.Default.GraphSelectedImportReport));
                return 3;
            }
        }
        if (args.Length == 10 && args[0] == "--fixture-import")
        {
            var slot = new ImportSlot(args[1], args[2], args[3], args[4], args[5],
                args[6], args[7], args[8], args[9]);
            var result = GitBundleImport.ImportAsync(slot, CancellationToken.None)
                .GetAwaiter().GetResult();
            Console.WriteLine(JsonSerializer.Serialize(result, FixtureJsonContext.Default.ImportOutcome));
            return result.Imported ? 0 : 1;
        }
        if (args.Length == 11 && args[0] == "--fixture-stage")
        {
            var slot = new ImportSlot(args[1], args[2], args[3], args[4], args[5],
                args[6], args[7], args[8], args[9]);
            var result = GitWorktreeStage.StageAsync(slot, args[10], CancellationToken.None)
                .GetAwaiter().GetResult();
            Console.WriteLine(JsonSerializer.Serialize(result, FixtureJsonContext.Default.StageOutcome));
            return result.Staged ? 0 : 1;
        }
        // This native move route is absent unless GitImportFixture=true.
        // GitWorktreePublish also requires the image in the nonce fixture root.
        if (args.Length == 13 &&
            (args[0] == "--fixture-publish" || args[0] == "--fixture-publish-canceled"))
        {
            var slot = new ImportSlot(args[1], args[2], args[3], args[4], args[5],
                args[6], args[7], args[8], args[9]);
            using var cancellation = new CancellationTokenSource();
            if (args[0] == "--fixture-publish-canceled") cancellation.Cancel();
            var result = GitWorktreePublish.PublishAsync(slot, args[10], args[11],
                args[12], cancellation.Token).GetAwaiter().GetResult();
            Console.WriteLine(JsonSerializer.Serialize(result, FixtureJsonContext.Default.PublishOutcome));
            return result.Published ? 0 : 1;
        }
        if (args.Length == 10 &&
            (args[0] == "--fixture-canceled-before-create" ||
             args[0] == "--fixture-canceled-before-resume"))
        {
            var slot = new ImportSlot(args[1], args[2], args[3], args[4], args[5],
                args[6], args[7], args[8], args[9]);
            var record = GitBundleImport.RunCancellationFixtureAsync(slot,
                args[0] == "--fixture-canceled-before-resume").GetAwaiter().GetResult();
            Console.WriteLine(JsonSerializer.Serialize(record, FixtureJsonContext.Default.CommandRecord));
            return 0;
        }
#endif
        Console.Error.WriteLine("no_production_git_entrypoint");
        return 2;
    }
}

#if GIT_IMPORT_FIXTURE
internal sealed record GraphSelectedImportReport(bool ProfileAccepted, string? GraphDigest,
    string? ManifestSha256, int MemberCount, bool AuthorizesLaunch,
    ImportOutcome? Import, string? Error);

internal sealed record EtwVersionProbeReport(string SchemaVersion, string Result,
    string ReasonCode, uint? RootProcessId, long? RootCreationFileTimeUtc,
    uint JobTotalProcesses, bool JobAssignedAtCreation, bool TerminalJobDrained,
    int? ExitCode, long DurationMs, string GitImageSha256, int StdoutBytes,
    string StdoutSha256, bool AuthorizesLoaderClosure, bool AuthorizesExecution);

[JsonSerializable(typeof(GraphSelectedImportReport))]
[JsonSerializable(typeof(ImportOutcome))]
[JsonSerializable(typeof(StageOutcome))]
[JsonSerializable(typeof(PublishOutcome))]
[JsonSerializable(typeof(CommandRecord))]
[JsonSerializable(typeof(EtwVersionProbeReport))]
internal partial class FixtureJsonContext : JsonSerializerContext;
#endif
