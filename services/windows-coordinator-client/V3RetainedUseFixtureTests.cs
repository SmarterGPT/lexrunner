#if COORDINATOR_CLIENT_FIXTURE_TESTS
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using LexRunner.WindowsCoordinator.Client;
using Microsoft.Win32.SafeHandles;
using Owner = LexRunner.WindowsCoordinator.Client.V3HeldInstalledFiles;
using GraphFixture = V3HeldGraphFixtureTests.Fixture;

// Retained-use mechanism tests only. Native trust, installed paths and operation
// children are absent. The two fixed quarantine subprocesses never spawn children.
[SupportedOSPlatform("windows")]
internal static class V3RetainedUseFixtureTests
{
    internal static int Run()
    {
        var results = new List<TestCase>(); var failures = new List<string>();
        foreach (var (name, parent) in new[] { ("artifact", AppContext.BaseDirectory), ("temp", Path.GetTempPath()) })
        {
            Case(name, "dispose_defers_all_custody_until_no_child_report", parent, DisposeDuringUse, results, failures);
            Case(name, "single_process_slot_and_second_use_refusal", parent, SingleSlot, results, failures);
            Case(name, "callback_failure_requires_explicit_completion", parent, CallbackFailure, results, failures);
            Case(name, "shared_io_and_invalid_terminal_report_refused", parent, InvalidReports, results, failures);
            Case(name, "uncertain_retains_until_fixture_process_exit", parent, f => ProcessExitCase(f, "uncertain"), results, failures);
            Case(name, "abandoned_token_retains_until_fixture_process_exit", parent, f => ProcessExitCase(f, "abandoned"), results, failures);
        }
        Program.Emit(new TestReport { State = failures.Count == 0 ? "pass" : "fail",
            Profile = "v3_retained_use_source_only", Results = results, Failures = failures }, failures.Count == 0 ? 0 : 1);
        return failures.Count == 0 ? 0 : 1;
    }
    private static void Case(string volume, string name, string parent, Action<GraphFixture> run,
        List<TestCase> results, List<string> failures)
    {
        GraphFixture? fixture = null;
        try
        {
            fixture = V3HeldGraphFixtureTests.CreateFixture(parent, false);
            run(fixture); fixture.VerifyMarker();
            results.Add(new TestCase { Name = volume + "_" + name, Passed = true,
                State = new DriveInfo(Path.GetPathRoot(parent)!).DriveFormat, FixturePath = fixture.Root });
        }
        catch (Exception error)
        {
            failures.Add(volume + "_" + name);
            results.Add(new TestCase { Name = volume + "_" + name, Passed = false,
                Error = error.GetType().Name + ":" + error.Message, FixturePath = fixture?.Root });
        }
        finally { Owner.FixtureOnOwnedHandle = null; }
    }
    private static void Need(bool condition, string reason)
    { if (!condition) throw new InvalidOperationException(reason); }
    private static Owner Open(GraphFixture f, List<SafeFileHandle> handles)
    {
        Owner.FixtureOnOwnedHandle = handles.Add;
        var owner = Owner.OpenFixture(f.Root, f.Graph.GenerationId);
        try { owner.AcquireGraph(f.Graph); return owner; }
        catch { owner.Dispose(); throw; }
    }
    private static bool Refuses<T>(Action operation) where T : Exception
    {
        try { operation(); return false; } catch (T) { return true; }
    }
    private static bool SharingRefused(Action operation)
    {
        try { operation(); return false; }
        catch (IOException error) when ((error.HResult & 0xffff) == 32) { return true; }
    }
    private static void Held(GraphFixture f)
    {
        foreach (var file in V3HeldGraphFixtureTests.Members)
        {
            Need(SharingRefused(() => File.Move(f.File(file.Path), f.File(file.Path) + ".attempt")), "member_replace_not_blocked");
            Need(SharingRefused(() => { using var write = new FileStream(f.File(file.Path), FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); }), "member_write_not_blocked");
        }
        Need(SharingRefused(() => File.Move(Path.Combine(f.Generation, "generation-graph.json"), Path.Combine(f.Generation, "manifest.attempt"))), "manifest_replace_not_blocked");
        Need(SharingRefused(() => Directory.Move(Path.Combine(f.Generation, "node"), Path.Combine(f.Generation, "node.attempt"))), "ancestor_replace_not_blocked");
    }
    private static void Released(GraphFixture f, List<SafeFileHandle>? handles = null)
    {
        if (handles is not null) Need(handles.Count > 20 && handles.All(h => h.IsClosed), "managed_handles_not_closed");
        foreach (var file in V3HeldGraphFixtureTests.Members)
        { using var exclusive = new FileStream(f.File(file.Path), FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
        Directory.Move(Path.Combine(f.Generation, "node"), Path.Combine(f.Generation, "node.after-close"));
    }
    private static void ReadBorrowed(nint file, byte[] expected)
    {
        var bytes = new byte[expected.Length];
        Need(ReadFile(file, bytes, (uint)bytes.Length, out var count, 0) && count == bytes.Length && bytes.AsSpan().SequenceEqual(expected),
            "borrowed_file_bytes_changed");
    }
    private static void DisposeDuringUse(GraphFixture f)
    {
        var handles = new List<SafeFileHandle>(); using var owner = Open(f, handles);
        Need(owner.State == Owner.RetainedOwnerState.Open, "initial_owner_state");
        using var use = owner.BeginRetainedUse();
        Need(owner.State == Owner.RetainedOwnerState.Active, "active_owner_state");
        owner.Dispose();
        Need(owner.State == Owner.RetainedOwnerState.CloseRequested && handles.All(h => !h.IsClosed), "dispose_released_active_use");
        foreach (var file in V3HeldGraphFixtureTests.Members)
            use.WithMemberHandle(file.Path, h => ReadBorrowed(h, f.Bytes[file.Path]));
        Held(f);
        Need(Refuses<ObjectDisposedException>(() => owner.ReadGraphMember("node/node.exe", 0, new byte[1])), "close_requested_byte_read_accepted");
        use.ConfirmNoChild();
        Need(owner.State == Owner.RetainedOwnerState.Closed, "completed_close_state");
        Released(f, handles);
        Need(Refuses<ObjectDisposedException>(() => use.WithMemberHandle("node/node.exe", _ => { })), "completed_borrow_accepted");
    }
    private static void SingleSlot(GraphFixture f)
    {
        var handles = new List<SafeFileHandle>(); using var first = Open(f, handles);
        var otherHandles = new List<SafeFileHandle>(); using var second = Open(f, otherHandles);
        using var use = first.BeginRetainedUse();
        Need(Refuses<InvalidOperationException>(() => first.BeginRetainedUse()), "second_owner_use_accepted");
        Need(Refuses<InvalidOperationException>(() => second.BeginRetainedUse()), "second_process_use_accepted");
        use.ConfirmNoChild();
        using var next = second.BeginRetainedUse(); next.ConfirmNoChild();
        first.Dispose(); second.Dispose();
        Released(f, handles);
        Need(otherHandles.All(h => h.IsClosed), "second_owner_not_closed");
    }
    private static void CallbackFailure(GraphFixture f)
    {
        var handles = new List<SafeFileHandle>(); using var owner = Open(f, handles);
        using var use = owner.BeginRetainedUse();
        Need(Refuses<InvalidOperationException>(() => use.WithMemberHandle("node/node.exe", h => {
            ReadBorrowed(h, f.Bytes["node/node.exe"]); throw new InvalidOperationException("fixture_setup_failure");
        })), "callback_failure_missing");
        Need(owner.State == Owner.RetainedOwnerState.Active && handles.All(h => !h.IsClosed), "callback_failure_released_use");
        Held(f);
        // Synchronous fixture callback returned and created no child or pending
        // native work. Its explicit report permits reuse; an exception alone does not.
        use.ConfirmNoChild();
        using var next = owner.BeginRetainedUse(); next.ConfirmNoChild();
        owner.Dispose(); Released(f, handles);
    }
    private static void InvalidReports(GraphFixture f)
    {
        var handles = new List<SafeFileHandle>(); using var owner = Open(f, handles);
        using var use = owner.BeginRetainedUse();
        Need(Refuses<InvalidOperationException>(() => owner.ReadGraphMember("node/node.exe", 0, new byte[1])), "shared_read_accepted");
        Need(Refuses<InvalidOperationException>(() => owner.VerifyGraphUnchanged()), "concurrent_hash_accepted");
        Need(Refuses<InvalidOperationException>(() => use.ConfirmDrained()), "drain_without_child_accepted");
        Need(Refuses<ArgumentException>(() => use.WithMemberHandle("node/unselected.exe", _ => { })), "unselected_member_accepted");
        use.WithMemberHandle("node/node.exe", h => {
            Need(Refuses<InvalidOperationException>(() => use.ConfirmNoChild()), "completion_inside_callback_accepted");
            Need(Refuses<InvalidOperationException>(() => use.WithMemberHandle("node/node.exe", _ => { })), "nested_borrow_accepted");
            ReadBorrowed(h, f.Bytes["node/node.exe"]);
        });
        use.ConfirmNoChild(); owner.Dispose(); Released(f, handles);
    }

    // A process exit is deliberately the only cleanup of these quarantined
    // owners. No operation child is launched and no child-drain fact is claimed.
    private static void ProcessExitCase(GraphFixture f, string mode)
    {
        using var child = new Process { StartInfo = new ProcessStartInfo(Environment.ProcessPath!) {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        } };
        child.StartInfo.ArgumentList.Add("--v3-retained-use-quarantine-child");
        child.StartInfo.ArgumentList.Add(f.Root); child.StartInfo.ArgumentList.Add(mode);
        var started = false;
        try
        {
            Need(child.Start(), "quarantine_fixture_start"); started = true;
            // Child source emits one fixed short ready line, then waits for exit.
            // Parent and external verifier both supervise this exact fixture image.
            var ready = child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            Need(ready == "retained_use_quarantined:" + mode && !child.HasExited, "quarantine_fixture_not_ready");
            Held(f);
            child.StandardInput.WriteLine("exit"); child.StandardInput.Flush();
            Need(child.WaitForExit(5000) && child.ExitCode == 0, "quarantine_fixture_not_terminal");
            var tail = child.StandardOutput.ReadToEnd(); var error = child.StandardError.ReadToEnd();
            Need(tail.Trim() == "residual_process_exit" && error.Length == 0, "quarantine_fixture_output");
            Released(f); // Actual OS handle release after this exact process exited.
        }
        finally
        {
            if (started && !child.HasExited) child.Kill(true);
            if (started && !child.WaitForExit(5000)) throw new TimeoutException("fixture_process_exit_uncertain");
        }
    }
    internal static int QuarantineChild(string root, string mode)
    {
        try
        {
            if (mode is not ("uncertain" or "abandoned")) return 2;
            var path = Path.GetFullPath(root); var name = Path.GetFileName(path);
            var parent = Path.GetDirectoryName(path);
            var imageParent = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd('\\');
            var tempParent = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\');
            if (name.Length != 45 || !name.StartsWith("v3-fullgraph-", StringComparison.Ordinal) ||
                name[13..].Any(c => !char.IsAsciiHexDigit(c)) ||
                (!string.Equals(parent, imageParent, StringComparison.OrdinalIgnoreCase) &&
                 !string.Equals(parent, tempParent, StringComparison.OrdinalIgnoreCase)) ||
                File.ReadAllText(Path.Combine(path, name + ".marker")) != name) return 2;
            var generations = Directory.GetDirectories(Path.Combine(path, "generations"));
            if (generations.Length != 1) return 2;
            var manifest = File.ReadAllBytes(Path.Combine(generations[0], "generation-graph.json"));
            var graph = GraphV3.Parse(manifest, GraphV3.Digest(manifest));
            var weak = CreateQuarantinedOwner(path, graph, mode);
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            Need(!weak.Use.IsAlive && weak.Owner.IsAlive && CheckQuarantinedOwner(weak.Owner, path, graph), "quarantine_root_or_finalizer_missing");
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            Need(weak.Owner.IsAlive, "owner_not_process_rooted");
            Console.WriteLine("retained_use_quarantined:" + mode);
            var exit = Console.In.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            if (exit != "exit") return 3;
            Console.WriteLine("residual_process_exit"); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().Name + ":" + error.Message); return 1; }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (WeakReference Owner, WeakReference Use) CreateQuarantinedOwner(string root, GraphV3 graph, string mode)
    {
        Owner.FixtureOnOwnedHandle = null;
        var owner = Owner.OpenFixture(root, graph.GenerationId); owner.AcquireGraph(graph);
        var use = owner.BeginRetainedUse(); owner.Dispose();
        if (mode == "uncertain")
        {
            // A synthetic child-start marker tests report consistency only.
            // It is not a claim that an actual operation child exists or drained.
            use.MarkChildStarted();
            Need(Refuses<InvalidOperationException>(() => use.ConfirmNoChild()), "no_child_report_after_start_accepted");
            Need(Refuses<InvalidOperationException>(() => use.WithMemberHandle("node/node.exe", _ => { })), "borrow_after_child_start_accepted");
            use.ReportUncertain();
        }
        return (new WeakReference(owner), new WeakReference(use));
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool CheckQuarantinedOwner(WeakReference reference, string root, GraphV3 graph)
    {
        if (reference.Target is not Owner owner || owner.State != Owner.RetainedOwnerState.TerminalUncertain) return false;
        owner.Dispose();
        if (!Refuses<ObjectDisposedException>(() => owner.BeginRetainedUse()) ||
            !Refuses<ObjectDisposedException>(() => owner.ReadGraphMember("node/node.exe", 0, new byte[1]))) return false;
        using var other = Owner.OpenFixture(root, graph.GenerationId); other.AcquireGraph(graph);
        try { using var unexpected = other.BeginRetainedUse(); return false; }
        catch (InvalidOperationException error) { return error.Message == "native_process_quarantined"; }
    }
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(nint file, byte[] buffer, uint bytes, out uint read, nint overlapped);
}
#endif
