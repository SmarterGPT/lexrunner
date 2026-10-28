using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const string ServiceName = "LexRunnerCoordinator";
    private static readonly Regex Nonce = new(@"\A[a-f0-9]{32}\z", RegexOptions.CultureInvariant);

    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) return 2;
#if COORDINATOR_ROOT_FIXTURE_TESTS
        if (args.Length == 2 && args[0] == "--fixture" && Nonce.IsMatch(args[1]))
        {
            try { return RunFixture(args[1]); }
            catch (Exception error)
            {
                Console.Error.WriteLine("fixture_refused:" + error.Message);
                return 4;
            }
        }
#endif
        // A separately approved installed graph, service identity and root
        // transaction do not exist yet. The normal image has no effect route.
        Console.Error.WriteLine("protected_provisioning_unavailable");
        return 3;
    }

#if COORDINATOR_ROOT_FIXTURE_TESTS
    [SupportedOSPlatform("windows")]
    private static int RunFixture(string nonce)
    {
        var repo = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Environment.CurrentDirectory));
        if (!File.Exists(Path.Combine(repo, "AGENTS.md")) ||
            !File.Exists(Path.Combine(repo, "package.json")))
            throw new InvalidOperationException("fixture_cwd_unavailable");
        var artifactParent = Path.Combine(repo, "artifacts", "windows-coordinator-root-provisioner");
        if (!Directory.Exists(artifactParent) ||
            File.GetAttributes(artifactParent).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException("fixture_parent_unavailable");
        var runRoot = Path.Combine(artifactParent, "run-" + nonce);
        var imageDirectory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(AppContext.BaseDirectory));
        if (!imageDirectory.Equals(Path.Combine(runRoot, "fixture-image"),
                StringComparison.OrdinalIgnoreCase) ||
            !Directory.Exists(runRoot) ||
            File.GetAttributes(runRoot).HasFlag(FileAttributes.ReparsePoint) ||
            File.ReadAllText(Path.Combine(runRoot, ".root-fixture-owner")) !=
                $"root-fixture-v1\n{nonce}\n{repo}\n")
            throw new InvalidOperationException("fixture_run_unavailable");
        var fixture = Path.Combine(runRoot, "fixture");
        var sid = WindowsIdentity.GetCurrent().User?.Value ??
            throw new InvalidOperationException("fixture_sid_unavailable");
        string? serviceSid;
        try
        {
            serviceSid = ((SecurityIdentifier)new NTAccount("NT SERVICE", ServiceName)
                .Translate(typeof(SecurityIdentifier))).Value;
        }
        catch (IdentityNotMappedException) { serviceSid = null; }
        var policy = RootPolicy.ForFixture(sid);
        var rows = new List<RootObservation>();
        var collisionRefused = false;
        using var run = Native.OpenDirectory(runRoot);
        SafeFileHandle parent;
        try { parent = Native.CreateDirectory(run, "fixture", policy); }
        catch (InvalidOperationException error) when (
            error.Message == "create_refused_ntstatus_0xc0000035")
        { throw new IOException("fixture_occupied"); }
        using (parent)
        {
            _ = Native.Observe(parent, fixture, policy);
            var created = new List<SafeFileHandle>();
            try
            {
                foreach (var rootName in new[] { "store", "c-anchor", "d-anchor" })
                {
                    var rootPath = Path.Combine(fixture, rootName);
                    var root = Native.CreateDirectory(parent, rootName, policy);
                    created.Add(root);
                    rows.Add(Native.Observe(root, rootPath, policy));
                    if (rootName == "store")
                    {
                        try
                        {
                            using var duplicate = Native.CreateDirectory(parent, rootName, policy);
                            throw new InvalidOperationException("occupied_root_replaced");
                        }
                        catch (InvalidOperationException error) when (
                            error.Message == "create_refused_ntstatus_0xc0000035")
                        {
                            collisionRefused = true;
                        }
                        if (Native.Observe(root, rootPath, policy).FileId != rows[0].FileId)
                            throw new InvalidOperationException("occupied_root_identity_changed");
                        continue;
                    }
                    foreach (var childName in new[] { "stage", "final" })
                    {
                        var childPath = Path.Combine(rootPath, childName);
                        var child = Native.CreateDirectory(root, childName, policy);
                        created.Add(child);
                        rows.Add(Native.Observe(child, childPath, policy));
                    }
                }
                var receipt = new FixtureReceipt("fixture_created_unqualified", fixture,
                    sid, serviceSid, policy.Sddl, rows.ToArray(), collisionRefused,
                    false, false);
                Console.WriteLine(JsonSerializer.Serialize(receipt, RootJsonContext.Default.FixtureReceipt));
                return 0;
            }
            finally
            {
                for (var i = created.Count - 1; i >= 0; i--) created[i].Dispose();
            }
        }
    }
#endif
}

internal sealed record RootPolicy(string OwnerSid, string Sddl)
{
    // Production must use SYSTEM or the installed service SID as owner, never
    // the approving administrator's ordinary-user SID. This fixture grants
    // its own SID only so checked cleanup needs no installed service.
    internal static RootPolicy ForFixture(string sid) =>
        new(sid, $"O:{sid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{sid})");
}

internal sealed record RootObservation(string Path, string VolumeSerial, string FileId,
    string Attributes, string Sddl, bool Consistent);
internal sealed record FixtureReceipt(string State, string Fixture, string CurrentUserSid,
    string? InstalledServiceSid, string Policy, RootObservation[] Rows,
    bool OccupiedRootRefused, bool AuthorizesProvisioning, bool AuthorizesExecution);
[JsonSerializable(typeof(FixtureReceipt))]
internal partial class RootJsonContext : JsonSerializerContext { }

internal static class Native
{
    private const uint FileReadAttributes = 0x80;
    private const uint FileAddSubdirectory = 0x4;
    private const uint ReadControl = 0x20000;
    private const uint Synchronize = 0x100000;
    private const uint FileShareRead = 0x1;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileDirectoryFile = 0x1;
    private const uint FileOpenReparsePoint = 0x200000;
    private const uint FileSynchronousIoNonalert = 0x20;
    private const uint FileAttributeDirectory = 0x10;
    private const uint ObjCaseInsensitive = 0x40;
    private const uint OwnerSecurityInformation = 0x1;
    private const uint DaclSecurityInformation = 0x4;
    private const uint FileAttributeReparsePoint = 0x400;

    internal static SafeFileHandle OpenDirectory(string path)
    {
        var handle = CreateFileW(path,
            FileReadAttributes | FileAddSubdirectory | ReadControl | Synchronize,
            FileShareRead, IntPtr.Zero, 3,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "parent_open_failed");
        try { _ = ObserveIdentity(handle, path); return handle; }
        catch { handle.Dispose(); throw; }
    }

    internal static SafeFileHandle CreateDirectory(SafeFileHandle parent, string name, RootPolicy policy)
    {
        if (name is not ("fixture" or "store" or "c-anchor" or "d-anchor" or "stage" or "final"))
            throw new ArgumentException("fixed_child_name_required", nameof(name));
        var unicodeBuffer = Marshal.StringToHGlobalUni(name);
        var unicode = new UnicodeString
        {
            Length = checked((ushort)(name.Length * 2)),
            MaximumLength = checked((ushort)((name.Length + 1) * 2)),
            Buffer = unicodeBuffer,
        };
        var unicodePtr = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
        Marshal.StructureToPtr(unicode, unicodePtr, false);
        IntPtr descriptor = IntPtr.Zero;
        try
        {
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(policy.Sddl, 1,
                    out descriptor, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "security_descriptor_invalid");
            var attributes = new ObjectAttributes
            {
                Length = (uint)Marshal.SizeOf<ObjectAttributes>(),
                RootDirectory = parent.DangerousGetHandle(),
                ObjectName = unicodePtr,
                Attributes = ObjCaseInsensitive,
                SecurityDescriptor = descriptor,
            };
            var status = NtCreateFile(out var handle,
                FileReadAttributes | FileAddSubdirectory | ReadControl | Synchronize,
                ref attributes, out _, IntPtr.Zero, FileAttributeDirectory,
                FileShareRead, 2, FileDirectoryFile | FileOpenReparsePoint |
                FileSynchronousIoNonalert, IntPtr.Zero, 0);
            if (status < 0)
            {
                handle.Dispose();
                throw new InvalidOperationException($"create_refused_ntstatus_0x{status:x8}");
            }
            return handle;
        }
        finally
        {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            Marshal.FreeHGlobal(unicodePtr);
            Marshal.FreeHGlobal(unicodeBuffer);
        }
    }

    internal static RootObservation Observe(SafeFileHandle handle, string expectedPath, RootPolicy policy)
    {
        var identity = ObserveIdentity(handle, expectedPath);
        var security = ReadSecurity(handle);
        if (!security.Equals(policy.Sddl, StringComparison.Ordinal))
            throw new InvalidOperationException("created_acl_readback_mismatch");
        return new RootObservation(expectedPath, identity.volumeSerial, identity.fileId,
            identity.attributes, security, true);
    }

    private static (string volumeSerial, string fileId, string attributes) ObserveIdentity(
        SafeFileHandle handle, string expectedPath)
    {
        var actual = GetFinalPath(handle);
        if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual[4..];
        if (!actual.Equals(expectedPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("held_path_mismatch");
        if (!GetFileInformationByHandleEx(handle, 0, out FileBasicInfo basic,
                (uint)Marshal.SizeOf<FileBasicInfo>()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "basic_info_unavailable");
        if ((basic.FileAttributes & FileAttributeReparsePoint) != 0 ||
            (basic.FileAttributes & FileAttributeDirectory) == 0)
            throw new InvalidOperationException("directory_reparse_or_type_mismatch");
        if (!GetFileInformationByHandleEx(handle, 18, out FileIdInfo fileId,
                (uint)Marshal.SizeOf<FileIdInfo>()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "file_id_unavailable");
        if (fileId.FileIdLow == 0 && fileId.FileIdHigh == 0)
            throw new InvalidOperationException("zero_file_id");
        return ($"0x{fileId.VolumeSerialNumber:x16}",
            $"{fileId.FileIdHigh:x16}{fileId.FileIdLow:x16}", $"0x{basic.FileAttributes:x8}");
    }

    private static string GetFinalPath(SafeFileHandle handle)
    {
        var chars = new char[32768];
        var count = GetFinalPathNameByHandleW(handle, chars, (uint)chars.Length, 0);
        if (count == 0 || count >= chars.Length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "final_path_unavailable");
        return new string(chars, 0, (int)count);
    }

    private static string ReadSecurity(SafeFileHandle handle)
    {
        var code = GetSecurityInfo(handle, 1, OwnerSecurityInformation | DaclSecurityInformation,
            out _, out _, out _, out _, out var descriptor);
        if (code != 0) throw new Win32Exception((int)code, "security_readback_failed");
        try
        {
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1,
                    OwnerSecurityInformation | DaclSecurityInformation, out var text, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "security_sddl_unavailable");
            try { return Marshal.PtrToStringUni(text) ?? throw new InvalidOperationException("empty_sddl"); }
            finally { LocalFree(text); }
        }
        finally { LocalFree(descriptor); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString
    { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes
    {
        public uint Length; public IntPtr RootDirectory, ObjectName; public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoStatusBlock
    { public IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)] private struct FileBasicInfo
    {
        public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
        public uint FileAttributes; public uint Padding;
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileIdInfo
    { public ulong VolumeSerialNumber, FileIdLow, FileIdHigh; }

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtCreateFile(out SafeFileHandle handle, uint access,
        ref ObjectAttributes attributes, out IoStatusBlock ioStatus,
        IntPtr allocationSize, uint fileAttributes, uint shareAccess,
        uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
    [DllImport("advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint length);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType,
        uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl,
        out IntPtr sacl, out IntPtr descriptor);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint desiredAccess,
        uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
        [Out] char[] path, uint length, uint flags);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int informationClass, out FileBasicInfo info, uint size);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int informationClass, out FileIdInfo info, uint size);
}
