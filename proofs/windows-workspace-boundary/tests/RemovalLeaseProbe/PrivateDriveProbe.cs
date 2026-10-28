using System.Runtime.InteropServices;

// Test-only adversarial namespace, owned by this short-lived process. The
// directory is anonymous and each new link is relative to its handle. Never
// modifies shared/session/global DOS names or calls DefineDosDevice.
internal static class PrivateDriveProbe
{
  internal static void WithAlias(string drive, string target, Action body, bool spoofGlobalRoot = false)
    => WithAliasHandle(drive, target, _ => body(), spoofGlobalRoot);

  internal static void WithAliasHandle(string drive, string target, Action<IntPtr> body, bool spoofGlobalRoot = false)
  {
    var owned = new List<IntPtr>(); var switched = false; var original = IntPtr.Zero;
    try
    {
      original = Named(@"\??", IntPtr.Zero, (ref Attributes attributes) => {
        Check(NtOpenDirectoryObject(out var handle, 3, ref attributes)); return handle;
      }); owned.Add(original);
      var anonymous = new Attributes { Length = Marshal.SizeOf<Attributes>() };
      Check(NtCreateDirectoryObject(out var directory, 0xf000f, ref anonymous)); owned.Add(directory);
      var selected = directory;
      Check(NtSetInformationProcess((IntPtr)(-1), 23, ref selected, (uint)IntPtr.Size)); switched = true;
      owned.Add(Link(directory, "GLOBALROOT", spoofGlobalRoot ? @"\Device\Null" : @"\"));
      owned.Add(Link(directory, drive, @"\GLOBAL??\" + target));
      body(directory);
    }
    finally
    {
      // Restore before releasing any names. Even on process failure all new
      // names disappear with their anonymous directory; other processes never
      // receive this map and no shared namespace cleanup is necessary.
      var restored = 0;
      if (switched) restored = NtSetInformationProcess((IntPtr)(-1), 23, ref original, (uint)IntPtr.Size);
      var closed = true;
      foreach (var handle in owned.AsEnumerable().Reverse()) closed &= CloseHandle(handle);
      Check(restored);
      if (!closed) throw new IOException("Private device-map probe release uncertain");
    }
  }

  internal static void SelectOwnedChild(IntPtr process, IntPtr directory)
  {
    if (process == IntPtr.Zero || process == (IntPtr)(-1) || directory == IntPtr.Zero) throw new InvalidDataException();
    Check(NtSetInformationProcess(process, 23, ref directory, (uint)IntPtr.Size));
  }

  internal static void SelectGlobalChild(IntPtr process)
  {
    var directory = Named(@"\GLOBAL??", IntPtr.Zero, (ref Attributes attributes) => {
      Check(NtOpenDirectoryObject(out var handle, 3, ref attributes)); return handle;
    });
    try { SelectOwnedChild(process, directory); }
    finally { if (!CloseHandle(directory)) throw new IOException("Global map probe handle release uncertain"); }
  }

  private static IntPtr Link(IntPtr directory, string name, string target)
  {
    if (directory == IntPtr.Zero || name.Contains('\\') || name.Contains('/')) throw new InvalidDataException();
    return Named(name, directory, (ref Attributes attributes) => {
      var text = Marshal.StringToHGlobalUni(target);
      try
      {
        var value = new UnicodeString { Length = checked((ushort)(target.Length * 2)),
          MaximumLength = checked((ushort)(target.Length * 2)), Buffer = text };
        Check(NtCreateSymbolicLinkObject(out var handle, 0xf0001, ref attributes, ref value)); return handle;
      }
      finally { Marshal.FreeHGlobal(text); }
    });
  }

  private delegate IntPtr Operation(ref Attributes attributes);
  private static IntPtr Named(string path, IntPtr root, Operation operation)
  {
    var text = Marshal.StringToHGlobalUni(path);
    var name = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
    try
    {
      Marshal.StructureToPtr(new UnicodeString { Length = checked((ushort)(path.Length * 2)),
        MaximumLength = checked((ushort)(path.Length * 2)), Buffer = text }, name, false);
      var attributes = new Attributes { Length = Marshal.SizeOf<Attributes>(), RootDirectory = root,
        ObjectName = name, Flags = 0x40 };
      return operation(ref attributes);
    }
    finally { Marshal.FreeHGlobal(name); Marshal.FreeHGlobal(text); }
  }

  private static void Check(int status)
  { if (status < 0) throw new IOException($"Private device-map probe status 0x{status:x8}"); }
  [StructLayout(LayoutKind.Sequential)] private struct UnicodeString
  { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] private struct Attributes
  { internal int Length; internal IntPtr RootDirectory, ObjectName; internal uint Flags; internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtOpenDirectoryObject(out IntPtr handle, uint access, ref Attributes attributes);
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtCreateDirectoryObject(out IntPtr handle, uint access, ref Attributes attributes);
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtCreateSymbolicLinkObject(out IntPtr handle, uint access, ref Attributes attributes, ref UnicodeString target);
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtSetInformationProcess(IntPtr process, int kind, ref IntPtr data, uint length);
  [DllImport("kernel32.dll", ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
