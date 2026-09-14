using System.Security.Cryptography;
using System.Text.Json;

internal sealed class DirectorySession : IDisposable
{
  private DirectoryLease? lease;
  private string? token;

  internal byte[] Execute(JsonElement root, byte[] bytes, string nonce, string sessionNonce,
      HashSet<string> requests, HashSet<string> operations)
  {
    var fields = root.EnumerateObject().ToArray();
    if (fields.Length != 9 || fields.Any(p => p.Value.ValueKind != JsonValueKind.String))
      throw new InvalidDataException();
    var operation = root.GetProperty("operation").GetString()!;
    var acquire = operation == "acquire";
    if (!acquire && operation is not ("assert" or "release")) throw new InvalidDataException();
    var request = root.GetProperty("request_id").GetString()!;
    var operationId = root.GetProperty("operation_id").GetString()!;
    var digest = root.GetProperty("request_digest").GetString()!;
    var argument = root.GetProperty(acquire ? "path" : "lease_token").GetString()!;
    if (!Program.IsId(request) || !Program.IsId(operationId) ||
        root.GetProperty("protocol_version").GetString() != "1.0.0" ||
        root.GetProperty("client_nonce").GetString() != nonce ||
        root.GetProperty("session_nonce").GetString() != sessionNonce)
      throw new InvalidDataException();
    void Body(Utf8JsonWriter writer, bool includeDigest)
    {
      writer.WriteString("client_nonce", nonce);
      writer.WriteString("kind", "directory_request");
      if (!acquire) writer.WriteString("lease_token", argument);
      writer.WriteString("operation", operation);
      writer.WriteString("operation_id", operationId);
      if (acquire) writer.WriteString("path", argument);
      writer.WriteString("protocol_version", "1.0.0");
      if (includeDigest) writer.WriteString("request_digest", digest);
      writer.WriteString("request_id", request);
      writer.WriteString("session_nonce", sessionNonce);
    }
    var expected = "sha256:" + Convert.ToHexString(SHA256.HashData(Program.Json(w => Body(w, false)))).ToLowerInvariant();
    if (digest != expected || !bytes.AsSpan().SequenceEqual(Program.Json(w => Body(w, true))) ||
        !requests.Add(request) || !operations.Add(operationId)) throw new InvalidDataException();
    if (acquire)
    {
      if (lease is not null) throw new InvalidDataException();
      lease = DirectoryLease.Acquire(argument);
      token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    }
    else if (lease is null || argument != token) throw new InvalidDataException();
    lease!.AssertCurrent();
    var leaf = lease.Leaf;
    var count = lease.Identities.Count;
    var replyToken = token!;
    if (operation == "release")
    {
      lease.Dispose(); // Any uncertain CloseHandle result prevents a successful reply.
      lease = null;
      token = null;
    }
    return Program.Json(writer =>
    {
      writer.WriteNumber("chain_length", count);
      writer.WriteString("client_nonce", nonce);
      writer.WriteString("file_id", leaf.FileId);
      writer.WriteString("filesystem", leaf.FileSystem);
      writer.WriteString("kind", "directory_result");
      writer.WriteString("lease_token", replyToken);
      writer.WriteString("operation_id", operationId);
      writer.WriteString("path", leaf.Path);
      writer.WriteString("protocol_version", "1.0.0");
      writer.WriteString("request_digest", digest);
      writer.WriteString("request_id", request);
      writer.WriteString("session_nonce", sessionNonce);
      writer.WriteString("status", acquire ? "acquired" : operation == "assert" ? "current" : "released");
      writer.WriteString("volume_serial_number", leaf.Volume);
    });
  }

  public void Dispose() => lease?.Dispose();
}
