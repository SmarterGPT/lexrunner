#pragma once
#include "HeldTrustSdkCore.h"
#include "SelectedTrustAbi.h"

struct SelectedTrustFacts {
    bool identityBefore=false,rawBefore=false,winTrust=false,timestamp=false;
    bool primaryChain=false,timestampChain=false,providerChains=false,purposes=false;
    bool issuerRootPeriods=false,revocation=false,close=false,clock=false;
    bool identityAfter=false,rawAfter=false,path=false;
};
inline uint32_t SelectedFactsMask(const SelectedTrustFacts& f) {
    return (f.identityBefore&&f.rawBefore?1u:0u)|(f.winTrust?2u:0u)|(f.timestamp?4u:0u)|
        (f.primaryChain?8u:0u)|(f.timestampChain?16u:0u)|(f.providerChains?32u:0u)|
        (f.purposes?64u:0u)|(f.issuerRootPeriods?128u:0u)|(f.revocation?256u:0u)|
        (f.close?512u:0u)|(f.clock?1024u:0u)|(f.identityAfter&&f.rawAfter?2048u:0u)|(f.path?4096u:0u);
}
// Used by the actual policy and pure fault/clock/coverage vectors, not a permit.
bool SelectedChainComplete(const ChainObservation& chain);
bool SelectedProviderMatches(const ProviderChainCopy& provider,const ChainObservation& chain);
bool SelectedIssuerRootsCurrent(const ChainObservation& chain,uint64_t current);
bool SelectedRevocationComplete(const ChainObservation& chain,uint64_t started);
bool SelectedClockBound(uint64_t beginQpc,uint64_t endQpc,uint64_t frequency,uint64_t beginUtc,uint64_t endUtc);
inline bool SelectedPurposesComplete(const PurposeObservation& primary,const PurposeObservation& timestamp) {
    return primary.called&&primary.apiSucceeded&&!primary.error&&timestamp.called&&timestamp.apiSucceeded&&!timestamp.error;
}

// Run after the last digest, not merely after WinTrust/CMS cleanup.
inline void SelectedApplyCloseState(SelectedTrustFacts& facts,bool& uncertain,const NativeCloseState& state) noexcept {
    uncertain=uncertain||state.Uncertain();facts.close=facts.close&&!uncertain;
}
inline LexTrustCompletion SelectedCompletion(bool caught,bool uncertain,uint32_t observedMask) noexcept {
    return uncertain?LexTrustCompletion::Uncertain:
        !caught&&observedMask==LexTrustRequiredMask?LexTrustCompletion::ChecksSatisfied:LexTrustCompletion::Refused;
}

// These are copied from the actual constructed SDK request, not expected flags.
inline void RecordSelectedRequest(const SharedWinTrustSession& session,LexTrustResultV2& out) noexcept {
    const GUID action=WINTRUST_ACTION_GENERIC_VERIFY_V2;
    out.requestUi=session.trust.data.dwUIChoice;out.requestRevocation=session.trust.data.fdwRevocationChecks;
    out.requestChoice=session.trust.data.dwUnionChoice;out.requestProvider=session.trust.data.dwProvFlags;
    out.requestVerifyAction=session.trust.data.dwStateAction;
    out.requestSignatureFlags=session.signature.dwFlags;out.requestIndex=session.signature.dwIndex;
    out.requestActionMatches=IsEqualGUID(session.trust.action,action)?1u:0u;
}
inline bool SelectedRequestComplete(const LexTrustResultV2& r) noexcept {
    return r.requestUi==WTD_UI_NONE&&r.requestRevocation==WTD_REVOKE_WHOLECHAIN&&r.requestChoice==WTD_CHOICE_FILE&&
        r.requestProvider==(WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT|WTD_DISABLE_MD2_MD4)&&
        r.requestVerifyAction==WTD_STATEACTION_VERIFY&&r.requestCloseAction==WTD_STATEACTION_CLOSE&&
        r.requestSignatureFlags==(WSS_GET_SECONDARY_SIG_COUNT|WSS_VERIFY_SPECIFIC)&&r.requestIndex==0&&
        r.requestActionMatches==1&&r.requestVerifiedIndex==0&&r.requestSecondaryCount==0&&
        r.primaryChainFlags==RequestedChainFlags(true,false)&&r.timestampChainFlags==RequestedChainFlags(true,false)&&
        r.primaryRevocationFlags==RequestedRevocationFlags(true)&&r.timestampRevocationFlags==RequestedRevocationFlags(true)&&
        r.primaryOcspChainFlags==RequestedChainFlags(true,false)&&r.timestampOcspChainFlags==RequestedChainFlags(true,false)&&
        r.primaryResync==r.startedUtc&&r.timestampResync==r.startedUtc&&r.startedUtc>0&&
        r.primaryRevocationAt>=r.startedUtc&&r.primaryRevocationAt<=r.endedUtc&&
        r.timestampRevocationAt>=r.startedUtc&&r.timestampRevocationAt<=r.endedUtc;
}
inline bool SelectedParentWindow(uint64_t parentStart,uint64_t parentEnd,uint64_t childStart,uint64_t childEnd,uint64_t frequency) noexcept {
    return parentStart>0&&frequency>0&&frequency<=1000000000ULL&&childStart>=parentStart&&childEnd>=childStart&&
        parentEnd>=childEnd&&parentEnd-parentStart<frequency*30;
}

// Numeric constants consumed by the private managed layout are checked against
// this compiler's actual Windows SDK, rather than silently drifting.
static_assert(RequestedChainFlags(true,false)==0x48000100&&RequestedRevocationFlags(true)==0x04&&
    (WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT|WTD_DISABLE_MD2_MD4)==0x2080&&
    (WSS_GET_SECONDARY_SIG_COUNT|WSS_VERIFY_SPECIFIC)==3&&WTD_UI_NONE==2&&WTD_REVOKE_WHOLECHAIN==1&&
    WTD_CHOICE_FILE==1&&WTD_STATEACTION_VERIFY==1&&WTD_STATEACTION_CLOSE==2);
