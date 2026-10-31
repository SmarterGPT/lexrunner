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
        var digest = new string('a', 64);
        results.Add(new { name = "status_observed", passed = ValidStatus("summary", "calibration_observed", "calibration_observed", digest, null, null) });
        results.Add(new { name = "status_start_failed_summary", passed = ValidStatus("summary", "refused", "start_failed_or_occupied", digest, "start", 5) });
        results.Add(new { name = "status_initial_readback_zero", passed = ValidStatus("capture", "refused", "initial_ownership_uncertain", null, "initial_query", 0) });
        results.Add(new { name = "status_stop_failed", passed = ValidStatus("capture", "refused", "ownership_or_stop_uncertain", null, "stop", 5) });
        foreach (var reason in new[] { "initial_ownership_uncertain", "ownership_or_stop_uncertain", "job_terminal_uncertain", "census_terminal_uncertain", "cleanup_uncertain", "final_ownership_uncertain", "stop_disposition_uncertain", "ownership_or_stop_exception" })
            results.Add(new { name = "status_uncertain_summary_" + reason, passed = !ValidStatus("summary", "refused", reason, digest, null, null) });
        foreach (var native in new[] { "start", "initial_query", "final_query", "stop" })
            foreach (uint code in new uint[] { 0, 5 })
                results.Add(new { name = "status_observed_native_" + native + "_" + code, passed = !ValidStatus("summary", "calibration_observed", "calibration_observed", digest, native, code) });
        results.Add(new { name = "status_start_missing_code", passed = !ValidStatus("summary", "refused", "start_failed_or_occupied", digest, null, null) });
        results.Add(new { name = "status_start_zero_code", passed = !ValidStatus("summary", "refused", "start_failed_or_occupied", digest, "start", 0) });
        results.Add(new { name = "status_refused_probe_native_stop", passed = !ValidStatus("summary", "refused", "probe_refused", digest, "stop", 5) });
        results.Add(new { name = "status_cleanup_native_stop", passed = !ValidStatus("capture", "refused", "cleanup_uncertain", null, "stop", 5) });
        results.Add(new { name = "status_ownership_native_start", passed = !ValidStatus("capture", "refused", "ownership_or_stop_uncertain", null, "start", 5) });
        results.Add(new { name = "status_initial_native_stop", passed = !ValidStatus("capture", "refused", "initial_ownership_uncertain", null, "stop", 5) });
        return results.ToArray();
    }

    internal static bool ValidStatus(string phase, string result, string reason,
        string? digest, string? nativePhase, uint? nativeCode, NativeActionDiagnostic? nativeActionDiagnostic = null)
    {
        if ((nativePhase is null) != (nativeCode is null)) return false;
        if (nativeActionDiagnostic is not null && (phase != "capture" || result != "refused" ||
            nativePhase is not ("initial_query" or "final_query" or "stop") || nativeCode is null ||
            !nativeActionDiagnostic.Valid(nativeCode.Value, nativePhase!) || (nativePhase == "stop" && nativeActionDiagnostic.FailureStage == "gate"))) return false;
        if (result is not ("refused" or "calibration_observed")) return false;
        if (result == "calibration_observed" && (phase != "summary" || reason != result)) return false;
        if (result == "refused" && reason == "calibration_observed") return false;
        var allowed = phase switch
        {
            "preflight" => reason is "arguments_invalid" or "offline_census_preflight_required" ||
                Checks.Any(check => reason == "preflight_" + check),
            "capture" => reason is "initial_ownership_uncertain" or "ownership_or_stop_uncertain" or
                "job_terminal_uncertain" or "census_terminal_uncertain" or "cleanup_uncertain" or
                "summary_bounds_refused" or "summary_output_occupied" or "summary_write_unavailable",
            "summary" => reason is "calibration_observed" or "capture_unstarted" or "start_failed_or_occupied" or
                "probe_observed" or "probe_refused" or "etl_missing_or_cap_refused" or "owned_loss_refused" or
                "etl_census_or_loss_refused" or "capture_deadline_refused" or "capture_exception",
            _ => false,
        };
        if (!allowed) return false;
        if (phase == "summary")
        {
            if (digest is null || digest.Length != 64 || digest.Any(c => !"0123456789abcdef".Contains(c))) return false;
        }
        else if (digest is not null) return false;
        if (nativePhase is null) return reason != "start_failed_or_occupied";
        if (phase == "preflight" || result != "refused") return false;
        return reason switch
        {
            "initial_ownership_uncertain" => nativePhase == "initial_query" || (nativePhase == "start" && nativeCode == 0),
            "ownership_or_stop_uncertain" => nativePhase is "final_query" or "stop",
            "cleanup_uncertain" or "summary_bounds_refused" or "summary_output_occupied" or
                "summary_write_unavailable" or "start_failed_or_occupied" => nativePhase == "start" && nativeCode != 0,
            _ => false,
        };
    }

    internal static object Status(string phase, string result, string reason,
        string? summarySha256 = null, string? nativePhase = null, uint? nativeCode = null, NativeActionDiagnostic? nativeActionDiagnostic = null)
    {
        if (!ValidStatus(phase, result, reason, summarySha256, nativePhase, nativeCode, nativeActionDiagnostic))
            throw new InvalidOperationException("manual_status_consistency");
        return new
        {
            schemaVersion = "lexrunner-owned-etw-manual-status/6",
            phase, result, reasonCode = reason, summarySha256, nativePhase, nativeCode,
            nativeActionDiagnostic = nativeActionDiagnostic?.Wire(),
            // False is conservative absence of deletion proof, not proof of retained bytes.
            rawEtlDeleted = summarySha256 is not null,
            authorizesLoaderClosure = false,
            authorizesExecution = false,
        };
    }

    internal static void Emit(string phase, string result, string reason, string? summarySha256 = null,
        string? nativePhase = null, uint? nativeCode = null, NativeActionDiagnostic? nativeActionDiagnostic = null) =>
        Console.Write(JsonSerializer.Serialize(Status(phase, result, reason, summarySha256,
            nativePhase, nativeCode, nativeActionDiagnostic)) + "\n");

    internal static int Refuse(string phase, string reason, string? nativePhase = null, uint? nativeCode = null, NativeActionDiagnostic? nativeActionDiagnostic = null)
    {
        Emit(phase, "refused", reason, null, nativePhase, nativeCode, nativeActionDiagnostic);
        return 3;
    }
}
