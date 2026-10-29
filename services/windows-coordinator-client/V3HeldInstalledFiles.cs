using System.Runtime.InteropServices;
using System.Runtime.Versioning;
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
    private bool _disposed;

    private V3HeldInstalledFiles(List<HeldDirectory> directories, string generationPath,
        SafeFileHandle generation, SafeFileHandle service)
    {
        _directories = directories;
        GenerationPath = generationPath;
        _generation = generation;
        _service = service;
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
        if (_disposed) throw new ObjectDisposedException(nameof(V3HeldInstalledFiles));
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
        if (_disposed) throw new ObjectDisposedException(nameof(V3HeldInstalledFiles));
        foreach (var row in _directories)
        {
            var current = Observe(row.Handle, row.Path, true, row.Identity.Volume);
            if (current != row.Identity)
                throw new V3HeldPathException("generation_path_changed");
        }
    }

#if COORDINATOR_CLIENT_FIXTURE_TESTS
    // Read-only access probes. No rename or deletion is dispatched.
    internal (int Generation, int Coordinator) ProbeDeleteAccess()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(V3HeldInstalledFiles));
        return (ProbeDelete(_directories[^3].Handle, Path.GetFileName(GenerationPath), true),
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
        if (_disposed) return;
        _disposed = true;
        for (var index = _directories.Count - 1; index >= 0; index--)
            _directories[index].Handle.Dispose();
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
        var stringPointer = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
        Marshal.StructureToPtr(stringValue, stringPointer, false);
        var parentReferenceAdded = false;
        try
        {
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
            Marshal.FreeHGlobal(stringPointer);
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
