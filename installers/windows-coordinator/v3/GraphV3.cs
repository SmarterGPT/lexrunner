using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed record GraphV3File(string Path, string Role, string Sha256, int Bytes);

// Caller-supplied digests are comparison inputs, never installed authority.
internal sealed class GraphV3
{
  private static readonly string[] Required = ["service-image", "worker-service-image", "client-image", "node-image",
    "admission-entry", "sqlite-addon", "helper-image", "git-entry"];
  private static readonly HashSet<string> Roles = new([..Required, "javascript-module",
    "native-dll", "git-tool", "git-support-file"], StringComparer.Ordinal);
  private static readonly HashSet<string> Native = new(["service-image", "worker-service-image", "client-image",
    "node-image", "helper-image", "git-entry", "git-tool"], StringComparer.Ordinal);
  private static readonly Regex Hex = new("^[a-f0-9]{64}\\z", RegexOptions.CultureInvariant);
  private static readonly Regex Component = new("^[A-Za-z0-9][A-Za-z0-9._-]*\\z", RegexOptions.CultureInvariant);
  private static readonly Regex Device = new("^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])\\z",
    RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
  private static readonly string[] Fields = ["schemaVersion", "profile", "architecture",
    "serviceName", "workerServiceName", "workerTokenUserSid", "workerServiceSid",
    "coordinatorProtocolVersion", "boundaryProtocolVersion",
    "removalProtocolVersion", "files", "graphDigest"];
  private static readonly string[] MemberFields = ["path", "role", "sha256", "bytes"];
  internal string GenerationId { get; }
  internal string ManifestSha256 { get; }
  internal IReadOnlyList<GraphV3File> Files { get; }
  internal GraphV3File ServiceImage => Files.Single(file => file.Role == "service-image");
  internal GraphV3File WorkerServiceImage => Files.Single(file => file.Role == "worker-service-image");
  private GraphV3(string id, string manifest, IReadOnlyList<GraphV3File> files)
  { GenerationId = id; ManifestSha256 = manifest; Files = files; }

  internal static GraphV3 Parse(byte[] bytes, string expectedManifest)
  {
    if (bytes.Length is < 1 or > 262144 || !ValidHex(expectedManifest) ||
        bytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }))
      throw new InvalidDataException("Invalid v3 graph size or expected digest");
    using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 24 });
    var root = document.RootElement;
    Exact(root, Fields);
    if (!bytes.AsSpan().SequenceEqual(Canonical(root)))
      throw new InvalidDataException("Noncanonical v3 graph bytes");
    var manifestDigest = Digest(bytes);
    if (manifestDigest != expectedManifest) throw new InvalidDataException("V3 manifest digest mismatch");
    Require(root, "schemaVersion", "lexrunner-windows-coordinator-generation-graph/3");
    Require(root, "profile", "windows-coordinator-service-msi/3");
    Require(root, "architecture", "win-x64");
    Require(root, "serviceName", "LexRunnerCoordinator");
    Require(root, "workerServiceName", "LexRunnerWorkerSlot1");
    Require(root, "workerTokenUserSid", "S-1-5-19");
    Require(root, "workerServiceSid", "S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843");
    Require(root, "coordinatorProtocolVersion", "1.0.0");
    Require(root, "boundaryProtocolVersion", "2.2.0");
    Require(root, "removalProtocolVersion", "1.0.0");
    var id = root.GetProperty("graphDigest").GetString() ?? "";
    if (!ValidHex(id)) throw new InvalidDataException("Invalid generation ID");
    var domain = Encoding.UTF8.GetBytes("lexrunner-windows-coordinator-generation-graph/3\n");
    var body = Canonical(root, true);
    var graphInput = new byte[domain.Length + body.Length];
    domain.CopyTo(graphInput, 0); body.CopyTo(graphInput, domain.Length);
    if (Digest(graphInput) != id) throw new InvalidDataException("V3 graph digest mismatch");
    var members = root.GetProperty("files");
    if (members.ValueKind != JsonValueKind.Array || members.GetArrayLength() is < 8 or > 512)
      throw new InvalidDataException("Invalid v3 graph file count");
    var files = new List<GraphV3File>();
    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var dirs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    var counts = new Dictionary<string, int>(StringComparer.Ordinal);
    string? previous = null;
    long total = 0;
    foreach (var member in members.EnumerateArray())
    {
      Exact(member, MemberFields);
      var path = member.GetProperty("path").GetString() ?? "";
      var role = member.GetProperty("role").GetString() ?? "";
      var hash = member.GetProperty("sha256").GetString() ?? "";
      var size = member.GetProperty("bytes");
      if (!SafePath(path) || !Roles.Contains(role) || !ValidHex(hash) ||
          role == "service-image" && path != "service/LexRunner.WindowsCoordinator.Service.exe" ||
          role == "worker-service-image" && path != "service/LexRunner.WindowsCoordinator.WorkerSlot.exe" ||
          size.ValueKind != JsonValueKind.Number || !size.TryGetInt32(out var length) || length <= 0 ||
          previous is not null && string.Compare(path.ToLowerInvariant(), previous, StringComparison.Ordinal) <= 0 ||
          !names.Add(path))
        throw new InvalidDataException("Invalid v3 graph member");
      previous = path.ToLowerInvariant();
      total += length;
      if (total > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("V3 graph byte budget exceeded");
      var parts = path.Split('/');
      for (var n = 1; n < parts.Length; n++)
      {
        var directory = string.Join('/', parts.Take(n));
        if (dirs.TryGetValue(directory, out var spelling) && spelling != directory)
          throw new InvalidDataException("V3 directory spelling collision");
        dirs[directory] = directory;
      }
      var suffix = parts[^1].ToLowerInvariant();
      if (Native.Contains(role) && !suffix.EndsWith(".exe", StringComparison.Ordinal) ||
          role == "sqlite-addon" && !suffix.EndsWith(".node", StringComparison.Ordinal) ||
          role == "native-dll" && !suffix.EndsWith(".dll", StringComparison.Ordinal) ||
          (role is "admission-entry" or "javascript-module") &&
            !(suffix.EndsWith(".mjs", StringComparison.Ordinal) ||
              suffix.EndsWith(".cjs", StringComparison.Ordinal) ||
              suffix.EndsWith(".js", StringComparison.Ordinal)))
        throw new InvalidDataException("V3 role/suffix mismatch");
      counts[role] = counts.GetValueOrDefault(role) + 1;
      files.Add(new GraphV3File(path, role, hash, length));
    }
    if (names.Any(name => dirs.ContainsKey(name)) ||
        Required.Any(role => counts.GetValueOrDefault(role) != 1))
      throw new InvalidDataException("Incomplete or aliased v3 graph");
    return new GraphV3(id, manifestDigest, files);
  }

  private static void Require(JsonElement root, string name, string expected)
  { if (root.GetProperty(name).GetString() != expected) throw new InvalidDataException("Unexpected v3 profile"); }
  private static void Exact(JsonElement value, string[] fields)
  {
    if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Expected v3 graph object");
    var expected = new HashSet<string>(fields, StringComparer.Ordinal);
    var count = 0;
    foreach (var item in value.EnumerateObject())
    { count++; if (!expected.Remove(item.Name)) throw new InvalidDataException("Unexpected/repeated v3 field"); }
    if (count != fields.Length || expected.Count != 0) throw new InvalidDataException("Incomplete v3 object");
  }
  internal static bool ValidHex(string value) => Hex.IsMatch(value);
  internal static bool ReservedDevice(string value) => Device.IsMatch(value);
  internal static bool SafePath(string path)
  {
    if (path.Length is < 3 or > 240 || path.Contains('\\')) return false;
    var parts = path.Split('/');
    return parts.Length is >= 2 and <= 12 && parts.All(part =>
      part.Length is > 0 and <= 64 && Component.IsMatch(part) &&
      !part.Contains("..", StringComparison.Ordinal) && !part.EndsWith('.') &&
      !part.Contains('~') && !ReservedDevice(part.Split('.')[0]));
  }
  private static byte[] Canonical(JsonElement element, bool omitDigest = false)
  {
    using var output = new MemoryStream();
    using (var writer = new Utf8JsonWriter(output)) Write(writer, element, omitDigest);
    return output.ToArray();
  }
  private static void Write(Utf8JsonWriter writer, JsonElement value, bool omitDigest)
  {
    switch (value.ValueKind)
    {
      case JsonValueKind.Object:
        writer.WriteStartObject();
        foreach (var item in value.EnumerateObject().Where(p => !omitDigest || p.Name != "graphDigest")
          .OrderBy(p => p.Name, StringComparer.Ordinal))
        { writer.WritePropertyName(item.Name); Write(writer, item.Value, false); }
        writer.WriteEndObject(); break;
      case JsonValueKind.Array:
        writer.WriteStartArray(); foreach (var item in value.EnumerateArray()) Write(writer, item, false);
        writer.WriteEndArray(); break;
      case JsonValueKind.String: writer.WriteStringValue(value.GetString()); break;
      case JsonValueKind.Number: writer.WriteNumberValue(value.GetInt64()); break;
      default: throw new InvalidDataException("Unsupported v3 JSON value");
    }
  }
  internal static string Digest(ReadOnlySpan<byte> bytes) =>
    Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
