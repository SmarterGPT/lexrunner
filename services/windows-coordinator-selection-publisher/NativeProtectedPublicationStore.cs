using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using LexRunner.WindowsCoordinator.SelectionCustody;

namespace LexRunner.WindowsCoordinator.SelectionPublisher;

// Fixed HKLM64 history-only storage. It cannot publish a catalog/selection,
// control SCM, launch a process, acknowledge drain or reconstruct effect rights.
[SupportedOSPlatform("windows")]
internal static class NativeProtectedPublicationStore
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    internal sealed record Expectation(string Epoch, string ProvisioningDigest,
        string History, string HistoryDigest, long HighWater, string ServiceBindingDigest);
    internal sealed record WriteFact(string HistoryDigest, string Next)
    {
        internal bool AuthorizesEffect => false;
        internal bool AuthorizesLaunch => false;
    }

    // The fake-only tests call this same sequencer, not a second storage model.
    // IPort is trusted in-process code, not an IPC/request deserialization seam.
    internal interface IPort : IDisposable
    {
        void Acquire();
        NativeInstalledPublicationReader.Facts Read();
        void WriteHistory(byte[] bytes);
        void Flush();
        void CompleteReadback();
    }

    internal sealed class Sequence(IPort port)
    {
        private int started;
        internal WriteFact PersistIntent(Expectation expected, string intent)
        {
            if (Interlocked.Exchange(ref started, 1) != 0)
                throw new InvalidOperationException("publication_owner_already_used");
            try
            {
                var parsed = PublicationContractV3.ReadHistory(expected.History);
                if (parsed.Epoch != expected.Epoch || PublicationContractV3.Digest(expected.History) != expected.HistoryDigest ||
                    expected.HighWater is < 0 or > PublicationContractV3.MaxRevision ||
                    parsed.ModelHighWater != expected.HighWater ||
                    !PublicationContractV3.MatchesIntentOrigin(intent, expected.ProvisioningDigest, expected.ServiceBindingDigest))
                    throw new InvalidOperationException("publication_expectation_invalid");
                // Only the real canonical Begin transition can supply new bytes.
                // No supplied receipt, next-state JSON or serialized LiveStep.
                var next = PublicationContractV3.Begin(expected.History, intent);
                var bytes = Utf8.GetBytes(next.State);
                port.Acquire();
                var before = port.Read();
                Compare(before, expected);
                // Immediate pre-write read is deliberate: no raw RegSet is
                // called an atomic compare-and-swap or multi-key transaction.
                var last = port.Read();
                if (!NativeInstalledPublicationReader.Same(before, last))
                    throw new InvalidOperationException("publication_concurrent_change");
                Compare(last, expected);
                port.WriteHistory(bytes);
                port.Flush();
                var after = port.Read();
                if (after.Epoch != expected.Epoch || after.ProvisioningDigest != expected.ProvisioningDigest ||
                    after.HighWater != expected.HighWater || after.History != next.State ||
                    after.Selection != before.Selection || after.Catalogs.Count != before.Catalogs.Count ||
                    before.Catalogs.Any(pair => !after.Catalogs.TryGetValue(pair.Key, out var value) || pair.Value != value))
                    throw new InvalidOperationException("publication_readback_mismatch");
                // The using/finally close disposition completes before this
                // fact can reach its caller. A lost reply is not an effect permit.
                port.CompleteReadback();
                return new WriteFact(PublicationContractV3.Digest(next.State), next.Next);
            }
            finally { port.Dispose(); }
        }

        private static void Compare(NativeInstalledPublicationReader.Facts actual, Expectation expected)
        {
            if (actual.Consistency is not ("publication_absent" or "model_consistent_requires_native_authority" or "retired_retained"))
                throw new InvalidOperationException("publication_projection_requires_reconciliation");
            if (actual.Epoch != expected.Epoch || actual.ProvisioningDigest != expected.ProvisioningDigest ||
                actual.History != expected.History || PublicationContractV3.Digest(actual.History) != expected.HistoryDigest ||
                actual.HighWater != expected.HighWater)
                throw new InvalidOperationException("publication_predecessor_conflict");
        }
    }

    internal static WriteFact PersistIntent(NativePublicationAdministration.Session session)
    {
        ArgumentNullException.ThrowIfNull(session);
        session.RequireLive(); // closed installed origin before ANY OS acquire
        var expected = new Expectation(session.Epoch, session.ProvisioningDigest,
            session.History, PublicationContractV3.Digest(session.History), session.HighWater, session.ServiceBindingDigest);
        return new Sequence(new NativePort(session)).PersistIntent(expected, session.Intent);
    }

    private sealed class NativePort(NativePublicationAdministration.Session session) : IPort
    {
        private NativePublicationMutex.Ownership? mutex;
        private NativeInstalledPublicationReader? reader;
        private NativeRegistryReaderV3.Key? writer;
        private bool closed;
        private bool writeAttempted, completed;
        private static int poisoned;

        public void Acquire()
        {
            RequireLive();
            if (mutex is not null) throw new InvalidOperationException("publication_reentrant_acquire");
            mutex = NativePublicationMutex.AcquireNative();
            session.RequireLive();
            reader = NativeInstalledPublicationReader.Open();
            writer = reader.OpenHistoryWriter();
            _ = Read();
        }
        public NativeInstalledPublicationReader.Facts Read()
        {
            RequireLive();
            if (reader is null || writer is null) throw new InvalidOperationException("publication_owner_absent");
            NativeInstalledPublicationReader.VerifyProtected(writer.Handle);
            var facts = reader.ReadStable();
            var value = NativeRegistryReaderV3.ReadRaw(writer.Handle, "History", PublicationContractV3.MaxBytes);
            if (value is null || value.Type != 3 || Utf8.GetString(value.Data) != facts.History)
                throw new InvalidOperationException("publication_writer_readback_mismatch");
            return facts;
        }
        public void WriteHistory(byte[] bytes)
        {
            RequireLive();
            if (writer is null || mutex is null || reader is null) throw new InvalidOperationException("publication_owner_absent");
            NativeInstalledPublicationReader.VerifyProtected(writer.Handle);
            if (bytes.Length is < 1 or > PublicationContractV3.MaxBytes)
                throw new InvalidOperationException("publication_capacity");
            // Single fixed value through the already-held key. No create/delete
            // API or caller-selected root/value/type can reach this method.
            writeAttempted = true;
            if (RegSetValueExW(writer.Handle, "History", 0, 3, bytes, checked((uint)bytes.Length)) != 0)
                throw new InvalidOperationException("publication_write_uncertain");
        }
        public void CompleteReadback()
        {
            RequireLive();
            completed = true;
        }
        public void Flush()
        {
            RequireLive();
            if (writer is null || RegFlushKey(writer.Handle) != 0)
                throw new InvalidOperationException("publication_flush_uncertain");
        }
        private void RequireLive()
        {
            if (closed || Volatile.Read(ref poisoned) != 0 || NativeRegistryReaderV3.CloseUncertain || NativePublicationMutex.Uncertain)
                throw new InvalidOperationException("publication_native_owner_uncertain");
            session.RequireLive();
        }
        public void Dispose()
        {
            if (closed) return;
            closed = true;
            var uncertain = false;
            try { writer?.Dispose(); } catch { uncertain = true; }
            try { reader?.Dispose(); } catch { uncertain = true; }
            try { mutex?.Dispose(); } catch { uncertain = true; }
            // Administrative sessions are consumed even when writes never ran.
            session.Dispose();
            if (writeAttempted && !completed) Interlocked.Exchange(ref poisoned, 1);
            if (uncertain)
            {
                Interlocked.Exchange(ref poisoned, 1);
                throw new InvalidOperationException("publication_native_close_uncertain");
            }
        }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegSetValueExW(nint key, string value, uint reserved, uint type, byte[] data, uint length);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern int RegFlushKey(nint key);
}
