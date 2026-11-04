using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

// Private same-process ABI, invoked only by the fixed verifier child with an
// opaque retained context. No endpoint converts caller fields into this request.
internal static unsafe class NativeTrustAbi
{
    internal const uint Version = 2;
    internal const uint RequiredMask = 0x1FFF;
    internal const string SelectedPolicySha256 = "AEAA82259B2AF8DD8353DD2B0CCABAD92C0C6F0F72A3A02502E9AF29BE87C62E";

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct Request
    {
        internal uint Size, Version;
        internal nuint Image;
        internal ulong Volume;
        internal fixed byte FileId[16];
        internal ulong Bytes;
        internal fixed byte Sha256[32];
        internal char* FinalPath;
        internal uint PathChars, Reserved;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct Result
    {
        internal uint Size, Version, Completion, Phase;
        internal ulong StartedQpc, EndedQpc, QpcFrequency, StartedUtc, EndedUtc;
        internal uint ObservedMask, RequiredMask, FailedMask, WinTrustCalls, TimestampCalls, RevocationCalls;
        internal int WinTrustResult, StateCloseResult;
        internal uint PrimaryChains, TimestampChains, PrimaryPurposeError, TimestampPurposeError;
        internal uint PolicyRevision, PurposeCalls;
        internal fixed byte Sha256[32], FileId[16];
        internal ulong Volume;
        internal uint RequestUi, RequestRevocation, RequestChoice, RequestProvider, RequestVerifyAction, RequestCloseAction;
        internal uint RequestSignatureFlags, RequestIndex, RequestActionMatches, RequestVerifiedIndex, RequestSecondaryCount;
        internal uint PrimaryChainFlags, TimestampChainFlags, PrimaryRevocationFlags, TimestampRevocationFlags;
        internal uint PrimaryOcspChainFlags, TimestampOcspChainFlags;
        internal ulong PrimaryResync, TimestampResync, PrimaryRevocationAt, TimestampRevocationAt;
    }

    [DllImport("__Internal", EntryPoint = "LexRunnerVerifySelectedTrustV2", ExactSpelling = true,
        CallingConvention = CallingConvention.Cdecl)]
    private static extern int VerifySelected(in Request request, out Result result);

    internal static bool LayoutMatches() => IntPtr.Size == 8 && sizeof(Request) == 96 && sizeof(Result) == 272 &&
        Marshal.OffsetOf<Request>(nameof(Request.Image)).ToInt32() == 8 &&
        Marshal.OffsetOf<Request>(nameof(Request.FinalPath)).ToInt32() == 80 &&
        Marshal.OffsetOf<Result>(nameof(Result.ObservedMask)).ToInt32() == 56 &&
        Marshal.OffsetOf<Result>(nameof(Result.Sha256)).ToInt32() == 112 &&
        Marshal.OffsetOf<Result>(nameof(Result.RequestUi)).ToInt32() == 168 &&
        Marshal.OffsetOf<Result>(nameof(Result.PrimaryResync)).ToInt32() == 240;

    // Do not turn API return zero or a zero-initialized struct into trust success.
    internal static bool CompleteObservation(int code, in Result result) => code == 0 &&
        result.Size == 272 && result.Version == Version && result.Completion == 2 && result.Phase == 10 &&
        result.RequiredMask == RequiredMask && result.ObservedMask == RequiredMask && result.FailedMask == 0 &&
        result.PolicyRevision == 1 && result.WinTrustResult == 0 && result.StateCloseResult == 0 &&
        result.WinTrustCalls == 2 && result.TimestampCalls == 1 && result.PurposeCalls == 2 &&
        result.PrimaryPurposeError == 0 && result.TimestampPurposeError == 0 &&
        result.PrimaryChains is >= 1 and <= 8 && result.TimestampChains is >= 1 and <= 8 &&
        result.RevocationCalls is >= 2 and <= 30 && result.StartedUtc > 0 && result.EndedUtc >= result.StartedUtc &&
        result.QpcFrequency is > 0 and <= 1_000_000_000 && result.EndedQpc >= result.StartedQpc &&
        result.EndedQpc - result.StartedQpc < result.QpcFrequency * 30 && result.Volume != 0 && NonzeroIdentity(in result) && ActualRequestMatches(in result);

    private static bool ActualRequestMatches(in Result r) =>
        r.RequestUi == 2 && r.RequestRevocation == 1 && r.RequestChoice == 1 &&
        r.RequestProvider == 0x2080 && r.RequestVerifyAction == 1 && r.RequestCloseAction == 2 &&
        r.RequestSignatureFlags == 3 && r.RequestIndex == 0 && r.RequestActionMatches == 1 &&
        r.RequestVerifiedIndex == 0 && r.RequestSecondaryCount == 0 &&
        r.PrimaryChainFlags == 0x48000100 && r.TimestampChainFlags == 0x48000100 &&
        r.PrimaryRevocationFlags == 0x04 && r.TimestampRevocationFlags == 0x04 &&
        r.PrimaryOcspChainFlags == 0x48000100 && r.TimestampOcspChainFlags == 0x48000100 &&
        r.PrimaryResync == r.StartedUtc && r.TimestampResync == r.StartedUtc &&
        r.PrimaryRevocationAt >= r.StartedUtc && r.PrimaryRevocationAt <= r.EndedUtc &&
        r.TimestampRevocationAt >= r.StartedUtc && r.TimestampRevocationAt <= r.EndedUtc;

    private static bool NonzeroIdentity(in Result result)
    {
        var copy = result;
        uint file = 0, digest = 0;
        for (var i = 0; i < 16; i++) file |= copy.FileId[i];
        for (var i = 0; i < 32; i++) digest |= copy.Sha256[i];
        return file != 0 && digest != 0;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static TrustPrimitiveObservation Observe(PrivateTrustChildContext context)
    {
        if (!LayoutMatches()) return new("abi_unavailable", false);
        TrustPrimitiveObservation observation = new("context_unavailable", false);
        context.WithRetainedMember(file =>
        {
            var metadata = context.Comparison;
            var request = new Request { Size = 96, Version = Version, Image = (nuint)file,
                Volume = metadata.Volume, Bytes = metadata.Bytes, PathChars = (uint)metadata.FinalPath.Length };
            for (var i = 0; i < 16; i++) request.FileId[i] = metadata.FileId[i];
            for (var i = 0; i < 32; i++) request.Sha256[i] = metadata.Sha256[i];
            fixed (char* path = metadata.FinalPath)
            {
                request.FinalPath = path;
                var code = VerifySelected(in request, out var result);
                var complete = CompleteObservation(code, in result);
                if (complete)
                {
                    complete = result.Volume == metadata.Volume;
                    for (var i = 0; i < 16; i++) complete &= result.FileId[i] == metadata.FileId[i];
                    for (var i = 0; i < 32; i++) complete &= result.Sha256[i] == metadata.Sha256[i];
                }
                observation = new(complete ? "checks_satisfied_requires_installed_custody" :
                    result.Completion == 3 ? "native_close_uncertain" : "verification_refused", complete,
                    new TrustPrimitiveDetail(code, result.Version, result.Completion, result.Phase,
                        result.ObservedMask, result.FailedMask, result.WinTrustResult, result.StateCloseResult,
                        result.PrimaryPurposeError, result.TimestampPurposeError, result.WinTrustCalls,
                        result.TimestampCalls, result.PurposeCalls, result.RevocationCalls,
                        result.StartedQpc, result.EndedQpc, result.QpcFrequency, result.StartedUtc, result.EndedUtc,
                        new TrustPrimitiveRequestDetail(result.RequestUi, result.RequestRevocation, result.RequestChoice,
                            result.RequestProvider, result.RequestVerifyAction, result.RequestCloseAction,
                            result.RequestSignatureFlags, result.RequestIndex, result.RequestActionMatches,
                            result.RequestVerifiedIndex, result.RequestSecondaryCount,
                            result.PrimaryChainFlags, result.TimestampChainFlags, result.PrimaryRevocationFlags,
                            result.TimestampRevocationFlags, result.PrimaryOcspChainFlags, result.TimestampOcspChainFlags,
                            result.PrimaryResync, result.TimestampResync, result.PrimaryRevocationAt, result.TimestampRevocationAt)));
            }
        });
        return observation;
    }

#if COORDINATOR_SERVICE_FIXTURE_TESTS
    internal static bool PureContractSelfTest()
    {
        var zero = new Result();
        var sample = new Result { Size = 272, Version = 2, Completion = 2, Phase = 10,
            ObservedMask = RequiredMask, RequiredMask = RequiredMask, PolicyRevision = 1,
            WinTrustCalls = 2, TimestampCalls = 1, PurposeCalls = 2, PrimaryChains = 1,
            TimestampChains = 1, RevocationCalls = 5, StartedUtc = 10, EndedUtc = 11,
            QpcFrequency = 1000, StartedQpc = 10, EndedQpc = 11, Volume = 1 };
        sample.RequestUi = 2; sample.RequestRevocation = sample.RequestChoice = sample.RequestVerifyAction = 1;
        sample.RequestProvider = 0x2080; sample.RequestCloseAction = 2; sample.RequestSignatureFlags = 3;
        sample.RequestActionMatches = 1; sample.PrimaryChainFlags = sample.TimestampChainFlags = 0x48000100;
        sample.PrimaryRevocationFlags = sample.TimestampRevocationFlags = 0x04;
        sample.PrimaryOcspChainFlags = sample.TimestampOcspChainFlags = 0x48000100;
        sample.PrimaryResync = sample.TimestampResync = sample.PrimaryRevocationAt = sample.TimestampRevocationAt = sample.StartedUtc;
        sample.FileId[0] = 1; sample.Sha256[0] = 1;
        if (!LayoutMatches() || CompleteObservation(0, in zero) || !CompleteObservation(0, in sample)) return false;
        for (var bit = 0; bit < 13; bit++)
        {
            var changed = sample; changed.ObservedMask &= ~(1u << bit);
            if (CompleteObservation(0, in changed)) return false;
        }
        var error = sample; error.StateCloseResult = 1;
        if (CompleteObservation(0, in error)) return false;
        error = sample; error.PrimaryPurposeError = 1;
        if (CompleteObservation(0, in error)) return false;
        error = sample; error.RequestProvider ^= 1;
        if (CompleteObservation(0, in error)) return false;
        error = sample; error.PrimaryResync--;
        if (CompleteObservation(0, in error)) return false;
        error = sample; error.TimestampRevocationAt = sample.EndedUtc + 1;
        if (CompleteObservation(0, in error)) return false;
        error = sample; error.Version = 1;
        if (CompleteObservation(0, in error)) return false;
        error = sample; error.Size = 168;
        if (CompleteObservation(0, in error)) return false;
        error = sample; error.EndedQpc = error.StartedQpc + error.QpcFrequency * 30;
        return !CompleteObservation(0, in error) && !PrivateTrustChildContext.TryAcquire(out _);
    }
#endif
}

internal sealed record TrustPrimitiveDetail(int ProtocolCode, uint Version, uint Completion, uint LastPhase,
    uint ObservedMask, uint FailedMask, int WinTrustResult, int StateCloseResult,
    uint PrimaryPurposeError, uint TimestampPurposeError, uint WinTrustCalls, uint TimestampCalls,
    uint PurposeCalls, uint RevocationCalls, ulong StartedQpc, ulong EndedQpc, ulong QpcFrequency,
    ulong StartedUtc, ulong EndedUtc, TrustPrimitiveRequestDetail? Request = null);

internal sealed record TrustPrimitiveRequestDetail(uint Ui, uint Revocation, uint Choice, uint Provider,
    uint VerifyAction, uint CloseAction, uint SignatureFlags, uint Index, uint ActionMatches,
    uint VerifiedIndex, uint SecondaryCount, uint PrimaryChainFlags, uint TimestampChainFlags,
    uint PrimaryRevocationFlags, uint TimestampRevocationFlags, uint PrimaryOcspChainFlags, uint TimestampOcspChainFlags,
    ulong PrimaryResync, ulong TimestampResync, ulong PrimaryRevocationAt, ulong TimestampRevocationAt);

internal sealed record TrustPrimitiveObservation(string State, bool ChecksSatisfied, TrustPrimitiveDetail? Detail = null)
{
    internal bool AuthorizesExecution => false;
    internal bool HelperMissingCleared => false;
}
