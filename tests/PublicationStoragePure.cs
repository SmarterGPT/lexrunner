using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Text;
using LexRunner.WindowsCoordinator.SelectionCustody;
using LexRunner.WindowsCoordinator.SelectionPublisher;

[SupportedOSPlatform("windows")]
internal static class PublicationStoragePure
{
    private static int cases;
    private static readonly string Epoch = new('a', 64), Provenance = new('b', 64), Binding = new('c', 64);
    private static readonly string Empty = PublicationContractV3.Empty(Epoch);
    private static readonly string Intent = PublicationContractV3.DescribeIntent(Empty, new string('d', 64), "initial", Selection(), Provenance, new string('e', 64), Binding);

    private static int Main()
    {
        try
        {
            // Only fake IPort/Ownership ports and data parsers are invoked here.
            // No native store/session/reader/entrypoint Run or P/Invoke is called.
            Storage();
            Mutex();
            Data();
            Routes();
            if (PublicationContractV3FixtureTests.Run() != 0) throw new Exception("historical_model_failed");
            Console.WriteLine($"publication_storage_pure PASS cases={cases} historicalModel=74 nativeEffects=0 authority=false");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("publication_storage_pure FAIL " + error.Message);
            return 1;
        }
    }

    private static NativeProtectedPublicationStore.Expectation Expected() =>
        new(Epoch, Provenance, Empty, PublicationContractV3.Digest(Empty), 0, Binding);
    private static NativeInstalledPublicationReader.Facts Initial() =>
        new(Epoch, Empty, Provenance, 0, null, new Dictionary<string, string>(), "publication_absent");

    private static void Storage()
    {
        var port = new StoragePort();
        var sequence = new NativeProtectedPublicationStore.Sequence(port);
        var result = sequence.PersistIntent(Expected(), Intent);
        Check(result.HistoryDigest == PublicationContractV3.Digest(port.State.History) && result.Next == "persist_intent" &&
            !result.AuthorizesEffect && !result.AuthorizesLaunch && port.Completed && port.Closed, "success_readback_closed");
        Check(string.Join(',', port.Events) == "acquire,read1,read2,write,flush,read3,complete,close", "exact_storage_order");
        Refuses(() => sequence.PersistIntent(Expected(), Intent), "publication_owner_already_used");
        var retained = port.State;
        Check(PublicationContractV3.Inspect(retained.History).LiveStep is null, "retained_intent_no_dispatch");
        var stale = new StoragePort { State = retained };
        Refuses(() => new NativeProtectedPublicationStore.Sequence(stale).PersistIntent(Expected(), Intent), "publication_projection_requires_reconciliation");
        Check(!stale.Wrote && stale.Closed, "stale_no_duplicate_write");
        // Restart after lost reply preserves the actual written intent. A fresh
        // request cannot re-begin from the old predecessor or replay an effect.
        foreach (var stage in new[] { "acquire", "read1", "read2", "write_before", "write_after", "flush_before", "flush_after", "read3", "complete_before", "complete_after", "close" })
        {
            var fault = new StoragePort { Fault = stage };
            Refuses(() => new NativeProtectedPublicationStore.Sequence(fault).PersistIntent(Expected(), Intent), "injected_" + stage);
            Check(fault.Closed && fault.CloseCalls == 1 && !fault.Dispatch, "fault_terminal_" + stage);
            if (fault.Wrote)
            {
                Check(PublicationContractV3.Inspect(fault.State.History).LiveStep is null, "fault_no_rehydrated_permit_" + stage);
                var restart = new StoragePort { State = fault.State };
                Refuses(() => new NativeProtectedPublicationStore.Sequence(restart).PersistIntent(Expected(), Intent), "publication_projection_requires_reconciliation");
                Check(!restart.Wrote, "lost_reply_no_reexecution_" + stage);
            }
        }
        var concurrent = new StoragePort { ChangeOnRead2 = true };
        Refuses(() => new NativeProtectedPublicationStore.Sequence(concurrent).PersistIntent(Expected(), Intent), "publication_concurrent_change");
        Check(!concurrent.Wrote, "concurrent_prewrite_refusal");
        var readback = new StoragePort { CorruptAfterWrite = true };
        Refuses(() => new NativeProtectedPublicationStore.Sequence(readback).PersistIntent(Expected(), Intent), "publication_readback_mismatch");
        Check(readback.Wrote && !readback.Completed && readback.Closed, "bad_readback_never_success");
        foreach (var expected in new[]
        {
            Expected() with { Epoch = new string('f',64) },
            Expected() with { HistoryDigest = new string('f',64) },
            Expected() with { HighWater = 1 },
            Expected() with { ServiceBindingDigest = new string('f',64) },
            Expected() with { ProvisioningDigest = new string('f',64) },
        })
        {
            var denied = new StoragePort();
            Refuses(() => new NativeProtectedPublicationStore.Sequence(denied).PersistIntent(expected, Intent), "publication_expectation_invalid");
            Check(!denied.Acquired && !denied.Wrote && denied.Closed, "invalid_expected_no_acquire");
        }
        var epoch = new StoragePort { State = Initial() with { Epoch = new string('f', 64) } };
        Refuses(() => new NativeProtectedPublicationStore.Sequence(epoch).PersistIntent(Expected(), Intent), "publication_predecessor_conflict");
        var provenance = new StoragePort { State = Initial() with { ProvisioningDigest = new string('f', 64) } };
        Refuses(() => new NativeProtectedPublicationStore.Sequence(provenance).PersistIntent(Expected(), Intent), "publication_predecessor_conflict");
        var number = new StoragePort { State = Initial() with { HighWater = 1 } };
        Refuses(() => new NativeProtectedPublicationStore.Sequence(number).PersistIntent(Expected(), Intent), "publication_predecessor_conflict");
        var inconsistent = new StoragePort { State = Initial() with { Consistency = "projection_mismatch" } };
        Refuses(() => new NativeProtectedPublicationStore.Sequence(inconsistent).PersistIntent(Expected(), Intent), "publication_projection_requires_reconciliation");
        Check(!inconsistent.Wrote && inconsistent.Closed, "mismatched_projection_no_append");
        var malformed = new StoragePort();
        RefusesAny(() => new NativeProtectedPublicationStore.Sequence(malformed).PersistIntent(Expected() with { History = Empty + " " }, Intent));
        Check(!malformed.Acquired && malformed.Closed, "noncanonical_history_no_acquire");
        var oversized = new StoragePort();
        RefusesAny(() => new NativeProtectedPublicationStore.Sequence(oversized).PersistIntent(Expected() with { History = new string('x', PublicationContractV3.MaxBytes + 1) }, Intent));
        Check(!oversized.Acquired && oversized.Closed, "capacity_no_acquire");
    }

    private static void Mutex()
    {
        foreach (var wait in new uint[] { 0, 0x80, 0x102, 0xFFFFFFFF, 1 })
        {
            var port = new MutexPort { WaitResult = wait };
            if (wait == 0)
            {
                var owned = NativePublicationMutex.Ownership.Acquire(port);
                owned.Dispose(); owned.Dispose();
                Check(port.Validates == 2 && port.Releases == 1 && port.Closes == 1, "mutex_once_owner");
            }
            else
            {
                RefusesAny(() => NativePublicationMutex.Ownership.Acquire(port));
                Check(port.Releases == (wait == 0x80 ? 1 : 0) && port.Closes == 1,
                    "mutex_rejected_ownership_" + wait);
            }
        }
        foreach (var validation in new[] { 1, 2 })
        {
            var port = new MutexPort { FailValidation = validation };
            RefusesAny(() => NativePublicationMutex.Ownership.Acquire(port));
            Check(port.Releases == (validation == 2 ? 1 : 0) && port.Closes == 1, "mutex_security_failure_cleanup_" + validation);
        }
        foreach (var wait in new uint[] { 0, 0x80 })
        {
            var port = new MutexPort { WaitResult = wait, ReleaseOk = false };
            if (wait == 0)
            {
                var owner = NativePublicationMutex.Ownership.Acquire(port);
                Refuses(() => owner.Dispose(), "publication_mutex_close_uncertain"); owner.Dispose();
                Check(owner.DispositionUncertain, "mutex_uncertainty_latched");
            }
            else Refuses(() => NativePublicationMutex.Ownership.Acquire(port), "publication_mutex_close_uncertain");
            Check(port.Releases == 1 && port.Closes == 1, "mutex_no_retry_after_release_failure_" + wait);
        }
        var close = new MutexPort { CloseOk = false };
        var closing = NativePublicationMutex.Ownership.Acquire(close);
        Refuses(() => closing.Dispose(), "publication_mutex_close_uncertain"); closing.Dispose();
        Check(close.Releases == 1 && close.Closes == 1, "mutex_close_failure_once");
    }

    private static void Data()
    {
        byte[] Sd(string text)
        {
            var descriptor = new RawSecurityDescriptor(text); var bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0); return bytes;
        }
        var registry = "O:SYG:SYD:P(A;;0x000f003f;;;SY)(A;;0x000f003f;;;BA)(A;;0x00020019;;;BU)(A;;0x00020019;;;" + CustodyContractV3.ServiceSid + ")";
        CustodyContractV3.VerifySecurity(Sd(registry)); cases++;
        NativePublicationMutex.VerifyDescriptor(Sd(NativePublicationMutex.Descriptor)); cases++;
        foreach (var changed in new[] { registry.Replace("O:SY", "O:BA"), registry.Replace("D:P", "D:"), registry.Replace("00020019", "000f003f"), registry + "(A;;0x00020019;;;WD)" })
            RefusesAny(() => CustodyContractV3.VerifySecurity(Sd(changed)));
        foreach (var changed in new[] { NativePublicationMutex.Descriptor.Replace("O:SY", "O:BA"), NativePublicationMutex.Descriptor.Replace("G:SY", "G:BA"), NativePublicationMutex.Descriptor.Replace("D:P", "D:"), NativePublicationMutex.Descriptor.Replace("D:P", "D:PAI"), NativePublicationMutex.Descriptor.Replace("00120000", "001f0001"), NativePublicationMutex.Descriptor + "(A;;0x00120000;;;BU)" })
            RefusesAny(() => NativePublicationMutex.VerifyDescriptor(Sd(changed)));
        foreach (var value in new[] { new RegistryValue(3, Encoding.Unicode.GetBytes("text\0")), new RegistryValue(1, Encoding.Unicode.GetBytes("text")), new RegistryValue(1, [0]), new RegistryValue(1, Encoding.Unicode.GetBytes("a\0b\0")) })
            RefusesAny(() => CustodyContractV3.ReadString(new Dictionary<string, RegistryValue> { ["x"] = value }, "x"));
        Check(!NativeInstalledPublicationReader.Same(Initial(), Initial() with { Selection = "changed" }), "snapshot_selection_change");
        Check(!NativeInstalledPublicationReader.Same(Initial(), Initial() with { Catalogs = new Dictionary<string, string> { ["x"] = "y" } }), "snapshot_catalog_change");
        Check(!Initial().AuthorizesEffect && !Initial().AuthorizesLaunch, "reader_facts_not_authority");
    }

    private static void Routes()
    {
        Check(PublicationAdminEntrypoint.Classify(["--publication-preview"]) == "preview", "preview_exact_mode");
        Check(PublicationAdminEntrypoint.Classify(["--admin-publication"]) == "admin", "admin_exact_mode");
        Check(PublicationAdminEntrypoint.Classify(["--admin-publication-recover"]) == "recover", "recovery_exact_mode");
        foreach (var args in new[] { Array.Empty<string>(), new[] { "--service" }, new[] { "--admin-publication", "{}" }, new[] { "--publication-preview", "C:\\caller" }, new[] { "--ADMIN-PUBLICATION" }, new[] { "--admin-publication-recover", "--service" } })
            Check(PublicationAdminEntrypoint.Classify(args) is null, "no_extended_route_or_input");
    }

    private sealed class StoragePort : NativeProtectedPublicationStore.IPort
    {
        internal NativeInstalledPublicationReader.Facts State = Initial();
        internal string Fault = "";
        internal bool Acquired, Wrote, Completed, Closed, ChangeOnRead2, CorruptAfterWrite;
        internal bool Dispatch => false;
        internal int CloseCalls;
        internal readonly List<string> Events = [];
        private int reads;
        public void Acquire() { Events.Add("acquire"); Acquired = true; Fail("acquire"); }
        public NativeInstalledPublicationReader.Facts Read()
        {
            var step = "read" + ++reads; Events.Add(step); Fail(step);
            if (reads == 2 && ChangeOnRead2) State = State with { HighWater = 1 };
            if (reads == 3 && CorruptAfterWrite) State = State with { History = Empty };
            return State;
        }
        public void WriteHistory(byte[] bytes)
        {
            Events.Add("write"); Fail("write_before");
            Wrote = true; State = State with { History = Encoding.UTF8.GetString(bytes), Consistency = "publication_pending_or_unknown" };
            Fail("write_after");
        }
        public void Flush() { Events.Add("flush"); Fail("flush_before"); Fail("flush_after"); }
        public void CompleteReadback() { Events.Add("complete"); Fail("complete_before"); Completed = true; Fail("complete_after"); }
        public void Dispose() { if (Closed) return; Closed = true; ++CloseCalls; Events.Add("close"); Fail("close"); }
        private void Fail(string point) { if (Fault == point) throw new InvalidOperationException("injected_" + point); }
    }

    private sealed class MutexPort : NativePublicationMutex.IPort
    {
        internal uint WaitResult;
        internal int Validates, Releases, Closes, FailValidation;
        internal bool ReleaseOk = true, CloseOk = true;
        public void ValidateSecurity() { if (++Validates == FailValidation) throw new InvalidOperationException("fake_security_mismatch"); }
        public uint Wait() => WaitResult;
        public bool Release() { ++Releases; return ReleaseOk; }
        public bool Close() { ++Closes; return CloseOk; }
    }

    private static void Check(bool value, string name) { if (!value) throw new Exception(name); ++cases; }
    private static void Refuses(Action action, string reason)
    {
        try { action(); } catch (Exception error) when (error.Message == reason) { ++cases; return; }
        throw new Exception("expected_refusal_" + reason);
    }
    private static void RefusesAny(Action action)
    {
        try { action(); } catch { ++cases; return; }
        throw new Exception("expected_refusal");
    }
    private static string Selection() => "{\"coordinatorProtocolVersion\":\"1.0.0\",\"generationId\":\"" + new string('f', 64) +
        "\",\"graphDigest\":\"" + new string('f', 64) + "\",\"manifestSha256\":\"" + new string('1', 64) +
        "\",\"profile\":\"windows-coordinator-service-msi/3\",\"revision\":1,\"schemaVersion\":\"windows-coordinator-active-selection/3\",\"serviceImageSha256\":\"" + new string('2', 64) +
        "\",\"serviceName\":\"LexRunnerCoordinator\",\"workerServiceImageSha256\":\"" + new string('3', 64) + "\",\"workerServiceName\":\"LexRunnerWorkerSlot1\"}";
}
