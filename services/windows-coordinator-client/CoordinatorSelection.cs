using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LexRunner.WindowsCoordinator.Client;

// Source-only comparison. None of these records or results conveys launch authority.
internal sealed record CoordinatorSelection(string GenerationId, string ManifestSha256,
    string ServiceImageSha256, string ServiceVersion, long Revision);
internal sealed record CoordinatorCatalog(string ManifestDigest, string ImageDigest,
    string State, string ServiceName);
internal sealed record CoordinatorManifest(string GenerationId, string ServiceImageSha256,
    string ServiceVersion, string State, bool ProductionReady);
internal sealed record CoordinatorServiceConfig(uint ServiceType, uint StartType,
    uint ErrorControl, string BinaryPath, string StartName,
    string LoadOrderGroup, string Dependencies);
internal sealed record CoordinatorObservation(string State, string Reason)
{
    public bool AuthorizesLaunch => false;
}

internal static class CoordinatorSelectionContract
{
    internal const string ServiceName = "LexRunnerCoordinator";
    internal const string ImageName = "LexRunner.WindowsCoordinator.Service.exe";
    internal const string Profile = "windows-coordinator-service-msi/1";
    internal const string SelectionVersion = "windows-coordinator-active-selection/1";
    internal const string ManifestVersion = "lexrunner-windows-coordinator-generation/1";
    internal const long MaxSafeInteger = 9_007_199_254_740_991;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static bool Digest(string? value) => value is { Length: 64 } &&
        value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool Version(string? value)
    {
        if (value is null) return false;
        var parts = value.Split('.');
        return parts.Length == 3 && parts.All(part => part.Length > 0 &&
            part.All(c => c is >= '0' and <= '9'));
    }

    private static string? String(JsonElement root, string key) =>
        root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;

    private static bool ExactNames(JsonElement root, params string[] names)
    {
        if (root.ValueKind != JsonValueKind.Object) return false;
        var expected = new HashSet<string>(names, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
            if (!expected.Contains(property.Name) || !seen.Add(property.Name)) return false;
        return seen.Count == expected.Count;
    }

    internal static CoordinatorSelection? ParseSelection(string? value)
    {
        if (value is null || value.Length == 0 || value.Length > 4096 ||
            value.Any(c => c > 0x7f)) return null;
        try
        {
            using var document = JsonDocument.Parse(value,
                new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            if (!ExactNames(root, "generationId", "manifestSha256", "profile",
                    "protocolVersion", "revision", "schemaVersion",
                    "serviceImageSha256", "serviceName", "serviceVersion")) return null;
            var generation = String(root, "generationId");
            var manifest = String(root, "manifestSha256");
            var image = String(root, "serviceImageSha256");
            var version = String(root, "serviceVersion");
            if (!Digest(generation) || !Digest(manifest) || image != generation ||
                !Version(version) || String(root, "profile") != Profile ||
                String(root, "protocolVersion") != "1.0.0" ||
                String(root, "schemaVersion") != SelectionVersion ||
                String(root, "serviceName") != ServiceName ||
                !root.TryGetProperty("revision", out var revisionValue) ||
                revisionValue.ValueKind != JsonValueKind.Number ||
                !revisionValue.TryGetInt64(out var revision) ||
                revision is < 1 or > MaxSafeInteger) return null;
            var selection = new CoordinatorSelection(generation!, manifest!, image!,
                version!, revision);
            return string.Equals(value, CanonicalSelection(selection),
                StringComparison.Ordinal) ? selection : null;
        }
        catch (Exception error) when (error is JsonException or ArgumentException or EncoderFallbackException)
        {
            return null;
        }
    }

    private static string CanonicalSelection(CoordinatorSelection s) =>
        $"{{\"generationId\":\"{s.GenerationId}\",\"manifestSha256\":\"{s.ManifestSha256}\"," +
        $"\"profile\":\"{Profile}\",\"protocolVersion\":\"1.0.0\"," +
        $"\"revision\":{s.Revision},\"schemaVersion\":\"{SelectionVersion}\"," +
        $"\"serviceImageSha256\":\"{s.ServiceImageSha256}\"," +
        $"\"serviceName\":\"{ServiceName}\",\"serviceVersion\":\"{s.ServiceVersion}\"}}";

    private static string CompactJson(string text)
    {
        var output = new StringBuilder(text.Length);
        var quoted = false;
        var escaped = false;
        foreach (var c in text)
        {
            if (quoted)
            {
                output.Append(c);
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') quoted = false;
            }
            else if (c == '"') { quoted = true; output.Append(c); }
            else if (!char.IsWhiteSpace(c)) output.Append(c);
        }
        return output.ToString();
    }

    private static string CanonicalManifest(JsonElement root)
    {
        var output = new StringBuilder();
        output.Append('{');
        var first = true;
        foreach (var property in root.EnumerateObject())
        {
            if (!first) output.Append(',');
            first = false;
            output.Append('"').Append(property.Name).Append("\":");
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                var value = property.Value.GetString()!;
                if (value.Any(c => c is < ' ' or > '~' or '"' or '\\')) return "";
                output.Append('"').Append(value).Append('"');
            }
            else if (property.Value.ValueKind == JsonValueKind.True) output.Append("true");
            else if (property.Value.ValueKind == JsonValueKind.False) output.Append("false");
            else return "";
        }
        return output.Append('}').ToString();
    }

    internal static CoordinatorManifest? ParseManifest(byte[]? bytes)
    {
        if (bytes is not { Length: > 0 and <= 16384 } ||
            (bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf))
            return null;
        try
        {
            var text = StrictUtf8.GetString(bytes);
            using var document = JsonDocument.Parse(text,
                new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            if (!ExactNames(root, "schemaVersion", "profile", "generationId",
                    "serviceName", "serviceImageSha256", "serviceVersion", "state",
                    "productionReady")) return null;
            if (String(root, "schemaVersion") != ManifestVersion ||
                String(root, "profile") != Profile ||
                String(root, "serviceName") != ServiceName ||
                !Digest(String(root, "generationId")) ||
                !Digest(String(root, "serviceImageSha256")) ||
                !Version(String(root, "serviceVersion")) ||
                String(root, "state") is not ("qualified" or "provisioned-unqualified") ||
                !root.TryGetProperty("productionReady", out var ready) ||
                ready.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
            // Preserve member order while rejecting duplicate/alternate encodings.
            // Whitespace outside strings is ignored, matching the TS v1 parser.
            if (!string.Equals(CanonicalManifest(root), CompactJson(text),
                    StringComparison.Ordinal)) return null;
            return new CoordinatorManifest(String(root, "generationId")!,
                String(root, "serviceImageSha256")!, String(root, "serviceVersion")!,
                String(root, "state")!, ready.GetBoolean());
        }
        catch (Exception error) when (error is JsonException or DecoderFallbackException or ArgumentException)
        {
            return null;
        }
    }

    internal static CoordinatorObservation Assess(CoordinatorSelection selection,
        CoordinatorCatalog? catalog, byte[]? manifestBytes, string? imageDigest,
        CoordinatorServiceConfig? service, string expectedImagePath)
    {
        static CoordinatorObservation Stop(string reason) => new("inconsistent", reason);
        var manifest = ParseManifest(manifestBytes);
        if (manifest is null || manifestBytes is null) return Stop("manifest_invalid");
        var manifestDigest = Convert.ToHexString(SHA256.HashData(manifestBytes)).ToLowerInvariant();
        if (manifestDigest != selection.ManifestSha256) return Stop("manifest_digest_mismatch");
        if (manifest.GenerationId != selection.GenerationId ||
            manifest.ServiceImageSha256 != selection.ServiceImageSha256 ||
            manifest.ServiceVersion != selection.ServiceVersion)
            return Stop("selection_manifest_mismatch");
        if (manifest.State != "qualified" || !manifest.ProductionReady)
            return Stop("generation_unqualified");
        if (catalog is null || !Digest(catalog.ManifestDigest) ||
            !Digest(catalog.ImageDigest) ||
            catalog.ManifestDigest != manifestDigest ||
            catalog.ImageDigest != selection.ServiceImageSha256 ||
            catalog.State != manifest.State || catalog.ServiceName != ServiceName)
            return Stop("catalog_mismatch");
        if (imageDigest != selection.ServiceImageSha256) return Stop("image_mismatch");
        if (service is null) return Stop("service_unavailable");
        if (service.ServiceType != 0x10 || service.StartType != 3 ||
            service.ErrorControl != 1 ||
            !string.Equals(service.StartName, @"NT SERVICE\LexRunnerCoordinator",
                StringComparison.OrdinalIgnoreCase) ||
            service.LoadOrderGroup.Length != 0 || service.Dependencies.Length != 0 ||
            !string.Equals(service.BinaryPath, $"\"{expectedImagePath}\" --service",
                StringComparison.OrdinalIgnoreCase))
            return Stop("service_config_mismatch");
        return new CoordinatorObservation("consistent", "structural_only");
    }
}
