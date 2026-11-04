#if SELECTION_PUBLISHER_FIXTURE || COORDINATOR_CLIENT_FIXTURE_TESTS || COORDINATOR_SERVICE_FIXTURE_TESTS
using System.Globalization;
using System.Runtime.Versioning;

namespace LexRunner.WindowsCoordinator.SelectionCustody;

// Pure in-memory vectors shared byte-for-byte by the three fixture images.
// No file/registry/process/native API is called. Receipts below are synthetic
// assertions and deliberately cannot become authenticated persistence or drain.
[SupportedOSPlatform("windows")]
internal static class PublicationContractV3FixtureTests
{
    private static readonly string Epoch = Id(100);
    private static readonly string Evidence = Id(101);
    private static readonly string Service = Id(103);
    private static int count;
    private static int failures;

    internal static int Run()
    {
        count = 0; failures = 0;
        var empty = PublicationContractV3.Empty(Epoch);
        var intent = Intent(empty, 1, "initial", Selection('a', 1));
        var begin = PublicationContractV3.Begin(empty, intent);
        Check("empty_begin_is_non_authorizing", () =>
            Require(begin.Next == "persist_intent" && !begin.AuthorizesLaunch && !begin.AuthorizesEffect));
        Check("empty_inspection", () => Require(PublicationContractV3.Inspect(empty).Next == "begin_required"));
        var (first, prefixes) = Finish(begin.State);
        var catalogs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [new string('a', 64)] = PublicationContractV3.CatalogForSelection(Selection('a', 1))
        };
        Check("completed_comparison_still_not_authority", () =>
        {
            var result = PublicationContractV3.AssessAcquisition(first, Epoch, 1, Selection('a', 1), catalogs);
            Require(result.Reason == "model_consistent_requires_native_authority" &&
                !result.AuthorizesLaunch && !result.AuthorizesEffect);
        });
        Check("wrong_epoch_refuses", () => Require(PublicationContractV3.AssessAcquisition(
            first, Id(999), 1, Selection('a', 1), catalogs).Reason == "epoch_mismatch"));
        Check("old_highwater_refuses", () => Require(PublicationContractV3.AssessAcquisition(
            first, Epoch, 0, Selection('a', 1), catalogs).Reason == "projection_mismatch"));
        Check("selection_projection_refuses", () => Require(PublicationContractV3.AssessAcquisition(
            first, Epoch, 1, Selection('a', 2), catalogs).Reason == "projection_mismatch"));
        Check("extra_catalog_projection_refuses", () =>
        {
            var extra = new Dictionary<string, string>(catalogs) { [Id(500)] = "forged" };
            Require(PublicationContractV3.AssessAcquisition(first, Epoch, 1, Selection('a', 1), extra)
                .Reason == "projection_mismatch");
        });
        Check("completed_explicit_recovery_is_query_only", () =>
        {
            var plan = PublicationContractV3.Recover(first, intent);
            Require(plan.Next == "already_recorded" && plan.LiveStep is null && !plan.AuthorizesEffect);
        });
        foreach (var (prefix, number) in prefixes.Select((text, index) => (text, index)))
        {
            Check("interruption_prefix_" + number, () =>
            {
                var inspected = PublicationContractV3.Inspect(prefix);
                var recovered = PublicationContractV3.Recover(prefix, intent);
                Require(inspected.LiveStep is null && recovered.LiveStep is null &&
                    (inspected.Next == recovered.Next || inspected.Next == "publication_complete" &&
                        recovered.Next == "already_recorded") && !recovered.AuthorizesEffect);
                if (inspected.Next != "publication_complete")
                {
                    Reject(() => PublicationContractV3.Begin(prefix,
                        Intent(prefix, 2, "update", Selection('b', 2))));
                    Require(PublicationContractV3.AssessAcquisition(prefix, Epoch, 1,
                        Selection('a', 1), catalogs).Selection is null);
                }
            });
        }
        Check("restart_issued_close_never_replays", () =>
        {
            var pending = prefixes.First(text => PublicationContractV3.Inspect(text).Next ==
                "reconcile_required:close_admissions");
            Require(PublicationContractV3.Recover(pending, intent).Next ==
                "reconcile_required:close_admissions");
        });
        Check("changed_recovery_target_refuses", () => Reject(() => PublicationContractV3.Recover(
            begin.State, intent.Replace(Id(101), Id(404), StringComparison.Ordinal))));
        Check("wrong_predecessor_refuses", () => Reject(() => PublicationContractV3.Begin(empty,
            intent.Replace(PublicationContractV3.Digest(empty), Id(405), StringComparison.Ordinal))));
        Check("revision_jump_refuses", () => Reject(() => PublicationContractV3.Begin(empty,
            intent.Replace("\"targetRevision\":1", "\"targetRevision\":2", StringComparison.Ordinal))));
        Check("unsafe_revision_refuses", () => Reject(() => PublicationContractV3.Begin(empty,
            intent.Replace("\"targetRevision\":1", "\"targetRevision\":9007199254740992", StringComparison.Ordinal))));
        Check("fractional_revision_refuses", () => Reject(() => PublicationContractV3.Begin(empty,
            intent.Replace("\"targetRevision\":1", "\"targetRevision\":1.5", StringComparison.Ordinal))));
        Check("duplicate_operation_refuses", () => Reject(() => PublicationContractV3.Begin(first,
            Intent(first, 1, "update", Selection('b', 2)))));
        Check("admission_fence_reuse_refuses", () => Reject(() => PublicationContractV3.Begin(first,
            Intent(first, 2, "update", Selection('b', 2)).Replace(Id(1002), Id(1001), StringComparison.Ordinal))));
        Check("caller_approved_field_refuses", () => Reject(() => PublicationContractV3.Begin(empty,
            intent.Replace("{\"admissionFence\":", "{\"approved\":true,\"admissionFence\":", StringComparison.Ordinal))));
        Check("initial_replay_refuses", () => Reject(() => PublicationContractV3.Begin(first, intent)));
        Check("stale_ack_refuses", () =>
        {
            var ack = PublicationContractV3.DescribeAcknowledgement(begin.State, "intent", "confirmed", Evidence);
            var after = PublicationContractV3.Acknowledge(begin.State, ack).State;
            Reject(() => PublicationContractV3.Acknowledge(after, ack));
        });
        Check("phase_skip_refuses", () => Reject(() => Ack(begin.State, "scm_cutover", "issued")));
        Check("no_terminal_without_issue", () =>
        {
            var after = Ack(begin.State, "intent", "confirmed").State;
            Reject(() => Ack(after, "close_admissions", "confirmed"));
        });
        Check("intent_unknown_cannot_permit_effect", () => Reject(() => Ack(begin.State, "intent", "unknown")));
        Check("intent_requires_clean_counters", () => Reject(() => Ack(begin.State, "intent", "confirmed", 0, 1)));
        Check("live_issue_description_not_rehydrated_permit", () =>
        {
            var after = Ack(begin.State, "intent", "confirmed").State;
            var issue = Ack(after, "close_admissions", "issued");
            Require(issue.LiveStep == "close_admissions" && !issue.AuthorizesEffect &&
                PublicationContractV3.Inspect(issue.State).LiveStep is null);
        });
        foreach (var step in new[] { "close_admissions", "drain", "catalog", "high_water",
            "scm_cutover", "selection", "commit", "reopen_admissions" })
        {
            Check("unknown_latched_" + step, () =>
            {
                var issued = prefixes.First(text => PublicationContractV3.Inspect(text).Next ==
                    "reconcile_required:" + step);
                var unknown = Ack(issued, step, "unknown").State;
                Require(PublicationContractV3.Recover(unknown, intent).Next == "quarantined:" + step);
                Reject(() => Ack(unknown, step, "confirmed"));
                Reject(() => PublicationContractV3.Begin(unknown,
                    Intent(unknown, 9, "update", Selection('b', 2))));
            });
        }
        var drainIssued = prefixes.First(text => PublicationContractV3.Inspect(text).Next ==
            "reconcile_required:drain");
        Check("drain_active_session_refuses", () => Reject(() => Ack(drainIssued, "drain", "confirmed", 1)));
        Check("drain_unknown_effect_refuses", () => Reject(() => Ack(drainIssued, "drain", "confirmed", 0, 1)));
        Check("drain_native_uncertainty_refuses", () => Reject(() => Ack(drainIssued, "drain", "confirmed", 0, 0, true)));
        Check("bad_count_refuses", () => Reject(() => Ack(drainIssued, "drain", "unknown", -1)));
        Check("scm_requires_full_drain_prefix", () =>
        {
            Reject(() => Ack(drainIssued, "scm_cutover", "issued"));
            var unknown = Ack(drainIssued, "drain", "unknown", 0, 1, true).State;
            Reject(() => Ack(unknown, "scm_cutover", "issued"));
        });
        var secondIntent = Intent(first, 2, "update", Selection('b', 2));
        var (second, _) = Finish(PublicationContractV3.Begin(first, secondIntent).State);
        Check("two_retained_catalogs_not_single_current_only", () =>
        {
            var retained = new Dictionary<string, string>(catalogs)
            { [new string('b', 64)] = PublicationContractV3.CatalogForSelection(Selection('b', 2)) };
            Require(PublicationContractV3.AssessAcquisition(second, Epoch, 2, Selection('b', 2), retained)
                .Reason == "model_consistent_requires_native_authority");
        });
        Check("retained_old_target_requires_explicit_rollback", () => Reject(() => PublicationContractV3.Begin(
            second, Intent(second, 3, "update", Selection('a', 3)))));
        Check("rollback_unretained_target_refuses", () => Reject(() => PublicationContractV3.Begin(
            second, Intent(second, 3, "rollback", Selection('c', 3)))));
        Check("explicit_rollback_higher_revision", () =>
        {
            var (rollback, _) = Finish(PublicationContractV3.Begin(second,
                Intent(second, 3, "rollback", Selection('a', 3))).State);
            Require(PublicationContractV3.Inspect(rollback).Next == "publication_complete");
            Reject(() => PublicationContractV3.Begin(second,
                Intent(second, 3, "rollback", Selection('a', 1))));
        });
        Check("same_generation_changed_catalog_refuses", () => Reject(() => PublicationContractV3.Begin(
            first, Intent(first, 2, "update", Selection('a', 2).Replace(new string('c', 64),
                new string('d', 64), StringComparison.Ordinal)))));
        Check("same_generation_refresh_is_explicit_new_revision", () =>
        {
            var (refresh, _) = Finish(PublicationContractV3.Begin(first,
                Intent(first, 2, "update", Selection('a', 2))).State);
            Require(PublicationContractV3.Inspect(refresh).Next == "publication_complete");
        });
        Check("retire_keeps_history_and_highwater", () =>
        {
            var retirementIntent = Intent(second, 4, "retire", null);
            var (retired, retirementPrefixes) = Finish(PublicationContractV3.Begin(second,
                retirementIntent).State);
            Require(PublicationContractV3.Inspect(retired).Next == "retired_retained" &&
                retired.Contains(SelectionEscaped('a', 1), StringComparison.Ordinal) &&
                PublicationContractV3.AssessAcquisition(retired, Epoch, 3, null, catalogs).Reason == "retired_retained");
            Reject(() => PublicationContractV3.Begin(retired, Intent(retired, 5, "initial", Selection('c', 4))));
            Reject(() => PublicationContractV3.Begin(retired, Intent(retired, 5, "retire", null)));
            var resumedIntent = Intent(retired, 5, "rollback", Selection('a', 4));
            Require(resumedIntent.Contains("\"expectedHighWater\":3", StringComparison.Ordinal));
            var (resumed, _) = Finish(PublicationContractV3.Begin(retired, resumedIntent).State);
            Require(PublicationContractV3.Inspect(resumed).Next == "publication_complete");
            var issuedRetirement = retirementPrefixes.First(text => PublicationContractV3.Inspect(text).Next ==
                "reconcile_required:retire_objects");
            var unknownRetirement = Ack(issuedRetirement, "retire_objects", "unknown").State;
            Require(PublicationContractV3.Recover(unknownRetirement, retirementIntent).Next ==
                "quarantined:retire_objects");
            Reject(() => Ack(unknownRetirement, "retire_objects", "confirmed"));
        });
        Check("parallel_plans_are_not_CAS_or_authority", () =>
        {
            var contender = Intent(first, 6, "update", Selection('c', 2));
            var left = PublicationContractV3.Begin(first, secondIntent);
            var right = PublicationContractV3.Begin(first, contender);
            Require(!left.AuthorizesEffect && !right.AuthorizesEffect);
            Reject(() => PublicationContractV3.Begin(left.State, contender));
            Reject(() => PublicationContractV3.Begin(second, contender));
        });
        Check("missing_history_is_not_epoch_enrollment", () =>
        {
            Require(PublicationContractV3.AssessAcquisition(empty, Epoch, 0, null, catalogs).Reason ==
                "publication_absent");
            Reject(() => PublicationContractV3.Begin(empty, secondIntent));
        });
        Check("synthetic_forged_receipts_never_authorize", () =>
        {
            // Entire first state was fabricated by this fixture, not installed.
            var result = PublicationContractV3.AssessAcquisition(first, Epoch, 1, Selection('a', 1), catalogs);
            Require(!result.AuthorizesLaunch && !result.AuthorizesEffect);
        });
        Check("zero_digest_refuses", () => Reject(() => PublicationContractV3.Empty(new string('0', 64))));
        Check("duplicate_property_refuses", () => Reject(() => PublicationContractV3.Inspect(
            empty.Replace("{\"epoch\":", "{\"epoch\":\"" + Epoch + "\",\"epoch\":", StringComparison.Ordinal))));
        Check("unknown_property_refuses", () => Reject(() => PublicationContractV3.Inspect(
            empty.Replace("{\"epoch\":", "{\"extra\":false,\"epoch\":", StringComparison.Ordinal))));
        Check("whitespace_refuses", () => Reject(() => PublicationContractV3.Inspect(" " + empty)));
        Check("unknown_schema_refuses", () => Reject(() => PublicationContractV3.Inspect(
            empty.Replace("publication-state/1", "publication-state/2", StringComparison.Ordinal))));
        Check("oversize_refuses", () => Reject(() => PublicationContractV3.Inspect(new string(' ', PublicationContractV3.MaxBytes + 1))));
        Check("bad_profile_refuses", () => Reject(() => PublicationContractV3.Begin(empty,
            Intent(empty, 1, "initial", Selection('a', 1).Replace("msi/3", "msi/2", StringComparison.Ordinal)))));
        Check("catalog_capacity_no_prune", () =>
        {
            var state = first;
            for (var n = 2; n <= PublicationContractV3.MaxGenerations; n++)
                (state, _) = Finish(PublicationContractV3.Begin(state,
                    Intent(state, n, "update", Selection("abcdef12"[n - 1], n))).State);
            Reject(() => PublicationContractV3.Begin(state, Intent(state, 9, "update", Selection('9', 9))));
        });
        Check("operation_capacity_no_prune", () =>
        {
            var state = first;
            for (var n = 2; n <= PublicationContractV3.MaxOperations; n++)
                (state, _) = Finish(PublicationContractV3.Begin(state,
                    Intent(state, n, "update", Selection('a', n))).State);
            Reject(() => PublicationContractV3.Begin(state,
                Intent(state, 99, "update", Selection('a', PublicationContractV3.MaxOperations + 1))));
        });
        Console.WriteLine("publication_contract_pure_selftest " + (failures == 0 ? "PASS" : "BLOCK") +
            " cases=" + count + " failures=" + failures + " authorizesLaunch=false authorizesEffect=false nativeEffects=0");
        return failures == 0 ? 0 : 1;
    }

    private static (string State, List<string> Prefixes) Finish(string state)
    {
        var prefixes = new List<string> { state };
        for (var n = 0; n < 18; n++)
        {
            var next = PublicationContractV3.Inspect(state).Next;
            if (next is "publication_complete" or "retired_retained") return (state, prefixes);
            if (next == "persist_intent") state = Ack(state, "intent", "confirmed").State;
            else if (next.StartsWith("record_issue:", StringComparison.Ordinal))
            {
                var step = next["record_issue:".Length..];
                var issue = Ack(state, step, "issued");
                Require(issue.LiveStep == step && !issue.AuthorizesEffect);
                prefixes.Add(issue.State);
                state = Ack(issue.State, step, "confirmed").State;
            }
            else throw new InvalidOperationException("fixture_unexpected_next");
            prefixes.Add(state);
        }
        throw new InvalidOperationException("fixture_step_bound");
    }
    private static PublicationContractV3.Plan Ack(string state, string step, string outcome,
        int active = 0, int unresolved = 0, bool nativeUnknown = false) =>
        PublicationContractV3.Acknowledge(state, PublicationContractV3.DescribeAcknowledgement(
            state, step, outcome, Evidence, active, unresolved, nativeUnknown));
    private static string Intent(string state, int id, string kind, string? selection) =>
        PublicationContractV3.DescribeIntent(state, Id(id), kind, selection, Evidence, Id(1000 + id), Service);
    private static string Id(int value) => value.ToString("x64", CultureInfo.InvariantCulture);
    private static string Selection(char generation, long revision) =>
        "{\"coordinatorProtocolVersion\":\"1.0.0\",\"generationId\":\"" + new string(generation, 64) +
        "\",\"graphDigest\":\"" + new string(generation, 64) + "\",\"manifestSha256\":\"" + new string('c', 64) +
        "\",\"profile\":\"windows-coordinator-service-msi/3\",\"revision\":" + revision.ToString(CultureInfo.InvariantCulture) +
        ",\"schemaVersion\":\"windows-coordinator-active-selection/3\",\"serviceImageSha256\":\"" + new string('d', 64) +
        "\",\"serviceName\":\"LexRunnerCoordinator\",\"workerServiceImageSha256\":\"" + new string('e', 64) +
        "\",\"workerServiceName\":\"LexRunnerWorkerSlot1\"}";
    private static string SelectionEscaped(char generation, long revision) =>
        Selection(generation, revision).Replace("\"", "\\u0022", StringComparison.Ordinal);
    private static void Reject(Action action)
    {
        try { action(); }
        catch (Exception error) when (error is PublicationContractV3.Refusal or CustodyException) { return; }
        throw new InvalidOperationException("expected_refusal");
    }
    private static void Require(bool condition)
    { if (!condition) throw new InvalidOperationException("fixture_assertion"); }
    private static void Check(string name, Action test)
    {
        count++;
        try { test(); Console.WriteLine("case=" + name + " PASS"); }
        catch (Exception error) { failures++; Console.WriteLine("case=" + name + " BLOCK type=" + error.GetType().Name); }
    }
}
#endif
