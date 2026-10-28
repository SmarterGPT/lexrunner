using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LexRunner.WindowsCoordinator.Git;

// Held identity/owner/DACL observations on the fixture's four critical
// objects. This is not protected ancestry or a service-token access proof.
internal sealed class HeldCheckout : IDisposable
{
    private readonly HeldEntity[] entities;
    internal string StageIdentity => entities[2].Identity;

    private HeldCheckout(HeldEntity[] entities) { this.entities = entities; }

    internal static HeldCheckout Open(string root, string mirror, string stage)
    {
        var held = new List<HeldEntity>();
        try
        {
            held.Add(HeldEntity.Open(root, directory: true));
            held.Add(HeldEntity.Open(mirror, directory: true));
            held.Add(HeldEntity.Open(stage, directory: true));
            held.Add(HeldEntity.Open(Path.Combine(stage, ".git"), directory: false));
            return new HeldCheckout(held.ToArray());
        }
        catch
        {
            foreach (var entity in held) entity.Dispose();
            throw;
        }
    }

    internal static HeldFile OpenFile(string path) => new(path);

    internal void AssertUnchanged()
    {
        foreach (var entity in entities) entity.AssertUnchanged();
    }

    public void Dispose()
    {
        for (var index = entities.Length - 1; index >= 0; index--)
            entities[index].Dispose();
    }
}

internal sealed class HeldFile : IDisposable
{
    private readonly HeldEntity entity;
    private readonly FileStream stream;
    internal string Identity => entity.Identity;
    internal string OwnerAndDacl => entity.OwnerAndDacl;

    internal HeldFile(string path)
    {
        entity = HeldEntity.Open(path, directory: false, readData: true);
        try { stream = new FileStream(entity.Handle, FileAccess.Read); }
        catch { entity.Dispose(); throw; }
    }

    internal byte[] ReadBounded(int maxBytes)
    {
        entity.AssertUnchanged();
        if (stream.Length < 1 || stream.Length > MaxFileBytes(maxBytes))
            throw new InvalidDataException("checkout_output_file_size_invalid");
        var bytes = new byte[checked((int)stream.Length)];
        stream.Position = 0;
        stream.ReadExactly(bytes);
        if (stream.Length != bytes.Length)
            throw new InvalidDataException("checkout_output_file_size_changed");
        entity.AssertUnchanged();
        return bytes;
    }

    private static int MaxFileBytes(int value) => value is < 1 or > 8192
        ? throw new ArgumentOutOfRangeException(nameof(value)) : value;

    public void Dispose() { stream.Dispose(); entity.Dispose(); }
}

internal sealed class HeldEntity : IDisposable
{
    private const uint ReadData = 0x0001;
    private const uint ReadAttributes = 0x0080;
    private const uint ReadControl = 0x00020000;
    private const uint Synchronize = 0x00100000;
    private const uint ShareRead = 0x1;
    private const uint ShareWrite = 0x2;
    private const uint OpenExisting = 3;
    private const uint OpenReparseAndBackup = 0x02200000;
    private const uint DirectoryAttribute = 0x10;
    private const uint ReparseAttribute = 0x400;
    private const uint OwnerInfo = 0x1;
    private const uint DaclInfo = 0x4;
    private const int FileBasicInfoClass = 0;
    private const int FileIdInfoClass = 18;
    private const int SeFileObject = 1;

    private readonly string expectedPath;
    private readonly bool directory;
    private readonly Snapshot before;
    internal SafeFileHandle Handle { get; }
    internal string Identity => before.Identity;
    internal string OwnerAndDacl => before.OwnerAndDacl;

    private HeldEntity(string path, bool directory, SafeFileHandle handle)
    {
        expectedPath = path;
        this.directory = directory;
        Handle = handle;
        before = Observe(handle, path, directory);
    }

    internal static HeldEntity Open(string path, bool directory, bool readData = false)
    {
        if (!Path.IsPathFullyQualified(path) ||
            !StringComparer.Ordinal.Equals(Path.GetFullPath(path), path))
            throw new InvalidDataException("checkout_held_path_not_canonical");
        var access = ReadAttributes | ReadControl | Synchronize | (readData ? ReadData : 0);
        var share = directory ? ShareRead | ShareWrite : ShareRead;
        var handle = CreateFileW(path, access, share, IntPtr.Zero, OpenExisting,
            OpenReparseAndBackup, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            var code = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(code, "checkout_held_open_failed");
        }
        try { return new HeldEntity(path, directory, handle); }
        catch { handle.Dispose(); throw; }
    }

    internal void AssertUnchanged()
    {
        var after = Observe(Handle, expectedPath, directory);
        if (before != after) throw new IOException("checkout_held_identity_or_acl_changed");
    }

    public void Dispose() => Handle.Dispose();

    private static Snapshot Observe(SafeFileHandle handle, string expected, bool directory)
    {
        if (!GetFileInformationByHandleEx(handle, FileBasicInfoClass, out FileBasicInfo basic,
                (uint)Marshal.SizeOf<FileBasicInfo>()) ||
            !GetFileInformationByHandleEx(handle, FileIdInfoClass, out FileIdInfo fileId,
                (uint)Marshal.SizeOf<FileIdInfo>()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "checkout_file_id_unavailable");
        if ((basic.FileAttributes & ReparseAttribute) != 0 ||
            ((basic.FileAttributes & DirectoryAttribute) != 0) != directory ||
            (fileId.FileIdLow == 0 && fileId.FileIdHigh == 0))
            throw new InvalidDataException("checkout_held_kind_or_id_invalid");
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity ||
            !StringComparer.OrdinalIgnoreCase.Equals(buffer.ToString(0, (int)length),
                @"\\?\" + expected))
            throw new InvalidDataException("checkout_held_path_changed_or_aliased");
        var sddl = ReadOwnerAndDacl(handle);
        return new Snapshot($"0x{fileId.VolumeSerialNumber:x16}:{fileId.FileIdHigh:x16}{fileId.FileIdLow:x16}",
            basic.FileAttributes, sddl);
    }

    private static string ReadOwnerAndDacl(SafeFileHandle handle)
    {
        var status = GetSecurityInfo(handle, SeFileObject, OwnerInfo | DaclInfo,
            out _, out _, out _, out _, out var descriptor);
        if (status != 0 || descriptor == IntPtr.Zero)
            throw new Win32Exception(checked((int)status), "checkout_security_info_unavailable");
        try
        {
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1,
                    OwnerInfo | DaclInfo, out var text, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "checkout_sddl_unavailable");
            try
            {
                var sddl = Marshal.PtrToStringUni(text);
                if (string.IsNullOrWhiteSpace(sddl) || !sddl.Contains("D:", StringComparison.Ordinal))
                    throw new InvalidDataException("checkout_owner_or_dacl_missing");
                return sddl;
            }
            finally { LocalFree(text); }
        }
        finally { LocalFree(descriptor); }
    }

    private sealed record Snapshot(string Identity, uint Attributes, string OwnerAndDacl);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileBasicInfo
    {
        internal long CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
        internal uint FileAttributes, Padding;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo
    { internal ulong VolumeSerialNumber, FileIdLow, FileIdHigh; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int informationClass, out FileBasicInfo info, uint size);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int informationClass, out FileIdInfo info, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
        StringBuilder path, uint capacity, uint flags);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType,
        uint securityInformation, out IntPtr owner, out IntPtr group, out IntPtr dacl,
        out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr descriptor, uint revision, uint information, out IntPtr text,
        out uint textLength);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr pointer);
}
