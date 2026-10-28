using System.Runtime.Versioning;

namespace LexRunner.WindowsCoordinator.Client;

internal static class CoordinatorAcquisition
{
    // The ordinary image may observe this source-only boundary for diagnostics.
    // No result constructs SelectedEndpoint or reaches BoundClient.RoundTrip.
    [SupportedOSPlatform("windows")]
    internal static CoordinatorObservation Observe() => Observe(
        new WindowsCoordinatorSelectionStore(),
        new WindowsCoordinatorGenerationStore(),
        new WindowsCoordinatorServiceConfigSource());

    internal static CoordinatorObservation Observe(ICoordinatorSelectionStore selectionStore,
        ICoordinatorGenerationStore generationStore,
        ICoordinatorServiceConfigSource serviceConfig)
    {
        try
        {
            var first = selectionStore.ReadSelection();
            if (first is null) return new CoordinatorObservation("unavailable", "selection_unavailable");
            var selection = CoordinatorSelectionContract.ParseSelection(first);
            if (selection is null) return new CoordinatorObservation("unavailable", "selection_invalid");
            var catalog = selectionStore.ReadCatalog(selection.GenerationId);
            if (catalog is null) return new CoordinatorObservation("unavailable", "catalog_unavailable");
            var manifest = generationStore.ReadManifest(selection.GenerationId);
            if (manifest is null) return new CoordinatorObservation("unavailable", "manifest_unavailable");
            var imageDigest = generationStore.ReadImageDigest(selection.GenerationId);
            if (imageDigest is null) return new CoordinatorObservation("unavailable", "image_unavailable");
            var path = generationStore.ImagePath(selection.GenerationId);
            var configuration = serviceConfig.Read();
            var second = selectionStore.ReadSelection();
            if (!string.Equals(first, second, StringComparison.Ordinal))
                return new CoordinatorObservation("unavailable", "selection_changed");
            return CoordinatorSelectionContract.Assess(selection, catalog, manifest,
                imageDigest, configuration, path);
        }
        catch
        {
            // Registry, SCM and file observations are not protected authority.
            // Any acquisition error leaves the route unavailable, with no send.
            return new CoordinatorObservation("unavailable", "source_unavailable");
        }
    }
}
