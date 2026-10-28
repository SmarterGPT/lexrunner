using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// All junctions and canaries belong to this freshly created disposable root.
// Exercise the native primitive at the exact assertion/open race boundary.
internal static class CapabilityIoProbe
{
  internal static void Run(string root, List<string> results)
  {
    void Check(bool value) { if (!value) throw new Exception("Capability I/O assertion failed"); }
    void Test(string name, Action<string> body)
    {
      var path = Path.Combine(root, "capability-" + name);
      Directory.CreateDirectory(path); body(path); results.Add("capability-" + name);
    }
    Test("independent-child-and-exclusive-create", path => {
      var parent = DirectoryLease.Acquire(path);
      var child = parent.OpenChild("child", false, true)!;
      parent.Dispose();
      try
      {
        child.CreateBoundedFile("file", [1, 2, 3]);
        Check((child.ReadBoundedFile("file", 3) ?? throw new InvalidDataException("Expected file observation"))
          .Content.SequenceEqual(new byte[] { 1, 2, 3 }));
        try { child.CreateBoundedFile("file", [9]); throw new Exception("Expected collision"); }
        catch (Win32Exception) { }
        Check((child.ReadBoundedFile("file", 3) ?? throw new InvalidDataException("Expected file observation"))
          .Content.SequenceEqual(new byte[] { 1, 2, 3 }));
        Check(child.OpenChild("missing", true, false) == null);
      }
      finally { child.Dispose(); }
      Directory.Move(path, path + "-released");
    });
    Test("writer-exclusion-and-failed-open-release", path => {
      File.WriteAllText(Path.Combine(path, "file"), "keep");
      using (var lease = DirectoryLease.Acquire(path))
      {
        using (var writer = new FileStream(Path.Combine(path, "file"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
        {
          try { lease.ReadBoundedFile("file", 4); throw new Exception("Expected conflicting writer refusal"); }
          catch (Win32Exception) { }
        }
        Check(Encoding.UTF8.GetString((lease.ReadBoundedFile("file", 4) ??
          throw new InvalidDataException("Expected file observation")).Content) == "keep");
      }
      Directory.Move(path, path + "-released");
    });
    Test("reserved-device-names", path => {
      using var lease = DirectoryLease.Acquire(path);
      foreach (var component in new[] { "CON", "nul.txt", "COM1", "LPT².log", "CONIN$", "CONOUT$", "CON .txt" })
      {
        try { lease.CreateBoundedFile(component, [1]); throw new Exception("Expected DOS device refusal"); }
        catch (InvalidDataException) { }
        try { lease.OpenChild(component, false, true); throw new Exception("Expected DOS directory refusal"); }
        catch (InvalidDataException) { }
      }
      Check(!Directory.EnumerateFileSystemEntries(path).Any());
    });
    Test("process-private-drive-alias", path => {
      var outside = path + "-alias"; Directory.CreateDirectory(outside);
      File.WriteAllText(Path.Combine(outside, "device-map-canary"), "alias");
      using var lease = DirectoryLease.Acquire(path);
      PrivateDriveProbe.WithAlias(path[..2], outside, () => {
        Check(File.ReadAllText(path[..2] + @"\device-map-canary") == "alias");
        try { using var refused = DirectoryLease.Acquire(path[..3]); throw new Exception("Expected DOS alias refusal"); }
        catch (InvalidDataException) { }
        lease.CreateBoundedFile("retained-file", [4, 5]);
        Check((lease.ReadBoundedFile("retained-file", 2) ??
          throw new InvalidDataException("Expected file observation")).Content.SequenceEqual(new byte[] { 4, 5 }));
        using var child = lease.OpenChild("retained-child", false, true)!;
      });
      Check(File.Exists(Path.Combine(path, "retained-file")) && Directory.Exists(Path.Combine(path, "retained-child")));
      Check(Directory.EnumerateFileSystemEntries(outside).Count() == 1);
    });
    Test("process-private-globalroot-spoof", path => {
      PrivateDriveProbe.WithAlias(path[..2], path[..3], () => {
        // The ordinary drive is correct, but the Win32 GLOBALROOT alias is
        // adversarial. Acquisition must use the absolute native OS namespace.
        Check(!Directory.Exists(@"\\.\GLOBALROOT\GLOBAL??\" + path));
        using var lease = DirectoryLease.Acquire(path);
        lease.CreateBoundedFile("native-root-file", [6]);
        Check((lease.ReadBoundedFile("native-root-file", 1) ??
          throw new InvalidDataException("Expected file observation")).Content.SequenceEqual(new byte[] { 6 }));
      }, spoofGlobalRoot: true);
      Check(File.ReadAllBytes(Path.Combine(path, "native-root-file")).SequenceEqual(new byte[] { 6 }));
    });
    Test("nonempty-directory-reparse-refusal", path => {
      var anchor = Path.Combine(path, "anchor");
      var outside = Path.Combine(path, "outside");
      Directory.CreateDirectory(anchor); Directory.CreateDirectory(outside);
      File.WriteAllText(Path.Combine(anchor, "keep"), "original");
      File.WriteAllText(Path.Combine(outside, "keep"), "outside");
      var attached = false;
      try { SetJunction(anchor, outside); attached = true; }
      catch (Win32Exception error) when (error.NativeErrorCode == 145) { }
      finally { if (attached) RemoveJunctionTag(anchor); }
      Check(!attached && File.ReadAllText(Path.Combine(anchor, "keep")) == "original" &&
        File.ReadAllText(Path.Combine(outside, "keep")) == "outside");
    });
    foreach (var operation in new[] { "directory", "create-file", "read-file" })
      Test("reparse-race-" + operation, path => {
        var outside = path + "-outside"; Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, "canary"), "preserve");
        using (var lease = DirectoryLease.Acquire(path))
        {
          lease.AssertCurrent();
          SetJunction(path, outside);
          try
          {
            // Paired weakened control: ordinary pathname lookup follows the
            // newly attached junction despite the still-open exclusion lease.
            File.WriteAllText(Path.Combine(path, "weak-control"), "redirected");
            Check(File.ReadAllText(Path.Combine(outside, "weak-control")) == "redirected");
            try
            {
              using var opened = operation == "directory"
                ? NativeRelativeFiles.OpenCapabilityDirectory(lease.LeafHandle, "relative-child", true)
                : NativeRelativeFiles.OpenCapabilityFile(lease.LeafHandle,
                    operation == "read-file" ? "canary" : "relative-file", operation != "read-file");
              if (operation == "read-file")
                throw new Exception("Relative read reached a file absent from the retained directory");
            }
            catch (Win32Exception) { /* A refusal also preserves the boundary. */ }
            Check(!File.Exists(Path.Combine(outside, "relative-file")) &&
              !Directory.Exists(Path.Combine(outside, "relative-child")) &&
              File.ReadAllText(Path.Combine(outside, "canary")) == "preserve");
            try { lease.AssertCurrent(); throw new Exception("Expected changed reparse state refusal"); }
            catch (InvalidDataException) { }
          }
          finally { RemoveJunctionTag(path); }
          lease.AssertCurrent();
        }
        Directory.Move(path, path + "-released");
      });
  }

  private static void SetJunction(string path, string target)
  {
    var substitute = Encoding.Unicode.GetBytes(@"\??\" + target);
    var print = Encoding.Unicode.GetBytes(target);
    var buffer = new byte[16 + substitute.Length + 2 + print.Length + 2];
    BinaryPrimitives.WriteUInt32LittleEndian(buffer, 0xa0000003);
    BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(4), checked((ushort)(buffer.Length - 8)));
    BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(10), checked((ushort)substitute.Length));
    BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(12), checked((ushort)(substitute.Length + 2)));
    BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(14), checked((ushort)print.Length));
    substitute.CopyTo(buffer, 16); print.CopyTo(buffer, 18 + substitute.Length);
    Control(path, 0x900a4, buffer);
  }

  private static void RemoveJunctionTag(string path)
  {
    var buffer = new byte[8]; BinaryPrimitives.WriteUInt32LittleEndian(buffer, 0xa0000003);
    Control(path, 0x900ac, buffer);
  }

  private static void Control(string path, uint operation, byte[] data)
  {
    var handle = CreateFileW(path, 0x40000000, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    try
    {
      if (handle.IsInvalid || !DeviceIoControl(handle, operation, data, (uint)data.Length,
          IntPtr.Zero, 0, out _, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    finally
    {
      var valid = !handle.IsInvalid; handle.Dispose();
      if (valid && handle.ReleaseSucceeded != true) throw new IOException("Probe release uncertain");
    }
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern DirectoryLease.DirectoryHandle CreateFileW(string path, uint access, uint share,
      IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool DeviceIoControl(SafeHandle handle, uint code, byte[] input, uint inputLength,
      IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
}
