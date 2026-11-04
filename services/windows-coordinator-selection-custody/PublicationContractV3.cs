using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LexRunner.WindowsCoordinator.SelectionCustody;

// Mechanical source model, not policy, a journal adapter, a persistence receipt,
// an authenticated administration protocol, or an installed acquisition factory.
// All input acknowledgements are supplied comparison data. A future protected
// owner must authenticate them, serialize/CAS durable writes and retain native
// custody. Rehydrating an issued row NEVER emits a dispatch instruction.
[SupportedOSPlatform("windows")]
internal static class PublicationContractV3
{
    internal const int MaxOperations = 32;
    internal const int MaxGenerations = 8;
    internal const int MaxBytes = 262144;
    internal const long MaxRevision = 9_007_199_254_740_991;
    private const string Schema = "windows-coordinator-publication-state/1";
    private const string Zero = "0000000000000000000000000000000000000000000000000000000000000000";
    private static readonly string[] SelectSteps = ["close_admissions", "drain", "catalog",
        "high_water", "scm_cutover", "selection", "commit", "reopen_admissions"];
    private static readonly string[] RetireSteps = ["close_admissions", "drain", "high_water",
        "selection", "commit", "retire_objects"];
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal sealed record Plan(string State, string Next, string? LiveStep = null)
    {
        // LiveStep describes the single live model transition only. It is neither
        // serializable dispatch authority nor proof that a native effect ran.
        internal bool AuthorizesLaunch => false;
        internal bool AuthorizesEffect => false;
    }

    internal sealed record Assessment(string Reason, string? Selection)
    {
        internal bool AuthorizesLaunch => false;
        internal bool AuthorizesEffect => false;
    }

    private sealed record Intent(string AdmissionFence, long ExpectedHighWater, string Kind,
        string OperationId, string PredecessorDigest, string ProvenanceReference,
        string? Selection, string ServiceBindingDigest, long TargetRevision);
    private sealed record Receipt(int ActiveSessions, string EvidenceDigest, bool NativeUnknown,
        string Outcome, string Step, int UnresolvedEffects);
    private sealed record Operation(Intent Intent, Receipt[] Receipts);
    private sealed record State(string Epoch, Operation[] Operations);
    internal sealed class Refusal(string reason) : Exception(reason);

    internal static string Empty(string epoch)
    {
        RequireDigest(epoch);
        return WriteState(new State(epoch, []));
    }

    internal static string Digest(string canonical) =>
        Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(canonical))).ToLowerInvariant();

    // Authoring comparison bytes cannot approve a target or mint an installation
    // epoch. The epoch and provenance reference require independent custody later.
    internal static string DescribeIntent(string state, string operationId, string kind,
        string? selection, string provenanceReference, string admissionFence,
        string serviceBindingDigest)
    {
        var current = ParseState(state);
        var highWater = HighWater(current);
        if (highWater == MaxRevision) throw new Refusal("revision_exhausted");
        return WriteIntent(new Intent(admissionFence, highWater, kind, operationId,
            Digest(state), provenanceReference, selection, serviceBindingDigest, highWater + 1));
    }

    internal static Plan Begin(string state, string intent)
    {
        var current = ParseState(state);
        if (current.Operations.Length != 0 && !Complete(current.Operations[^1]))
            throw new Refusal("recovery_required");
        if (current.Operations.Length >= MaxOperations) throw new Refusal("history_full");
        var candidate = ParseIntent(intent);
        var next = new State(current.Epoch, [.. current.Operations, new Operation(candidate, [])]);
        var text = WriteState(next);
        // Reserve the complete fixed receipt suffix before admitting an intent.
        // Capacity failure must not strand a valid operation halfway through.
        if (StrictUtf8.GetByteCount(text) + 8192 > MaxBytes)
            throw new Refusal("byte_capacity");
        _ = ParseState(text); // validates exact predecessor, revision and history together
        return new Plan(text, "persist_intent");
    }

    internal static Plan Inspect(string state)
    {
        var parsed = ParseState(state);
        return new Plan(state, Next(parsed));
    }

    internal static Plan Recover(string state, string exactPriorIntent)
    {
        var parsed = ParseState(state);
        _ = ParseIntent(exactPriorIntent);
        if (parsed.Operations.Length == 0 ||
            WriteIntent(parsed.Operations[^1].Intent) != exactPriorIntent)
            throw new Refusal("recovery_intent_conflict");
        // Explicit recovery only plans the next durable record or reconciliation.
        // It cannot reconstruct a lost live effect permit from a snapshot.
        return new Plan(state, Complete(parsed.Operations[^1]) ? "already_recorded" : Next(parsed));
    }

    // Fixed canonical event authoring for native-adapter/fixture comparison. This
    // function never observes persistence, a process, drain or operator approval.
    internal static string DescribeAcknowledgement(string state, string step, string outcome,
        string evidenceDigest, int activeSessions = 0, int unresolvedEffects = 0,
        bool nativeUnknown = false)
    {
        var parsed = ParseState(state);
        if (parsed.Operations.Length == 0) throw new Refusal("operation_absent");
        return Json(w =>
        {
            w.WriteStartObject();
            w.WriteNumber("activeSessions", activeSessions);
            w.WriteString("evidenceDigest", evidenceDigest);
            w.WriteBoolean("nativeUnknown", nativeUnknown);
            w.WriteString("operationId", parsed.Operations[^1].Intent.OperationId);
            w.WriteString("outcome", outcome);
            w.WriteString("stateDigest", Digest(state));
            w.WriteString("step", step);
            w.WriteNumber("unresolvedEffects", unresolvedEffects);
            w.WriteEndObject();
        });
    }

    internal static Plan Acknowledge(string state, string acknowledgement)
    {
        var parsed = ParseState(state);
        if (parsed.Operations.Length == 0) throw new Refusal("operation_absent");
        using var document = Document(acknowledgement, 2048);
        var root = document.RootElement;
        Names(root, "activeSessions", "evidenceDigest", "nativeUnknown", "operationId",
            "outcome", "stateDigest", "step", "unresolvedEffects");
        var last = parsed.Operations[^1];
        if (String(root, "stateDigest") != Digest(state) ||
            String(root, "operationId") != last.Intent.OperationId)
            throw new Refusal("stale_acknowledgement");
        var receipt = ReadReceipt(root);
        var canonical = DescribeAcknowledgement(state, receipt.Step, receipt.Outcome,
            receipt.EvidenceDigest, receipt.ActiveSessions, receipt.UnresolvedEffects,
            receipt.NativeUnknown);
        if (canonical != acknowledgement) throw new Refusal("noncanonical_acknowledgement");
        if (Complete(last)) throw new Refusal("operation_complete");
        var updated = new Operation(last.Intent, [.. last.Receipts, receipt]);
        parsed.Operations[^1] = updated;
        var next = WriteState(parsed);
        _ = ParseState(next);
        // This description is returned ONLY on the live append of an issued row.
        // Inspect/Recover of the very same bytes refuse replay and require
        // reconciliation. Native durable CAS/custody is deliberately not supplied.
        var live = receipt.Outcome == "issued" ? receipt.Step : null;
        return new Plan(next, Next(parsed), live);
    }

    internal static Assessment AssessAcquisition(string state, string expectedEpoch, long observedHighWater,
        string? observedSelection, IReadOnlyDictionary<string, string> observedCatalogs)
    {
        var parsed = ParseState(state);
        RequireDigest(expectedEpoch);
        if (parsed.Epoch != expectedEpoch) return new Assessment("epoch_mismatch", null);
        if (parsed.Operations.Length == 0) return new Assessment("publication_absent", null);
        var last = parsed.Operations[^1];
        if (!Complete(last)) return new Assessment("publication_pending_or_unknown", null);
        if (last.Intent.Kind == "retire") return new Assessment("retired_retained", null);
        var expected = Catalogs(parsed);
        if (observedHighWater != HighWater(parsed) || observedSelection != last.Intent.Selection ||
            expected.Count != observedCatalogs.Count || expected.Any(pair =>
                !observedCatalogs.TryGetValue(pair.Key, out var value) || value != pair.Value))
            return new Assessment("projection_mismatch", null);
        return new Assessment("model_consistent_requires_native_authority", last.Intent.Selection);
    }

    internal static string CatalogForSelection(string canonicalSelection)
    {
        var selection = CustodyContractV3.ParseSelection(canonicalSelection);
        return Json(w =>
        {
            w.WriteStartObject();
            w.WriteString("GraphDigest", selection.GraphDigest);
            w.WriteString("ManifestDigest", selection.ManifestDigest);
            w.WriteString("ServiceImageDigest", selection.ServiceImageDigest);
            w.WriteString("ServiceName", "LexRunnerCoordinator");
            w.WriteString("State", "qualified"); // a claim, never qualification evidence
            w.WriteString("WorkerServiceImageDigest", selection.WorkerServiceImageDigest);
            w.WriteString("WorkerServiceName", "LexRunnerWorkerSlot1");
            w.WriteEndObject();
        });
    }

    private static State ParseState(string text)
    {
        using var document = Document(text, MaxBytes);
        var root = document.RootElement;
        Names(root, "epoch", "operations", "schemaVersion");
        if (String(root, "schemaVersion") != Schema) throw new Refusal("schema_mismatch");
        var epoch = String(root, "epoch");
        RequireDigest(epoch);
        var operations = root.GetProperty("operations");
        if (operations.ValueKind != JsonValueKind.Array || operations.GetArrayLength() > MaxOperations)
            throw new Refusal("history_full_or_invalid");
        var result = new List<Operation>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var fences = new HashSet<string>(StringComparer.Ordinal);
        var catalogs = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var value in operations.EnumerateArray())
        {
            Names(value, "intent", "receipts");
            if (result.Count != 0 && !Complete(result[^1])) throw new Refusal("unfinished_predecessor");
            var prior = new State(epoch, [.. result]);
            var intent = ReadIntent(value.GetProperty("intent"));
            if (!ids.Add(intent.OperationId)) throw new Refusal("duplicate_operation");
            if (!fences.Add(intent.AdmissionFence)) throw new Refusal("reused_admission_fence");
            if (intent.ExpectedHighWater != HighWater(prior) ||
                intent.ExpectedHighWater == MaxRevision ||
                intent.TargetRevision != intent.ExpectedHighWater + 1 ||
                intent.PredecessorDigest != Digest(WriteState(prior)))
                throw new Refusal("predecessor_or_revision_mismatch");
            if ((result.Count == 0) != (intent.Kind == "initial"))
                throw new Refusal("initial_history_mismatch");
            if (intent.Kind == "retire")
            {
                if (result.Count == 0 || result[^1].Intent.Selection is null)
                    throw new Refusal("no_active_selection_to_retire");
            }
            else
            {
                var selection = CustodyContractV3.ParseSelection(intent.Selection!);
                var catalog = CatalogForSelection(intent.Selection!);
                if (selection.Revision != intent.TargetRevision)
                    throw new Refusal("target_revision_mismatch");
                if (catalogs.TryGetValue(selection.GenerationId, out var existing))
                {
                    if (existing != catalog) throw new Refusal("catalog_identity_conflict");
                    var active = result.Count == 0 || result[^1].Intent.Selection is null ? null :
                        CustodyContractV3.ParseSelection(result[^1].Intent.Selection!).GenerationId;
                    if (intent.Kind == "update" && active != selection.GenerationId)
                        throw new Refusal("retained_target_requires_explicit_rollback");
                }
                else
                {
                    if (intent.Kind == "rollback") throw new Refusal("rollback_target_not_retained");
                    if (catalogs.Count == MaxGenerations) throw new Refusal("catalog_capacity");
                }
            }
            var receiptsField = value.GetProperty("receipts");
            if (receiptsField.ValueKind != JsonValueKind.Array || receiptsField.GetArrayLength() > 17)
                throw new Refusal("receipts_invalid");
            var receipts = receiptsField.EnumerateArray().Select(item =>
            {
                Names(item, "activeSessions", "evidenceDigest", "nativeUnknown", "outcome",
                    "step", "unresolvedEffects");
                return ReadReceipt(item);
            }).ToArray();
            var operation = new Operation(intent, receipts);
            ValidateReceipts(operation);
            result.Add(operation);
            if (intent.Selection is not null && HasConfirmed(operation, "catalog"))
            {
                var selected = CustodyContractV3.ParseSelection(intent.Selection);
                catalogs[selected.GenerationId] = CatalogForSelection(intent.Selection);
            }
        }
        var state = new State(epoch, [.. result]);
        if (WriteState(state) != text) throw new Refusal("noncanonical_state");
        return state;
    }

    private static void ValidateReceipts(Operation operation)
    {
        var index = 0;
        if (operation.Receipts.Length == 0) return;
        var first = operation.Receipts[index++];
        if (first.Step != "intent" || first.Outcome != "confirmed" || !Clean(first))
            throw new Refusal("intent_not_persisted");
        foreach (var step in Steps(operation))
        {
            if (index == operation.Receipts.Length) return;
            var issued = operation.Receipts[index++];
            if (issued.Step != step || issued.Outcome != "issued" || !Clean(issued))
                throw new Refusal("issue_order_mismatch");
            if (index == operation.Receipts.Length) return;
            var terminal = operation.Receipts[index++];
            if (terminal.Step != step || terminal.Outcome is not ("confirmed" or "unknown"))
                throw new Refusal("terminal_order_mismatch");
            if (terminal.Outcome == "unknown")
            {
                if (index != operation.Receipts.Length) throw new Refusal("unknown_latched");
                return;
            }
            if (!Clean(terminal)) throw new Refusal("drain_or_effects_unresolved");
        }
        if (index != operation.Receipts.Length) throw new Refusal("extra_receipt");
    }

    private static bool Clean(Receipt receipt) => receipt.ActiveSessions == 0 &&
        receipt.UnresolvedEffects == 0 && !receipt.NativeUnknown;
    private static string[] Steps(Operation operation) =>
        operation.Intent.Kind == "retire" ? RetireSteps : SelectSteps;
    private static bool Complete(Operation operation) => operation.Receipts.Length ==
        1 + 2 * Steps(operation).Length && operation.Receipts[^1].Outcome == "confirmed";
    private static bool HasConfirmed(Operation operation, string step) =>
        operation.Receipts.Any(receipt => receipt.Step == step && receipt.Outcome == "confirmed");
    private static long HighWater(State state) => state.Operations.Length == 0 ? 0 :
        state.Operations[^1].Intent.TargetRevision;

    private static Dictionary<string, string> Catalogs(State state)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var operation in state.Operations)
            if (operation.Intent.Selection is not null && HasConfirmed(operation, "catalog"))
            {
                var selected = CustodyContractV3.ParseSelection(operation.Intent.Selection);
                result[selected.GenerationId] = CatalogForSelection(operation.Intent.Selection);
            }
        return result;
    }

    private static string Next(State state)
    {
        if (state.Operations.Length == 0) return "begin_required";
        var operation = state.Operations[^1];
        if (operation.Receipts.Length == 0) return "persist_intent";
        if (Complete(operation)) return operation.Intent.Kind == "retire" ?
            "retired_retained" : "publication_complete";
        var last = operation.Receipts[^1];
        if (last.Outcome == "unknown") return "quarantined:" + last.Step;
        if (last.Outcome == "issued") return "reconcile_required:" + last.Step;
        var phase = (operation.Receipts.Length - 1) / 2;
        return "record_issue:" + Steps(operation)[phase];
    }

    private static Intent ParseIntent(string text)
    {
        using var document = Document(text, 8192);
        var result = ReadIntent(document.RootElement);
        if (WriteIntent(result) != text) throw new Refusal("noncanonical_intent");
        return result;
    }

    private static Intent ReadIntent(JsonElement root)
    {
        Names(root, "admissionFence", "expectedHighWater", "kind", "operationId",
            "predecessorDigest", "provenanceReference", "selection", "serviceBindingDigest",
            "targetRevision");
        var result = new Intent(String(root, "admissionFence"), Number(root, "expectedHighWater"),
            String(root, "kind"), String(root, "operationId"), String(root, "predecessorDigest"),
            String(root, "provenanceReference"), NullableString(root, "selection"),
            String(root, "serviceBindingDigest"), Number(root, "targetRevision"));
        foreach (var digest in new[] { result.AdmissionFence, result.OperationId,
            result.PredecessorDigest, result.ProvenanceReference, result.ServiceBindingDigest })
            RequireDigest(digest);
        if (result.Kind is not ("initial" or "update" or "rollback" or "retire") ||
            (result.Kind == "retire") != (result.Selection is null) ||
            result.ExpectedHighWater is < 0 or > MaxRevision ||
            result.TargetRevision is < 1 or > MaxRevision)
            throw new Refusal("intent_invalid");
        if (result.Selection is not null) _ = CustodyContractV3.ParseSelection(result.Selection);
        return result;
    }

    private static Receipt ReadReceipt(JsonElement root)
    {
        var active = Number(root, "activeSessions");
        var effects = Number(root, "unresolvedEffects");
        if (active is < 0 or > 10000 || effects is < 0 or > 10000)
            throw new Refusal("receipt_count_invalid");
        var evidence = String(root, "evidenceDigest");
        RequireDigest(evidence);
        var outcome = String(root, "outcome");
        var step = String(root, "step");
        if (outcome is not ("issued" or "confirmed" or "unknown") ||
            (step != "intent" && !SelectSteps.Contains(step, StringComparer.Ordinal) &&
                !RetireSteps.Contains(step, StringComparer.Ordinal)))
            throw new Refusal("receipt_invalid");
        var unknown = root.GetProperty("nativeUnknown");
        if (unknown.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new Refusal("receipt_invalid");
        return new Receipt((int)active, evidence, unknown.GetBoolean(), outcome, step, (int)effects);
    }

    private static string WriteState(State state) => Json(w =>
    {
        w.WriteStartObject();
        w.WriteString("epoch", state.Epoch);
        w.WriteStartArray("operations");
        foreach (var operation in state.Operations)
        {
            w.WriteStartObject();
            w.WritePropertyName("intent"); WriteIntent(w, operation.Intent);
            w.WriteStartArray("receipts");
            foreach (var receipt in operation.Receipts)
            {
                w.WriteStartObject();
                w.WriteNumber("activeSessions", receipt.ActiveSessions);
                w.WriteString("evidenceDigest", receipt.EvidenceDigest);
                w.WriteBoolean("nativeUnknown", receipt.NativeUnknown);
                w.WriteString("outcome", receipt.Outcome);
                w.WriteString("step", receipt.Step);
                w.WriteNumber("unresolvedEffects", receipt.UnresolvedEffects);
                w.WriteEndObject();
            }
            w.WriteEndArray(); w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteString("schemaVersion", Schema);
        w.WriteEndObject();
    });

    private static string WriteIntent(Intent intent) => Json(w => WriteIntent(w, intent));
    private static void WriteIntent(Utf8JsonWriter w, Intent intent)
    {
        w.WriteStartObject();
        w.WriteString("admissionFence", intent.AdmissionFence);
        w.WriteNumber("expectedHighWater", intent.ExpectedHighWater);
        w.WriteString("kind", intent.Kind);
        w.WriteString("operationId", intent.OperationId);
        w.WriteString("predecessorDigest", intent.PredecessorDigest);
        w.WriteString("provenanceReference", intent.ProvenanceReference);
        if (intent.Selection is null) w.WriteNull("selection");
        else w.WriteString("selection", intent.Selection);
        w.WriteString("serviceBindingDigest", intent.ServiceBindingDigest);
        w.WriteNumber("targetRevision", intent.TargetRevision);
        w.WriteEndObject();
    }

    private static string Json(Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer)) { write(writer); }
        if (buffer.Length > MaxBytes) throw new Refusal("byte_capacity");
        return StrictUtf8.GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length));
    }

    private static JsonDocument Document(string text, int maximum)
    {
        if (text is null || text.Length == 0 || StrictUtf8.GetByteCount(text) > maximum)
            throw new Refusal("byte_capacity");
        try { return JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 16 }); }
        catch (JsonException) { throw new Refusal("json_invalid"); }
    }

    private static void Names(JsonElement value, params string[] expected)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new Refusal("shape_invalid");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
            if (!names.Add(property.Name)) throw new Refusal("duplicate_field");
        if (names.Count != expected.Length || expected.Any(name => !names.Contains(name)))
            throw new Refusal("shape_invalid");
    }

    private static string String(JsonElement value, string field) =>
        NullableString(value, field) ?? throw new Refusal("string_invalid");
    private static string? NullableString(JsonElement value, string field)
    {
        var member = value.GetProperty(field);
        if (member.ValueKind == JsonValueKind.Null) return null;
        if (member.ValueKind != JsonValueKind.String) throw new Refusal("string_invalid");
        return member.GetString();
    }
    private static long Number(JsonElement value, string field)
    {
        var member = value.GetProperty(field);
        if (member.ValueKind != JsonValueKind.Number || !member.TryGetInt64(out var result))
            throw new Refusal("number_invalid");
        return result;
    }
    private static void RequireDigest(string value)
    {
        if (value.Length != 64 || value == Zero ||
            value.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')))
            throw new Refusal("digest_invalid");
    }
}
