using System.Runtime.Versioning;
using System.Text.Json;
using LexRunner.WindowsCoordinator.SelectionCustody;

namespace LexRunner.WindowsCoordinator.SelectionPublisher;

[SupportedOSPlatform("windows")]
internal static class PublicationAdminEntrypoint
{
    internal static string? Classify(string[] args) => args switch
    {
        ["--publication-preview"] => "preview",
        ["--admin-publication"] => "admin",
        ["--admin-publication-recover"] => "recover",
        _ => null,
    };

    internal static int Run(string mode)
    {
        try
        {
            if (mode == "preview") return Preview();
            if (mode is not ("admin" or "recover")) return Refuse("publication_mode_invalid");
            if (!NativePublicationAdministration.TryOpenSession(mode == "recover", out var session, out var reason))
                return Refuse(reason);
            // This remains unreachable until an independently admitted producer
            // replaces the hard-closed session factory. Slice A never dispatches
            // SCM/selection effects or claims Node drain/recovery exists.
            using (session)
            {
                if (session is null) return Refuse("publication_session_absent");
                _ = NativeProtectedPublicationStore.PersistIntent(session);
                return Refuse("node_fence_and_effect_dispatch_unavailable");
            }
        }
        catch { return Refuse("publication_unavailable_or_uncertain"); }
    }

    private static int Preview()
    {
        NativeInstalledPublicationReader.Facts facts;
        using (var reader = NativeInstalledPublicationReader.Open()) facts = reader.ReadStable();
        // No roots, raw provenance, selections, manifests, exception text or
        // authority claims are emitted. Close errors prevent a facts response.
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("authorizesEffect", false);
            writer.WriteBoolean("authorizesLaunch", false);
            writer.WriteString("consistency", facts.Consistency);
            writer.WriteString("difference", "no_authenticated_target_request");
            writer.WriteString("epoch", facts.Epoch);
            writer.WriteString("historyDigest", PublicationContractV3.Digest(facts.History));
            writer.WriteNumber("highWater", facts.HighWater);
            writer.WriteString("prerequisite", "independent_installer_root_and_node_fence");
            writer.WriteNumber("retainedCatalogs", facts.Catalogs.Count);
            writer.WriteString("schemaVersion", "windows-publication-preview/1");
            writer.WriteEndObject();
        }
        if (buffer.Length > 2048) return Refuse("publication_preview_capacity");
        Console.WriteLine(System.Text.Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length));
        return 0;
    }

    private static int Refuse(string reason)
    {
        Console.Error.WriteLine(reason);
        return 3;
    }
}
