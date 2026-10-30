#if COORDINATOR_CLIENT_FIXTURE_TESTS
using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using LexRunner.WindowsCoordinator.Client;
using Microsoft.Win32.SafeHandles;

// Only nonce/marker-owned tiny synthetic files. No installed path, SCM, registry,
// ACL, trust provider, helper image execution, network or process launch.
[SupportedOSPlatform("windows")]
internal static class V3HeldGraphFixtureTests
{
    internal static readonly (string Path, string Role)[] Members = [
        ("bin/lexrunner-windows-boundary-helper.exe", "helper-image"),
        ("client/lexrunner-windows-coordinator-client.exe", "client-image"),
        ("git/cmd/git.exe", "git-entry"),
        ("git/mingw64/bin/support.dll", "native-dll"),
        ("git/mingw64/bin/tool.exe", "git-tool"),
        ("git/share/git-core/config", "git-support-file"),
        ("node/better_sqlite3.node", "sqlite-addon"),
        ("node/lib/deep/module.mjs", "javascript-module"),
        ("node/node.exe", "node-image"),
        ("node/private-admission-worker.mjs", "admission-entry"),
        ("service/LexRunner.WindowsCoordinator.Service.exe", "service-image"),
        ("service/LexRunner.WindowsCoordinator.WorkerSlot.exe", "worker-service-image"),
    ];
    internal sealed record Fixture(string Root, string Generation, GraphV3 Graph,
        Dictionary<string, byte[]> Bytes, string Marker)
    {
        internal string File(string relative) => Path.Combine(Generation, relative.Replace('/', '\\'));
        internal void VerifyMarker()
        {
            if (System.IO.File.ReadAllText(Path.Combine(Root, Marker + ".marker")) != Marker)
                throw new InvalidOperationException("fixture_marker_changed");
        }
    }

    internal static int Run()
    {
        var results = new List<TestCase>(); var failures = new List<string>();
        foreach (var (name, parent) in new[] { ("artifact", AppContext.BaseDirectory), ("temp", Path.GetTempPath()) })
        {
            RunCase(name, "nested_complete_graph_and_replacement_custody", parent, VerifyComplete, results, failures);
            RunCase(name, "late_hash_failure_closes_every_handle", parent, f => VerifyFailure(f, "hash"), results, failures);
            RunCase(name, "size_failure_closes_every_handle", parent, f => VerifyFailure(f, "size"), results, failures);
            RunCase(name, "missing_leaf_closes_partial_graph", parent, f => VerifyFailure(f, "missing"), results, failures);
            RunCase(name, "directory_reparse_refused", parent, VerifyReparse, results, failures);
            RunCase(name, "physical_hardlink_alias_refused", parent, VerifyHardlink, results, failures, true);
            RunCase(name, "root_dot_alias_refused", parent, VerifyDotAlias, results, failures);
            RunCase(name, "dispose_waits_for_acquisition", parent, f => VerifySerialization(f, false), results, failures);
            RunCase(name, "dispose_waits_for_consumption", parent, f => VerifySerialization(f, true), results, failures);
        }
        Program.Emit(new TestReport { State = failures.Count == 0 ? "pass" : "fail",
            Profile = "v3_fullgraph_custody_source_only", Results = results, Failures = failures }, failures.Count == 0 ? 0 : 1);
        return failures.Count == 0 ? 0 : 1;
    }

    private static void RunCase(string volumeName, string name, string parent,
        Action<Fixture> test, List<TestCase> results, List<string> failures, bool alias = false)
    {
        Fixture? fixture = null;
        try
        {
            fixture = CreateFixture(parent, alias);
            test(fixture); fixture.VerifyMarker();
            results.Add(new TestCase { Name = volumeName + "_" + name, Passed = true,
                State = new DriveInfo(Path.GetPathRoot(parent)!).DriveFormat, FixturePath = fixture.Root });
        }
        catch (Exception error)
        {
            failures.Add(volumeName + "_" + name);
            results.Add(new TestCase { Name = volumeName + "_" + name, Passed = false,
                Error = error.GetType().Name + ":" + error.Message, FixturePath = fixture?.Root });
        }
        finally
        {
            V3HeldInstalledFiles.FixtureOnOwnedHandle = null;
            V3HeldInstalledFiles.FixtureBeforeGraphMemberHash = null;
            V3HeldInstalledFiles.FixtureBeforeGraphRead = null;
        }
    }

    internal static Fixture CreateFixture(string baseDirectory, bool alias)
    {
        var parent = Path.GetFullPath(baseDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if (!Directory.Exists(parent) || (System.IO.File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("fixture_parent_unavailable");
        var marker = "v3-fullgraph-" + Guid.NewGuid().ToString("N");
        var root = Path.GetFullPath(Path.Combine(parent, marker));
        if (!string.Equals(Path.GetDirectoryName(root), parent, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("fixture_root_escape");
        var bytes = Members.ToDictionary(m => m.Path, m => Encoding.UTF8.GetBytes("synthetic-fullgraph:" + m.Path + "\n"), StringComparer.Ordinal);
        if (alias) bytes["node/lib/deep/module.mjs"] = bytes[Members[0].Path];
        var (manifest, graph) = MakeGraph(bytes);
        var generation = Path.Combine(root, "generations", graph.GenerationId);
        Directory.CreateDirectory(generation);
        System.IO.File.WriteAllText(Path.Combine(root, marker + ".marker"), marker);
        foreach (var member in Members)
        {
            var path = Path.Combine(generation, member.Path.Replace('/', '\\'));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            System.IO.File.WriteAllBytes(path, bytes[member.Path]);
        }
        System.IO.File.WriteAllBytes(Path.Combine(generation, "generation-graph.json"), manifest);
        return new Fixture(root, generation, graph, bytes, marker);
    }

    private static (byte[], GraphV3) MakeGraph(Dictionary<string, byte[]> bytes)
    {
        var files = new StringBuilder("[");
        foreach (var member in Members)
        {
            if (files.Length > 1) files.Append(',');
            var content = bytes[member.Path];
            files.Append("{\"bytes\":").Append(content.Length).Append(",\"path\":\"").Append(member.Path)
                .Append("\",\"role\":\"").Append(member.Role).Append("\",\"sha256\":\"").Append(GraphV3.Digest(content)).Append("\"}");
        }
        files.Append(']');
        var leading = "{\"architecture\":\"win-x64\",\"boundaryProtocolVersion\":\"2.2.0\",\"coordinatorProtocolVersion\":\"1.0.0\",\"files\":" + files + ",";
        const string trailing = "\"profile\":\"windows-coordinator-service-msi/3\",\"removalProtocolVersion\":\"1.0.0\"," +
            "\"schemaVersion\":\"lexrunner-windows-coordinator-generation-graph/3\",\"serviceName\":\"LexRunnerCoordinator\"," +
            "\"workerServiceName\":\"LexRunnerWorkerSlot1\",\"workerServiceSid\":\"S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843\",\"workerTokenUserSid\":\"S-1-5-19\"}";
        var id = GraphV3.Digest(Encoding.UTF8.GetBytes("lexrunner-windows-coordinator-generation-graph/3\n" + leading + trailing));
        var manifest = Encoding.UTF8.GetBytes(leading + "\"graphDigest\":\"" + id + "\"," + trailing);
        return (manifest, GraphV3.Parse(manifest, GraphV3.Digest(manifest)));
    }

    private static V3HeldInstalledFiles Open(Fixture f, List<SafeFileHandle> handles)
    {
        V3HeldInstalledFiles.FixtureOnOwnedHandle = handles.Add;
        return V3HeldInstalledFiles.OpenFixture(f.Root, f.Graph.GenerationId);
    }
    private static void Need(bool condition, string reason)
    { if (!condition) throw new InvalidOperationException(reason); }
    private static void Closed(List<SafeFileHandle> handles)
    { Need(handles.Count > 4 && handles.All(h => h.IsClosed), "owned_handles_not_closed"); }
    private static bool SharingRefused(Action operation)
    {
        try { operation(); return false; }
        catch (IOException e) when ((e.HResult & 0xffff) == 32) { return true; }
    }
    private static void VerifyComplete(Fixture f)
    {
        var handles = new List<SafeFileHandle>();
        var held = Open(f, handles);
        try
        {
            held.AcquireGraph(f.Graph);
            var retained = handles.Count;
            foreach (var member in Members)
            {
                var read = new byte[32768];
                var length = held.ReadGraphMember(member.Path, 0, read);
                Need(read.AsSpan(0, length).SequenceEqual(f.Bytes[member.Path]), "held_member_read_mismatch");
                Need(SharingRefused(() => { using var writer = new FileStream(f.File(member.Path), FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); }), "writer_not_refused");
                Need(SharingRefused(() => System.IO.File.Move(f.File(member.Path), f.File(member.Path) + ".moved")), "leaf_replacement_not_refused");
            }
            Need(SharingRefused(() => Directory.Move(Path.Combine(f.Generation, "node", "lib"), Path.Combine(f.Generation, "node", "lib-moved"))), "ancestor_replacement_not_refused");
            Need(SharingRefused(() => System.IO.File.Move(Path.Combine(f.Generation, "generation-graph.json"), Path.Combine(f.Generation, "manifest-moved"))), "manifest_replacement_not_refused");
            held.VerifyGraphUnchanged();
            var repeated = false;
            try { held.AcquireGraph(f.Graph); } catch (InvalidOperationException) { repeated = true; }
            Need(repeated && retained == handles.Count, "second_acquisition_not_refused");
            var alias = false;
            try { held.ReadGraphMember("NODE/node.exe", 0, new byte[1]); } catch (ArgumentException) { alias = true; }
            Need(alias && retained == handles.Count, "unselected_spelling_opened");
        }
        finally { held.Dispose(); }
        Closed(handles);
        var disposed = false;
        try { held.ReadGraphMember("node/node.exe", 0, new byte[1]); } catch (ObjectDisposedException) { disposed = true; }
        Need(disposed, "disposed_consumption_accepted");
        System.IO.File.Move(f.File(Members[0].Path), f.File(Members[0].Path) + ".after-close");
        Directory.Move(Path.Combine(f.Generation, "node", "lib"), Path.Combine(f.Generation, "node", "lib-after-close"));
    }
    private static void VerifyFailure(Fixture f, string kind)
    {
        var relative = Members[^1].Path;
        if (kind == "hash") { var bad = f.Bytes[relative].ToArray(); bad[0] ^= 1; System.IO.File.WriteAllBytes(f.File(relative), bad); }
        else if (kind == "size") System.IO.File.AppendAllText(f.File(relative), "changed");
        else System.IO.File.Delete(f.File(relative));
        var handles = new List<SafeFileHandle>();
        using var held = Open(f, handles);
        var refused = false;
        try { held.AcquireGraph(f.Graph); } catch (V3HeldPathException) { refused = true; }
        Need(refused, "changed_graph_accepted"); Closed(handles);
        var terminal = false;
        try { held.AcquireGraph(f.Graph); } catch (ObjectDisposedException) { terminal = true; }
        Need(terminal, "partial_owner_reused");
        foreach (var member in Members.Where(m => kind != "missing" || m.Path != relative))
        { using var exclusive = new FileStream(f.File(member.Path), FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
        Directory.Move(f.Generation, f.Generation + ".after-failure");
    }
    private static void VerifyHardlink(Fixture f)
    {
        var alias = f.File("node/lib/deep/module.mjs");
        System.IO.File.Delete(alias);
        if (!CreateHardLinkW(NativePath(alias), NativePath(f.File(Members[0].Path)), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var handles = new List<SafeFileHandle>(); using var held = Open(f, handles);
        var refused = false;
        try { held.AcquireGraph(f.Graph); } catch (V3HeldPathException e) when (e.Reason == "graph_file_alias") { refused = true; }
        Need(refused, "physical_alias_accepted"); Closed(handles);
    }
    private static void VerifyDotAlias(Fixture f)
    {
        var handles = new List<SafeFileHandle>();
        V3HeldInstalledFiles.FixtureOnOwnedHandle = handles.Add;
        V3HeldInstalledFiles.FixtureBeforeRootObserve = handles.Add;
        var refused = false;
        try { using var held = V3HeldInstalledFiles.OpenFixture(f.Root + "\\.", f.Graph.GenerationId); }
        catch (V3HeldPathException) { refused = true; }
        finally { V3HeldInstalledFiles.FixtureBeforeRootObserve = null; }
        Need(refused && handles.Count > 0 && handles.All(h => h.IsClosed), "dot_alias_or_cleanup_failed");
    }
    private static void VerifyReparse(Fixture f)
    {
        var link = Path.Combine(f.Generation, "node", "lib"); var target = link + "-target";
        Directory.Move(link, target); MakeJunction(link, target);
        Need((System.IO.File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0, "fixture_reparse_not_created");
        var handles = new List<SafeFileHandle>(); using var held = Open(f, handles);
        var refused = false;
        try { held.AcquireGraph(f.Graph); } catch (V3HeldPathException e) when (e.Reason == "generation_path_unavailable") { refused = true; }
        Need(refused, "reparse_graph_accepted"); Closed(handles);
    }
    private static void VerifySerialization(Fixture f, bool reading)
    {
        var handles = new List<SafeFileHandle>(); using var held = Open(f, handles);
        if (reading) held.AcquireGraph(f.Graph);
        using var entered = new ManualResetEventSlim(false); using var release = new ManualResetEventSlim(false);
        using var disposing = new ManualResetEventSlim(false);
        void Pause() { entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("fixture_operation_gate"); }
        if (reading) V3HeldInstalledFiles.FixtureBeforeGraphRead = Pause;
        else V3HeldInstalledFiles.FixtureBeforeGraphMemberHash = _ => Pause();
        Task? operation = null; Task? disposer = null;
        try
        {
            operation = Task.Run(() => { if (reading) held.ReadGraphMember("node/node.exe", 0, new byte[10]); else held.AcquireGraph(f.Graph); });
            Need(entered.Wait(TimeSpan.FromSeconds(5)), "operation_did_not_enter");
            disposer = Task.Run(() => { disposing.Set(); held.Dispose(); });
            Need(disposing.Wait(TimeSpan.FromSeconds(5)), "dispose_did_not_enter");
            Need(!disposer.Wait(100) && handles.All(h => !h.IsClosed), "dispose_closed_inflight_custody");
            // Only pause once; later graph member hashes must not wait again.
            V3HeldInstalledFiles.FixtureBeforeGraphMemberHash = null;
            release.Set();
            Need(operation.Wait(TimeSpan.FromSeconds(5)) && disposer.Wait(TimeSpan.FromSeconds(5)), "serialized_operations_timeout");
            Closed(handles);
        }
        finally
        {
            release.Set();
            V3HeldInstalledFiles.FixtureBeforeGraphMemberHash = null; V3HeldInstalledFiles.FixtureBeforeGraphRead = null;
            if (operation is not null && !operation.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("operation_terminal_uncertain");
            if (disposer is not null && !disposer.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("dispose_terminal_uncertain");
        }
    }

    // Fixture-only bounded encoding of documented MountPointReparseBuffer:
    // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer
    // Targets stay within the same nonce-owned fixture. No privilege is enabled.
    private static void MakeJunction(string link, string target)
    {
        Directory.CreateDirectory(link);
        var substitute = Encoding.Unicode.GetBytes(@"\??\" + Path.GetFullPath(target));
        var print = Encoding.Unicode.GetBytes(Path.GetFullPath(target));
        var buffer = new byte[16 + substitute.Length + 2 + print.Length + 2];
        if (buffer.Length > 16384) throw new InvalidOperationException("fixture_reparse_bound");
        BinaryPrimitives.WriteUInt32LittleEndian(buffer, 0xA0000003);
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(4), checked((ushort)(buffer.Length - 8)));
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(10), checked((ushort)substitute.Length));
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(12), checked((ushort)(substitute.Length + 2)));
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(14), checked((ushort)print.Length));
        substitute.CopyTo(buffer, 16); print.CopyTo(buffer, 16 + substitute.Length + 2);
        using var handle = CreateFileW(NativePath(link), 0x40000000, 0, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid || !DeviceIoControl(handle, 0x000900A4, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out _, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private static string NativePath(string path)
    {
        var full = Path.GetFullPath(path);
        if (Path.GetPathRoot(full) is not { Length: 3 }) throw new InvalidOperationException("fixture_local_root_required");
        return @"\\?\" + full;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLinkW(string file, string existing, IntPtr security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string file, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input, uint inputBytes, IntPtr output, uint outputBytes, out uint returned, IntPtr overlapped);
}
#endif
