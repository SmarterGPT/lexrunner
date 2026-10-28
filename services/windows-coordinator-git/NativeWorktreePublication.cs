#if GIT_IMPORT_FIXTURE
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LexRunner.WindowsCoordinator.Git;

// Source-only held-handle rename control. The caller-supplied paths do not
// establish protected parent custody; no publication here authorizes a worker.
internal sealed record NativeMoveObservation(string NtStatus, int Win32Code,
    bool MoveAttempted, bool Moved, string SourceBefore, string SourceAfter,
    string SourceParentPathBefore, string FinalParentPathBefore,
    string SourceIdentityBefore, string SourceIdentityAfter,
    string SourceParentIdentityBefore, string SourceParentIdentityAfter,
    string FinalParentIdentityBefore, string FinalParentIdentityAfter,
    string? FinalFreshIdentity, string? SourceIdentityAfterRepair,
    string? SourceParentIdentityAfterRepair, string? FinalParentIdentityAfterRepair,
    string? FinalFreshIdentityAfterRepair);

internal static class NativeWorktreePublication
{
    private const uint OpenExisting = 3;
    private const uint OpenReparsePointAndBackupSemantics = 0x02200000;
    private const uint Delete = 0x00010000;
    private const uint ReadAttributes = 0x00000080;
    private const uint ListDirectory = 0x00000001;
    private const uint AddSubdirectory = 0x00000004;
    private const uint Synchronize = 0x00100000;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const int FileBasicInfoClass = 0;
    private const int FileIdInfoClass = 18;
    private const int FileRenameInformation = 10;

    internal static async Task<NativeMoveObservation> RenameNoReplaceHeldAsync(string source,
        string finalParent, string childName, Func<NativeMoveObservation, Task> onMoved,
        CancellationToken token)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
            throw new InvalidOperationException("native_windows_x64_required");
        if (childName.Length is < 1 or > 80 || childName is "." or ".." ||
            childName.IndexOfAny(['\\', '/', ':', '\0']) >= 0)
            throw new InvalidOperationException("final_child_invalid");
        var sourceParentPath = Path.GetDirectoryName(source) ??
            throw new InvalidOperationException("source_parent_unavailable");
        using var sourceParent = Open(sourceParentPath,
            ListDirectory | ReadAttributes | Synchronize);
        using var destinationParent = Open(finalParent,
            ListDirectory | AddSubdirectory | ReadAttributes | Synchronize);
        using var stage = Open(source, Delete | ReadAttributes | Synchronize);
        var sourceParentBefore = ReadIdentity(sourceParent);
        var finalParentBefore = ReadIdentity(destinationParent);
        var sourceBefore = ReadIdentity(stage);
        RequireDirectory(sourceParentBefore, "source_parent");
        RequireDirectory(finalParentBefore, "final_parent");
        RequireDirectory(sourceBefore, "stage");
        var sourceParentBeforePath = FinalPath(sourceParent);
        var finalParentBeforePath = FinalPath(destinationParent);
        var beforePath = FinalPath(stage);
        RequireHeldPath(sourceParentBeforePath, sourceParentPath, "source_parent");
        RequireHeldPath(finalParentBeforePath, finalParent, "final_parent");
        RequireHeldPath(beforePath, source, "stage");
        if (sourceBefore.VolumeSerial != finalParentBefore.VolumeSerial ||
            sourceBefore.VolumeSerial != sourceParentBefore.VolumeSerial)
            throw new InvalidOperationException("wrong_volume_before_move");
        token.ThrowIfCancellationRequested();
        var nameBytes = Encoding.Unicode.GetBytes(childName);
        var buffer = Marshal.AllocHGlobal(20 + nameBytes.Length);
        try
        {
            Marshal.Copy(new byte[20 + nameBytes.Length], 0, buffer, 20 + nameBytes.Length);
            Marshal.WriteInt32(buffer, 0, 0); // ReplaceIfExists = FALSE.
            Marshal.WriteIntPtr(buffer, 8, destinationParent.DangerousGetHandle());
            Marshal.WriteInt32(buffer, 16, nameBytes.Length);
            Marshal.Copy(nameBytes, 0, IntPtr.Add(buffer, 20), nameBytes.Length);
            var status = NtSetInformationFile(stage, out _, buffer,
                (uint)(20 + nameBytes.Length), FileRenameInformation);
            var code = status >= 0 ? 0 : checked((int)RtlNtStatusToDosError(status));
            var sourceAfter = ReadIdentity(stage);
            var sourceParentAfter = ReadIdentity(sourceParent);
            var finalParentAfter = ReadIdentity(destinationParent);
            var afterPath = FinalPath(stage);
            string? fresh = null;
            if (status >= 0)
            {
                using var finalChild = Open(Path.Combine(finalParent, childName),
                    ReadAttributes | Synchronize);
                var finalIdentity = ReadIdentity(finalChild);
                RequireDirectory(finalIdentity, "final_child");
                fresh = finalIdentity.Text;
            }
            var observed = new NativeMoveObservation($"0x{unchecked((uint)status):x8}", code,
                true, status >= 0, beforePath, afterPath,
                sourceParentBeforePath, finalParentBeforePath, sourceBefore.Text,
                sourceAfter.Text, sourceParentBefore.Text, sourceParentAfter.Text,
                finalParentBefore.Text, finalParentAfter.Text, fresh,
                null, null, null, null);
            if (status < 0) return observed;
            // Retain the moved directory and both parent handles with no
            // FILE_SHARE_DELETE through fixed repair and readback. This closes
            // the demonstrated final-name swap interval in this process, but
            // does not protect writable child bytes or installed custody.
            await onMoved(observed);
            var stageAfterRepair = ReadIdentity(stage);
            var sourceParentAfterRepair = ReadIdentity(sourceParent);
            var finalParentAfterRepair = ReadIdentity(destinationParent);
            RequireHeldPath(FinalPath(stage), Path.Combine(finalParent, childName),
                "stage_after_repair");
            RequireHeldPath(FinalPath(sourceParent), sourceParentPath,
                "source_parent_after_repair");
            RequireHeldPath(FinalPath(destinationParent), finalParent,
                "final_parent_after_repair");
            using var finalAfterRepair = Open(Path.Combine(finalParent, childName),
                ReadAttributes | Synchronize);
            var freshAfterRepair = ReadIdentity(finalAfterRepair);
            RequireDirectory(freshAfterRepair, "final_after_repair");
            return observed with {
                SourceIdentityAfterRepair = stageAfterRepair.Text,
                SourceParentIdentityAfterRepair = sourceParentAfterRepair.Text,
                FinalParentIdentityAfterRepair = finalParentAfterRepair.Text,
                FinalFreshIdentityAfterRepair = freshAfterRepair.Text
            };
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void RequireDirectory(Identity value, string label)
    {
        if ((value.Attributes & FileAttributeDirectory) == 0 ||
            (value.Attributes & FileAttributeReparsePoint) != 0 ||
            (value.FileIdLow == 0 && value.FileIdHigh == 0))
            throw new InvalidOperationException(label + "_identity_or_reparse_unavailable");
    }

    private static void RequireHeldPath(string actual, string expected, string label)
    {
        if (!Path.IsPathFullyQualified(expected) ||
            !StringComparer.Ordinal.Equals(Path.GetFullPath(expected), expected) ||
            !actual.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            !StringComparer.OrdinalIgnoreCase.Equals(actual[4..], expected))
            throw new InvalidOperationException(label + "_held_path_mismatch");
    }

    private static SafeFileHandle Open(string path, uint access)
    {
        var handle = CreateFileW(path, access, 3, IntPtr.Zero, OpenExisting,
            OpenReparsePointAndBackupSemantics, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        return handle;
    }

    private static Identity ReadIdentity(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandleEx(handle, FileBasicInfoClass, out FileBasicInfo basic,
                (uint)Marshal.SizeOf<FileBasicInfo>()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "basic_info_unavailable");
        if (!GetFileInformationByHandleEx(handle, FileIdInfoClass, out FileIdInfo fileId,
                (uint)Marshal.SizeOf<FileIdInfo>()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "file_id_info_unavailable");
        return new Identity(fileId.VolumeSerialNumber, fileId.FileIdLow,
            fileId.FileIdHigh, basic.FileAttributes,
            $"0x{fileId.VolumeSerialNumber:x16}:{fileId.FileIdHigh:x16}{fileId.FileIdLow:x16}");
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return buffer.ToString(0, checked((int)length));
    }

    private sealed record Identity(ulong VolumeSerial, ulong FileIdLow,
        ulong FileIdHigh,
        uint Attributes, string Text);

    [StructLayout(LayoutKind.Sequential)] private struct FileBasicInfo
    {
        internal long CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
        internal uint FileAttributes, Padding;
    }

    [StructLayout(LayoutKind.Sequential)] private struct FileIdInfo
    { internal ulong VolumeSerialNumber, FileIdLow, FileIdHigh; }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        internal IntPtr Status;
        internal IntPtr Information;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access,
        uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int informationClass, out FileBasicInfo info, uint size);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int informationClass, out FileIdInfo info, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
        StringBuilder path, uint capacity, uint flags);

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtSetInformationFile(SafeFileHandle handle,
        out IoStatusBlock io, IntPtr information, uint size, int informationClass);

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern uint RtlNtStatusToDosError(int status);
}
#endif
