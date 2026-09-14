using System.Security.Cryptography;
using System.Text.Json;

internal sealed class DirectorySession : IDisposable
{
  private readonly Dictionary<string, DirectoryLease> leases = [];

  internal byte[] CreateFile(JsonElement root, byte[] bytes, string nonce, string sessionNonce,
      HashSet<string> requests, HashSet<string> operations)
  {
    var fields = root.EnumerateObject().ToArray();
    if (fields.Length != 12 || fields.Any(p => p.Value.ValueKind != JsonValueKind.String)) throw new InvalidDataException();
    var request = root.GetProperty("request_id").GetString()!;
    var operation = root.GetProperty("operation_id").GetString()!;
    var digest = root.GetProperty("request_digest").GetString()!;
    var token = root.GetProperty("lease_token").GetString()!;
    var component = root.GetProperty("component").GetString()!;
    var encoded = root.GetProperty("content_base64").GetString()!;
    var contentDigest = root.GetProperty("content_sha256").GetString()!;
    var buffer = new byte[1024];
    if (encoded.Length > 1368 || !Convert.TryFromBase64String(encoded, buffer, out var size)) throw new InvalidDataException();
    var content = buffer.AsSpan(0, size).ToArray();
    if (Convert.ToBase64String(content) != encoded ||
        "sha256:" + Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant() != contentDigest ||
        !Program.IsId(request) || !Program.IsId(operation) ||
        root.GetProperty("protocol_version").GetString() != "1.0.0" ||
        root.GetProperty("operation").GetString() != "create-file" ||
        root.GetProperty("client_nonce").GetString() != nonce ||
        root.GetProperty("session_nonce").GetString() != sessionNonce) throw new InvalidDataException();
    void Body(Utf8JsonWriter writer, bool includeDigest)
    {
      writer.WriteString("client_nonce", nonce);
      writer.WriteString("component", component);
      writer.WriteString("content_base64", encoded);
      writer.WriteString("content_sha256", contentDigest);
      writer.WriteString("kind", "file_create_request");
      writer.WriteString("lease_token", token);
      writer.WriteString("operation", "create-file");
      writer.WriteString("operation_id", operation);
      writer.WriteString("protocol_version", "1.0.0");
      if (includeDigest) writer.WriteString("request_digest", digest);
      writer.WriteString("request_id", request);
      writer.WriteString("session_nonce", sessionNonce);
    }
    var expected = "sha256:" + Convert.ToHexString(SHA256.HashData(Program.Json(w => Body(w, false)))).ToLowerInvariant();
    if (digest != expected || !bytes.AsSpan().SequenceEqual(Program.Json(w => Body(w, true))) ||
        !requests.Add(request) || !operations.Add(operation) || !leases.TryGetValue(token, out var lease)) throw new InvalidDataException();
    var observation = lease.CreateBoundedFile(component, content);
    return Program.Json(writer =>
    {
      writer.WriteNumber("byte_length", observation.Content.Length);
      writer.WriteString("client_nonce", nonce);
      writer.WriteString("content_sha256", contentDigest);
      writer.WriteString("file_id", observation.Identity.FileId);
      writer.WriteString("kind", "file_create_result");
      writer.WriteString("lease_token", token);
      writer.WriteString("operation_id", operation);
      writer.WriteString("protocol_version", "1.0.0");
      writer.WriteString("request_digest", digest);
      writer.WriteString("request_id", request);
      writer.WriteString("session_nonce", sessionNonce);
      writer.WriteString("status", "created");
      writer.WriteString("volume_serial_number", observation.Identity.Volume);
    });
  }

  internal byte[] ReadFile(JsonElement root, byte[] bytes, string nonce, string sessionNonce,
      HashSet<string> requests, HashSet<string> operations)
  {
    var fields = root.EnumerateObject().ToArray();
    if (fields.Length != 11 || fields.Any(p => p.Name == "max_bytes" ?
        p.Value.ValueKind != JsonValueKind.Number : p.Value.ValueKind != JsonValueKind.String)) throw new InvalidDataException();
    var request = root.GetProperty("request_id").GetString()!;
    var operation = root.GetProperty("operation_id").GetString()!;
    var digest = root.GetProperty("request_digest").GetString()!;
    var token = root.GetProperty("lease_token").GetString()!;
    var component = root.GetProperty("component").GetString()!;
    if (!root.GetProperty("max_bytes").TryGetInt32(out var maximum) || maximum is < 0 or > 1024 ||
        !Program.IsId(request) || !Program.IsId(operation) ||
        root.GetProperty("protocol_version").GetString() != "1.0.0" ||
        root.GetProperty("operation").GetString() != "read-file" ||
        root.GetProperty("client_nonce").GetString() != nonce ||
        root.GetProperty("session_nonce").GetString() != sessionNonce) throw new InvalidDataException();
    void Body(Utf8JsonWriter writer, bool includeDigest)
    {
      writer.WriteString("client_nonce", nonce);
      writer.WriteString("component", component);
      writer.WriteString("kind", "file_request");
      writer.WriteString("lease_token", token);
      writer.WriteNumber("max_bytes", maximum);
      writer.WriteString("operation", "read-file");
      writer.WriteString("operation_id", operation);
      writer.WriteString("protocol_version", "1.0.0");
      if (includeDigest) writer.WriteString("request_digest", digest);
      writer.WriteString("request_id", request);
      writer.WriteString("session_nonce", sessionNonce);
    }
    var expected = "sha256:" + Convert.ToHexString(SHA256.HashData(Program.Json(w => Body(w, false)))).ToLowerInvariant();
    if (digest != expected || !bytes.AsSpan().SequenceEqual(Program.Json(w => Body(w, true))) ||
        !requests.Add(request) || !operations.Add(operation) || !leases.TryGetValue(token, out var lease)) throw new InvalidDataException();
    var observation = lease.ReadBoundedFile(component, maximum);
    return Program.Json(writer =>
    {
      writer.WriteNumber("byte_length", observation.Content.Length);
      writer.WriteString("client_nonce", nonce);
      writer.WriteString("content_base64", Convert.ToBase64String(observation.Content));
      writer.WriteString("content_sha256", "sha256:" + Convert.ToHexString(SHA256.HashData(observation.Content)).ToLowerInvariant());
      writer.WriteString("file_id", observation.Identity.FileId);
      writer.WriteString("kind", "file_result");
      writer.WriteString("lease_token", token);
      writer.WriteString("operation_id", operation);
      writer.WriteString("protocol_version", "1.0.0");
      writer.WriteString("request_digest", digest);
      writer.WriteString("request_id", request);
      writer.WriteString("session_nonce", sessionNonce);
      writer.WriteString("volume_serial_number", observation.Identity.Volume);
    });
  }

  internal byte[] Execute(JsonElement root, byte[] bytes, string nonce, string sessionNonce,
      HashSet<string> requests, HashSet<string> operations)
  {
    var fields = root.EnumerateObject().ToArray();
    if (fields.Any(p => p.Value.ValueKind != JsonValueKind.String))
      throw new InvalidDataException();
    var operation = root.GetProperty("operation").GetString()!;
    var acquire = operation == "acquire";
    var childOperation = operation is "open-child" or "try-open-child" or "create-child";
    if (fields.Length != (childOperation ? 10 : 9) ||
        (!acquire && !childOperation && operation is not ("assert" or "release"))) throw new InvalidDataException();
    var request = root.GetProperty("request_id").GetString()!;
    var operationId = root.GetProperty("operation_id").GetString()!;
    var digest = root.GetProperty("request_digest").GetString()!;
    var argument = root.GetProperty(acquire ? "path" : "lease_token").GetString()!;
    var component = childOperation ? root.GetProperty("component").GetString()! : null;
    if (!Program.IsId(request) || !Program.IsId(operationId) ||
        root.GetProperty("protocol_version").GetString() != "1.0.0" ||
        root.GetProperty("client_nonce").GetString() != nonce ||
        root.GetProperty("session_nonce").GetString() != sessionNonce)
      throw new InvalidDataException();
    void Body(Utf8JsonWriter writer, bool includeDigest)
    {
      writer.WriteString("client_nonce", nonce);
      if (childOperation) writer.WriteString("component", component);
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
    DirectoryLease lease;
    string token;
    var missing = false;
    if (acquire)
    {
      if (leases.Count != 0) throw new InvalidDataException();
      lease = DirectoryLease.Acquire(argument);
      token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
      leases.Add(token, lease);
    }
    else
    {
      if (!leases.TryGetValue(argument, out var parent)) throw new InvalidDataException();
      lease = parent;
      token = argument;
      if (childOperation)
      {
        var child = parent.OpenChild(component!, operation == "try-open-child", operation == "create-child");
        if (child is null) missing = true;
        else
        {
          lease = child;
          token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
          leases.Add(token, lease);
        }
      }
    }
    lease.AssertCurrent();
    var leaf = lease.Leaf;
    var count = lease.Identities.Count;
    var replyToken = token!;
    if (operation == "release")
    {
      lease.Dispose(); // Any uncertain CloseHandle result prevents a successful reply.
      leases.Remove(token);
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
      writer.WriteString("status", missing ? "child-missing" : childOperation ?
        (operation == "create-child" ? "child-created" : "child-opened") :
        acquire ? "acquired" : operation == "assert" ? "current" : "released");
      writer.WriteString("volume_serial_number", leaf.Volume);
    });
  }

  public void Dispose()
  {
    var uncertain = false;
    foreach (var lease in leases.Values)
      try { lease.Dispose(); } catch (IOException) { uncertain = true; }
    leases.Clear();
    if (uncertain) throw new IOException("Native session release uncertain");
  }
}
