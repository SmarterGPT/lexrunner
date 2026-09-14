using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Development protocol and held-directory peer; not a qualified production boundary.
internal static class Program
{
  private const string Version = "1.0.0";
  private const int Limit = 4096;

  private static int Main(string[] args)
  {
    if (!OperatingSystem.IsWindows() || args.Length != 2 ||
        (args[0] != "--boundary-protocol" && args[0] != "--boundary-session") || args[1] != Version)
      return 2;
    try
    {
      using var input = Console.OpenStandardInput();
      using var output = Console.OpenStandardOutput();
      var header = new byte[4];
      input.ReadExactly(header);
      var length = BinaryPrimitives.ReadUInt32BigEndian(header);
      if (length is 0 or > Limit) throw new InvalidDataException();
      var payload = new byte[(int)length];
      input.ReadExactly(payload);
      var text = new UTF8Encoding(false, true).GetString(payload);
      using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 4 });
      var root = document.RootElement;
      if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
      var fields = root.EnumerateObject().ToArray();
      if (fields.Length != 4 || fields.Any(p => p.Value.ValueKind != JsonValueKind.String))
        throw new InvalidDataException();
      var nonce = root.GetProperty("client_nonce").GetString()!;
      var request = root.GetProperty("request_id").GetString()!;
      if (root.GetProperty("kind").GetString() != "hello" ||
          root.GetProperty("protocol_version").GetString() != Version ||
          nonce.Length != 64 || !nonce.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f') ||
          request.Length is < 1 or > 64 ||
          !request.All(c => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '-'))
        throw new InvalidDataException();
      var canonical = Json(writer =>
      {
        writer.WriteString("client_nonce", nonce);
        writer.WriteString("kind", "hello");
        writer.WriteString("protocol_version", Version);
        writer.WriteString("request_id", request);
      });
      // Exact comparison also rejects duplicate/unknown keys, BOM and alternate encodings.
      if (!payload.AsSpan().SequenceEqual(canonical)) throw new InvalidDataException();
      var architecture = RuntimeInformation.ProcessArchitecture switch
      {
        Architecture.X64 => "x64",
        Architecture.Arm64 => "arm64",
        _ => throw new InvalidDataException()
      };
      // Self-report for protocol comparison only, never executable authentication.
      using var image = File.OpenRead(Environment.ProcessPath!);
      var digest = "sha256:" + Convert.ToHexString(SHA256.HashData(image)).ToLowerInvariant();
      var sessionNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
      var reply = Json(writer =>
      {
        writer.WriteString("client_nonce", nonce);
        writer.WritePropertyName("helper");
        writer.WriteStartObject();
        writer.WriteString("architecture", architecture);
        writer.WriteString("artifact_sha256", digest);
        writer.WriteNumber("process_id", Environment.ProcessId);
        writer.WriteEndObject();
        writer.WriteString("kind", "hello_result");
        writer.WriteString("protocol_version", Version);
        writer.WriteString("request_id", request);
        writer.WriteString("session_nonce", sessionNonce);
      });
      BinaryPrimitives.WriteUInt32BigEndian(header, (uint)reply.Length);
      output.Write(header);
      output.Write(reply);
      output.Flush();
      if (args[0] == "--boundary-session") return RunSession(input, output, nonce, sessionNonce);
      // One exchange only. The owned parent closes stdin after matching the reply.
      if (input.ReadByte() != -1) throw new InvalidDataException();
      return 0;
    }
    catch (Exception error) when (error is IOException or InvalidDataException or JsonException or System.ComponentModel.Win32Exception or
        DecoderFallbackException or InvalidOperationException or KeyNotFoundException or
        UnauthorizedAccessException)
    {
      Console.Error.WriteLine("boundary negotiation rejected");
      return 3;
    }
  }

  private static int RunSession(Stream input, Stream output, string nonce, string sessionNonce)
  {
    using var directories = new DirectorySession();
    var requests = new HashSet<string>(StringComparer.Ordinal);
    var operations = new HashSet<string>(StringComparer.Ordinal);
    var header = new byte[4];
    for (var count = 0; ; count++)
    {
      var first = input.ReadByte();
      if (first == -1) return 0;
      if (count >= 15) throw new InvalidDataException();
      header[0] = (byte)first;
      input.ReadExactly(header.AsSpan(1));
      var length = BinaryPrimitives.ReadUInt32BigEndian(header);
      if (length is 0 or > Limit) throw new InvalidDataException();
      var bytes = new byte[(int)length];
      input.ReadExactly(bytes);
      using var document = JsonDocument.Parse(new UTF8Encoding(false, true).GetString(bytes),
          new JsonDocumentOptions { MaxDepth = 4 });
      var root = document.RootElement;
      if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
      if (root.TryGetProperty("kind", out var kind) && kind.ValueKind == JsonValueKind.String &&
          kind.GetString() is "directory_request" or "file_request")
      {
        var directoryReply = kind.GetString() == "file_request" ?
          directories.ReadFile(root, bytes, nonce, sessionNonce, requests, operations) :
          directories.Execute(root, bytes, nonce, sessionNonce, requests, operations);
        if (directoryReply.Length > Limit) throw new InvalidDataException();
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)directoryReply.Length);
        output.Write(header);
        output.Write(directoryReply);
        output.Flush();
        continue;
      }
      var fields = root.EnumerateObject().ToArray();
      if (fields.Length != 8 || fields.Any(p => p.Value.ValueKind != JsonValueKind.String))
        throw new InvalidDataException();
      var request = root.GetProperty("request_id").GetString()!;
      var operation = root.GetProperty("operation_id").GetString()!;
      var digest = root.GetProperty("request_digest").GetString()!;
      if (!IsId(request) || !IsId(operation) ||
          root.GetProperty("kind").GetString() != "session_request" ||
          root.GetProperty("operation").GetString() != "session-status" ||
          root.GetProperty("protocol_version").GetString() != Version ||
          root.GetProperty("client_nonce").GetString() != nonce ||
          root.GetProperty("session_nonce").GetString() != sessionNonce)
        throw new InvalidDataException();
      void Body(Utf8JsonWriter writer, bool includeDigest)
      {
        writer.WriteString("client_nonce", nonce);
        writer.WriteString("kind", "session_request");
        writer.WriteString("operation", "session-status");
        writer.WriteString("operation_id", operation);
        writer.WriteString("protocol_version", Version);
        if (includeDigest) writer.WriteString("request_digest", digest);
        writer.WriteString("request_id", request);
        writer.WriteString("session_nonce", sessionNonce);
      }
      var expected = "sha256:" + Convert.ToHexString(SHA256.HashData(Json(w => Body(w, false)))).ToLowerInvariant();
      if (digest != expected || !bytes.AsSpan().SequenceEqual(Json(w => Body(w, true))) ||
          !requests.Add(request) || !operations.Add(operation)) throw new InvalidDataException();
      var reply = Json(writer =>
      {
        writer.WriteString("client_nonce", nonce);
        writer.WriteString("kind", "session_result");
        writer.WriteString("operation_id", operation);
        writer.WriteString("protocol_version", Version);
        writer.WriteString("request_digest", digest);
        writer.WriteString("request_id", request);
        writer.WriteString("session_nonce", sessionNonce);
        writer.WriteString("status", "alive");
      });
      BinaryPrimitives.WriteUInt32BigEndian(header, (uint)reply.Length);
      output.Write(header);
      output.Write(reply);
      output.Flush();
    }
  }

  internal static bool IsId(string value) => value.Length is >= 1 and <= 64 &&
      value.All(c => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '-');

  internal static byte[] Json(Action<Utf8JsonWriter> body)
  {
    using var stream = new MemoryStream();
    using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
    {
      writer.WriteStartObject();
      body(writer);
      writer.WriteEndObject();
    }
    stream.WriteByte((byte)'\n');
    // The wire contract uses LF even on Windows; native writer formatting may use CRLF.
    return Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(stream.ToArray()).Replace("\r\n", "\n"));
  }
}
