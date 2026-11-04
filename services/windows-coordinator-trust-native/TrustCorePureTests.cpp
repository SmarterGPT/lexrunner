#include "SelectedTrustPolicy.h"
#include <iostream>

static ChainObservation Chain() {
    ChainObservation c;c.called=c.built=c.contextPresent=true;c.chains=1;c.requestedTime=100;c.observationTime=200;
    c.flags=RequestedChainFlags(true,false);
    for(DWORD i=0;i<3;++i){ChainElementObservation e;e.elementIndex=i;e.notBefore=10;e.notAfter=i?300:150;
        e.validAtTimestamp=true;e.validAtObservation=i!=0;e.certificateSha256=std::string(64,static_cast<char>('a'+i));c.elements.push_back(e);}
    auto& r=c.currentRevocation;r.requested=r.contextsAvailable=true;r.disposition="observed";
    r.cacheResync=50;r.timeToUse=r.currentTime=200;r.flags=RequestedRevocationFlags(true);
    r.timeoutMs=10000;r.ocspChainFlags=RequestedChainFlags(true,false);
    for(DWORD i=0;i<2;++i){CurrentRevocationRow v;v.certificateRow=i;v.issuerRow=i+1;v.succeeded=true;r.rows.push_back(v);}
    return c;
}
struct FakeClose {
    unsigned* calls;bool succeeds;
    bool operator()(uintptr_t) const noexcept { ++*calls;return succeeds; }
};
int main() {
    size_t cases=0;
    auto check=[&](bool value,const char* name){if(!value)throw Stop(name);++cases;};
    try {
        auto c=Chain();check(SelectedChainComplete(c),"valid_historical_chain");
        check(SelectedIssuerRootsCurrent(c,200),"expired_leaf_allowed_with_current_issuers");
        check(!SelectedIssuerRootsCurrent(c,301),"expired_issuer_root_refused");
        for(size_t i=0;i<c.elements.size();++i){auto x=c;x.elements[i].errors=1;check(!SelectedChainComplete(x),"element_error_refused");}
        for(size_t i=0;i<c.elements.size();++i){auto x=c;x.elements[i].notBefore=101;check(!SelectedChainComplete(x),"not_valid_at_stamp_refused");}
        auto x=c;x.errors=1;check(!SelectedChainComplete(x),"aggregate_error_refused");
        x=c;x.flags|=CERT_CHAIN_TIMESTAMP_TIME;check(!SelectedChainComplete(x),"different_chain_time_semantics_refused");
        x=c;x.flags|=CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY;check(!SelectedChainComplete(x),"cache_only_chain_refused");
        x=c;x.elements[1].elementIndex=0;check(!SelectedChainComplete(x),"duplicate_chain_index_refused");
        x=c;x.chains=2;check(!SelectedChainComplete(x),"omitted_simple_chain_refused");
        x=c;x.elements[2].simpleChainIndex=1;check(!SelectedChainComplete(x),"wrong_chain_boundary_refused");
        ProviderChainCopy p;p.present=true;p.chainCount=1;p.errors=0;p.elements=c.elements;
        check(SelectedProviderMatches(p,c),"ordered_provider_match");
        auto q=p;std::swap(q.elements[0],q.elements[1]);check(!SelectedProviderMatches(q,c),"reordered_provider_refused");
        q=p;q.elements[1].certificateSha256=std::string(64,'d');check(!SelectedProviderMatches(q,c),"different_cross_signed_chain_refused");
        q=p;q.errors=1;check(!SelectedProviderMatches(q,c),"provider_error_not_waived");
        q=p;q.elements.pop_back();check(!SelectedProviderMatches(q,c),"partial_provider_chain_refused");
        PurposeObservation a,b;a.called=a.apiSucceeded=b.called=b.apiSucceeded=true;a.error=b.error=0;
        check(SelectedPurposesComplete(a,b),"purpose_complete");
        auto bad=a;bad.error=static_cast<DWORD>(CERT_E_WRONG_USAGE);check(!SelectedPurposesComplete(bad,b),"api_true_policy_error_refused");
        bad=a;bad.apiSucceeded=false;check(!SelectedPurposesComplete(bad,b),"policy_api_failure_refused");
        bad=b;bad.called=false;check(!SelectedPurposesComplete(a,bad),"missing_timestamp_purpose_refused");
        check(SelectedRevocationComplete(c,50),"current_complete_revocation");
        x=c;x.currentRevocation.rows.pop_back();check(!SelectedRevocationComplete(x,50),"missing_revocation_row_refused");
        x=c;x.currentRevocation.rows.push_back(x.currentRevocation.rows[0]);check(!SelectedRevocationComplete(x,50),"duplicate_revocation_row_refused");
        x=c;x.currentRevocation.rows[0].issuerRow=2;check(!SelectedRevocationComplete(x,50),"wrong_issuer_refused");
        x=c;x.currentRevocation.rows[0].succeeded=false;check(!SelectedRevocationComplete(x,50),"unknown_revocation_refused");
        x=c;x.currentRevocation.rows[0].nativeError=static_cast<DWORD>(CRYPT_E_REVOKED);check(!SelectedRevocationComplete(x,50),"revoked_result_refused");
        x=c;x.currentRevocation.flags=RequestedRevocationFlags(false);check(!SelectedRevocationComplete(x,50),"offline_retry_refused");
        x=c;x.currentRevocation.cacheResync=49;check(!SelectedRevocationComplete(x,50),"wrong_resync_refused");
        x=c;x.currentRevocation.contextsAvailable=false;check(!SelectedRevocationComplete(x,50),"no_native_context_refused");
        check(SelectedClockBound(0,1000,1000,10000000,20000000),"bounded_consistent_clock");
        check(!SelectedClockBound(0,30000,1000,10000000,310000000),"thirty_seconds_refused");
        check(!SelectedClockBound(100,99,1000,10000000,10000001),"monotonic_rollback_refused");
        check(!SelectedClockBound(0,1000,1000,10000000,9999999),"utc_rollback_refused");
        check(!SelectedClockBound(0,1000,1000,10000000,10000000),"frozen_utc_uncertainty_refused");
        check(!SelectedClockBound(0,1,0,10000000,10000000),"missing_frequency_refused");
        check(!SelectedClockBound(0,1,UINT64_MAX,10000000,10000000),"frequency_overflow_refused");
        Cms closedCms; closedCms.closeFailed=true;
        check(!closedCms.CloseObserved()&&!closedCms.CloseObserved(),"cms_close_failure_latched_without_retry");
        TimestampResources closedTimestamp;closedTimestamp.closeFailed=true;
        check(!closedTimestamp.CloseObserved()&&!closedTimestamp.CloseObserved(),"timestamp_close_failure_latched_without_retry");
        SelectedTrustFacts f;bool* flags[]={&f.identityBefore,&f.rawBefore,&f.winTrust,&f.timestamp,&f.primaryChain,&f.timestampChain,
            &f.providerChains,&f.purposes,&f.issuerRootPeriods,&f.revocation,&f.close,&f.clock,&f.identityAfter,&f.rawAfter,&f.path};
        for(auto bit:flags)*bit=true;check(SelectedFactsMask(f)==LexTrustRequiredMask,"complete_observation_mask");
        for(auto bit:flags){*bit=false;check(SelectedFactsMask(f)!=LexTrustRequiredMask,"partial_observation_never_complete");*bit=true;}
        // Test the same actual owner, hash-status guard and final completion
        // functions with deterministic close results; no SDK operation is called.
        for(const auto hashOk:{true,false}) {
            NativeCloseState state;unsigned closeCalls=0;bool hashReturned=false,caughtHash=false;
            {
                SingleCloseOwner<uintptr_t,FakeClose> owner(1,state,{&closeCalls,false});
                try { RequireHashAndCloseStatus(hashOk?0:static_cast<NTSTATUS>(-1),owner.CloseObserved());hashReturned=true; }
                catch(const Stop&){caughtHash=true;}
                check(!owner.CloseObserved()&&closeCalls==1,"failed_close_not_retried");
            }
            check(closeCalls==1&&state.Uncertain()&&!hashReturned&&caughtHash,
                hashOk?"successful_hash_failed_close_retained":"combined_hash_and_close_failure_retained");
            auto late=f;bool uncertain=false;
            SelectedApplyCloseState(late,uncertain,state);
            check(!late.close&&uncertain&&SelectedCompletion(caughtHash,uncertain,SelectedFactsMask(late))==LexTrustCompletion::Uncertain,
                "close_failure_cannot_become_completed_abi");
        }
        NativeCloseState lateState;unsigned lateCalls=0;auto lateFacts=f;bool lateUncertain=false;
        SelectedApplyCloseState(lateFacts,lateUncertain,lateState);
        check(lateFacts.close&&!lateUncertain,"earlier_cleanup_observed_clean");
        {
            SingleCloseOwner<uintptr_t,FakeClose> finalDigest(1,lateState,{&lateCalls,false});
            check(!finalDigest.CloseObserved(),"final_digest_close_failure");
        }
        SelectedApplyCloseState(lateFacts,lateUncertain,lateState);
        check(lateCalls==1&&lateUncertain&&!lateFacts.close&&
            SelectedCompletion(false,lateUncertain,SelectedFactsMask(lateFacts))==LexTrustCompletion::Uncertain,
            "late_final_digest_overrides_earlier_clean_close");
        unsigned cleanCalls=0;
        {
            SingleCloseOwner<uintptr_t,FakeClose> clean(1,lateState,{&cleanCalls,true});
            RequireHashAndCloseStatus(0,clean.CloseObserved());
            check(clean.CloseObserved()&&cleanCalls==1,"success_close_also_not_retried");
        }
        check(lateState.Uncertain()&&cleanCalls==1,"later_success_cannot_clear_uncertainty");
        NativeCloseState emptyState;unsigned emptyCalls=0;
        { SingleCloseOwner<uintptr_t,FakeClose> empty(0,emptyState,{&emptyCalls,false});check(empty.CloseObserved(),"empty_owner_clean"); }
        check(emptyCalls==0&&!emptyState.Uncertain(),"empty_owner_no_close_attempt");
        NativeCloseState unwindState;unsigned unwindCalls=0;
        try {
            SingleCloseOwner<uintptr_t,FakeClose> unwound(1,unwindState,{&unwindCalls,false});
            throw Stop("synthetic_hash_unwind");
        }catch(const Stop&){}
        check(unwindCalls==1&&unwindState.Uncertain(),"exception_cleanup_failure_latched_once");
        NativeCloseState cleanHashFailure;unsigned hashFailureCalls=0;bool hashFailureCaught=false;
        {
            SingleCloseOwner<uintptr_t,FakeClose> cleanRelease(1,cleanHashFailure,{&hashFailureCalls,true});
            try { RequireHashAndCloseStatus(static_cast<NTSTATUS>(-1),cleanRelease.CloseObserved()); }
            catch(const Stop&) {hashFailureCaught=true;}
        }
        check(hashFailureCaught&&hashFailureCalls==1&&!cleanHashFailure.Uncertain()&&
            SelectedCompletion(true,false,LexTrustRequiredMask)==LexTrustCompletion::Refused,
            "hash_failure_with_clean_close_remains_refused");
        // Header/layout vectors only: no SIP, WinTrust, process or file API.
        check(sizeof(LexTrustRequestV2)==96&&sizeof(LexTrustResultV2)==272,"v2_layout_unchanged");
        check(sizeof(LexTrustRequestV3)==128&&sizeof(LexTrustResultV3)==320,"v3_layout_fixed");
        LexTrustRequestV3 header{};header.size=sizeof(header);header.version=LexTrustAbiVersion3;
        header.fileKind=2;header.requiredFeatures=LexTrustFeaturesForKind(2);
        check(LexTrustV3HeaderSupported(&header),"known_msi_header_supported_not_authorized");
        auto h=header;h.fileKind=1;h.requiredFeatures=LexTrustFeaturesForKind(1);
        check(LexTrustV3HeaderSupported(&h),"known_pe_header_supported");
        h=header;h.fileKind=0;check(!LexTrustV3HeaderSupported(&h),"unknown_kind_refused");
        h=header;h.version=4;check(!LexTrustV3HeaderSupported(&h),"unknown_abi_refused");
        h=header;--h.size;check(!LexTrustV3HeaderSupported(&h),"wrong_size_refused");
        h=header;h.requiredFeatures|=0x80000000;check(!LexTrustV3HeaderSupported(&h),"unknown_feature_refused");
        h=header;h.requiredFeatures=0;check(!LexTrustV3HeaderSupported(&h),"missing_features_refused");
        for(size_t i=0;i<4;++i){h=header;h.reserved[i]=1;check(!LexTrustV3HeaderSupported(&h),"reserved_field_refused");}
        check(!LexTrustV3HeaderSupported(nullptr),"missing_header_refused");
        check(!CngCloseState.Uncertain(),"no_real_cng_operation");
        check(NativeTrustCalls==0&&CurrentRevocationCalls==0&&TimestampMathCalls==0&&PurposePolicyCalls==0,"no_sdk_trust_calls");
        std::cout<<"{\"result\":\"pure_pass\",\"cases\":"<<cases<<",\"sdkTrustCalls\":0,\"childStarted\":false,\"authorizesExecution\":false}\n";
        return 0;
    }catch(const Stop& failure){std::cout<<"{\"result\":\"pure_failed\",\"case\":\""<<failure.phase<<"\"}\n";return 1;}
}
