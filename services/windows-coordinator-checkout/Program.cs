#if CHECKOUT_FIXTURE
using System.Text.Json;
using System.Text.Json.Serialization;
#endif

namespace LexRunner.WindowsCoordinator.Git;

internal static class Program
{
    private static int Main(string[] args)
    {
#if CHECKOUT_FIXTURE
        if (args.Length == 13 &&
            (args[0] == "--fixture-populate" || args[0] == "--fixture-observe"))
        {
            try
            {
                var slot = new ImportSlot(args[1], args[2], args[3], args[4], args[5],
                    args[6], args[7], args[8], args[9]);
                using var profile = GraphSelectedGitProfile.Open(args[11], args[12]);
                var report = (args[0] == "--fixture-populate"
                    ? CheckoutPopulation.RunAsync(slot, args[10], profile,
                        CancellationToken.None)
                    : CheckoutPopulation.ObserveAsync(slot, args[10], profile,
                        CancellationToken.None)).GetAwaiter().GetResult();
                Console.WriteLine(JsonSerializer.Serialize(report,
                    CheckoutJsonContext.Default.CheckoutReport));
                return report.Populated ? 0 : 1;
            }
            catch (Exception error)
            {
                var report = new CheckoutReport(false, "refused_before_checkout_entry",
                    error.GetType().Name + ":" + error.Message, false, false, null, null,
                    [], []);
                Console.WriteLine(JsonSerializer.Serialize(report,
                    CheckoutJsonContext.Default.CheckoutReport));
                return 3;
            }
        }
#endif
        Console.Error.WriteLine("no_production_checkout_entrypoint");
        return 2;
    }
}

#if CHECKOUT_FIXTURE
[JsonSerializable(typeof(CheckoutReport))]
internal partial class CheckoutJsonContext : JsonSerializerContext;
#endif
