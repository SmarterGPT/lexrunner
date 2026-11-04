#pragma once
#include <cstdint>
#include <cstddef>

// Private borrowed-handle ABI. Only the retained bootstrap owner can supply it.
// These comparison inputs do not authenticate their origin or grant authority.
inline constexpr uint32_t LexTrustAbiVersion=2;
inline constexpr uint32_t LexTrustRequiredMask=0x1FFF;
enum class LexTrustCompletion:uint32_t { NotCompleted=0, Refused=1, ChecksSatisfied=2, Uncertain=3 };
enum class LexTrustPhase:uint32_t { Input=1, Identity=2, Digest=3, WinTrust=4, Timestamp=5, Chains=6, Revocation=7, Close=8, FinalIdentity=9, Completed=10, AlreadyUsed=11, Exception=12 };
#pragma pack(push,8)
struct LexTrustRequestV2 {
    uint32_t size,version;
    uintptr_t image;
    uint64_t volume;
    uint8_t fileId[16];
    uint64_t bytes;
    uint8_t sha256[32];
    const uint16_t* finalPath;
    uint32_t pathChars,reserved;
};
struct LexTrustResultV2 {
    uint32_t size,version,completion,phase;
    uint64_t startedQpc,endedQpc,qpcFrequency,startedUtc,endedUtc;
    uint32_t observedMask,requiredMask,failedMask,winTrustCalls,timestampCalls,revocationCalls;
    int32_t winTrustResult,stateCloseResult;
    uint32_t primaryChains,timestampChains,primaryPurposeError,timestampPurposeError;
    uint32_t policyRevision,purposeCalls;
    uint8_t sha256[32],fileId[16];
    uint64_t volume;
    uint32_t requestUi,requestRevocation,requestChoice,requestProvider,requestVerifyAction,requestCloseAction;
    uint32_t requestSignatureFlags,requestIndex,requestActionMatches,requestVerifiedIndex,requestSecondaryCount;
    uint32_t primaryChainFlags,timestampChainFlags,primaryRevocationFlags,timestampRevocationFlags;
    uint32_t primaryOcspChainFlags,timestampOcspChainFlags;
    uint64_t primaryResync,timestampResync,primaryRevocationAt,timestampRevocationAt;
};
#pragma pack(pop)
static_assert(sizeof(LexTrustRequestV2)==96 && offsetof(LexTrustRequestV2,image)==8 && offsetof(LexTrustRequestV2,finalPath)==80);
static_assert(sizeof(LexTrustResultV2)==272 && offsetof(LexTrustResultV2,observedMask)==56 && offsetof(LexTrustResultV2,sha256)==112 && offsetof(LexTrustResultV2,requestUi)==168 && offsetof(LexTrustResultV2,primaryResync)==240);
extern "C" int32_t __cdecl LexRunnerVerifySelectedTrustV2(const LexTrustRequestV2* request,LexTrustResultV2* result) noexcept;
