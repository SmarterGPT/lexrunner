using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace LexRunner.WindowsCoordinator.Client;

// Read-only, fixed-name installed-file custody for a structural observation.
// This does not authenticate installation, signatures, ACL provisioning,
// selected revision, a running process, or the loader graph.
[SupportedOSPlatform("windows")]
internal sealed class V3HeldInstalledFiles : IDisposable
{
    private const string ApplicationName = "SmarterGPT.LexRunner.WindowsCoordinator";
    private const uint FileReadData = 0x0001;
    private const uint FileTraverse = 0x0020;
    private const uint FileReadAttributes = 0x0080;
    private const uint ReadControl = 0x00020000;
    private const uint Synchronize = 0x00100000;
    private const uint DeleteAccess = 0x00010000;
    private const uint FileShareRead = 0x0001;
    private const uint FileShareAll = 0x0007;
    private const uint FileAttributeNormal = 0x0080;
    private const uint FileAttributeDirectory = 0x0010;
    private const uint FileAttributeReparsePoint = 0x0400;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileDirectoryFile = 0x0001;
    private const uint FileNonDirectoryFile = 0x0040;
    private const uint FileOpenReparsePoint = 0x00200000;
    private const uint FileSynchronousIoNonalert = 0x0020;
    private const uint ObjCaseInsensitive = 0x0040;
    private const uint OpenExisting = 3;
    private const uint FileOpen = 1;
    private const int FileAttributeTagInfoClass = 9;
    private const int FileIdInfoClass = 18;

    private readonly List<HeldDirectory> _directories;
    private readonly SafeFileHandle _generation;
    private readonly SafeFileHandle _service;
    private readonly SafeFileHandle _generationParent;
    private readonly object _gate = new();
    // GraphV3 permits at most512 files, each with at most11 directory components.
    // Include the generation cache entry; shared prefixes consume one handle.
    private const int MaxGraphDirectories = 1 + 512 * 11;
    private readonly List<HeldMember> _heldGraphMembers = [];
    private FileStream? _heldManifest;
    private HeldIdentity _manifestIdentity;
    private string? _manifestSha256;
    private int _manifestLength;
    private Dictionary<string, HeldMember>? _graphFiles;
    private bool _disposed;
    private bool _closeRequested, _terminalUncertain, _nativeCallbackActive;
    private bool _nativeChildStarted, _releaseFailed;
    private long _activeUse;
    private static readonly object NativeUseGate = new();
    // Strong process-lifetime root from acquisition, not only after uncertainty.
    // The owner does not retain its token: abandoned tokens must be finalizable.
    private static V3HeldInstalledFiles? NativeUseOwner;
    private static bool NativeUseQuarantined;
    private static long NextNativeUse;

    internal enum RetainedOwnerState { Open, Active, CloseRequested, Closed, TerminalUncertain }
    internal delegate void SelectedMemberHandleCallback(nint file);
    internal RetainedOwnerState State
    {
        get
        {
            lock (_gate)
                return _terminalUncertain || _releaseFailed ? RetainedOwnerState.TerminalUncertain :
                    _disposed ? RetainedOwnerState.Closed : _closeRequested ? RetainedOwnerState.CloseRequested :
                    _activeUse != 0 ? RetainedOwnerState.Active : RetainedOwnerState.Open;
        }
    }

    private V3HeldInstalledFiles(List<HeldDirectory> directories, string generationPath,
        SafeFileHandle generation, SafeFileHandle service)
    {
        _directories = directories;
        GenerationPath = generationPath;
        _generation = generation;
        _service = service;
        _generationParent = directories[^3].Handle;
    }

    internal string GenerationPath { get; }

    internal static V3HeldInstalledFiles OpenInstalled(string generationId)
    {
        if (!GraphV3.ValidHex(generationId))
            throw new V3HeldPathException("graph_unavailable");
        var system = Environment.SystemDirectory;
        var volume = Path.GetPathRoot(system);
        if (volume is not { Length: 3 } || volume[1] != ':' || volume[2] != '\\' ||
            !char.IsAsciiLetter(volume[0]) ||
            !string.Equals(Path.GetFileName(system), "System32",
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFullPath(system), system,
                StringComparison.OrdinalIgnoreCase))
            throw new V3HeldPathException("unsupported_host");
        return OpenChain(volume,
            ["Program Files", ApplicationName, "generations", generationId, "service"]);
    }

#if COORDINATOR_CLIENT_FIXTURE_TESTS
    // Fixture-only pause after the native root handle has an owned reference.
    internal static Action? FixtureAfterParentAddRef;
    internal static Action<SafeFileHandle>? FixtureBeforeRootObserve;
    internal static Action<SafeFileHandle>? FixtureOnOwnedHandle;
    internal static Action<string>? FixtureBeforeGraphMemberHash;
    internal static Action? FixtureBeforeGraphRead;

    // Only a separately compiled fixture image can select a disposable root.
    internal static V3HeldInstalledFiles OpenFixture(string root, string generationId)
    {
        if (!GraphV3.ValidHex(generationId))
            throw new V3HeldPathException("graph_unavailable");
        return OpenChain(root, ["generations", generationId, "service"]);
    }

    internal static V3HeldInstalledFiles OpenFixtureChain(string root, string[] children) =>
        OpenChain(root, children);
#endif

    private static V3HeldInstalledFiles OpenChain(string root, string[] children)
    {
        var directories = new List<HeldDirectory>(children.Length + 1);
        try
        {
            var rootHandle = CreateFileW(root,
                FileTraverse | FileReadAttributes | ReadControl | Synchronize,
                FileShareRead, IntPtr.Zero, OpenExisting,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
            if (rootHandle.IsInvalid)
            {
                rootHandle.Dispose();
                throw new V3HeldPathException("generation_path_unavailable");
            }
            HeldIdentity rootIdentity;
            try
            {
#if COORDINATOR_CLIENT_FIXTURE_TESTS
                FixtureBeforeRootObserve?.Invoke(rootHandle);
#endif
                rootIdentity = Observe(rootHandle, root, true, null);
                directories.Add(new HeldDirectory(rootHandle, root, rootIdentity));
#if COORDINATOR_CLIENT_FIXTURE_TESTS
                FixtureOnOwnedHandle?.Invoke(rootHandle);
#endif
            }
            catch { rootHandle.Dispose(); throw; }
            var path = root;
            for (var index = 0; index < children.Length; index++)
            {
                var child = children[index];
                path = Path.Combine(path, child);
                var parent = directories[^1].Handle;
                var handle = OpenRelative(parent, child, true);
                try
                {
                    var identity = Observe(handle, path, true, rootIdentity.Volume);
                    directories.Add(new HeldDirectory(handle, path, identity));
#if COORDINATOR_CLIENT_FIXTURE_TESTS
                    FixtureOnOwnedHandle?.Invoke(handle);
#endif
                }
                catch { handle.Dispose(); throw; }
            }
            if (children.Length < 2 || children[^1] != "service")
                throw new V3HeldPathException("generation_path_unavailable");
            var generation = directories[^2];
            var service = directories[^1];
            var result = new V3HeldInstalledFiles(directories, generation.Path,
                generation.Handle, service.Handle);
            result.VerifyUnchanged();
            return result;
        }
        catch
        {
            for (var index = directories.Count - 1; index >= 0; index--)
                directories[index].Handle.Dispose();
            throw;
        }
    }

    internal FileStream OpenManifest() => OpenRegular(_generation,
        "generation-graph.json", Path.Combine(GenerationPath, "generation-graph.json"));

    internal FileStream OpenCoordinator() => OpenRegular(_service,
        "LexRunner.WindowsCoordinator.Service.exe",
        Path.Combine(GenerationPath, "service", "LexRunner.WindowsCoordinator.Service.exe"));

    internal FileStream OpenWorker() => OpenRegular(_service,
        "LexRunner.WindowsCoordinator.WorkerSlot.exe",
        Path.Combine(GenerationPath, "service", "LexRunner.WindowsCoordinator.WorkerSlot.exe"));

    private FileStream OpenRegular(SafeFileHandle parent, string name, string expected)
    {
        // Legacy structural streams own independent leaf handles. They cannot
        // consume the retained graph's shared stream position during native use.
        ThrowIfDisposed();
        var handle = OpenRelative(parent, name, false);
        try
        {
            _ = Observe(handle, expected, false, _directories[0].Identity.Volume);
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }

    internal void VerifyUnchanged()
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            VerifyAncestryCore();
        }
    }

    private void VerifyAncestryCore()
    {
        foreach (var row in _directories)
        {
            var current = Observe(row.Handle, row.Path, true, row.Identity.Volume);
            if (current != row.Identity)
                throw new V3HeldPathException("generation_path_changed");
        }
    }

    // One synchronous acquisition per owner. All selected files and their complete
    // directory ancestry remain private to this owner until Dispose. This is
    // supplied-graph byte/namespace comparison only, never installed authority.
    internal void AcquireGraph(GraphV3 graph)
    {
        ArgumentNullException.ThrowIfNull(graph);
        lock (_gate)
        {
            ThrowIfDisposed();
            if (_graphFiles is not null) throw new InvalidOperationException("graph_already_acquired");
            try
            {
                var selected = graph.Files.ToArray();
                if (graph.GenerationId != Path.GetFileName(GenerationPath) || selected.Length is < 8 or > 512)
                    throw new V3HeldPathException("graph_mismatch");
                long total = 0;
                foreach (var file in selected)
                {
                    if (!GraphV3.SafePath(file.Path) || !GraphV3.ValidHex(file.Sha256) || file.Bytes <= 0)
                        throw new V3HeldPathException("graph_invalid");
                    total = checked(total + file.Bytes);
                    if (total > 2L * 1024 * 1024 * 1024) throw new V3HeldPathException("graph_invalid");
                }
                _heldManifest = OpenManifest();
#if COORDINATOR_CLIENT_FIXTURE_TESTS
                FixtureOnOwnedHandle?.Invoke(_heldManifest.SafeFileHandle);
#endif
                if (_heldManifest.Length is < 1 or > 262144) throw new V3HeldPathException("graph_invalid");
                var manifestBytes = new byte[(int)_heldManifest.Length];
                _heldManifest.ReadExactly(manifestBytes);
                if (_heldManifest.Length != manifestBytes.Length) throw new V3HeldPathException("graph_changed");
                var retainedGraph = GraphV3.Parse(manifestBytes, graph.ManifestSha256);
                if (retainedGraph.GenerationId != graph.GenerationId || !retainedGraph.Files.SequenceEqual(selected))
                    throw new V3HeldPathException("graph_mismatch");
                _heldManifest.Position = 0;
                _manifestSha256 = graph.ManifestSha256;
                _manifestLength = manifestBytes.Length;
                var generation = _directories.Single(row => ReferenceEquals(row.Handle, _generation));
                var service = _directories.Single(row => ReferenceEquals(row.Handle, _service));
                var cache = new Dictionary<string, HeldDirectory>(StringComparer.OrdinalIgnoreCase) {
                    [""] = generation, ["service"] = service,
                };
                var files = new Dictionary<string, HeldMember>(StringComparer.Ordinal);
                var manifestIdentity = Observe(_heldManifest.SafeFileHandle,
                    Path.Combine(GenerationPath, "generation-graph.json"), false, generation.Identity.Volume);
                _manifestIdentity = manifestIdentity;
                var identities = new HashSet<(ulong Volume, ulong Low, ulong High)> {
                    (manifestIdentity.Volume, manifestIdentity.Low, manifestIdentity.High),
                };
                foreach (var file in selected)
                {
                    ThrowIfDisposed();
                    var parts = file.Path.Split('/');
                    var parent = generation;
                    var key = "";
                    for (var index = 0; index < parts.Length - 1; index++)
                    {
                        key = key.Length == 0 ? parts[index] : key + "/" + parts[index];
                        if (!cache.TryGetValue(key, out var directory))
                        {
                            if (cache.Count >= MaxGraphDirectories) throw new V3HeldPathException("graph_directory_budget");
                            var path = Path.Combine(parent.Path, parts[index]);
                            var handle = OpenRelative(parent.Handle, parts[index], true);
                            try
                            {
                                var identity = Observe(handle, path, true, generation.Identity.Volume);
                                directory = new HeldDirectory(handle, path, identity);
                                _directories.Add(directory);
#if COORDINATOR_CLIENT_FIXTURE_TESTS
                                FixtureOnOwnedHandle?.Invoke(handle);
#endif
                                cache.Add(key, directory);
                            }
                            catch { handle.Dispose(); throw; }
                        }
                        parent = directory;
                    }
                    var expectedPath = Path.Combine(parent.Path, parts[^1]);
                    var leaf = OpenRelative(parent.Handle, parts[^1], false);
                    FileStream? stream = null;
                    var owned = false;
                    try
                    {
                        var identity = Observe(leaf, expectedPath, false, generation.Identity.Volume);
                        stream = new FileStream(leaf, FileAccess.Read);
                        var member = new HeldMember(file, expectedPath, stream, identity);
                        _heldGraphMembers.Add(member);
                        owned = true;
#if COORDINATOR_CLIENT_FIXTURE_TESTS
                        FixtureOnOwnedHandle?.Invoke(leaf);
                        FixtureBeforeGraphMemberHash?.Invoke(file.Path);
#endif
                        ThrowIfDisposed();
                        if (!identities.Add((identity.Volume, identity.Low, identity.High)))
                            throw new V3HeldPathException("graph_file_alias");
                        CompareMember(member);
                        files.Add(file.Path, member);
                    }
                    catch
                    {
                        if (!owned) { if (stream is null) leaf.Dispose(); else stream.Dispose(); }
                        throw;
                    }
                }
                ThrowIfDisposed();
                VerifyAncestryCore();
                _graphFiles = files;
            }
            catch
            {
                // A partial graph is never reusable. Close leaves before ancestry;
                // no fresh observation/retry can turn this owner into success.
                CloseCore();
                throw;
            }
        }
    }

    // No FileStream/SafeHandle escapes. Each bounded read keeps the whole owner
    // alive under the same gate; a caller cannot use a borrowed handle after close.
    // Future native verification must add scoped synchronous hFile consumption
    // under this lifetime, not substitute these byte reads for trusted launch.
    internal int ReadGraphMember(string relativePath, long offset, Span<byte> buffer)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            if (_graphFiles is null) throw new InvalidOperationException("graph_not_acquired");
            if (!_graphFiles.TryGetValue(relativePath, out var member)) throw new ArgumentException("unselected_graph_member");
            if (offset < 0 || offset > member.Selected.Bytes || buffer.Length > 32768)
                throw new ArgumentOutOfRangeException(nameof(offset));
            try
            {
#if COORDINATOR_CLIENT_FIXTURE_TESTS
                FixtureBeforeGraphRead?.Invoke();
#endif
                ThrowIfDisposed();
                var count = (int)Math.Min(buffer.Length, member.Selected.Bytes - offset);
                var read = RandomAccess.Read(member.Stream.SafeFileHandle, buffer[..count], offset);
                if (read != count || member.Stream.Length != member.Selected.Bytes)
                    throw new V3HeldPathException("graph_file_changed");
                return read;
            }
            catch { CloseCore(); throw; }
        }
    }

    internal void VerifyGraphUnchanged()
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            if (_graphFiles is null) throw new InvalidOperationException("graph_not_acquired");
            try
            {
                VerifyAncestryCore();
                if (_heldManifest is null ||
                    Observe(_heldManifest.SafeFileHandle, Path.Combine(GenerationPath, "generation-graph.json"),
                        false, _manifestIdentity.Volume) != _manifestIdentity || _heldManifest.Length != _manifestLength)
                    throw new V3HeldPathException("graph_changed");
                _heldManifest.Position = 0;
                var manifestHash = Convert.ToHexString(SHA256.HashData(_heldManifest)).ToLowerInvariant();
                if (_heldManifest.Length != _manifestLength || manifestHash != _manifestSha256)
                    throw new V3HeldPathException("graph_changed");
                _heldManifest.Position = 0;
                foreach (var member in _heldGraphMembers)
                {
                    if (Observe(member.Stream.SafeFileHandle, member.Path, false, member.Identity.Volume) != member.Identity)
                        throw new V3HeldPathException("graph_file_changed");
                    CompareMember(member);
                }
            }
            catch { CloseCore(); throw; }
        }
    }

    private static void CompareMember(HeldMember member)
    {
        if (member.Stream.Length != member.Selected.Bytes) throw new V3HeldPathException("graph_file_mismatch");
        member.Stream.Position = 0;
        var hash = Convert.ToHexString(SHA256.HashData(member.Stream)).ToLowerInvariant();
        if (member.Stream.Length != member.Selected.Bytes || hash != member.Selected.Sha256)
            throw new V3HeldPathException("graph_file_mismatch");
        member.Stream.Position = 0;
    }

    private void ThrowIfDisposed()
    {
        if (_disposed || _closeRequested || _terminalUncertain || _releaseFailed)
            throw new ObjectDisposedException(nameof(V3HeldInstalledFiles));
        if (_activeUse != 0) throw new InvalidOperationException("retained_native_use_active");
    }

    internal RetainedUse BeginRetainedUse()
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            if (_graphFiles is null) throw new InvalidOperationException("graph_not_acquired");
            lock (NativeUseGate)
            {
                if (NativeUseQuarantined) throw new InvalidOperationException("native_process_quarantined");
                if (NativeUseOwner is not null) throw new InvalidOperationException("native_process_slot_active");
                var id = checked(NextNativeUse + 1);
                var use = new RetainedUse(this, id);
                NextNativeUse = id;
                _activeUse = id;
                _nativeChildStarted = false;
                NativeUseOwner = this;
                use.Arm();
                return use;
            }
        }
    }

    private void RequireUse(long id)
    {
        if (_disposed || _terminalUncertain || _activeUse != id || id == 0)
            throw new ObjectDisposedException(nameof(RetainedUse));
    }

    private void WithSelectedHandle(long id, string relativePath, SelectedMemberHandleCallback callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        lock (_gate)
        {
            RequireUse(id);
            if (_nativeCallbackActive || _nativeChildStarted)
                throw new InvalidOperationException("retained_handle_scope_unavailable");
            if (_graphFiles is null || !_graphFiles.TryGetValue(relativePath, out var member))
                throw new ArgumentException("unselected_graph_member");
            var handle = member.Stream.SafeFileHandle;
            var added = false;
            _nativeCallbackActive = true;
            try
            {
                member.Stream.Position = 0;
                handle.DangerousAddRef(ref added);
                // Synchronous borrow only. Never close, retain or return this
                // value. Inheritable duplicates for a future fixed child remain
                // covered by this use until explicit terminal completion.
                callback(handle.DangerousGetHandle());
            }
            finally
            {
                try { if (added) handle.DangerousRelease(); }
                finally { _nativeCallbackActive = false; }
            }
        }
    }

    private void MarkChildStarted(long id)
    {
        lock (_gate)
        {
            RequireUse(id);
            if (_nativeChildStarted) throw new InvalidOperationException("retained_child_already_started");
            _nativeChildStarted = true;
        }
    }

    private enum UseCompletion { NoChild, Drained }
    private void CompleteUse(long id, UseCompletion completion)
    {
        lock (_gate)
        {
            RequireUse(id);
            if (_nativeCallbackActive || (completion == UseCompletion.NoChild && _nativeChildStarted) ||
                (completion == UseCompletion.Drained && !_nativeChildStarted))
                throw new InvalidOperationException("retained_terminal_report_invalid");
            lock (NativeUseGate)
            {
                if (!ReferenceEquals(NativeUseOwner, this) || NativeUseQuarantined)
                    throw new InvalidOperationException("retained_process_root_unavailable");
                _activeUse = 0;
                _nativeChildStarted = false;
                try { if (_closeRequested) CloseCore(); }
                catch
                {
                    _terminalUncertain = true;
                    NativeUseQuarantined = true;
                    throw;
                }
                // Clear only after the explicit terminal report and any requested
                // managed close completed. This is not an OS child-drain proof.
                NativeUseOwner = null;
            }
        }
    }

    private void QuarantineUse(long id)
    {
        lock (_gate)
        {
            if (_activeUse != id || id == 0) return; // Already explicitly completed.
            _terminalUncertain = true;
            _closeRequested = true;
            _activeUse = 0;
            lock (NativeUseGate)
            {
                NativeUseQuarantined = true;
                // Never remove this root or close any held handle. Process exit
                // is residual cleanup, not child drain or permission to retry.
                NativeUseOwner = this;
            }
        }
    }

    internal sealed class RetainedUse : IDisposable
    {
        private readonly V3HeldInstalledFiles _owner;
        private readonly long _id;
        private int _armed, _completion;
        internal RetainedUse(V3HeldInstalledFiles owner, long id) { _owner = owner; _id = id; }
        internal void Arm() => Volatile.Write(ref _armed, 1);
        private void RequireLive()
        {
            if (Volatile.Read(ref _completion) != 0 || Volatile.Read(ref _armed) == 0)
                throw new ObjectDisposedException(nameof(RetainedUse));
        }
        internal void WithMemberHandle(string selectedPath, SelectedMemberHandleCallback callback)
        {
            RequireLive();
            try { _owner.WithSelectedHandle(_id, selectedPath, callback); }
            finally { GC.KeepAlive(this); }
        }
        internal void MarkChildStarted()
        {
            RequireLive();
            try { _owner.MarkChildStarted(_id); }
            finally { GC.KeepAlive(this); }
        }
        // Trusted native caller reports these facts only after its own observed
        // terminal cleanup. These methods do not infer or prove OS completion.
        internal void ConfirmNoChild() => Complete(UseCompletion.NoChild);
        internal void ConfirmDrained() => Complete(UseCompletion.Drained);
        private void Complete(UseCompletion completion)
        {
            if (Interlocked.CompareExchange(ref _completion, 1, 0) != 0)
                throw new ObjectDisposedException(nameof(RetainedUse));
            try
            {
                _owner.CompleteUse(_id, completion);
                Volatile.Write(ref _completion, 2);
                GC.SuppressFinalize(this);
            }
            catch { Interlocked.CompareExchange(ref _completion, 0, 1); throw; }
            finally { GC.KeepAlive(this); }
        }
        internal void ReportUncertain() => Dispose();
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _completion, 2) == 2) return;
            try { if (Volatile.Read(ref _armed) != 0) _owner.QuarantineUse(_id); }
            finally { GC.SuppressFinalize(this); }
        }
        ~RetainedUse()
        {
            try
            {
                if (Volatile.Read(ref _armed) != 0 && Interlocked.Exchange(ref _completion, 2) != 2)
                    _owner.QuarantineUse(_id);
            }
            catch { /* The process root already retains the owner; never release. */ }
        }
    }

#if COORDINATOR_CLIENT_FIXTURE_TESTS
    // Read-only access probes. No rename or deletion is dispatched.
    internal (int Generation, int Coordinator) ProbeDeleteAccess()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(V3HeldInstalledFiles));
        return (ProbeDelete(_generationParent, Path.GetFileName(GenerationPath), true),
            ProbeDelete(_service, "LexRunner.WindowsCoordinator.Service.exe", false));
    }

    private static int ProbeDelete(SafeFileHandle parent, string name, bool directory)
    {
        var status = OpenRelativeCore(parent, name, directory,
            DeleteAccess | Synchronize, FileShareAll, out var handle);
        handle.Dispose();
        return status;
    }

    // Exercises the native root-handle guard, bypassing the public disposed check.
    internal bool ProbeDisposedParentRefusal()
    {
        try
        {
            using var unexpected = OpenRelative(_service,
                "LexRunner.WindowsCoordinator.Service.exe", false);
            return false;
        }
        catch (ObjectDisposedException) { return true; }
    }
#endif

    public void Dispose()
    {
        lock (_gate)
        {
            _closeRequested = true;
            if (_activeUse != 0 || _terminalUncertain) return;
            CloseCore();
        }
    }

    private void CloseCore()
    {
        if (_disposed) return;
        _disposed = true;
        Exception? failure = null;
        void Close(IDisposable value)
        {
            try { value.Dispose(); }
            catch (Exception error) { failure ??= error; }
        }
        for (var index = _heldGraphMembers.Count - 1; index >= 0; index--)
            Close(_heldGraphMembers[index].Stream);
        if (_heldManifest is not null) Close(_heldManifest);
        for (var index = _directories.Count - 1; index >= 0; index--)
            Close(_directories[index].Handle);
        if (failure is not null) { _releaseFailed = true; throw failure; }
    }

    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, bool directory)
    {
        var access = FileReadAttributes | ReadControl | Synchronize |
            (directory ? FileTraverse : FileReadData);
        var status = OpenRelativeCore(parent, name, directory, access, FileShareRead,
            out var handle);
        if (status < 0 || handle.IsInvalid)
        {
            handle.Dispose();
            throw new V3HeldPathException(directory ? "generation_path_unavailable" :
                "installed_file_unavailable");
        }
        return handle;
    }

    private static int OpenRelativeCore(SafeFileHandle parent, string name, bool directory,
        uint access, uint share, out SafeFileHandle handle)
    {
        if (name.Length is < 1 or > 128 || name is "." or ".." ||
            name.Any(c => c is '/' or '\\' or ':' or '\0'))
            throw new V3HeldPathException("generation_path_unavailable");
        var nameBytes = Marshal.StringToHGlobalUni(name);
        var stringValue = new UnicodeString {
            Length = checked((ushort)(name.Length * 2)),
            MaximumLength = checked((ushort)((name.Length + 1) * 2)),
            Buffer = nameBytes,
        };
        var stringPointer = IntPtr.Zero;
        var parentReferenceAdded = false;
        try
        {
            stringPointer = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
            Marshal.StructureToPtr(stringValue, stringPointer, false);
            // ObjectAttributes.RootDirectory is an IntPtr, so P/Invoke cannot
            // marshal the SafeHandle for us. Own a reference across NtCreateFile
            // even if another thread disposes the containing lease.
            parent.DangerousAddRef(ref parentReferenceAdded);
            var attributes = new ObjectAttributes {
                Length = (uint)Marshal.SizeOf<ObjectAttributes>(),
                RootDirectory = parent.DangerousGetHandle(),
                ObjectName = stringPointer,
                Attributes = ObjCaseInsensitive,
            };
#if COORDINATOR_CLIENT_FIXTURE_TESTS
            FixtureAfterParentAddRef?.Invoke();
#endif
            var options = FileOpenReparsePoint | FileSynchronousIoNonalert |
                (directory ? FileDirectoryFile : FileNonDirectoryFile);
            return NtCreateFile(out handle, access, ref attributes, out _,
                IntPtr.Zero, directory ? FileAttributeDirectory : FileAttributeNormal,
                share, FileOpen, options, IntPtr.Zero, 0);
        }
        finally
        {
            if (parentReferenceAdded) parent.DangerousRelease();
            if (stringPointer != IntPtr.Zero) Marshal.FreeHGlobal(stringPointer);
            Marshal.FreeHGlobal(nameBytes);
        }
    }

    private static HeldIdentity Observe(SafeFileHandle handle, string expected,
        bool directory, ulong? volume)
    {
        if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfoClass,
                out FileAttributeTag tag, (uint)Marshal.SizeOf<FileAttributeTag>()) ||
            (tag.Attributes & FileAttributeReparsePoint) != 0 ||
            ((tag.Attributes & FileAttributeDirectory) != 0) != directory ||
            !GetFileInformationByHandleEx(handle, FileIdInfoClass,
                out FileIdInfo id, (uint)Marshal.SizeOf<FileIdInfo>()) ||
            (id.FileIdLow == 0 && id.FileIdHigh == 0) ||
            (volume.HasValue && volume.Value != id.VolumeSerialNumber))
            throw new V3HeldPathException(directory ? "generation_path_unavailable" :
                "installed_file_unavailable");
        var path = FinalPath(handle);
        if (!string.Equals(path, expected, StringComparison.OrdinalIgnoreCase))
            throw new V3HeldPathException(directory ? "generation_path_unavailable" :
                "installed_file_unavailable");
        return new HeldIdentity(id.VolumeSerialNumber, id.FileIdLow, id.FileIdHigh,
            tag.Attributes);
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new char[32768];
        var count = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
        if (count == 0 || count >= buffer.Length)
            throw new V3HeldPathException("generation_path_unavailable");
        var value = new string(buffer, 0, (int)count);
        return value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value[4..] : value;
    }

    private sealed record HeldDirectory(SafeFileHandle Handle, string Path, HeldIdentity Identity);
    private sealed record HeldMember(GraphV3File Selected, string Path, FileStream Stream, HeldIdentity Identity);
    private readonly record struct HeldIdentity(ulong Volume, ulong Low, ulong High, uint Attributes);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes {
        internal uint Length;
        internal IntPtr RootDirectory, ObjectName;
        internal uint Attributes;
        internal IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock { internal IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTag { internal uint Attributes, ReparseTag; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo { internal ulong VolumeSerialNumber, FileIdLow, FileIdHigh; }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("ntdll.dll", EntryPoint = "NtCreateFile", ExactSpelling = true)]
    private static extern int NtCreateFile(out SafeFileHandle handle, uint access,
        ref ObjectAttributes attributes, out IoStatusBlock status, IntPtr allocation,
        uint fileAttributes, uint share, uint disposition, uint options,
        IntPtr ea, uint eaLength);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx",
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,
        int informationClass, out FileAttributeTag information, uint size);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx",
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,
        int informationClass, out FileIdInfo information, uint size);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW",
        CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,
        [Out] char[] path, uint length, uint flags);
}

internal sealed class V3HeldPathException(string reason) : Exception(reason)
{
    internal string Reason { get; } = reason;
}
