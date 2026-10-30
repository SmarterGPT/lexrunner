using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

// A manually dispatched, disposable-runner diagnostic. It never grants loader
// closure or production execution. Ordinary --capture remains a refusal.
internal static class CaptureCalibration
{
    private const string SessionName = "LexRunner Windows Git Loader Qualification";
    private const uint Mode = 0x02400001;
    private const uint Flags = 0x06000307;
    private const long MaxEtlBytes = 128L * 1024 * 1024;
    private const int MaxSummaryBytes = 8192;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static int Run(string[] args)
    {
        if (!ValidArguments(args, out var expectedHead, out var expectedGitSha))
            return ManualCaptureDiagnostic.Refuse("preflight", "arguments_invalid");
        var preflight = Preflight(expectedHead, expectedGitSha, out var runnerTemp,
            out var workspace, out var runId, out var runAttempt);
        if (preflight is not null) return ManualCaptureDiagnostic.Refuse("preflight", preflight);

        string? scratch = null;
        string? etlPath = null;
        string reason = "capture_unstarted";
        string? nativeFailurePhase = null;
        uint? nativeFailureCode = null;
        QueryDiagnostic? queryDiagnostic = null;
        TraceIdentity? identity = null;
        NativeTraceAdapter? adapter = null;
        ulong ownedHandle = 0;
        bool started = false, initialMatch = false, stopAttempted = false;
        bool stopConfirmed = false, cleanupCertain = false;
        bool probeTerminalCertain = false;
        bool censusAttempted = false, censusTerminalCertain = false;
        TraceObservation? initial = null, final = null, stopped = null;
        VersionProbe? probe = null;
        SchemaCensusResult? census = null;
        long etlBytes = 0;
        string etlSha = "";
        var watch = Stopwatch.StartNew();
        try
        {
            scratch = CreateRestrictedScratch(runnerTemp!, runId!, runAttempt!);
            etlPath = Path.Combine(scratch, "git-loader.etl");
            if (File.Exists(etlPath) || Directory.Exists(etlPath))
                throw new InvalidOperationException("etl_path_occupied");
            identity = new TraceIdentity(SessionName, Guid.NewGuid(), etlPath, Mode, Flags);
            adapter = new NativeTraceAdapter(identity);
            if (!NativeTraceAdapter.IdentityIsBounded(identity) ||
                !NativeTraceAdapter.LayoutIsExpected())
                throw new InvalidOperationException("native_layout_or_identity_refused");

            var start = adapter.Start(identity);
            started = start.Code == 0;
            if (start.Code != 0 || start.Handle is 0 or ulong.MaxValue)
            {
                nativeFailurePhase = "start"; nativeFailureCode = start.Code;
                reason = "start_failed_or_occupied";
            }
            else
            {
                ownedHandle = start.Handle;
                var first = adapter.Query(ownedHandle);
                if (!Matches(identity, first))
                {
                    nativeFailurePhase = "initial_query"; nativeFailureCode = first.Code; queryDiagnostic = first.Diagnostic;
                    reason = "initial_ownership_uncertain";
                }
                else
                {
                    initialMatch = true;
                    initial = first.Observation;
                    try
                    {
                        probe = RunVersionProbe(scratch, expectedGitSha!);
                        probeTerminalCertain = probe.TerminalJobDrained;
                        reason = probe.Observed ? "probe_observed" : "probe_refused";
                    }
                    catch { reason = "job_terminal_uncertain"; }
                    finally
                    {
                        // Any work result still requires a fresh exact-handle
                        // readback. A mismatch never permits a name-based stop.
                        try
                        {
                            var last = adapter.Query(ownedHandle);
                            if (!Matches(identity, last))
                            {
                                nativeFailurePhase = "final_query"; nativeFailureCode = last.Code; queryDiagnostic = last.Diagnostic;
                                reason = "final_ownership_uncertain";
                            }
                            else
                            {
                                final = last.Observation;
                                stopAttempted = true;
                                var stop = adapter.Stop(ownedHandle);
                                if (stop.Code != 0 || stop.Observation is null)
                                {
                                    nativeFailurePhase = "stop"; nativeFailureCode = stop.Code;
                                    reason = "stop_disposition_uncertain";
                                }
                                else
                                {
                                    stopped = stop.Observation;
                                    stopConfirmed = true;
                                }
                            }
                        }
                        catch { reason = "ownership_or_stop_exception"; }
                    }
                }
            }

            if (stopConfirmed && etlPath is not null)
            {
                var file = new FileInfo(etlPath);
                if (!file.Exists || file.Length is < 1 or >= MaxEtlBytes)
                {
                    reason = "etl_missing_or_cap_refused";
                }
                else
                {
                    etlBytes = file.Length;
                    using (var stream = new FileStream(etlPath, FileMode.Open,
                        FileAccess.Read, FileShare.Read))
                        etlSha = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                    if (HasLoss(initial) || HasLoss(final) || HasLoss(stopped))
                        reason = "owned_loss_refused";
                    else
                    {
                        censusAttempted = true;
                        census = RunCensusSubprocess(etlPath, out censusTerminalCertain);
                        if (census is null || !census.Accepted || census.HeaderEventsLost != 0 ||
                            census.HeaderBuffersLost != 0 || !census.HeaderEndTimeValid)
                            reason = "etl_census_or_loss_refused";
                        else if (probe is not { Observed: true })
                            reason = "probe_refused";
                        else if (watch.Elapsed > TimeSpan.FromSeconds(90))
                            reason = "capture_deadline_refused";
                        else
                            reason = "calibration_observed";
                    }
                }
            }
        }
        catch { reason = "capture_exception"; }
        finally
        {
            // If ownership was lost or STOP is uncertain, do not manufacture
            // cleanup evidence or an uploadable summary. The dedicated VM is
            // disposable; no foreign/stale logger is ever stopped.
            if ((!started || (initialMatch && stopConfirmed &&
                probeTerminalCertain && (!censusAttempted || censusTerminalCertain))) &&
                scratch is not null)
                cleanupCertain = TryDeleteFreshScratch(scratch, etlPath);
            watch.Stop();
        }

        if (started && !initialMatch) return Refuse("initial_ownership_uncertain", nativeFailurePhase, nativeFailureCode, queryDiagnostic);
        if (started && (!stopAttempted || !stopConfirmed))
            return Refuse("ownership_or_stop_uncertain", nativeFailurePhase, nativeFailureCode, queryDiagnostic);
        if (started && initialMatch && !probeTerminalCertain)
            return Refuse("job_terminal_uncertain", nativeFailurePhase, nativeFailureCode, queryDiagnostic);
        if (censusAttempted && !censusTerminalCertain)
            return Refuse("census_terminal_uncertain", nativeFailurePhase, nativeFailureCode, queryDiagnostic);
        if (!cleanupCertain) return Refuse("cleanup_uncertain", nativeFailurePhase, nativeFailureCode, queryDiagnostic);
        try
        {
            var summary = new
            {
                schemaVersion = "lexrunner-windows-owned-etw-manual/1",
                result = reason == "calibration_observed" ? "calibration_observed" : "refused",
                reasonCode = reason,
                sourceHead = expectedHead,
                runId,
                runAttempt,
                runnerImage = Environment.GetEnvironmentVariable("ImageOS") ?? "",
                runnerImageVersion = Environment.GetEnvironmentVariable("ImageVersion") ?? "",
                hostOS = Environment.OSVersion.VersionString,
                diagnosticImageSha256 = ShaFile(Environment.ProcessPath!),
                expectedGitSha256 = expectedGitSha,
                sessionGuid = identity?.Guid,
                traceStarted = started,
                traceStopAttempted = stopAttempted,
                traceStopped = stopConfirmed,
                fixedCommand = "git.exe --version",
                commandCwd = "RUNNER_TEMP/" + Path.GetFileName(scratch),
                gitFixtureImageSha256 = ShaFile(Path.Combine(AppContext.BaseDirectory,
                    "git-fixture", "LexRunner.WindowsCoordinator.Git.exe")),
                rootProcessId = probe?.RootProcessId,
                rootCreationFileTimeUtc = probe?.RootCreationFileTimeUtc,
                gitDurationMs = probe?.DurationMs,
                jobTotalProcesses = probe?.JobTotalProcesses,
                jobAssignedAtCreation = probe?.JobAssignedAtCreation,
                jobTerminalDrained = probe?.TerminalJobDrained,
                gitExitCode = probe?.ExitCode,
                etlBytes,
                etlSha256 = etlSha,
                liveLoss = Loss(initial),
                finalLiveLoss = Loss(final),
                stoppedLoss = Loss(stopped),
                headerEventsLost = census?.HeaderEventsLost,
                headerBuffersLost = census?.HeaderBuffersLost,
                headerEndTimeValid = census?.HeaderEndTimeValid,
                censusReasonCode = census?.ReasonCode,
                censusEventCount = census?.EventCount,
                schemas = census?.Schemas,
                durationMs = watch.ElapsedMilliseconds,
                rawEtlDeleted = true,
                cleanupCertain = true,
                authorizesLoaderClosure = false,
                authorizesExecution = false,
                helperMissingCleared = false,
                productionReady = false,
            };
            var bytes = StrictUtf8.GetBytes(JsonSerializer.Serialize(summary) + "\n");
            if (bytes.Length > MaxSummaryBytes) return Refuse("summary_bounds_refused", nativeFailurePhase, nativeFailureCode, queryDiagnostic);
            var output = Path.Combine(workspace!, "artifacts", "windows-owned-etw-manual",
                $"{runId}-{runAttempt}");
            if (Directory.Exists(output) || File.Exists(output))
                return Refuse("summary_output_occupied", nativeFailurePhase, nativeFailureCode, queryDiagnostic);
            Directory.CreateDirectory(output);
            var summaryPath = Path.Combine(output, "summary.json");
            using (var stream = new FileStream(summaryPath, FileMode.CreateNew,
                FileAccess.Write, FileShare.None))
                stream.Write(bytes);
            ManualCaptureDiagnostic.Emit("summary", summary.result, reason,
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                nativeFailurePhase, nativeFailureCode, queryDiagnostic);
            return reason == "calibration_observed" ? 0 : 3;
        }
        catch { return Refuse("summary_write_unavailable", nativeFailurePhase, nativeFailureCode, queryDiagnostic); }
    }

    internal static bool ValidArguments(string[] args, out string? head,
        out string? gitSha)
    {
        head = null; gitSha = null;
        if (args.Length != 6 || args[0] != "--capture-calibrate" ||
            args[1] != "--manual-disposable-runner" ||
            args[2] != "--expected-head" || args[4] != "--expected-git-sha256" ||
            !LowerHex(args[3], 40) || !LowerHex(args[5], 64)) return false;
        head = args[3]; gitSha = args[5];
        return true;
    }

    internal static bool SyntheticCensusWireRoundTrip()
    {
        var original = new SchemaCensusResult("census_observed", 1,
            [new SchemaCensusItem("3d6fa8d0-fe05-11d0-9dda-00c04fd7ba7c",
                1, 3, 0, true, 0, 0, 1, ["ProcessId"])],
            0, 0, 1, 2, false, false);
        var wire = JsonSerializer.SerializeToUtf8Bytes(original);
        var read = JsonSerializer.Deserialize<SchemaCensusResult>(wire);
        return read is { Accepted: true, HeaderEndTimeValid: true } &&
            read.Schemas.Count == 1 &&
            read.Schemas[0].PropertyNames.SequenceEqual(["ProcessId"]) &&
            !read.AuthorizesLoaderClosure && !read.AuthorizesExecution;
    }

    private static string? Preflight(string? head, string? gitSha,
        out string? runnerTemp, out string? workspace, out string? runId,
        out string? runAttempt)
    {
        var temp = Environment.GetEnvironmentVariable("RUNNER_TEMP");
        var work = Environment.GetEnvironmentVariable("GITHUB_WORKSPACE");
        var id = Environment.GetEnvironmentVariable("GITHUB_RUN_ID");
        var attempt = Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT");
        runnerTemp = temp; workspace = work; runId = id; runAttempt = attempt;
        return ManualCaptureDiagnostic.FirstFailure(check => check switch
        {
            "os" => OperatingSystem.IsWindows(),
            "x64" => Environment.Is64BitProcess && IntPtr.Size == 8 &&
                System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture ==
                    System.Runtime.InteropServices.Architecture.X64,
            "event" => Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true" &&
                Environment.GetEnvironmentVariable("GITHUB_EVENT_NAME") == "workflow_dispatch" &&
                Environment.GetEnvironmentVariable("GITHUB_REPOSITORY") == "SmarterGPT/lexrunner" &&
                Environment.GetEnvironmentVariable("GITHUB_REF") == "refs/heads/main",
            "source_head" => Environment.GetEnvironmentVariable("GITHUB_SHA") == head,
            "runner_identity" => Environment.GetEnvironmentVariable("RUNNER_OS") == "Windows" &&
                Environment.GetEnvironmentVariable("RUNNER_ARCH") == "X64" &&
                Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") == "github-hosted",
            "numeric_ids" => ulong.TryParse(id, out var parsedId) && parsedId > 0 &&
                uint.TryParse(attempt, out var parsedAttempt) && parsedAttempt > 0,
            "elevation" => IsElevatedAdministrator(),
            "native_layout" => NativeTraceAdapter.LayoutIsExpected(),
            "runner_temp_root" => Path.IsPathFullyQualified(temp ?? "") &&
                Directory.Exists(temp) && NoReparseAncestors(temp),
            "workspace_root" => Path.IsPathFullyQualified(work ?? "") &&
                Directory.Exists(work) && NoReparseAncestors(work),
            "git_image_digest" => gitSha is not null &&
                ShaFile(@"C:\Program Files\Git\bin\git.exe") == gitSha,
            "fixture_image" => File.Exists(Path.Combine(AppContext.BaseDirectory,
                "git-fixture", "LexRunner.WindowsCoordinator.Git.exe")),
            _ => false,
        });
    }

    private static bool IsElevatedAdministrator()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch { return false; }
    }

    private static string CreateRestrictedScratch(string runnerTemp,
        string runId, string runAttempt)
    {
        var path = Path.Combine(runnerTemp,
            $"lexrunner-owned-etw-{runId}-{runAttempt}-{Guid.NewGuid():N}");
        if (Directory.Exists(path) || File.Exists(path))
            throw new InvalidOperationException("scratch_occupied");
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User ?? throw new InvalidOperationException("sid_missing");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(sid);
        var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl, inheritance, PropagationFlags.None,
            AccessControlType.Allow));
        var directory = new DirectoryInfo(path);
        directory.Create(security);
        if (!directory.Exists || !NoReparseAncestors(path) ||
            !directory.GetAccessControl().AreAccessRulesProtected)
            throw new InvalidOperationException("scratch_protection_unavailable");
        return path;
    }

    private static bool NoReparseAncestors(string path)
    {
        for (var cursor = new DirectoryInfo(path); cursor is not null;
             cursor = cursor.Parent)
        {
            if (!cursor.Exists || (cursor.Attributes & FileAttributes.ReparsePoint) != 0)
                return false;
        }
        return true;
    }

    private static bool TryDeleteFreshScratch(string scratch, string? etlPath)
    {
        try
        {
            if (!Directory.Exists(scratch)) return false;
            if ((File.GetAttributes(scratch) & FileAttributes.ReparsePoint) != 0)
                return false;
            if (etlPath is not null)
            {
                if (!StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(etlPath),
                        Path.Combine(scratch, "git-loader.etl")))
                    return false;
                if (File.Exists(etlPath))
                {
                    if ((File.GetAttributes(etlPath) & FileAttributes.ReparsePoint) != 0)
                        return false;
                    File.Delete(etlPath);
                }
            }
            foreach (var name in new[] { "home", "template" })
            {
                var child = Path.Combine(scratch, name);
                if (!Directory.Exists(child)) continue;
                if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0)
                    return false;
                Directory.Delete(child, false);
            }
            if (Directory.EnumerateFileSystemEntries(scratch).Any()) return false;
            Directory.Delete(scratch, false);
            return !Directory.Exists(scratch) &&
                (etlPath is null || !File.Exists(etlPath));
        }
        catch { return false; }
    }

    private static VersionProbe RunVersionProbe(string scratch, string expectedGitSha)
    {
        var image = Path.Combine(AppContext.BaseDirectory, "git-fixture",
            "LexRunner.WindowsCoordinator.Git.exe");
        if (!File.Exists(image)) throw new InvalidOperationException("fixture_missing");
        var info = new ProcessStartInfo(image)
        {
            WorkingDirectory = scratch,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in new[] { "--fixture-etw-version", scratch, expectedGitSha })
            info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("probe_start_failed");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            var stdout = ReadBounded(process.StandardOutput.BaseStream, 4096, timeout.Token);
            var stderr = ReadBounded(process.StandardError.BaseStream, 1024, timeout.Token);
            process.WaitForExitAsync(timeout.Token).GetAwaiter().GetResult();
            var output = stdout.GetAwaiter().GetResult();
            var error = stderr.GetAwaiter().GetResult();
            if (error.Length != 0)
                throw new InvalidDataException("probe_stderr_unexpected");
            using var json = JsonDocument.Parse(output);
            var root = json.RootElement;
            if (root.GetProperty("SchemaVersion").GetString() != "lexrunner-etw-version-probe/1" ||
                !root.GetProperty("TerminalJobDrained").GetBoolean() ||
                root.GetProperty("AuthorizesLoaderClosure").GetBoolean() ||
                root.GetProperty("AuthorizesExecution").GetBoolean())
                throw new InvalidDataException("probe_terminal_receipt_invalid");
            var result = root.GetProperty("Result").GetString();
            var total = root.GetProperty("JobTotalProcesses").GetUInt32();
            var assigned = root.GetProperty("JobAssignedAtCreation").GetBoolean();
            var code = root.GetProperty("ExitCode").ValueKind == JsonValueKind.Null ?
                3 : root.GetProperty("ExitCode").GetInt32();
            var duration = root.GetProperty("DurationMs").GetInt64();
            var pid = root.GetProperty("RootProcessId").ValueKind == JsonValueKind.Null ?
                0 : root.GetProperty("RootProcessId").GetUInt32();
            var created = root.GetProperty("RootCreationFileTimeUtc").ValueKind == JsonValueKind.Null ?
                0 : root.GetProperty("RootCreationFileTimeUtc").GetInt64();
            var observed = process.ExitCode == 0 && result == "observed" &&
                root.GetProperty("GitImageSha256").GetString() == expectedGitSha &&
                total == 1 && assigned && code == 0 && pid > 0 && created > 0;
            if ((process.ExitCode == 0) != observed)
                throw new InvalidDataException("probe_exit_receipt_mismatch");
            if (duration is < 0 or > 30000)
                throw new InvalidDataException("probe_duration_invalid");
            return new VersionProbe(observed, pid, created, total, assigned, true,
                code, duration);
        }
        catch { throw new InvalidOperationException("probe_terminal_uncertain"); }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(true); } catch { }
                try { process.WaitForExit(5000); } catch { }
            }
        }
    }

    private static SchemaCensusResult? RunCensusSubprocess(string etlPath,
        out bool terminalCertain)
    {
        terminalCertain = false;
        var image = Path.Combine(AppContext.BaseDirectory, "OwnedTraceDraft.exe");
        if (!File.Exists(image)) return null;
        var info = new ProcessStartInfo(image)
        {
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add("--census-offline");
        info.ArgumentList.Add(etlPath);
        using var process = Process.Start(info);
        if (process is null) return null;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(35));
        try
        {
            var stdout = ReadBounded(process.StandardOutput.BaseStream, 8192, timeout.Token);
            var stderr = ReadBounded(process.StandardError.BaseStream, 1024, timeout.Token);
            process.WaitForExitAsync(timeout.Token).GetAwaiter().GetResult();
            terminalCertain = process.HasExited;
            var output = stdout.GetAwaiter().GetResult();
            var error = stderr.GetAwaiter().GetResult();
            if (error.Length != 0 || output.Length == 0) return null;
            var result = JsonSerializer.Deserialize<SchemaCensusResult>(output);
            if (result is null || result.AuthorizesLoaderClosure ||
                result.AuthorizesExecution ||
                (process.ExitCode == 0) != result.Accepted)
                return null;
            return result;
        }
        catch { return null; }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(true); } catch { }
                try { process.WaitForExit(5000); } catch { }
            }
        }
    }

    private static async Task<byte[]> ReadBounded(Stream input, int limit,
        CancellationToken token)
    {
        using var output = new MemoryStream();
        var buffer = new byte[1024];
        while (true)
        {
            var count = await input.ReadAsync(buffer, token);
            if (count == 0) return output.ToArray();
            if (output.Length + count > limit) throw new InvalidDataException("output_limit");
            output.Write(buffer, 0, count);
        }
    }

    private static bool Matches(TraceIdentity expected, QueryResult query) =>
        query.Code == 0 && query.Observation is { } value &&
        value.Name == expected.Name && value.Guid == expected.Guid &&
        value.EtlPath == expected.EtlPath && value.Mode == expected.Mode &&
        value.Flags == expected.Flags;

    private static bool HasLoss(TraceObservation? value) =>
        value is null || value.EventsLost != 0 || value.LogBuffersLost != 0 ||
        value.RealTimeBuffersLost != 0;

    private static object? Loss(TraceObservation? value) => value is null ? null : new
    {
        value.EventsLost, value.LogBuffersLost, value.RealTimeBuffersLost,
    };

    private static bool LowerHex(string text, int length) =>
        text.Length == length && text.All(value =>
            value is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string ShaFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
            FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    internal static int RefuseNoTrace(string reason) =>
        ManualCaptureDiagnostic.Refuse("preflight", reason);

    private static int Refuse(string reason, string? nativePhase = null, uint? nativeCode = null,
        QueryDiagnostic? queryDiagnostic = null) =>
        ManualCaptureDiagnostic.Refuse("capture", reason, nativePhase, nativeCode, queryDiagnostic);

    private sealed record VersionProbe(bool Observed, uint RootProcessId,
        long RootCreationFileTimeUtc, uint JobTotalProcesses,
        bool JobAssignedAtCreation, bool TerminalJobDrained, int ExitCode,
        long DurationMs);
}
