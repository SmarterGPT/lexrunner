#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace LexRunner.WindowsCoordinator.Git;

// A selected identity is historical evidence. Only a separately protected
// producer may make it authoritative for the installed coordinator. This
// source component keeps native ancestry handles alive while Git runs; it
// cannot prove the future service token or the caller's expected values.
internal sealed record SelectedGitRoot(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("volume_serial_number")] string VolumeSerialNumber,
    [property: JsonPropertyName("file_id")] string FileId,
    [property: JsonPropertyName("filesystem")] string FileSystem);
internal sealed record SelectedGitRoots(
    [property: JsonPropertyName("stage_parent")] SelectedGitRoot StageParent,
    [property: JsonPropertyName("final_parent")] SelectedGitRoot FinalParent,
    [property: JsonPropertyName("mirror")] SelectedGitRoot Mirror,
    [property: JsonPropertyName("registration_parent")] SelectedGitRoot RegistrationParent);

internal sealed class HeldSelectedGitRoots : IDisposable
{
    private readonly DirectoryChain stageParent;
    private readonly DirectoryChain finalParent;
    private readonly DirectoryChain mirror;
    private readonly DirectoryChain registrationParent;
    private readonly SelectedGitRoots selected;
    private bool closed;

    private HeldSelectedGitRoots(SelectedGitRoots selected, DirectoryChain stageParent,
        DirectoryChain finalParent, DirectoryChain mirror,
        DirectoryChain registrationParent)
    {
        this.selected = selected;
        this.stageParent = stageParent;
        this.finalParent = finalParent;
        this.mirror = mirror;
        this.registrationParent = registrationParent;
    }

    internal static HeldSelectedGitRoots Acquire(SelectedGitRoots selected)
    {
        ValidateTopology(selected);
        DirectoryChain? stage = null, final = null, mirror = null, registration = null;
        try
        {
            stage = DirectoryChain.Open(selected.StageParent.Path);
            stage.Require(selected.StageParent);
            final = DirectoryChain.Open(selected.FinalParent.Path);
            final.Require(selected.FinalParent);
            mirror = DirectoryChain.Open(selected.Mirror.Path);
            mirror.Require(selected.Mirror);
            registration = DirectoryChain.Open(selected.RegistrationParent.Path);
            registration.Require(selected.RegistrationParent);
            var held = new HeldSelectedGitRoots(selected, stage, final, mirror, registration);
            held.AssertCurrent();
            return held;
        }
        catch
        {
            registration?.Dispose(); mirror?.Dispose(); final?.Dispose(); stage?.Dispose();
            throw;
        }
    }

    internal void AssertCurrent()
    {
        if (closed) throw new ObjectDisposedException(nameof(HeldSelectedGitRoots));
        stageParent.Require(selected.StageParent);
        finalParent.Require(selected.FinalParent);
        mirror.Require(selected.Mirror);
        registrationParent.Require(selected.RegistrationParent);
    }

    internal string StagePath(string component)
    {
        AssertCurrent();
        ValidateComponent(component);
        return System.IO.Path.Combine(selected.StageParent.Path, component);
    }

    internal string FinalPath(string component)
    {
        AssertCurrent();
        ValidateComponent(component);
        return System.IO.Path.Combine(selected.FinalParent.Path, component);
    }

    // Read-only recovery never promotes a newly observed child to the selected
    // identity. A missing or changed child remains an uncertain effect.
    internal SelectedGitRoot? ObserveStage(string component) =>
        Observe(stageParent, component);
    internal SelectedGitRoot? ObserveFinal(string component) =>
        Observe(finalParent, component);

    private SelectedGitRoot? Observe(DirectoryChain parent, string component)
    {
        AssertCurrent();
        ValidateComponent(component);
        using var child = parent.OpenOptionalChild(component);
        var observed = child?.Capture();
        AssertCurrent();
        return observed;
    }

    public void Dispose()
    {
        if (closed) return;
        closed = true;
        var uncertain = false;
        try { registrationParent.Dispose(); } catch { uncertain = true; }
        try { mirror.Dispose(); } catch { uncertain = true; }
        try { finalParent.Dispose(); } catch { uncertain = true; }
        try { stageParent.Dispose(); } catch { uncertain = true; }
        if (uncertain) throw new IOException("selected_git_root_release_uncertain");
    }

    private static void ValidateTopology(SelectedGitRoots value)
    {
        if (value is null || value.StageParent is null ||
            value.FinalParent is null || value.Mirror is null ||
            value.RegistrationParent is null)
            throw new InvalidDataException("selected_git_roots_missing");
        foreach (var root in new[] { value.StageParent, value.FinalParent,
                     value.Mirror, value.RegistrationParent })
        {
            DirectoryChain.ValidatePath(root.Path);
            if (root.FileId.Length != 32 || !root.FileId.All(IsHex) ||
                root.VolumeSerialNumber.Length != 16 ||
                !root.VolumeSerialNumber.All(IsHex) ||
                root.FileSystem is not ("NTFS" or "ReFS"))
                throw new InvalidDataException("selected_git_root_identity_invalid");
        }
        if (!StringComparer.Ordinal.Equals(value.StageParent.VolumeSerialNumber,
                value.FinalParent.VolumeSerialNumber) ||
            !StringComparer.Ordinal.Equals(value.StageParent.VolumeSerialNumber,
                value.Mirror.VolumeSerialNumber) ||
            !StringComparer.Ordinal.Equals(value.StageParent.VolumeSerialNumber,
                value.RegistrationParent.VolumeSerialNumber) ||
            !StringComparer.Ordinal.Equals(value.StageParent.FileSystem,
                value.FinalParent.FileSystem) ||
            !StringComparer.Ordinal.Equals(value.StageParent.FileSystem,
                value.Mirror.FileSystem) ||
            !StringComparer.Ordinal.Equals(value.StageParent.FileSystem,
                value.RegistrationParent.FileSystem) ||
            StringComparer.OrdinalIgnoreCase.Equals(value.StageParent.Path, value.FinalParent.Path) ||
            value.StageParent.FileId == value.FinalParent.FileId ||
            !StringComparer.OrdinalIgnoreCase.Equals(
                System.IO.Path.GetDirectoryName(value.Mirror.Path), value.StageParent.Path) ||
            !StringComparer.OrdinalIgnoreCase.Equals(value.RegistrationParent.Path,
                System.IO.Path.Combine(value.Mirror.Path, "worktrees")))
            throw new InvalidDataException("selected_git_root_topology_invalid");
    }

    private static bool IsHex(char c) => c is >= '0' and <= '9' or >= 'a' and <= 'f';

    private static void ValidateComponent(string value)
    {
        if (value.Length is < 1 or > 80 || value is "." or ".." ||
            !char.IsAsciiLetterOrDigit(value[0]) ||
            value.EndsWith('.') || value.EndsWith(' ') ||
            value.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-')))
            throw new InvalidDataException("selected_git_component_invalid");
        var stem = value.Split('.')[0].ToUpperInvariant();
        if (stem is "CON" or "PRN" or "AUX" or "NUL" ||
            (stem.Length == 4 &&
                (stem.StartsWith("COM", StringComparison.Ordinal) ||
                 stem.StartsWith("LPT", StringComparison.Ordinal)) &&
                stem[3] is >= '1' and <= '9'))
            throw new InvalidDataException("selected_git_device_component_invalid");
    }

    private sealed class DirectoryChain : IDisposable
    {
        private const uint Access = 0x00100081; // SYNCHRONIZE | LIST_DIRECTORY | READ_ATTRIBUTES
        private const uint ShareReadWrite = 3; // omit FILE_SHARE_DELETE
        private readonly List<(DirectoryHandle Handle, SelectedGitRoot Identity)> chain = [];
        private bool closed;
        private DirectoryChain() { }

        internal static void ValidatePath(string path)
        {
            if (path.Length is < 3 or > 1024 || path[0] is < 'A' or > 'Z' ||
                path[1] != ':' || path[2] != '\\' || path.Contains('/') ||
                path.Contains('\0') || (path.Length > 3 && path.EndsWith('\\')) ||
                !StringComparer.Ordinal.Equals(System.IO.Path.GetFullPath(path), path))
                throw new InvalidDataException("selected_git_path_invalid");
            if (path.Length > 3)
            {
                var parts = path[3..].Split('\\');
                if (parts.Length > 32) throw new InvalidDataException("selected_git_path_depth");
                foreach (var part in parts) ValidateComponent(part);
            }
        }

        internal static DirectoryChain Open(string path)
        {
            ValidatePath(path);
            var result = new DirectoryChain();
            try
            {
                var drive = path[..3];
                var ordinary = OpenWin32(drive);
                try
                {
                    var root = OpenNative(null, @"\GLOBAL??\" + drive);
                    result.Add(root, drive);
                    if (Capture(ordinary, drive) != result.chain[0].Identity)
                        throw new InvalidDataException("selected_git_drive_alias");
                }
                finally
                {
                    ordinary.Dispose();
                    if (ordinary.ReleaseSucceeded != true)
                        throw new IOException("selected_git_drive_probe_release_uncertain");
                }
                var current = drive;
                if (path.Length > 3)
                    foreach (var component in path[3..].Split('\\'))
                    {
                        current = System.IO.Path.Combine(current, component);
                        result.Add(OpenNative(result.chain[^1].Handle, component), current);
                    }
                result.AssertCurrent();
                return result;
            }
            catch { result.Dispose(); throw; }
        }

        internal void Require(SelectedGitRoot expected)
        {
            AssertCurrent();
            if (chain[^1].Identity != expected)
                throw new InvalidDataException("selected_git_root_identity_mismatch");
        }

        internal void AssertCurrent()
        {
            if (closed) throw new ObjectDisposedException(nameof(DirectoryChain));
            foreach (var (handle, expected) in chain)
                if (Capture(handle, expected.Path) != expected)
                    throw new InvalidDataException("selected_git_ancestor_changed");
        }

        internal DirectoryChain? OpenOptionalChild(string component)
        {
            ValidateComponent(component);
            AssertCurrent();
            var child = new DirectoryChain();
            try
            {
                // A fresh child observation is never a selected identity.
                var path = System.IO.Path.Combine(chain[^1].Identity.Path, component);
                DirectoryHandle handle;
                try { handle = OpenNative(chain[^1].Handle, component); }
                catch (Win32Exception e) when (e.NativeErrorCode is 2 or 3)
                { child.Dispose(); AssertCurrent(); return null; }
                child.Add(handle, path);
                AssertCurrent();
                return child;
            }
            catch { child.Dispose(); throw; }
        }

        internal SelectedGitRoot Capture()
        {
            AssertCurrent();
            return chain[^1].Identity;
        }

        private void Add(DirectoryHandle handle, string path)
        {
            try { chain.Add((handle, Capture(handle, path))); }
            catch { handle.Dispose(); throw; }
        }

        public void Dispose()
        {
            if (closed) return;
            closed = true;
            var uncertain = false;
            for (var i = chain.Count - 1; i >= 0; i--)
            {
                var handle = chain[i].Handle;
                handle.Dispose();
                if (handle.ReleaseSucceeded != true) uncertain = true;
            }
            if (uncertain) throw new IOException("selected_git_chain_release_uncertain");
        }

        private static SelectedGitRoot Capture(DirectoryHandle handle, string expectedPath)
        {
            var path = new StringBuilder(32768);
            var length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
            if (length == 0 || length >= path.Capacity)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "selected_git_final_path_unavailable");
            if (!StringComparer.OrdinalIgnoreCase.Equals(path.ToString(0, (int)length),
                    @"\\?\" + expectedPath))
                throw new InvalidDataException("selected_git_held_path_mismatch");
            if (!GetFileInformationByHandleEx(handle, 0, out FileBasicInfo basic,
                    (uint)Marshal.SizeOf<FileBasicInfo>()) ||
                !GetFileInformationByHandleEx(handle, 18, out FileIdInfo id,
                    (uint)Marshal.SizeOf<FileIdInfo>()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "selected_git_file_id_unavailable");
            if ((basic.FileAttributes & 0x10) == 0 || (basic.FileAttributes & 0x400) != 0 ||
                (id.FileIdLow == 0 && id.FileIdHigh == 0))
                throw new InvalidDataException("selected_git_directory_or_reparse_invalid");
            var fs = new StringBuilder(32);
            if (!GetVolumeInformationByHandleW(handle, IntPtr.Zero, 0, out _, out _,
                    out _, fs, (uint)fs.Capacity) || fs.ToString() is not ("NTFS" or "ReFS"))
                throw new InvalidDataException("selected_git_filesystem_unavailable");
            // FILE_ID_INFO's 128-bit identifier is stored as its exact 16 bytes,
            // matching the existing Windows removal helper's wire identity.
            var raw = new byte[16];
            BitConverter.GetBytes(id.FileIdLow).CopyTo(raw, 0);
            BitConverter.GetBytes(id.FileIdHigh).CopyTo(raw, 8);
            return new SelectedGitRoot(expectedPath,
                id.VolumeSerialNumber.ToString("x16"),
                Convert.ToHexString(raw).ToLowerInvariant(), fs.ToString());
        }

        private static DirectoryHandle OpenWin32(string path)
        {
            var handle = CreateFileW(path, Access, ShareReadWrite, IntPtr.Zero,
                3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            return handle;
        }

        private static DirectoryHandle OpenNative(DirectoryHandle? parent, string name)
        {
            var text = Marshal.StringToHGlobalUni(name);
            var unicode = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
            var retained = false;
            try
            {
                parent?.DangerousAddRef(ref retained);
                Marshal.StructureToPtr(new UnicodeString {
                    Length = checked((ushort)(name.Length * 2)),
                    MaximumLength = checked((ushort)(name.Length * 2)), Buffer = text
                }, unicode, false);
                var attributes = new ObjectAttributes {
                    Length = Marshal.SizeOf<ObjectAttributes>(),
                    RootDirectory = parent?.DangerousGetHandle() ?? IntPtr.Zero,
                    ObjectName = unicode, Attributes = parent is null ? 0x40u : 0x1040u
                };
                var status = NtCreateFile(out var handle, Access, ref attributes, out _,
                    IntPtr.Zero, 0, ShareReadWrite, 1, 0x200021u, IntPtr.Zero, 0);
                if (status >= 0) return handle;
                handle.Dispose();
                throw new Win32Exception((int)RtlNtStatusToDosError(status));
            }
            finally
            {
                if (retained) parent!.DangerousRelease();
                Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text);
            }
        }

        private sealed class DirectoryHandle : SafeHandleZeroOrMinusOneIsInvalid
        {
            internal DirectoryHandle() : base(true) { }
            internal bool? ReleaseSucceeded { get; private set; }
            protected override bool ReleaseHandle()
            {
                ReleaseSucceeded = CloseHandle(handle);
                return ReleaseSucceeded.Value;
            }
        }
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
        [StructLayout(LayoutKind.Sequential)] private struct UnicodeString
        { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes
        { internal int Length; internal IntPtr RootDirectory, ObjectName; internal uint Attributes;
            internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
        [StructLayout(LayoutKind.Sequential)] private struct IoStatus
        { internal IntPtr Status, Information; }
        [StructLayout(LayoutKind.Sequential)] private struct FileBasicInfo
        { internal long CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
            internal uint FileAttributes, Padding; }
        [StructLayout(LayoutKind.Sequential)] private struct FileIdInfo
        { internal ulong VolumeSerialNumber, FileIdLow, FileIdHigh; }
        [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtCreateFile(
            out DirectoryHandle handle, uint access, ref ObjectAttributes attributes,
            out IoStatus io, IntPtr allocationSize, uint fileAttributes, uint share,
            uint disposition, uint options, IntPtr ea, uint eaLength);
        [DllImport("ntdll.dll", ExactSpelling = true)] private static extern uint RtlNtStatusToDosError(int status);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
            SetLastError = true)] private static extern DirectoryHandle CreateFileW(
            string path, uint access, uint share, IntPtr security, uint disposition,
            uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
            SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(
            DirectoryHandle handle, StringBuilder path, uint capacity, uint flags);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(
            DirectoryHandle handle, int kind, out FileBasicInfo info, uint length);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(
            DirectoryHandle handle, int kind, out FileIdInfo info, uint length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeInformationByHandleW(
            DirectoryHandle handle, IntPtr volumeName, uint volumeNameLength,
            out uint serial, out uint maxComponent, out uint flags,
            StringBuilder fileSystem, uint fileSystemLength);
    }
}
