using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Removal preparation and general capability I/O resolve a single component
// against its retained parent object, never against a reconstructed pathname.
internal static class NativeRelativeFiles
{
  internal static IEnumerable<(string Name, bool Directory)> Entries(DirectoryLease.DirectoryHandle parent)
  {
    var buffer = new byte[65536]; var restart = true;
    while (true)
    {
      if (!GetFileInformationByHandleEx(parent, restart ? 15 : 14, buffer, (uint)buffer.Length))
      {
        var error = Marshal.GetLastWin32Error();
        if (error == 18) yield break; // ERROR_NO_MORE_FILES only.
        throw new Win32Exception(error);
      }
      restart = false;
      var offset = 0;
      while (true)
      {
        if (offset < 0 || offset > buffer.Length - 68) throw new InvalidDataException("Directory buffer");
        var next = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(offset));
        var attributes = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(offset + 56));
        var length = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(offset + 60));
        if (length > 510 || (length & 1) != 0 || length > buffer.Length - offset - 68)
          throw new InvalidDataException("Directory name length");
        var name = new UnicodeEncoding(false, false, true).GetString(buffer, offset + 68, (int)length);
        if (name is not ("." or ".."))
        {
          DirectoryLease.ValidateComponent(name);
          if ((attributes & 0x400) != 0) throw new InvalidDataException("Removal reparse point");
          yield return (name, (attributes & 0x10) != 0);
        }
        if (next == 0) break;
        if (next < 68 + length || (next & 7) != 0 || next > buffer.Length - offset - 68)
          throw new InvalidDataException("Directory next offset");
        offset += (int)next;
      }
    }
  }

  internal static DirectoryLease.DirectoryHandle OpenChild(DirectoryLease.DirectoryHandle parent,
      string component, bool directory, bool deletion = false, bool exclusive = false)
  {
    var access = deletion ? (directory ? 0x110081u : 0x110080u) : (directory ? 0x100081u : 0x80100080u);
    var share = exclusive ? 0u : deletion ? (directory ? 3u : 1u) : (directory ? 7u : 5u);
    return Open(parent, component, directory, access, share, 1, 0);
  }

  internal static DirectoryLease.DirectoryHandle OpenCapabilityDirectory(
      DirectoryLease.DirectoryHandle parent, string component, bool create) =>
    Open(parent, component, true, 0x100081, 3, create ? 2u : 1u, create ? 0x10u : 0u);

  internal static DirectoryLease.DirectoryHandle OpenCapabilityFile(
      DirectoryLease.DirectoryHandle parent, string component, bool create) =>
    Open(parent, component, false, create ? 0xc0100080u : 0x80100080u,
      create ? 0u : 1u, create ? 2u : 1u, create ? 0x80u : 0u);

  internal static DirectoryLease.DirectoryHandle OpenGlobalDriveRoot(string drive)
  {
    if (drive.Length != 3 || !char.IsAsciiLetter(drive[0]) || drive[1] != ':' || drive[2] != '\\')
      throw new InvalidDataException();
    // Native absolute object-manager name: never the per-process DOS aliases
    // named GLOBALROOT or GLOBAL??. Only the OS-managed drive link is followed.
    return OpenNative(null, @"\GLOBAL??\" + drive, true, 0x100081, 3, 1, 0);
  }

  private static DirectoryLease.DirectoryHandle Open(DirectoryLease.DirectoryHandle parent,
      string component, bool directory, uint access, uint share, uint disposition, uint fileAttributes)
  {
    DirectoryLease.ValidateComponent(component);
    return OpenNative(parent, component, directory, access, share, disposition, fileAttributes);
  }

  private static DirectoryLease.DirectoryHandle OpenNative(DirectoryLease.DirectoryHandle? parent,
      string component, bool directory, uint access, uint share, uint disposition, uint fileAttributes)
  {
    var text = Marshal.StringToHGlobalUni(component);
    var name = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
    var retained = false;
    try
    {
      parent?.DangerousAddRef(ref retained);
      Marshal.StructureToPtr(new UnicodeString { Length = checked((ushort)(component.Length * 2)),
          MaximumLength = checked((ushort)(component.Length * 2)), Buffer = text }, name, false);
      var attributes = new ObjectAttributes { Length = Marshal.SizeOf<ObjectAttributes>(),
          RootDirectory = parent?.DangerousGetHandle() ?? IntPtr.Zero, ObjectName = name,
          Attributes = parent == null ? 0x40u : 0x1040u };
      var status = NtCreateFile(out var handle, access,
          ref attributes, out _, IntPtr.Zero, fileAttributes, share, disposition,
          0x200020u | (directory ? 1u : 0x40u), IntPtr.Zero, 0);
      if (status >= 0) return handle;
      handle.Dispose(); throw new Win32Exception((int)RtlNtStatusToDosError(status));
    }
    finally
    {
      if (retained) parent!.DangerousRelease();
      Marshal.FreeHGlobal(name); Marshal.FreeHGlobal(text);
    }
  }

  [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes
  { internal int Length; internal IntPtr RootDirectory, ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] private struct IoStatus { internal IntPtr Status, Information; }
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtCreateFile(
      out DirectoryLease.DirectoryHandle handle, uint access, ref ObjectAttributes attributes,
      out IoStatus io, IntPtr allocationSize, uint fileAttributes, uint share, uint disposition,
      uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(
      DirectoryLease.DirectoryHandle handle, int kind, [Out] byte[] data, uint length);
}
