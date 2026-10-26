using System.Runtime.InteropServices;

// Build-time MSI database access. No MsiInstallProduct/ConfigureProduct/DoAction API.
internal sealed class NativeDatabase : IDisposable
{
  private uint handle;
  private readonly Dictionary<string, string[]> columns = [];
  internal NativeDatabase(string path) => Check(MsiOpenDatabaseW(path, (IntPtr)3, out handle), "create");
  internal void Create(string table, string fields, string keys)
  { Execute($"CREATE TABLE `{table}` ({fields} PRIMARY KEY {keys})"); columns.Add(table, fields.Split(',').Select(s => s.Trim().Split(' ')[0]).ToArray()); }
  internal void Insert(string table, params object?[] values)
  {
    if (values.Length != columns[table].Length) throw new InvalidDataException("MSI row shape");
    var record = MsiCreateRecord((uint)values.Length);
    if (record == 0) throw new IOException("MSI record allocation");
    try
    {
      for (var i = 0; i < values.Length; i++)
      {
        if (values[i] is int number) Check(MsiRecordSetInteger(record, (uint)i + 1, number), "integer");
        else if (values[i] is string text) Check(MsiRecordSetStringW(record, (uint)i + 1, text), "text");
      }
      Execute($"INSERT INTO `{table}` ({string.Join(",", columns[table])}) VALUES ({string.Join(",", values.Select(_ => "?"))})", record);
    }
    finally { Close(record); }
  }
  internal void Stream(string name, string path)
  {
    var record = MsiCreateRecord(2); if (record == 0) throw new IOException("MSI stream record");
    try { Check(MsiRecordSetStringW(record, 1, name), "stream name"); Check(MsiRecordSetStreamW(record, 2, path), "stream bytes"); Execute("INSERT INTO `_Streams` (`Name`,`Data`) VALUES (?,?)", record); }
    finally { Close(record); }
  }
  private void Execute(string sql, uint record = 0)
  {
    Check(MsiDatabaseOpenViewW(handle, sql, out var view), "view " + sql.Split(' ')[0]);
    try { Check(MsiViewExecute(view, record), "execute " + sql.Split(' ')[0]); }
    finally { Close(view); }
  }
  internal void Summary(string packageCode)
  {
    Check(MsiGetSummaryInformationW(handle, null, 12, out var summary), "summary");
    try
    {
      void Text(uint id, string value) => Check(MsiSummaryInfoSetPropertyW(summary, id, 30, 0, IntPtr.Zero, value), "summary text");
      void Number(uint id, int value) => Check(MsiSummaryInfoSetPropertyW(summary, id, 3, value, IntPtr.Zero, null), "summary number");
      Check(MsiSummaryInfoSetPropertyW(summary, 1, 2, 1252, IntPtr.Zero, null), "codepage");
      Text(2, "Installation Database"); Text(3, "LexRunner Windows helper qualification"); Text(4, "SmarterGPT");
      Text(7, "x64;1033"); Text(9, packageCode); Number(14, 500); Number(15, 2); Text(18, "LexRunner native MSI builder");
      var time = Marshal.AllocHGlobal(8);
      try {
        Marshal.WriteInt64(time, new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc).ToFileTimeUtc());
        foreach (var id in new uint[] { 12, 13 }) Check(MsiSummaryInfoSetPropertyW(summary, id, 64, 0, time, null), "summary time");
      } finally { Marshal.FreeHGlobal(time); }
      Check(MsiSummaryInfoPersist(summary), "persist summary");
    }
    finally { Close(summary); }
  }
  internal void Commit() => Check(MsiDatabaseCommit(handle), "commit");
  internal void FileHash(string id, string path)
  {
    var hash = new FileHashInfo { Size = 20 }; Check(MsiGetFileHashW(path, 0, ref hash), "file hash");
    Insert("MsiFileHash", id, 0, hash.One, hash.Two, hash.Three, hash.Four);
  }
  public void Dispose() { var owned = handle; handle = 0; if (owned != 0) Close(owned); }
  private static void Check(uint code, string operation) { if (code != 0) throw new IOException($"Windows Installer {operation} failed: {code}"); }
  private static void Close(uint handle) => Check(MsiCloseHandle(handle), "close");
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint MsiOpenDatabaseW(string path, IntPtr mode, out uint database);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiViewExecute(uint view, uint record);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiCreateRecord(uint fields);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiRecordSetInteger(uint record, uint field, int value);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint MsiRecordSetStringW(uint record, uint field, string value);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint MsiRecordSetStreamW(uint record, uint field, string path);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiDatabaseCommit(uint database);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiCloseHandle(uint handle);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint MsiGetSummaryInformationW(uint database, string? path, uint count, out uint summary);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint MsiSummaryInfoSetPropertyW(uint summary, uint id, uint type, int number, IntPtr fileTime, string? text);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiSummaryInfoPersist(uint summary);
  [StructLayout(LayoutKind.Sequential)] private struct FileHashInfo { internal uint Size; internal int One, Two, Three, Four; }
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint MsiGetFileHashW(string path, uint options, ref FileHashInfo hash);
}
