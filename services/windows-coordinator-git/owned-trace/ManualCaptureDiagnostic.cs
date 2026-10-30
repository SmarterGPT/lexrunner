using System.Text.Json;

// Diagnostic grammar only. A preflight result grants no trace or execution authority.
internal static class ManualCaptureDiagnostic
{
    internal static readonly string[] Checks = ["os", "x64", "event", "source_head",
        "runner_identity", "numeric_ids", "elevation", "native_layout",
        "runner_temp_root", "workspace_root", "git_image_digest", "fixture_image"];

    internal static string? FirstFailure(Func<string, bool> observe)
    {
        foreach (var check in Checks)
        {
            try { if (!observe(check)) return "preflight_" + check; }
            catch { return "preflight_" + check; }
        }
        return null;
    }

    internal static object[] SelfTest()
    {
        var results = new List<object>();
        results.Add(new { name = "all_checks_pass", passed = FirstFailure(_ => true) is null });
        for (var index = 0; index < Checks.Length; index++)
        {
            var target = Checks[index];
            var observed = new List<string>();
            var reason = FirstFailure(check => { observed.Add(check); return check != target; });
            var exceptionReason = FirstFailure(check => check == target ?
                throw new InvalidOperationException("not_logged") : true);
            results.Add(new { name = "first_failed_" + target,
                passed = reason == "preflight_" + target && exceptionReason == reason &&
                    observed.SequenceEqual(Checks.Take(index + 1)) });
        }
        return results.ToArray();
    }

    internal static object Status(string phase, string result, string reason,
        string? summarySha256 = null, string? nativePhase = null, uint? nativeCode = null) => new
    {
        schemaVersion = "lexrunner-owned-etw-manual-status/2",
        phase, result, reasonCode = reason, summarySha256, nativePhase, nativeCode,
        // False is conservative absence of deletion proof, not proof of retained bytes.
        rawEtlDeleted = summarySha256 is not null,
        authorizesLoaderClosure = false,
        authorizesExecution = false,
    };

    internal static void Emit(string phase, string result, string reason, string? summarySha256 = null,
        string? nativePhase = null, uint? nativeCode = null) =>
        Console.Write(JsonSerializer.Serialize(Status(phase, result, reason, summarySha256,
            nativePhase, nativeCode)) + "\n");

    internal static int Refuse(string phase, string reason, string? nativePhase = null, uint? nativeCode = null)
    {
        Emit(phase, "refused", reason, null, nativePhase, nativeCode);
        return 3;
    }
}
