using System.Diagnostics;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// Build tooling only: native MSI database + embedded cabinet, never an installation.
internal static class Program
{
  internal const string DirectorySddl = "O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)";
  internal const string FileSddl = "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)";
  internal const string RegistrySddl = "O:SYG:SYD:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KR;;;BU)";
  internal static readonly (string Id, string Name, string Component, bool Permanent)[] Files = [
    ("HelperImage", "lexrunner-windows-boundary-helper.exe", "RetainedHelperImage", true),
    ("GenerationManifest", "generation.json", "RetainedGenerationManifest", true),
    ("InstalledMarker", "installed.json", "InstallationMarker", false)
  ];
  private static int Main(string[] args)
  {
    if (!OperatingSystem.IsWindows() || args.Length != 6) return 2;
    try
    {
      var output = Path.GetFullPath(args[0]); var payload = Path.GetFullPath(args[1]);
      var generation = args[2]; var manifest = args[3]; var version = args[4]; var recipe = args[5];
      if (!Path.IsPathFullyQualified(args[0]) || !Path.IsPathFullyQualified(args[1]) || File.Exists(output) ||
          new[] { generation, manifest, recipe }.Any(s => !Regex.IsMatch(s, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)) ||
          !Version.TryParse(version, out var parsed) || parsed.Major > 255 || parsed.Minor > 255 || parsed.Build is < 0 or > 65535 || parsed.Revision != -1)
        throw new InvalidDataException("Invalid explicit MSI build selection");
      var streams = new List<FileStream>();
      try
      {
        foreach (var file in Files) streams.Add(File.Open(Path.Combine(payload, file.Name), FileMode.Open, FileAccess.Read, FileShare.Read));
        string Digest(Stream stream) { stream.Position = 0; var value = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(); stream.Position = 0; return value; }
        if (Digest(streams[0]) != generation || Digest(streams[1]) != manifest) throw new InvalidDataException("Payload digest changed");
        using var document = JsonDocument.Parse(streams[1]);
        var metadata = document.RootElement;
        if (metadata.GetProperty("schemaVersion").GetString() != "windows-helper-generation/1" ||
            metadata.GetProperty("profile").GetString() != "windows-helper-msi-direct/1" ||
            metadata.GetProperty("generationId").GetString() != generation || metadata.GetProperty("productionReady").GetBoolean() ||
            metadata.GetProperty("state").GetString() != "provisioned-unqualified" ||
            metadata.GetProperty("helperVersion").GetString() != version ||
            metadata.GetProperty("helper").GetProperty("sha256").GetString() != generation)
          throw new InvalidDataException("Expected unqualified generation manifest");
        using var marker = JsonDocument.Parse(streams[2]);
        if (marker.RootElement.GetProperty("generationId").GetString() != generation ||
            marker.RootElement.GetProperty("manifestSha256").GetString() != manifest || marker.RootElement.GetProperty("productionReady").GetBoolean())
          throw new InvalidDataException("Installation marker mismatch");
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var cabinet = BuildCabinet(Path.GetDirectoryName(output)!, payload);
        using (var database = new NativeDatabase(output))
          MsiRecipe.Build(database, generation, manifest, version, recipe, streams.Select(s => checked((int)s.Length)).ToArray(), cabinet, payload);
        NormalizeUnsignedStorageTime(output);
      }
      finally { foreach (var stream in streams) stream.Dispose(); }
      Console.WriteLine("MSI candidate created; no installation or activation performed"); return 0;
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or JsonException or OverflowException)
    { Console.Error.WriteLine("MSI build rejected: " + error.Message); return 3; }
  }
  private static string BuildCabinet(string directory, string payload)
  {
    var cabinet = Path.Combine(directory, "payload.cab"); var directives = Path.Combine(directory, "payload.ddf");
    var lines = new List<string> { ".OPTION EXPLICIT", ".Set CabinetNameTemplate=payload.cab", ".Set DiskDirectoryTemplate=.", ".Set Cabinet=on", ".Set Compress=on", ".Set CompressionType=MSZIP", ".Set MaxDiskSize=0" };
    foreach (var file in Files) lines.Add($"\"{Path.Combine(payload, file.Name)}\" {file.Id}");
    File.WriteAllLines(directives, lines, new UTF8Encoding(false));
    var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "makecab.exe"))
    { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    start.ArgumentList.Add("/F"); start.ArgumentList.Add(directives);
    using var process = Process.Start(start) ?? throw new IOException("makecab did not start");
    var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
    if (!process.WaitForExit(30000)) { process.Kill(entireProcessTree: true); process.WaitForExit(); throw new IOException("makecab timed out"); }
    Task.WaitAll(stdout, stderr); File.WriteAllText(Path.Combine(directory, "makecab.log"), stdout.Result + stderr.Result);
    if (process.ExitCode != 0 || !File.Exists(cabinet)) throw new IOException("makecab rejected the fixed payload");
    return cabinet;
  }
  internal static string GuidFor(string key)
  {
    var bytes = SHA256.HashData(Encoding.UTF8.GetBytes("lexrunner-msi/1:" + key))[..16];
    bytes[7] = (byte)((bytes[7] & 15) | 0x50); bytes[8] = (byte)((bytes[8] & 63) | 0x80);
    return new Guid(bytes).ToString("B").ToUpperInvariant();
  }
  // Windows Installer stamps the CFB root storage on commit independently of the
  // SummaryInformation timestamps. Canonicalize only this unsigned build metadata
  // before signing; do not modify payload bytes or any signed input artifact.
  private static void NormalizeUnsignedStorageTime(string path)
  {
    using var file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
    var header = new byte[512]; file.ReadExactly(header);
    byte[] magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    var shift = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(30));
    if (!header.AsSpan(0, 8).SequenceEqual(magic) || shift is not (9 or 12)) throw new InvalidDataException("Unexpected MSI storage profile");
    var directory = checked(((long)BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(48)) + 1) << shift);
    if (directory < 512 || directory > file.Length - 128) throw new InvalidDataException("MSI directory extent");
    file.Position = directory; var root = new byte[128]; file.ReadExactly(root);
    if (root[66] != 5) throw new InvalidDataException("MSI root storage missing");
    var fixedTime = new byte[8]; BinaryPrimitives.WriteInt64LittleEndian(fixedTime, new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc).ToFileTimeUtc());
    file.Position = directory + 100; file.Write(fixedTime); file.Write(fixedTime); file.Flush(flushToDisk: true);
  }
}
