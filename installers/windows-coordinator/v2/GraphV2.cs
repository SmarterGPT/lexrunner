using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed record GraphFile(string Path, string Role, string Sha256, int Bytes);

// Caller-supplied digests are comparison inputs, never installed authority.
internal sealed class GraphV2
{
  private static readonly string[] Required = ["service-image", "client-image", "node-image",
    "admission-entry", "sqlite-addon", "helper-image", "git-entry"];
  private static readonly HashSet<string> Roles = new([..Required, "javascript-module",
    "native-dll", "git-tool", "git-support-file"], StringComparer.Ordinal);
  private static readonly HashSet<string> Native = new(["service-image", "client-image",
    "node-image", "helper-image", "git-entry", "git-tool"], StringComparer.Ordinal);
  private static readonly Regex Hex = new("^[a-f0-9]{64}\\z", RegexOptions.CultureInvariant);
  private static readonly Regex Component = new("^[A-Za-z0-9][A-Za-z0-9._-]*\\z", RegexOptions.CultureInvariant);
  private static readonly Regex Device = new("^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])\\z",
    RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
  private static readonly string[] Fields = ["schemaVersion", "profile", "architecture",
    "serviceName", "coordinatorProtocolVersion", "boundaryProtocolVersion",
    "removalProtocolVersion", "files", "graphDigest"];
  private static readonly string[] MemberFields = ["path", "role", "sha256", "bytes"];
  internal string GenerationId { get; }
  internal string ManifestSha256 { get; }
  internal IReadOnlyList<GraphFile> Files { get; }
  internal GraphFile ServiceImage => Files.Single(file => file.Role == "service-image");
  private GraphV2(string id, string manifest, IReadOnlyList<GraphFile> files)
  { GenerationId = id; ManifestSha256 = manifest; Files = files; }

  internal static GraphV2 Parse(byte[] bytes, string expectedManifest)
  {
    if (bytes.Length is < 1 or > 262144 || !ValidHex(expectedManifest) ||
        bytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }))
      throw new InvalidDataException("Invalid v2 graph size or expected digest");
    using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 24 });
    var root = document.RootElement;
    Exact(root, Fields);
    if (!bytes.AsSpan().SequenceEqual(Canonical(root)))
      throw new InvalidDataException("Noncanonical v2 graph bytes");
    var manifestDigest = Digest(bytes);
    if (manifestDigest != expectedManifest) throw new InvalidDataException("V2 manifest digest mismatch");
    Require(root, "schemaVersion", "lexrunner-windows-coordinator-generation-graph/2");
    Require(root, "profile", "windows-coordinator-service-msi/2");
    Require(root, "architecture", "win-x64");
    Require(root, "serviceName", "LexRunnerCoordinator");
    Require(root, "coordinatorProtocolVersion", "1.0.0");
    Require(root, "boundaryProtocolVersion", "2.2.0");
    Require(root, "removalProtocolVersion", "1.0.0");
    var id = root.GetProperty("graphDigest").GetString() ?? "";
    if (!ValidHex(id)) throw new InvalidDataException("Invalid generation ID");
    var domain = Encoding.UTF8.GetBytes("lexrunner-windows-coordinator-generation-graph/2\n");
    var body = Canonical(root, true);
    var graphInput = new byte[domain.Length + body.Length];
    domain.CopyTo(graphInput, 0); body.CopyTo(graphInput, domain.Length);
    if (Digest(graphInput) != id) throw new InvalidDataException("V2 graph digest mismatch");
    var members = root.GetProperty("files");
    if (members.ValueKind != JsonValueKind.Array || members.GetArrayLength() is < 7 or > 512)
      throw new InvalidDataException("Invalid v2 graph file count");
    var files = new List<GraphFile>();
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
          size.ValueKind != JsonValueKind.Number || !size.TryGetInt32(out var length) || length <= 0 ||
          previous is not null && string.Compare(path.ToLowerInvariant(), previous, StringComparison.Ordinal) <= 0 ||
          !names.Add(path))
        throw new InvalidDataException("Invalid v2 graph member");
      previous = path.ToLowerInvariant();
      total += length;
      if (total > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("V2 graph byte budget exceeded");
      var parts = path.Split('/');
      for (var n = 1; n < parts.Length; n++)
      {
        var directory = string.Join('/', parts.Take(n));
        if (dirs.TryGetValue(directory, out var spelling) && spelling != directory)
          throw new InvalidDataException("V2 directory spelling collision");
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
        throw new InvalidDataException("V2 role/suffix mismatch");
      counts[role] = counts.GetValueOrDefault(role) + 1;
      files.Add(new GraphFile(path, role, hash, length));
    }
    if (names.Any(name => dirs.ContainsKey(name)) ||
        Required.Any(role => counts.GetValueOrDefault(role) != 1))
      throw new InvalidDataException("Incomplete or aliased v2 graph");
    return new GraphV2(id, manifestDigest, files);
  }

  private static void Require(JsonElement root, string name, string expected)
  { if (root.GetProperty(name).GetString() != expected) throw new InvalidDataException("Unexpected v2 profile"); }
  private static void Exact(JsonElement value, string[] fields)
  {
    if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Expected v2 graph object");
    var expected = new HashSet<string>(fields, StringComparer.Ordinal);
    var count = 0;
    foreach (var item in value.EnumerateObject())
    { count++; if (!expected.Remove(item.Name)) throw new InvalidDataException("Unexpected/repeated v2 field"); }
    if (count != fields.Length || expected.Count != 0) throw new InvalidDataException("Incomplete v2 object");
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
      default: throw new InvalidDataException("Unsupported v2 JSON value");
    }
  }
  internal static string Digest(ReadOnlySpan<byte> bytes) =>
    Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
