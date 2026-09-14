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

  private static Identity Capture(DirectoryHandle handle)
  {
    var tag = new byte[8];
    var id = new byte[24];
    if (!GetFileInformationByHandleEx(handle, 9, tag, 8) ||
        !GetFileInformationByHandleEx(handle, 18, id, 24)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var attributes = BinaryPrimitives.ReadUInt32LittleEndian(tag);
    if ((attributes & 0x10) == 0 || (attributes & 0x400) != 0) throw new InvalidDataException();
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
}
