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


// Additive private diagnostic ABI. V2's 96/272 layout and PE-only contract stay.
// Feature support is source implementation, not MSI qualification or authority.
enum class LexTrustFileKind:uint32_t { Pe=1, Msi=2 };
inline constexpr uint32_t LexTrustAbiVersion3=3;
inline constexpr uint32_t LexTrustFeatureHeld=1,LexTrustFeatureRaw=2,
    LexTrustFeaturePe=4,LexTrustFeatureMsiSip=8,LexTrustFeatureDecoded=16,
    LexTrustFeatureSelectedPolicy=32;
inline constexpr uint32_t LexTrustFeaturesForKind(uint32_t kind) noexcept {
    const uint32_t common=LexTrustFeatureHeld|LexTrustFeatureRaw|
        LexTrustFeatureDecoded|LexTrustFeatureSelectedPolicy;
    return kind==1?common|LexTrustFeaturePe:kind==2?common|LexTrustFeatureMsiSip:0;
}
#pragma pack(push,8)
struct LexTrustRequestV3 {
    uint32_t size,version,fileKind,requiredFeatures;
    LexTrustRequestV2 input;
    uint32_t reserved[4];
};
struct LexTrustResultV3 {
    uint32_t size,version,fileKind,implementedFeatures;
    uint8_t observedSubject[16]; // MSI observation; PE does not query a SIP GUID.
    LexTrustResultV2 selected;
    uint32_t reserved[4];
};
#pragma pack(pop)
static_assert(sizeof(LexTrustRequestV3)==128 && offsetof(LexTrustRequestV3,input)==16 &&
    offsetof(LexTrustRequestV3,reserved)==112);
static_assert(sizeof(LexTrustResultV3)==320 && offsetof(LexTrustResultV3,selected)==32 &&
    offsetof(LexTrustResultV3,reserved)==304);
inline bool LexTrustV3HeaderSupported(const LexTrustRequestV3* r) noexcept {
    if(!r||r->size!=sizeof(*r)||r->version!=LexTrustAbiVersion3)return false;
    const auto features=LexTrustFeaturesForKind(r->fileKind);
    if(!features||r->requiredFeatures!=features)return false;
    for(const auto value:r->reserved)if(value)return false;
    return true;
}
extern "C" int32_t __cdecl LexRunnerVerifySelectedTrustV3(
    const LexTrustRequestV3* request,LexTrustResultV3* result) noexcept;
