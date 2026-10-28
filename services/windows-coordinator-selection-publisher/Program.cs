namespace LexRunner.WindowsCoordinator.SelectionPublisher;

internal static class Program
{
    private static int Main(string[] args)
    {
#if SELECTION_PUBLISHER_FIXTURE
        if (args.Length == 1 && args[0] == "--fixture-hkcu-selftest")
        {
            try
            {
                if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("windows_required");
                FixtureTests.Run();
                Console.WriteLine("fixture_hkcu_selftest_pass");
                return 0;
            }
            catch (Exception error)
            {
                var reason = error.Message;
                if (reason.Length is < 1 or > 80 || reason.Any(c =>
                    c is not (>= 'a' and <= 'z' or >= '0' and <= '9' or ':' or '_')))
                    reason = "unavailable";
                Console.Error.WriteLine("fixture_hkcu_selftest_" + reason);
                return 3;
            }
        }
#endif
        Console.WriteLine("no_production_publisher_entrypoint");
        return 2;
    }
}
