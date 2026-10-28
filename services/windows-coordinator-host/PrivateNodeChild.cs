#if COORDINATOR_ADMISSION_BRIDGE_TESTS
using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// One-shot source fixture. ProcessStartInfo does not provide protected image/
// loader custody or atomic Job assignment; never use this owner for a service.
internal static class PrivateNodeChild
{
    private const int MaxClientFrameBytes = 1024 * 1024 + 4;
    private const int MaxReplyFrameBytes = 4096;
    private const int MaxPrivateReplyBytes = 8 + 16 + 4 + MaxReplyFrameBytes;
    private const int MaxStderrBytes = 4096;
    private static readonly byte[] RequestMagic = "LXNPEER1"u8.ToArray();
    private static readonly byte[] ReplyMagic = "LXNREPL1"u8.ToArray();

    internal static async Task<byte[]> RunAsync(string nodeImage, string worker, string context,
        string nodeSha256, string workerSha256, string observedSid, byte[] clientFrame,
        CancellationToken cancellation)
    {
        RequireRegularFile(nodeImage, ".exe");
        RequireRegularFile(worker, ".mjs");
        RequireRegularFile(context, ".json");
        if (new FileInfo(context).Length > 65536 ||
            HashFile(nodeImage) != nodeSha256 || HashFile(worker) != workerSha256)
            throw new InvalidDataException("Private Node fixture identity mismatch");
        if (clientFrame.Length is < 5 or > MaxClientFrameBytes ||
            BinaryPrimitives.ReadUInt32LittleEndian(clientFrame) != clientFrame.Length - 4)
            throw new InvalidDataException("Private client frame bound");
        var sidBytes = Encoding.ASCII.GetBytes(observedSid);
        if (sidBytes.Length is < 7 or > 184 || !observedSid.All(char.IsAscii))
            throw new InvalidDataException("Private peer SID bound");

        var nonce = RandomNumberGenerator.GetBytes(16);
        var request = new byte[8 + 16 + 2 + sidBytes.Length + 4 + clientFrame.Length];
        var offset = 0;
        RequestMagic.CopyTo(request, offset); offset += RequestMagic.Length;
        nonce.CopyTo(request, offset); offset += nonce.Length;
        BinaryPrimitives.WriteUInt16LittleEndian(request.AsSpan(offset), (ushort)sidBytes.Length); offset += 2;
        sidBytes.CopyTo(request, offset); offset += sidBytes.Length;
        BinaryPrimitives.WriteUInt32LittleEndian(request.AsSpan(offset), (uint)clientFrame.Length); offset += 4;
        clientFrame.CopyTo(request, offset);

        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ??
            Environment.GetEnvironmentVariable("WINDIR") ?? throw new InvalidOperationException("Windows root unavailable");
        if (!Path.IsPathFullyQualified(systemRoot)) throw new InvalidDataException("Windows root unavailable");
        var nodeDirectory = Path.GetDirectoryName(nodeImage)!;
        var workerDirectory = Path.GetDirectoryName(worker)!;
        var temporaryDirectory = Path.GetDirectoryName(context)!;
        var start = new ProcessStartInfo(nodeImage)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = workerDirectory
        };
        start.ArgumentList.Add(worker);
        start.ArgumentList.Add("--private-admission-fixture");
        start.ArgumentList.Add(context);
        // Construct the entire child environment. No inherited Node preloads,
        // Git overrides, user profile, credentials or client-supplied values.
        start.Environment.Clear();
        start.Environment["SystemRoot"] = systemRoot;
        start.Environment["WINDIR"] = systemRoot;
        start.Environment["OS"] = "Windows_NT";
        start.Environment["TEMP"] = temporaryDirectory;
        start.Environment["TMP"] = temporaryDirectory;
        start.Environment["PATH"] = nodeDirectory + ";" + Path.Combine(systemRoot, "System32");

        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new IOException("Private Node child did not start");
        var output = ReadBounded(process.StandardOutput.BaseStream, MaxPrivateReplyBytes, cancellation);
        var error = ReadBounded(process.StandardError.BaseStream, MaxStderrBytes, cancellation);
        try
        {
            await process.StandardInput.BaseStream.WriteAsync(request, cancellation);
            await process.StandardInput.BaseStream.FlushAsync(cancellation);
            process.StandardInput.Close();
            await process.WaitForExitAsync(cancellation);
            var reply = await output;
            var stderr = await error;
            if (process.ExitCode != 0 || stderr.Length != 0 ||
                HashFile(nodeImage) != nodeSha256 || HashFile(worker) != workerSha256)
                throw new IOException("Private Node child or image changed");
            return ValidatePrivateReply(reply, nonce, clientFrame);
        }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (Exception killError) when (killError is InvalidOperationException or System.ComponentModel.Win32Exception) { }
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try { await process.WaitForExitAsync(cleanup.Token); }
                catch (OperationCanceledException) { throw new IOException("Private Node cleanup uncertain"); }
                if (!process.HasExited) throw new IOException("Private Node cleanup uncertain");
            }
        }
    }

    private static void RequireRegularFile(string value, string extension)
    {
        if (value.Length is < 4 or > 1024 || !char.IsAsciiLetter(value[0]) ||
            value[1] != ':' || value[2] != '\\' || value.Contains('\0') ||
            !Path.IsPathFullyQualified(value) ||
            !string.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase) ||
            !value.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Private Node fixture path");
        var attributes = File.GetAttributes(value);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new InvalidDataException("Private Node fixture reparse point");
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static async Task<byte[]> ReadBounded(Stream input, int maximum, CancellationToken cancellation)
    {
        using var content = new MemoryStream();
        var buffer = new byte[4096];
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellation);
            if (read == 0) return content.ToArray();
            if (read > maximum - content.Length) throw new InvalidDataException("Private Node output bound");
            content.Write(buffer, 0, read);
        }
    }

    private static byte[] ValidatePrivateReply(byte[] reply, byte[] nonce, byte[] clientFrame)
    {
        if (reply.Length < 8 + 16 + 4 + 5 ||
            !reply.AsSpan(0, 8).SequenceEqual(ReplyMagic) ||
            !reply.AsSpan(8, 16).SequenceEqual(nonce))
            throw new InvalidDataException("Private Node reply correlation");
        var length = BinaryPrimitives.ReadUInt32LittleEndian(reply.AsSpan(24, 4));
        if (length is < 5 or > MaxReplyFrameBytes || length != reply.Length - 28)
            throw new InvalidDataException("Private Node reply length");
        var denial = reply.AsSpan(28).ToArray();
        if (BinaryPrimitives.ReadUInt32LittleEndian(denial) != denial.Length - 4)
            throw new InvalidDataException("Private Node denial frame");
        ValidateDenial(denial, clientFrame);
        return denial;
    }

    private static void ValidateDenial(byte[] frame, byte[] clientFrame)
    {
        try
        {
            var json = new UTF8Encoding(false, true).GetString(frame, 4, frame.Length - 4);
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in root.EnumerateObject())
                if (!names.Add(field.Name)) throw new InvalidDataException();
            if (names.Count != 6 || root.GetProperty("schema_version").GetString() != "1.0.0" ||
                root.GetProperty("kind").GetString() != "denial" ||
                root.GetProperty("effect_state").GetString() != "no_effect" ||
                root.GetProperty("authorizes_execution").ValueKind != JsonValueKind.False)
                throw new InvalidDataException();
            var reason = root.GetProperty("reason_code").GetString();
            if (reason is not ("invalid_frame" or "invalid_request" or "admission_unavailable"))
                throw new InvalidDataException();
            var fieldId = root.GetProperty("request_id");
            string? id = null;
            if (fieldId.ValueKind == JsonValueKind.String)
            {
                id = fieldId.GetString();
                if (id is null || id.Length is < 1 or > 128 ||
                    !char.IsAsciiLetterOrDigit(id[0]) ||
                    !id.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or ':' or '-'))
                    throw new InvalidDataException();
                // A correlated non-null ID must occur in the exact received
                // client frame, never only in a private child assertion.
                var request = new UTF8Encoding(false, true).GetString(clientFrame, 4, clientFrame.Length - 4);
                using var requestDocument = JsonDocument.Parse(request);
                if (!requestDocument.RootElement.TryGetProperty("request_id", out var requestId) ||
                    requestId.ValueKind != JsonValueKind.String || requestId.GetString() != id)
                    throw new InvalidDataException();
            }
            else if (fieldId.ValueKind != JsonValueKind.Null) throw new InvalidDataException();
            var expected = "{\n" +
                "  \"authorizes_execution\": false,\n" +
                "  \"effect_state\": \"no_effect\",\n" +
                "  \"kind\": \"denial\",\n" +
                $"  \"reason_code\": \"{reason}\",\n" +
                $"  \"request_id\": {(id is null ? "null" : "\"" + id + "\"")},\n" +
                "  \"schema_version\": \"1.0.0\"\n" +
                "}\n";
            if (json != expected) throw new InvalidDataException();
        }
        catch (Exception error) when (error is JsonException or DecoderFallbackException or
                                      KeyNotFoundException or InvalidOperationException)
        {
            throw new InvalidDataException("Private Node denial malformed", error);
        }
    }
}
#endif
