#if COORDINATOR_CLIENT_FIXTURE_TESTS
using System.Runtime.Versioning;
using LexRunner.WindowsCoordinator.Client;

// The compiled fixture uses only its own nonce directories and an existing
// read-only system junction. It never writes Program Files, HKLM, or SCM.
[SupportedOSPlatform("windows")]
internal static class V3HeldInstalledFixtureTests
{
    private const int StatusSharingViolation = unchecked((int)0xC0000043);

    internal static int Run()
    {
        var results = new List<TestCase>();
        var failures = new List<string>();
        RunOne("fixture_image_root", AppContext.BaseDirectory, results, failures);
        RunOne("process_temp_root", Path.GetTempPath(), results, failures);
        var junction = @"C:\Users\All Users";
        if (Directory.Exists(junction) &&
            (File.GetAttributes(junction) & FileAttributes.ReparsePoint) != 0)
        {
            var refused = false;
            try
            {
                using var ignored = V3HeldInstalledFiles.OpenFixtureChain(@"C:\Users",
                    ["All Users", "__lexrunner_missing__", "service"]);
            }
            catch (V3HeldPathException error) when (
                error.Reason == "generation_path_unavailable") { refused = true; }
            Add("existing_junction_before_missing_child", refused, "system_junction", null,
                results, failures);
        }
        Program.Emit(new TestReport {
            State = failures.Count == 0 ? "pass" : "fail",
            Profile = "v3_held_installed_source_only",
            Results = results,
            Failures = failures,
        }, failures.Count == 0 ? 0 : 1);
        return failures.Count == 0 ? 0 : 1;
    }

    private static void RunOne(string name, string baseDirectory,
        List<TestCase> results, List<string> failures)
    {
        try
        {
            var fileSystem = new DriveInfo(Path.GetPathRoot(baseDirectory)!).DriveFormat;
            var (passed, retainedPath) = DisposableHeldPathCase(baseDirectory);
            Add(name, passed, fileSystem, retainedPath, results, failures);
        }
        catch (Exception error)
        {
            Add(name, false, error.GetType().Name + ":" + error.Message,
                null, results, failures);
        }
    }

    private static (bool Passed, string RetainedPath) DisposableHeldPathCase(
        string baseDirectory)
    {
        var parent = Path.GetFullPath(baseDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if (!Directory.Exists(parent) ||
            (File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("fixture_parent_unavailable");
        var marker = "v3-held-" + Guid.NewGuid().ToString("N");
        var root = Path.GetFullPath(Path.Combine(parent, marker));
        if (!string.Equals(Path.GetDirectoryName(root), parent,
                StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("fixture_root_escape");
        var generationId = new string('a', 64);
        var generations = Path.Combine(root, "generations");
        var generation = Path.Combine(generations, generationId);
        var service = Path.Combine(generation, "service");
        Directory.CreateDirectory(service);
        var ownership = Path.Combine(root, marker + ".marker");
        File.WriteAllText(ownership, marker);
        var manifest = Path.Combine(generation, "generation-graph.json");
        var coordinator = Path.Combine(service, "LexRunner.WindowsCoordinator.Service.exe");
        var worker = Path.Combine(service, "LexRunner.WindowsCoordinator.WorkerSlot.exe");
        File.WriteAllText(manifest, "manifest");
        File.WriteAllText(coordinator, "coordinator");
        File.WriteAllText(worker, "worker");
        var generationDeleteAccessError = 0;
        var imageDeleteAccessError = 0;
        using (var held = V3HeldInstalledFiles.OpenFixture(root, generationId))
        using (var manifestHandle = held.OpenManifest())
        using (var coordinatorHandle = held.OpenCoordinator())
        using (var workerHandle = held.OpenWorker())
        {
            if (manifestHandle.Length != 8 || coordinatorHandle.Length != 11 ||
                workerHandle.Length != 6)
                throw new InvalidOperationException("fixture_bytes_mismatch");
            (generationDeleteAccessError, imageDeleteAccessError) = held.ProbeDeleteAccess();
            held.VerifyUnchanged();
            VerifyDisposeRaceAndRefusal(held);
        }
        if (generationDeleteAccessError != StatusSharingViolation ||
            imageDeleteAccessError != StatusSharingViolation)
            throw new InvalidOperationException("held_delete_access_errors_" +
                generationDeleteAccessError + "_" + imageDeleteAccessError);
        if (File.ReadAllText(ownership) != marker)
            throw new InvalidOperationException("fixture_marker_changed");
        // Retain the three tiny files and nonce marker. A path-based cleanup
        // here would reopen a same-user mutable namespace after releasing the
        // held handles. Removal needs its own reviewed custody transition.
        return (true, root);
    }

    private static void VerifyDisposeRaceAndRefusal(V3HeldInstalledFiles held)
    {
        using var entered = new ManualResetEventSlim(false);
        using var release = new ManualResetEventSlim(false);
        V3HeldInstalledFiles.FixtureAfterParentAddRef = () => {
            entered.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("parent_reference_gate_timeout");
        };
        try
        {
            var opener = Task.Run(() => {
                using var file = held.OpenCoordinator();
                return file.Length;
            });
            if (!entered.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("parent_reference_not_acquired");
            held.Dispose();
            release.Set();
            if (!opener.Wait(TimeSpan.FromSeconds(10)) || opener.Result != 11)
                throw new InvalidOperationException("held_parent_dispose_race_failed");
            if (!held.ProbeDisposedParentRefusal())
                throw new InvalidOperationException("disposed_parent_not_refused");
        }
        finally
        {
            release.Set();
            V3HeldInstalledFiles.FixtureAfterParentAddRef = null;
        }
    }

    private static void Add(string name, bool passed, string state, string? fixturePath,
        List<TestCase> results, List<string> failures)
    {
        results.Add(new TestCase { Name = name, Passed = passed, State = state,
            FixturePath = fixturePath });
        if (!passed) failures.Add(name);
    }

}
#endif
