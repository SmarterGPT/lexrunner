using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

// Bounded development lease. Native facts only; not a serialized authority token.
internal sealed class DirectoryLease : IDisposable
{
  internal sealed record Identity(string Path, string Volume, string FileId, string FileSystem);
  private readonly List<DirectoryHandle> handles = [];
  private readonly List<Identity> identities = [];
  internal IReadOnlyList<Identity> Identities => identities;
  internal Identity Leaf => identities[^1];
  private bool closed;

  internal static DirectoryLease Acquire(string path)
  {
    if (path.Length is < 3 or > 1024 || !char.IsAsciiLetter(path[0]) ||
        path[1] != ':' || path[2] != '\\' || path.Contains('/') || path.Contains('\0'))
      throw new InvalidDataException();
    var tail = path.Length == 3 ? Array.Empty<string>() : path[3..].Split('\\');
    if (tail.Length > 32 || tail.Any(p => p.Length == 0 || p is "." or ".." ||
        p.EndsWith(' ') || p.EndsWith('.') || p.Any(c => c < 32 || "<>:\"|?*".Contains(c))))
      throw new InvalidDataException();
    var lease = new DirectoryLease();
    try
    {
      var current = path[..3];
      lease.Open(current);
      foreach (var component in tail)
      {
        current = System.IO.Path.Combine(current, component);
        lease.Open(current);
      }
      return lease;
    }
    catch { lease.Dispose(); throw; }
  }

  private void Open(string path)
  {
    // LIST_DIRECTORY | READ_ATTRIBUTES, share read/write but not delete.
    var handle = CreateFileW(path, 0x81, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    handles.Add(handle);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
    var identity = Capture(handle);
    if (!string.Equals(identity.Path, path, StringComparison.OrdinalIgnoreCase))
      throw new InvalidDataException();
    identities.Add(identity);
  }

  internal void AssertCurrent()
  {
    if (closed) throw new InvalidDataException();
    for (var i = 0; i < handles.Count; i++)
      if (Capture(handles[i]) != identities[i]) throw new InvalidDataException();
  }

  internal DirectoryLease? OpenChild(string component, bool allowMissing, bool create)
  {
    ValidateComponent(component);
    AssertCurrent();
    var path = System.IO.Path.Combine(Leaf.Path, component);
    // Validate the complete profile before a potentially effectful creation.
    if (path.Length > 1024 || identities.Count >= 33) throw new InvalidDataException();
    if (create && !CreateDirectoryW(path, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    DirectoryLease? child = null;
    try
    {
      try { child = Acquire(path); }
      catch (Win32Exception error) when (allowMissing && error.NativeErrorCode is 2 or 3)
      {
        AssertCurrent();
        return null;
      }
      AssertCurrent();
      if (child.identities.Count != identities.Count + 1 ||
          !child.identities.Take(identities.Count).SequenceEqual(identities)) throw new InvalidDataException();
      return child;
    }
    catch { child?.Dispose(); throw; }
  }

  private static void ValidateComponent(string component)
  {
    if (component.Length is 0 or > 255 || component is "." or ".." ||
        component.EndsWith(' ') || component.EndsWith('.') ||
        component.Any(c => c < 32 || "<>:\"/\\|?*".Contains(c))) throw new InvalidDataException();
  }

  internal sealed record FileObservation(Identity Identity, byte[] Content);

  internal FileObservation ReadBoundedFile(string component, int maximum)
  {
    ValidateComponent(component);
    if (maximum is < 0 or > 1024) throw new InvalidDataException();
    AssertCurrent();
    var path = System.IO.Path.Combine(Leaf.Path, component);
    if (path.Length > 1024) throw new InvalidDataException();
    // Synchronous read, no reparse following, read sharing only (no write/delete).
    var file = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    try
    {
      if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (GetFileType(file) != 1) throw new InvalidDataException();
      var before = Capture(file, false);
      if (!string.Equals(before.Path, path, StringComparison.OrdinalIgnoreCase) ||
          before.Volume != Leaf.Volume || before.FileSystem != Leaf.FileSystem) throw new InvalidDataException();
      if (!GetFileSizeEx(file, out var size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (size < 0 || size > maximum) throw new InvalidDataException();
      var buffer = new byte[maximum + 1];
      using var content = new MemoryStream();
      while (true)
      {
        if (!ReadFile(file, buffer, (uint)buffer.Length, out var read, IntPtr.Zero))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        if (read == 0) break;
        if (content.Length + read > maximum) throw new InvalidDataException();
        content.Write(buffer, 0, (int)read);
      }
      if (content.Length != size || !GetFileSizeEx(file, out var afterSize) || afterSize != size ||
          Capture(file, false) != before) throw new InvalidDataException();
      AssertCurrent();
      return new FileObservation(before, content.ToArray());
    }
    finally
    {
      var valid = !file.IsInvalid;
      file.Dispose();
      if (valid && file.ReleaseSucceeded != true) throw new IOException("Native file release uncertain");
    }
  }

  public void Dispose()
  {
    if (closed) return;
    closed = true;
    var uncertain = false;
    for (var i = handles.Count - 1; i >= 0; i--)
    {
      var handle = handles[i];
      var valid = !handle.IsInvalid;
      handle.Dispose();
      if (valid && handle.ReleaseSucceeded != true) uncertain = true;
    }
    if (uncertain) throw new IOException("Native handle release uncertain");
  }

  private static Identity Capture(DirectoryHandle handle, bool directory = true)
  {
    var tag = new byte[8];
    var id = new byte[24];
    if (!GetFileInformationByHandleEx(handle, 9, tag, 8) ||
        !GetFileInformationByHandleEx(handle, 18, id, 24)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var attributes = BinaryPrimitives.ReadUInt32LittleEndian(tag);
    if (((attributes & 0x10) != 0) != directory || (attributes & 0x400) != 0) throw new InvalidDataException();
    var final = new StringBuilder(2048);
    var length = GetFinalPathNameByHandleW(handle, final, 2048, 0);
    if (length == 0 || length >= 2048) throw new InvalidDataException();
    var path = final.ToString();
    if (!path.StartsWith("\\\\?\\", StringComparison.Ordinal) || path.Length < 7 || path[5] != ':')
      throw new InvalidDataException();
    path = path[4..];
    var fs = new StringBuilder(32);
    if (!GetVolumeInformationByHandleW(handle, null, 0, out _, out _, out _, fs, 32))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (fs.ToString() is not ("NTFS" or "ReFS")) throw new InvalidDataException();
    return new Identity(path, BinaryPrimitives.ReadUInt64LittleEndian(id).ToString("x16"),
        Convert.ToHexString(id.AsSpan(8, 16)).ToLowerInvariant(), fs.ToString());
  }

  internal sealed class DirectoryHandle : SafeHandleZeroOrMinusOneIsInvalid
  {
    public DirectoryHandle() : base(true) { }
    internal bool? ReleaseSucceeded { get; private set; }
    protected override bool ReleaseHandle()
    {
      var result = CloseHandle(handle);
      ReleaseSucceeded = result;
      return result;
    }
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern DirectoryHandle CreateFileW(string path, uint access, uint share, IntPtr security,
      uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandleEx(DirectoryHandle handle, int kind,
      [Out] byte[] data, uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(DirectoryHandle handle, StringBuilder path,
      uint length, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetVolumeInformationByHandleW(DirectoryHandle handle, StringBuilder? name,
      uint nameLength, out uint serial, out uint maximumComponent, out uint flags,
      StringBuilder fileSystem, uint fileSystemLength);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  private static extern uint GetFileType(DirectoryHandle handle);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileSizeEx(DirectoryHandle handle, out long size);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ReadFile(DirectoryHandle handle, [Out] byte[] bytes, uint length,
      out uint read, IntPtr overlapped);
}
