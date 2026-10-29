#if COORDINATOR_CLIENT_FIXTURE_TESTS
using LexRunner.WindowsCoordinator.Client;
using LexRunner.WindowsCoordinator.SelectionCustody;

// Pure result mapping. No registry read, service open, endpoint or pipe send.
internal static class CoordinatorV3RegistryFixtureTests
{
    internal static void Run(List<TestCase> results, List<string> failures)
    {
        void Check(string name, CoordinatorObservation value, string state, string reason)
        {
            var passed = value.State == state && value.Reason == reason &&
                !value.AuthorizesLaunch;
            results.Add(new TestCase { Name = name, Passed = passed,
                State = value.State + ":" + value.Reason, BytesWritten = 0,
                ServerBytesRead = 0 });
            if (!passed) failures.Add(name);
        }

        Check("v3_registry_structural_only_no_send",
            CoordinatorV3RegistryObservation.FromCustody(CustodyResult.Observed()),
            "observed_registry_only", "registry_structural_match_only");
        Check("v3_registry_absent_no_send",
            CoordinatorV3RegistryObservation.FromCustody(
                CustodyResult.Unavailable("selection_unavailable")),
            "unavailable", "selection_unavailable");
        Check("v3_registry_invalid_result_no_send",
            CoordinatorV3RegistryObservation.FromCustody(new CustodyResult("observed", "other")),
            "unavailable", "registry_unavailable");
    }
}
#endif
