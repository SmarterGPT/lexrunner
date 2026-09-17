using System.Text.Json;

// Development observations, never authenticated production receipts.
internal sealed record RemovalEvidence(string Name, List<RemovalSnapshot> Snapshots)
{
  internal void Write(Utf8JsonWriter json)
  {
    json.WriteStartObject(); json.WriteString("name", Name);
    json.WriteStartArray("snapshots");
    foreach (var snapshot in Snapshots) snapshot.Write(json);
    json.WriteEndArray(); json.WriteEndObject();
  }
}

internal sealed record RemovalSnapshot(string At, DirectoryLease.Identity? Root, string Contents,
    DirectoryLease.Identity? Registration, string? Backlink)
{
  internal static RemovalSnapshot Capture(string target, string registrationPath, bool registered)
  {
    DirectoryLease.Identity? root = null;
    var contents = "unknown";
    var present = true;
    try
    {
      // Unlike Directory.Exists, unexpected access/I/O errors are not reported as absence.
      _ = File.GetAttributes(target);
    }
    catch (FileNotFoundException) { present = false; }
    catch (DirectoryNotFoundException) { present = false; }
    if (present)
    {
      using var lease = DirectoryLease.Acquire(target);
      root = lease.Leaf;
      contents = Directory.EnumerateFileSystemEntries(target).Any() ? "remaining" : "empty";
    }
    DirectoryLease.Identity? registration = null;
    string? backlink = null;
    if (registered)
    {
      using var lease = DirectoryLease.Acquire(registrationPath);
      registration = lease.Leaf;
      var file = Path.Combine(registrationPath, "gitdir");
      if (new FileInfo(file).Length > 4096) throw new InvalidDataException("Oversized fixture backlink");
      backlink = File.ReadAllText(file);
    }
    return new(DateTimeOffset.UtcNow.ToString("O"), root, contents, registration, backlink);
  }

  internal void Write(Utf8JsonWriter json)
  {
    json.WriteStartObject(); json.WriteString("at", At);
    WriteIdentity(json, "root", Root); json.WriteString("contents", Contents);
    WriteIdentity(json, "registration", Registration); json.WriteString("backlink", Backlink);
    json.WriteEndObject();
  }
  private static void WriteIdentity(Utf8JsonWriter json, string name, DirectoryLease.Identity? identity)
  {
    if (identity is null) { json.WriteNull(name); return; }
    json.WriteStartObject(name); json.WriteString("path", identity.Path);
    json.WriteString("volume", identity.Volume); json.WriteString("fileId", identity.FileId);
    json.WriteString("filesystem", identity.FileSystem); json.WriteEndObject();
  }
}
