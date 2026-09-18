using System.Diagnostics;
using System.Text.Json;

// Test-only bridge to the existing SQLite journal. Process success is not deletion authority.
internal static class JournalCheckpoint
{
  internal static JsonElement Record(string root, string name, RemovalSnapshot snapshot, string node, string script)
  {
    if (!Path.IsPathFullyQualified(node) || !Path.IsPathFullyQualified(script))
      throw new InvalidDataException("Absolute journal bridge paths required");
    var selected = Path.Combine(root, "journal-selection.json");
    var input = Path.Combine(root, "journal-request.json");
    using (var file = new FileStream(input, FileMode.Create, FileAccess.Write, FileShare.None))
    {
      using (var json = new Utf8JsonWriter(file))
      {
        json.WriteStartObject(); json.WriteString("operation", name);
        json.WritePropertyName("snapshot"); snapshot.Write(json);
        json.WritePropertyName("previous");
        if (File.Exists(selected))
        {
          if (new FileInfo(selected).Length > 32768) throw new InvalidDataException("Oversized checkpoint");
          using var previous = JsonDocument.Parse(File.ReadAllBytes(selected));
          using var intent = JsonDocument.Parse(previous.RootElement.GetProperty("intentBytes").GetString()!);
          using var observation = JsonDocument.Parse(previous.RootElement.GetProperty("observationBytes").GetString()!);
          json.WriteStartObject();
          json.WriteString("intentDigest", intent.RootElement.GetProperty("intent_digest").GetString());
          json.WriteString("observationDigest", observation.RootElement.GetProperty("observation_digest").GetString());
          json.WriteEndObject();
        }
        else json.WriteNullValue();
        json.WriteEndObject(); json.Flush();
      }
      file.Flush(true);
    }
    var start = new ProcessStartInfo(node) {
      WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(script))!,
      UseShellExecute = false, CreateNoWindow = true,
      RedirectStandardOutput = true, RedirectStandardError = true,
    };
    foreach (var arg in new[] { "--import", "tsx", script, Path.Combine(root, "journal.db"), input })
      start.ArgumentList.Add(arg);
    using var process = Process.Start(start) ?? throw new IOException("Journal bridge start failed");
    var output = ReadBounded(process.StandardOutput);
    var error = ReadBounded(process.StandardError);
    try
    {
      if (!process.WaitForExit(15000)) throw new TimeoutException("Journal checkpoint deadline");
      if (process.ExitCode != 0) throw new IOException("Journal checkpoint failed: " + error.GetAwaiter().GetResult());
      var bytes = System.Text.Encoding.UTF8.GetBytes(output.GetAwaiter().GetResult());
      using var checkpoint = JsonDocument.Parse(bytes);
      using (var file = new FileStream(selected, FileMode.Create, FileAccess.Write, FileShare.None))
      { file.Write(bytes); file.Flush(true); }
      return checkpoint.RootElement.Clone();
    }
    finally
    {
      if (!process.HasExited) {
        process.Kill(true);
        if (!process.WaitForExit(5000)) throw new IOException("Journal bridge termination unconfirmed");
      }
    }
  }

  private static async Task<string> ReadBounded(StreamReader reader)
  {
    var result = new System.Text.StringBuilder();
    var buffer = new char[1024];
    int count;
    while ((count = await reader.ReadAsync(buffer)) != 0) {
      if (result.Length + count > 32768) throw new InvalidDataException("Oversized journal output");
      result.Append(buffer, 0, count);
    }
    return result.ToString();
  }
}
