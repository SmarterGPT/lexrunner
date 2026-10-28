using System.Runtime.Versioning;
using LexRunner.WindowsCoordinator.SelectionCustody;

namespace LexRunner.WindowsCoordinator.Client;

// V2 registry custody is one input to a future installed proof, never an
// endpoint or execution grant. The ordinary client has no route from this
// observation to BoundClient.RoundTrip.
internal static class CoordinatorV2RegistryObservation
{
    [SupportedOSPlatform("windows")]
    internal static CoordinatorObservation Observe()
    {
        if (!Environment.Is64BitProcess)
            return new CoordinatorObservation("unavailable", "unsupported_host");
        return FromCustody(NativeRegistryReader.Observe());
    }

    internal static CoordinatorObservation FromCustody(CustodyResult result)
    {
        if (result.State == "observed" &&
            result.Reason == "registry_structural_match_only")
            return new CoordinatorObservation("observed_registry_only", result.Reason);
        if (result.State == "unavailable" && CustodyResult.ValidReason(result.Reason) &&
            result.Reason != "registry_structural_match_only")
            return new CoordinatorObservation("unavailable", result.Reason);
        return new CoordinatorObservation("unavailable", "registry_unavailable");
    }
}
