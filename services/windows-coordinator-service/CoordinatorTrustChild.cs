using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;

// This opaque context has no ordinary factory. The later installed bootstrap
// owner must bind actual parent/SCM/token/image/loader and the retained one-use
// generation before supplying this callback and independently protected inputs.
internal sealed class PrivateTrustChildContext
{
    internal sealed record ExpectedMember(ulong Volume, ulong Bytes, byte[] FileId, byte[] Sha256, string FinalPath);
    private readonly Action<Action<nint>> _retainedMember;
    private readonly long _verificationStartedTimestamp;
    private int _used;
    private readonly ExpectedMember _comparison;
    private PrivateTrustChildContext(Action<Action<nint>> retainedMember, ExpectedMember comparison, long verificationStartedTimestamp)
    {
        _retainedMember = retainedMember;
        _comparison = comparison with { FileId = comparison.FileId.ToArray(), Sha256 = comparison.Sha256.ToArray() };
        _verificationStartedTimestamp = verificationStartedTimestamp;
    }
    internal ExpectedMember Comparison => _comparison with
        { FileId = _comparison.FileId.ToArray(), Sha256 = _comparison.Sha256.ToArray() };

    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static bool TryAcquire(out PrivateTrustChildContext? context)
    {
        // A caller's path, hash, PID, marker, result JSON or service name cannot
        // supply the still-unqualified installed bootstrap capability.
        context = null;
        return false;
    }

    internal void WithRetainedMember(Action<nint> use)
    {
        if (Interlocked.CompareExchange(ref _used, 1, 0) != 0 || !WithinWindow())
            throw new InvalidOperationException("trust_context_unavailable");
        if (_comparison.Volume == 0 || _comparison.Bytes is 0 or > 64 * 1024 * 1024 ||
            _comparison.FileId.Length != 16 || _comparison.Sha256.Length != 32 ||
            _comparison.FinalPath.Length is < 7 or > 512 || _comparison.FinalPath.Contains('\0'))
            throw new InvalidOperationException("trust_context_invalid");
        // The real owner's retained-use callback must acquire/retain its native
        // references for this complete synchronous call. No new handle owner is
        // invented here, and no callback is retained by the native ABI.
        _retainedMember(file =>
        {
            if (file == 0 || file == -1) throw new InvalidOperationException("trust_member_unavailable");
            use(file);
        });
        if (!WithinWindow()) throw new InvalidOperationException("trust_observation_expired");
    }

    private bool WithinWindow()
    {
        var now = Stopwatch.GetTimestamp();
        // The future qualified packet binds this host-QPC timestamp to the
        // parent's verification start. A child-local new stopwatch would omit
        // launch time; a serialized Stopwatch object is not a cross-process clock.
        return _verificationStartedTimestamp > 0 && now >= _verificationStartedTimestamp &&
            Stopwatch.GetElapsedTime(_verificationStartedTimestamp, now) < TimeSpan.FromSeconds(30);
    }
}

internal static class CoordinatorTrustChild
{
    // Preserve the actual statically linked call seam for artifact inspection;
    // this does not construct a context or expose a general native interface.
    [DynamicDependency(DynamicallyAccessedMemberTypes.NonPublicMethods, typeof(NativeTrustAbi))]
    internal static int Run()
    {
        if (!PrivateTrustChildContext.TryAcquire(out var context) || context is null)
        {
            Console.Error.WriteLine("protected_bootstrap_unavailable");
            return 3;
        }
        // Actual child packet/result/Job integration is still a separate
        // qualified owner. No public packet or ordinary route reaches here.
        var observed = NativeTrustAbi.Observe(context);
        Console.WriteLine(observed.State);
        return observed.ChecksSatisfied ? 0 : 3;
    }
}
