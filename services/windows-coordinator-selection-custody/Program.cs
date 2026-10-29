using System.Runtime.Versioning;

namespace LexRunner.WindowsCoordinator.SelectionCustody;

internal static class Program
{
    private const string Schema = "windows-coordinator-selection-custody-observation/1";

    private static int Main(string[] args)
    {
#if SELECTION_CUSTODY_FIXTURE
        if (OperatingSystem.IsWindows() && Environment.Is64BitProcess &&
            args.Length == 1 && args[0] == "--fixture-selftest")
        {
            var passed = FixtureTests.Run() && FixtureTestsV3.Run();
            Console.WriteLine(passed ? "selection_custody_fixture_pass" :
                "selection_custody_fixture_fail");
            return passed ? 0 : 1;
        }
#endif
        if (args.Length == 1 && args[0] == "--observe")
        {
            var result = OperatingSystem.IsWindows() && Environment.Is64BitProcess
                ? ObserveWindows()
                : CustodyResult.Unavailable("unsupported_host");
            Console.WriteLine(Frame(result));
            return result.State == "observed" ? 0 : 2;
        }
        // No build has a publish, repair, activation, registry-write, or
        // arbitrary-path entrypoint. The normal image also lacks fixture tests.
        Console.WriteLine(Frame(CustodyResult.Unavailable("publisher_unavailable")));
        return 2;
    }

    [SupportedOSPlatform("windows")]
    private static CustodyResult ObserveWindows() => NativeRegistryReader.Observe();

    private static string Frame(CustodyResult result)
    {
        // State and reason are from closed internal literals; no observed
        // registry bytes are placed in this bounded diagnostic frame.
        if (result.State is not ("observed" or "unavailable") ||
            !CustodyResult.ValidReason(result.Reason))
            throw new InvalidOperationException("invalid_custody_result");
        return "{\"schemaVersion\":\"" + Schema + "\",\"state\":\"" +
            result.State + "\",\"reason\":\"" + result.Reason +
            "\",\"authorizesLaunch\":false,\"productionReady\":false," +
            "\"helperMissingCleared\":false}";
    }
}
