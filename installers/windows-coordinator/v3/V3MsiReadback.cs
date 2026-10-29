using System.Runtime.InteropServices;
using System.Security.Cryptography;

// Extracts the exact cabinet members from the committed MSI database and
// compares their bytes with the supplied v3 graph. No installation is run.
internal static class V3MsiReadback
{
  internal static void Verify(string msi, IReadOnlyList<V3MsiProgram.PayloadFile> files)
  {
    var output = Path.Combine(Path.GetDirectoryName(msi)!, "readback-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(output);
    var cabinet = Path.Combine(output, "payload.cab");
    uint database = 0, view = 0, record = 0;
    try
    {
      Check(MsiOpenDatabaseW(msi, IntPtr.Zero, out database));
      Check(MsiDatabaseOpenViewW(database,
        "SELECT `Data` FROM `_Streams` WHERE `Name`='payload.cab'", out view));
      Check(MsiViewExecute(view, 0));
      Check(MsiViewFetch(view, out record));
      using var stream = File.Open(cabinet, FileMode.CreateNew, FileAccess.Write, FileShare.None);
      var buffer = new byte[65536]; long total = 0;
      while (true)
      {
        uint read = (uint)buffer.Length;
        Check(MsiRecordReadStream(record, 1, buffer, ref read));
        if (read == 0) break;
        total += read;
        if (total > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("V3 cabinet budget");
        stream.Write(buffer, 0, checked((int)read));
      }
      stream.Flush(flushToDisk: true);
    }
    finally
    {
      if (record != 0) Close(record);
      if (view != 0) Close(view);
      if (database != 0) Close(database);
    }

    var expected = files.ToDictionary(file => file.Id, file => file, StringComparer.Ordinal);
    var seen = new HashSet<string>(StringComparer.Ordinal);
    string? failure = null;
    CabinetCallback callback = (context, notification, first, second) =>
    {
      try
      {
        if (notification == 17)
        {
          var name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(first));
          var length = unchecked((uint)Marshal.ReadInt32(first, IntPtr.Size));
          if (name is null || !expected.TryGetValue(name, out var file) ||
              !seen.Add(name) || length != file.Bytes)
            throw new InvalidDataException("Unexpected v3 cabinet member");
          var target = Path.Combine(output, name);
          if (target.Length >= 260 || File.Exists(target))
            throw new InvalidDataException("V3 cabinet target budget");
          var chars = (target + "\0").ToCharArray();
          Marshal.Copy(chars, 0, IntPtr.Add(first, IntPtr.Size + 14), chars.Length);
          return 1;
        }
        if (notification == 18) throw new InvalidDataException("Multiple cabinets unsupported");
        if (notification == 19 && Marshal.ReadInt32(first, IntPtr.Size * 2) != 0)
          throw new IOException("V3 cabinet extraction error");
        return 0;
      }
      catch (Exception error)
      {
        failure = error.Message;
        return notification == 17 ? 0u : 1223u;
      }
    };
    if (!SetupIterateCabinetW(cabinet, 0, callback, IntPtr.Zero) ||
        failure is not null || seen.Count != files.Count)
      throw new InvalidDataException(failure ?? "V3 cabinet extraction failed");
    GC.KeepAlive(callback);
    foreach (var file in files)
    {
      using var stream = File.OpenRead(Path.Combine(output, file.Id));
      if (stream.Length != file.Bytes ||
          Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant() != file.Digest)
        throw new InvalidDataException("V3 embedded payload digest mismatch: " + file.Path);
    }
  }

  private static void Check(uint code)
  { if (code != 0) throw new IOException("V3 MSI readback failed: " + code); }
  private static void Close(uint handle) => Check(MsiCloseHandle(handle));
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiOpenDatabaseW(string path, IntPtr mode, out uint database);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiViewExecute(uint view, uint record);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiViewFetch(uint view, out uint record);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern uint MsiRecordReadStream(uint record, uint field, byte[] buffer, ref uint size);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiCloseHandle(uint handle);
  private delegate uint CabinetCallback(IntPtr context, uint notification, IntPtr first, IntPtr second);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetupIterateCabinetW(string cabinet, uint reserved,
    CabinetCallback callback, IntPtr context);
}
