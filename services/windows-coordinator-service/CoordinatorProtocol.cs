using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

internal static class CoordinatorProtocol
{
    internal const int MaxRequestBytes = 1024 * 1024;
    internal const int MaxReplyBytes = 4096;

    internal readonly record struct StatusRequest(string RequestId, string RunId, string AttemptId);

    internal static (StatusRequest? Request, string Reason) ParseStatusOnly(byte[] payload)
    {
        string json;
        try { json = new UTF8Encoding(false, true).GetString(payload); }
        catch (DecoderFallbackException) { return (null, "invalid_frame"); }
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return (null, "invalid_request");
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in root.EnumerateObject())
                if (!names.Add(field.Name)) return (null, "invalid_frame");
            if (names.Count != 5 ||
                !ReadOpaque(root, "request_id", out var requestId) ||
                !ReadOpaque(root, "run_id", out var runId) ||
                !ReadOpaque(root, "attempt_id", out var attemptId) ||
                !ReadExact(root, "schema_version", "1.0.0") ||
                !ReadExact(root, "verb", "attempt.status"))
                return (null, "invalid_request");

            var canonical = "{\n" +
                $"  \"attempt_id\": \"{attemptId}\",\n" +
                $"  \"request_id\": \"{requestId}\",\n" +
                $"  \"run_id\": \"{runId}\",\n" +
                "  \"schema_version\": \"1.0.0\",\n" +
                "  \"verb\": \"attempt.status\"\n" +
                "}\n";
            return json == canonical
                ? (new StatusRequest(requestId, runId, attemptId), "protected_store_unavailable")
                : (null, "invalid_frame");
        }
        catch (JsonException) { return (null, "invalid_frame"); }
    }

    // Status is deliberately a new reply major version. The v1 denial could
    // assert only no_effect, which is false for an unknown historical Attempt.
    // These echoed IDs are correlation data, never proof of an enrolled client
    // or of an Attempt in a protected store.
    internal static byte[] IndeterminateStatusFrame(StatusRequest request)
    {
        if (!ValidOpaque(request.RequestId) || !ValidOpaque(request.RunId) ||
            !ValidOpaque(request.AttemptId))
            throw new ArgumentException("Invalid status correlation ID", nameof(request));

        var json = "{\n" +
            $"  \"attempt_id\": \"{request.AttemptId}\",\n" +
            "  \"authorizes_execution\": false,\n" +
            "  \"effect_state\": \"effect_unknown\",\n" +
            "  \"kind\": \"status\",\n" +
            "  \"reason_code\": \"protected_store_unavailable\",\n" +
            $"  \"request_id\": \"{request.RequestId}\",\n" +
            $"  \"run_id\": \"{request.RunId}\",\n" +
            "  \"schema_version\": \"2.0.0\",\n" +
            "  \"state\": \"indeterminate\"\n" +
            "}\n";
        return Frame(json);
    }

    private static byte[] Frame(string json)
    {
        var payload = Encoding.UTF8.GetBytes(json);
        if (payload.Length is 0 or > MaxReplyBytes) throw new InvalidOperationException("Reply too large");
        var frame = new byte[payload.Length + 4];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(4));
        return frame;
    }

#if COORDINATOR_SERVICE_FIXTURE_TESTS
    internal static byte[] DenialFrame(string? requestId, string reason)
    {
        if (reason is not ("invalid_frame" or "invalid_request" or "admission_unavailable"))
            throw new ArgumentException("Invalid denial reason", nameof(reason));
        if (requestId is not null && !ValidOpaque(requestId))
            throw new ArgumentException("Invalid request ID", nameof(requestId));

        var id = requestId is null ? "null" : $"\"{requestId}\"";
        var json = "{\n" +
            "  \"authorizes_execution\": false,\n" +
            "  \"effect_state\": \"no_effect\",\n" +
            "  \"kind\": \"denial\",\n" +
            $"  \"reason_code\": \"{reason}\",\n" +
            $"  \"request_id\": {id},\n" +
            "  \"schema_version\": \"1.0.0\"\n" +
            "}\n";
        return Frame(json);
    }
#endif

    private static bool ReadOpaque(JsonElement root, string name, out string value)
    {
        value = "";
        if (!root.TryGetProperty(name, out var field) || field.ValueKind != JsonValueKind.String)
            return false;
        value = field.GetString() ?? "";
        return ValidOpaque(value);
    }

    private static bool ValidOpaque(string value) => value.Length is >= 1 and <= 128 &&
        IsAsciiLetterOrDigit(value[0]) &&
        value.All(c => IsAsciiLetterOrDigit(c) || c is '.' or '_' or ':' or '-');

    private static bool IsAsciiLetterOrDigit(char c) =>
        c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9';

    private static bool ReadExact(JsonElement root, string name, string expected) =>
        root.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String &&
        field.GetString() == expected;

#if COORDINATOR_SERVICE_FIXTURE_TESTS
    internal static bool SelfTest()
    {
        var canonical = Encoding.UTF8.GetBytes("{\n" +
            "  \"attempt_id\": \"attempt-1\",\n" +
            "  \"request_id\": \"request-1\",\n" +
            "  \"run_id\": \"run-1\",\n" +
            "  \"schema_version\": \"1.0.0\",\n" +
            "  \"verb\": \"attempt.status\"\n" +
            "}\n");
        var parsed = ParseStatusOnly(canonical);
        if (parsed.Request is not { } request ||
            request != new StatusRequest("request-1", "run-1", "attempt-1") ||
            parsed.Reason != "protected_store_unavailable") return false;
        if (ParseStatusOnly(Encoding.UTF8.GetBytes("{\"request_id\":\"x\"}")).Reason != "invalid_request")
            return false;
        if (ParseStatusOnly(Encoding.UTF8.GetBytes("{\"request_id\":\"x\",\"request_id\":\"y\"}")).Reason != "invalid_frame")
            return false;
        if (ParseStatusOnly(Encoding.UTF8.GetBytes("{\n  \"attempt_id\": \"attempt-1\",\n  \"request_id\": \"request-1\",\n  \"run_id\": \"run-1\",\n  \"schema_version\": \"1.0.0\",\n  \"verb\": \"attempt.prepare\"\n}\n")).Request is not null)
            return false;
        if (ParseStatusOnly([0xff]).Request is not null) return false;
        if (ParseStatusOnly(Encoding.UTF8.GetBytes("{\"attempt_id\":\"attempt-1\",\"request_id\":\"request-1\",\"run_id\":\"run-1\",\"schema_version\":\"1.0.0\",\"verb\":\"attempt.status\"}")).Request is not null)
            return false;
        var status = IndeterminateStatusFrame(request);
        if (status.Length > MaxReplyBytes + 4 ||
            BinaryPrimitives.ReadUInt32LittleEndian(status) != status.Length - 4 ||
            !status.SequenceEqual(IndeterminateStatusFrame(request)))
            return false;
        using (var document = JsonDocument.Parse(status.AsMemory(4)))
        {
            var root = document.RootElement;
            if (root.GetProperty("schema_version").GetString() != "2.0.0" ||
                root.GetProperty("kind").GetString() != "status" ||
                root.GetProperty("state").GetString() != "indeterminate" ||
                root.GetProperty("effect_state").GetString() != "effect_unknown" ||
                root.GetProperty("reason_code").GetString() != "protected_store_unavailable" ||
                root.GetProperty("authorizes_execution").GetBoolean() ||
                root.GetProperty("request_id").GetString() != "request-1" ||
                root.GetProperty("run_id").GetString() != "run-1" ||
                root.GetProperty("attempt_id").GetString() != "attempt-1" ||
                root.EnumerateObject().Count() != 9)
                return false;
        }
        var denial = DenialFrame(request.RequestId, "admission_unavailable");
        if (denial.Length > MaxReplyBytes + 4 || BinaryPrimitives.ReadUInt32LittleEndian(denial) != denial.Length - 4)
            return false;
        var response = Encoding.UTF8.GetString(denial.AsSpan(4));
        return response.Contains("\"effect_state\": \"no_effect\"", StringComparison.Ordinal) &&
               response.Contains("\"authorizes_execution\": false", StringComparison.Ordinal) &&
               response.Contains("\"request_id\": \"request-1\"", StringComparison.Ordinal);
    }
#endif
}
