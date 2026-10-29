using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// Offline authoring only. There is no installation, start or selection API.
internal static class V3MsiProgram
{
  internal const string ServiceName = "LexRunnerCoordinator";
  internal const string ServiceSid = "S-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579";
  internal const string WorkerServiceName = "LexRunnerWorkerSlot1";
  internal const string WorkerServiceSid = "S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843";
  internal const string DirectorySddl = "O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)(A;OICI;GRGX;;;" + ServiceSid + ")(A;OICI;GRGX;;;" + WorkerServiceSid + ")";
  internal const string FileSddl = "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)(A;;GRGX;;;" + ServiceSid + ")(A;;GRGX;;;" + WorkerServiceSid + ")";
  internal const string ServiceSddl = "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCLORC;;;BU)";
  // Only the coordinator service SID can start, stop and observe this slot.
  // Ordinary users retain read/query rights, never SERVICE_USER_DEFINED_CONTROL.
  internal const string WorkerServiceSddl = "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCLORC;;;BU)(A;;CCLCRPWPLORC;;;" + ServiceSid + ")";
  internal sealed record PayloadFile(string Path, string Role, string Digest, int Bytes,
    string Id, string Component, string Directory, string ShortName);

  private static int Main(string[] args)
  {
    if (!OperatingSystem.IsWindows() || args.Length != 5) return 2;
    try
    {
      var output = LocalPath(args[0]);
      var payload = LocalPath(args[1]);
      var expectedManifest = args[2];
      var version = args[3];
      var recipeDigest = args[4];
      if (!Regex.IsMatch(recipeDigest, @"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant) ||
          !Regex.IsMatch(expectedManifest, @"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant) ||
          !Regex.IsMatch(version, @"\A\d+\.\d+\.\d+\z", RegexOptions.CultureInvariant) ||
          !Version.TryParse(version, out var parsed) || parsed.Major is < 0 or > 255 ||
          parsed.Minor is < 0 or > 255 || parsed.Build is < 0 or > 65535 ||
          parsed.Revision != -1 || File.Exists(output) || !Directory.Exists(payload))
        throw new InvalidDataException("Invalid explicit v3 MSI build selection");
      var outputDirectory = Path.GetDirectoryName(output)!;
      if (Directory.Exists(outputDirectory) && Directory.EnumerateFileSystemEntries(outputDirectory).Any())
        throw new InvalidDataException("V3 MSI output directory must be empty");
      if ((File.GetAttributes(payload) & FileAttributes.ReparsePoint) != 0)
        throw new InvalidDataException("V3 payload root is redirected");
      using var manifest = File.Open(Path.Combine(payload, "generation-graph.json"),
        FileMode.Open, FileAccess.Read, FileShare.Read);
      if (manifest.Length is < 1 or > 262144) throw new InvalidDataException("V3 manifest size");
      var graphBytes = new byte[checked((int)manifest.Length)];
      manifest.ReadExactly(graphBytes);
      var graph = GraphV3.Parse(graphBytes, expectedManifest);
      var files = graph.Files.Select((member, index) => new PayloadFile(
        member.Path, member.Role, member.Sha256, member.Bytes,
        $"F{index + 1:D6}", $"C{index + 1:D6}", DirectoryId(member.Path),
        $"F{index + 1:D6}")).ToList();
      files.Add(new PayloadFile("generation-graph.json", "manifest", graph.ManifestSha256,
        graphBytes.Length, "GraphManifest", "GraphManifestComponent", "CoordinatorGenerationRoot", "GRAPHJSN"));
      CheckPayloadTree(payload, files);

      var held = new List<FileStream>();
      try
      {
        foreach (var file in files)
        {
          var input = Path.Combine(payload, file.Path.Replace('/', Path.DirectorySeparatorChar));
          var stream = File.Open(input, FileMode.Open, FileAccess.Read, FileShare.Read);
          held.Add(stream);
          if (stream.Length != file.Bytes || Digest(stream) != file.Digest)
            throw new InvalidDataException("V3 payload member changed: " + file.Path);
        }
        Directory.CreateDirectory(outputDirectory);
        var staged = Path.Combine(outputDirectory, "payload-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staged);
        foreach (var file in files.Select((item, index) => (item, index)))
        {
          var target = Path.Combine(staged, file.item.Path.Replace('/', Path.DirectorySeparatorChar));
          Directory.CreateDirectory(Path.GetDirectoryName(target)!);
          held[file.index].Position = 0;
          using (var copy = File.Open(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
          { held[file.index].CopyTo(copy); copy.Flush(flushToDisk: true); }
          using var check = File.Open(target, FileMode.Open, FileAccess.Read, FileShare.Read);
          if (check.Length != file.item.Bytes || Digest(check) != file.item.Digest)
            throw new InvalidDataException("Staged v3 payload changed: " + file.item.Path);
        }
        var cabinet = BuildCabinet(outputDirectory, staged, files);
        using (var database = new NativeDatabase(output))
          V3MsiRecipe.Build(database, graph, files, version, recipeDigest, cabinet, staged);
        NormalizeUnsignedStorageTime(output);
        V3MsiReadback.Verify(output, files);
        V3MsiAudit.Verify(output, graph, files, version, recipeDigest, staged);
      }
      finally { foreach (var item in held) item.Dispose(); }
      Console.WriteLine("Inactive v3 two-service MSI authored; no installation or selection performed");
      return 0;
    }
    catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or
      ArgumentException or InvalidOperationException or JsonException or OverflowException or FormatException or
      NotSupportedException or Win32Exception or KeyNotFoundException)
    { Console.Error.WriteLine("V3 MSI build rejected: " + error.Message); return 3; }
  }

  private static string LocalPath(string input)
  {
    if (!Regex.IsMatch(input, "^[A-Za-z]:\\\\", RegexOptions.CultureInvariant) ||
        !Path.IsPathFullyQualified(input) || Path.GetFullPath(input) != input || input.Length <= 3)
      throw new InvalidDataException("Expected normalized local-drive path");
    return input;
  }

  private static string DirectoryId(string path)
  {
    var prefix = path[..path.LastIndexOf('/')];
    return "D" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(prefix)))[..12];
  }

  private static void CheckPayloadTree(string root, IReadOnlyList<PayloadFile> files)
  {
    var expectedFiles = files.Select(file => file.Path).ToHashSet(StringComparer.Ordinal);
    var expectedDirectories = new HashSet<string>(StringComparer.Ordinal);
    foreach (var file in files)
    {
      var parts = file.Path.Split('/');
      for (var n = 1; n < parts.Length; n++) expectedDirectories.Add(string.Join('/', parts.Take(n)));
    }
    var seen = new HashSet<string>(StringComparer.Ordinal);
    void Visit(string path, string prefix)
    {
      var count = 0;
      foreach (var entry in Directory.EnumerateFileSystemEntries(path))
      {
        if (++count > 513) throw new InvalidDataException("V3 payload directory budget exceeded");
        var relative = prefix.Length == 0 ? Path.GetFileName(entry) : prefix + "/" + Path.GetFileName(entry);
        var kind = File.GetAttributes(entry);
        if ((kind & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("V3 payload link");
        if ((kind & FileAttributes.Directory) != 0)
        {
          if (!expectedDirectories.Contains(relative)) throw new InvalidDataException("Unlisted v3 directory");
          Visit(entry, relative);
        }
        else if (!expectedFiles.Contains(relative) || !seen.Add(relative))
          throw new InvalidDataException("Unlisted v3 payload member");
      }
    }
    Visit(root, "");
    if (!seen.SetEquals(expectedFiles)) throw new InvalidDataException("Incomplete v3 payload");
  }

  private static string Digest(Stream stream)
  {
    stream.Position = 0;
    var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    stream.Position = 0;
    return hash;
  }

  private static string BuildCabinet(string output, string staged, IReadOnlyList<PayloadFile> files)
  {
    var cabinet = Path.Combine(output, "payload.cab");
    var directives = Path.Combine(output, "payload.ddf");
    var lines = new List<string> { ".OPTION EXPLICIT", ".Set CabinetNameTemplate=payload.cab",
      ".Set DiskDirectoryTemplate=.", ".Set Cabinet=on", ".Set Compress=on",
      ".Set CompressionType=MSZIP", ".Set MaxDiskSize=0" };
    foreach (var file in files)
    {
      var path = Path.Combine(staged, file.Path.Replace('/', Path.DirectorySeparatorChar));
      if (path.IndexOfAny(['"', '\r', '\n']) >= 0)
        throw new InvalidDataException("V3 cabinet DDF syntax in path");
      lines.Add($"\"{path}\" {file.Id}");
    }
    File.WriteAllLines(directives, lines, new UTF8Encoding(false));
    var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "makecab.exe"))
    { WorkingDirectory = output, UseShellExecute = false, CreateNoWindow = true,
      RedirectStandardOutput = true, RedirectStandardError = true };
    start.ArgumentList.Add("/F"); start.ArgumentList.Add(directives);
    var result = QualificationBoundedProcess.Run(start, 300000, 131072, 4096);
    File.WriteAllText(Path.Combine(output, "makecab.log"),
      $"outcome={result.Outcome};exit={result.ExitCode};bytes={result.TotalOutputBytes};truncated={result.OutputTruncated}\n" +
      result.Stdout + result.Stderr, new UTF8Encoding(false));
    if (result.Outcome != QualificationProcessOutcome.Exited || result.ExitCode != 0 ||
        !File.Exists(cabinet)) throw new IOException("makecab rejected v3 payload or did not finish bounded");
    return cabinet;
  }

  internal static string GuidFor(string key)
  {
    var bytes = SHA256.HashData(Encoding.UTF8.GetBytes("lexrunner-coordinator-msi/3:" + key))[..16];
    bytes[7] = (byte)((bytes[7] & 15) | 0x50); bytes[8] = (byte)((bytes[8] & 63) | 0x80);
    return new Guid(bytes).ToString("B").ToUpperInvariant();
  }

  private static void NormalizeUnsignedStorageTime(string path)
  {
    using var file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
    var header = new byte[512]; file.ReadExactly(header);
    byte[] magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    var shift = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(30));
    if (!header.AsSpan(0, 8).SequenceEqual(magic) || shift is not (9 or 12))
      throw new InvalidDataException("Unexpected MSI storage profile");
    var directory = checked(((long)BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(48)) + 1) << shift);
    if (directory < 512 || directory > file.Length - 128) throw new InvalidDataException("MSI directory extent");
    file.Position = directory; var root = new byte[128]; file.ReadExactly(root);
    if (root[66] != 5) throw new InvalidDataException("MSI root storage missing");
    var time = new byte[8];
    BinaryPrimitives.WriteInt64LittleEndian(time,
      new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc).ToFileTimeUtc());
    file.Position = directory + 100; file.Write(time); file.Write(time);
    file.Flush(flushToDisk: true);
  }
}
