#include "SelectedTrustPolicy.h"
#include <atomic>
#include <memory>
#include <limits>

static bool HexDigest(const std::string& s) {
    return s.size()==64&&s.find_first_not_of("0123456789abcdef")==std::string::npos;
}
bool SelectedChainComplete(const ChainObservation& c) {
    if(!c.called||!c.built||!c.contextPresent||c.apiError||c.errors||!c.chains||c.chains>8||
        c.flags!=RequestedChainFlags(true,false)||!c.requestedTime||c.elements.size()>32)return false;
    size_t at=0;
    for(DWORD ci=0;ci<c.chains;++ci){
        DWORD ei=0;
        while(at<c.elements.size()&&c.elements[at].simpleChainIndex==ci){
            const auto& e=c.elements[at++];
            if(e.elementIndex!=ei++||e.errors||!HexDigest(e.certificateSha256)||e.notBefore>e.notAfter||
                !TimeInPeriod(c.requestedTime,e.notBefore,e.notAfter))return false;
        }
        if(ei<2)return false;
    }
    return at==c.elements.size();
}
bool SelectedProviderMatches(const ProviderChainCopy& p,const ChainObservation& c) {
    if(!p.present||p.errors||p.chainCount!=c.chains||p.elements.size()!=c.elements.size()||!SelectedChainComplete(c))return false;
    for(size_t i=0;i<c.elements.size();++i){const auto& a=p.elements[i];const auto& b=c.elements[i];
        if(a.errors||a.simpleChainIndex!=b.simpleChainIndex||a.elementIndex!=b.elementIndex||
            a.certificateSha256!=b.certificateSha256||a.notBefore!=b.notBefore||a.notAfter!=b.notAfter)return false;
    }
    return true;
}
bool SelectedIssuerRootsCurrent(const ChainObservation& c,uint64_t current) {
    if(!SelectedChainComplete(c)||!current)return false;
    for(const auto& e:c.elements)if(e.elementIndex&&!TimeInPeriod(current,e.notBefore,e.notAfter))return false;
    return true;
}
bool SelectedRevocationComplete(const ChainObservation& c,uint64_t started) {
    if(!SelectedChainComplete(c))return false;
    const auto& r=c.currentRevocation;
    if(!r.requested||!r.contextsAvailable||std::strcmp(r.disposition,"observed")||r.cacheResync!=started||
        !started||r.timeToUse<started||r.currentTime!=r.timeToUse||r.flags!=RequestedRevocationFlags(true)||
        r.ocspChainFlags!=RequestedChainFlags(true,false)||r.timeoutMs!=10000)return false;
    size_t row=0;
    for(size_t i=0;i<c.elements.size();++i){
        const auto& e=c.elements[i];
        if(i+1==c.elements.size()||c.elements[i+1].simpleChainIndex!=e.simpleChainIndex)continue;
        if(row>=r.rows.size())return false;
        const auto& v=r.rows[row++];
        if(v.certificateRow!=i||v.issuerRow!=i+1||!v.succeeded||v.nativeError||v.statusAvailable||
            v.statusError||v.statusIndex||v.reasonAvailable||v.reason||(!v.freshnessAvailable&&v.crlAgeSeconds))return false;
    }
    return row==r.rows.size()&&row>0;
}
bool SelectedClockBound(uint64_t begin,uint64_t end,uint64_t frequency,uint64_t utcBegin,uint64_t utcEnd) {
    if(!frequency||frequency>1000000000ULL||end<begin||!utcBegin||utcEnd<utcBegin)return false;
    const auto delta=end-begin;
    if(delta>=frequency*30||utcEnd-utcBegin>=300000000)return false;
    // Conservative consistency check, not an authority-granting clock correction.
    const auto monoMs=delta*1000/frequency,wallMs=(utcEnd-utcBegin)/10000;
    return monoMs>wallMs?monoMs-wallMs<=100:wallMs-monoMs<=100;
}

static std::wstring HeldFinalPath(HANDLE file) {
    wchar_t text[513]{};
    const DWORD count=GetFinalPathNameByHandleW(file,text,513,0);
    Need(count>0&&count<=512,"selected_final_path_bound");return std::wstring(text,count);
}
static bool ExpectedObject(HANDLE file,const LexTrustRequestV2& r) {
    FILE_ATTRIBUTE_TAG_INFO tag{};FILE_STANDARD_INFO standard{};FILE_ID_INFO id{};
    return GetFileType(file)==FILE_TYPE_DISK&&GetFileInformationByHandleEx(file,FileAttributeTagInfo,&tag,sizeof(tag))&&
        !(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))&&
        GetFileInformationByHandleEx(file,FileStandardInfo,&standard,sizeof(standard))&&!standard.Directory&&!standard.DeletePending&&
        standard.NumberOfLinks==1&&standard.EndOfFile.QuadPart>=0&&static_cast<uint64_t>(standard.EndOfFile.QuadPart)==r.bytes&&
        GetFileInformationByHandleEx(file,FileIdInfo,&id,sizeof(id))&&id.VolumeSerialNumber==r.volume&&
        std::memcmp(id.FileId.Identifier,r.fileId,16)==0;
}
static std::vector<BYTE> ReadSelected(HANDLE file,uint64_t bytes) {
    Need(bytes>0&&bytes<=64*1024*1024,"selected_size_bound");
    LARGE_INTEGER zero{};Need(SetFilePointerEx(file,zero,nullptr,FILE_BEGIN),"selected_seek");
    std::vector<BYTE> out(static_cast<size_t>(bytes));size_t at=0;
    while(at<out.size()){
        const DWORD request=static_cast<DWORD>(std::min<size_t>(out.size()-at,1024*1024));DWORD got=0;
        Need(ReadFile(file,out.data()+at,request,&got,nullptr)&&got>0&&got<=request,"selected_read");at+=got;
    }
    Need(SetFilePointerEx(file,zero,nullptr,FILE_BEGIN),"selected_rewind");return out;
}
// One global latch across both entry points, including input refusals.
static std::atomic_flag SelectedRequestUsed=ATOMIC_FLAG_INIT;
static void InitializeSelectedResult(LexTrustResultV2& out) noexcept {
    out={};out.size=sizeof(out);out.version=LexTrustAbiVersion;
    out.requiredMask=LexTrustRequiredMask;out.failedMask=LexTrustRequiredMask;out.policyRevision=1;
    out.completion=static_cast<uint32_t>(LexTrustCompletion::Refused);out.phase=static_cast<uint32_t>(LexTrustPhase::Input);
    out.winTrustResult=out.stateCloseResult=static_cast<int32_t>(E_UNEXPECTED);
    out.primaryPurposeError=out.timestampPurposeError=MAXDWORD;
}
static int32_t VerifySelectedCore(const LexTrustRequestV2* request,LexTrustResultV2* result,
    LexTrustFileKind kind,GUID* subject) noexcept {
    if(!result)return 1;
    *result={};auto& out=*result;out.size=sizeof(out);out.version=LexTrustAbiVersion;
    out.requiredMask=LexTrustRequiredMask;out.failedMask=LexTrustRequiredMask;out.policyRevision=1;
    out.completion=static_cast<uint32_t>(LexTrustCompletion::Refused);out.phase=static_cast<uint32_t>(LexTrustPhase::Input);
    out.winTrustResult=out.stateCloseResult=static_cast<int32_t>(E_UNEXPECTED);
    out.primaryPurposeError=out.timestampPurposeError=MAXDWORD;
    if(!request||request->size!=sizeof(LexTrustRequestV2)||request->version!=LexTrustAbiVersion||request->reserved||
        !request->image||request->image==reinterpret_cast<uintptr_t>(INVALID_HANDLE_VALUE)||
        !request->finalPath||!request->pathChars||request->pathChars>512||!request->bytes||request->bytes>64*1024*1024||
        !request->volume||std::all_of(std::begin(request->fileId),std::end(request->fileId),[](BYTE v){return v==0;}))return 1;
    const auto input=*request;
    SelectedTrustFacts facts;bool caught=false,uncertain=false;
    std::unique_ptr<Cms> cms;std::unique_ptr<SharedWinTrustSession> operation;std::unique_ptr<SharedTimestampOperation> timestamp;
    ChainObservation primary,tsa;std::wstring expectedPath;
    auto phase=[&](LexTrustPhase p){out.phase=static_cast<uint32_t>(p);};
    LARGE_INTEGER begin{},end{},frequency{};FILETIME started{},ended{};
    try {
        Need(QueryPerformanceFrequency(&frequency)&&frequency.QuadPart>0&&QueryPerformanceCounter(&begin)&&begin.QuadPart>=0,"selected_clock_start");
        GetSystemTimePreciseAsFileTime(&started);out.startedQpc=static_cast<uint64_t>(begin.QuadPart);
        out.qpcFrequency=static_cast<uint64_t>(frequency.QuadPart);out.startedUtc=FileTimeValue(started);
        const auto& r=input;const auto file=reinterpret_cast<HANDLE>(r.image);
        phase(LexTrustPhase::Identity);facts.identityBefore=ExpectedObject(file,r);Need(facts.identityBefore,"selected_identity_before");
        const std::wstring expected(reinterpret_cast<const wchar_t*>(r.finalPath),r.pathChars);
        expectedPath=expected;
        Need(expected.find(L'\0')==std::wstring::npos&&expected.size()>7&&expected.substr(0,4)==L"\\\\?\\"&&
            ((expected[4]>=L'A'&&expected[4]<=L'Z')||(expected[4]>=L'a'&&expected[4]<=L'z'))&&expected[5]==L':'&&expected[6]==L'\\',"selected_path_form");
        const auto actualPath=HeldFinalPath(file);facts.path=_wcsicmp(actualPath.c_str(),expected.c_str())==0;
        Need(facts.path,"selected_path_mismatch");
        phase(LexTrustPhase::Digest);const auto bytes=ReadSelected(file,r.bytes);const auto expectedSha=Hex(r.sha256,32);
        facts.rawBefore=Sha(bytes.data(),bytes.size())==expectedSha;Need(facts.rawBefore,"selected_raw_digest");
        cms=std::make_unique<Cms>();
        if(kind==LexTrustFileKind::Pe) {
            DWORD certOffset=0,certLength=0;CheckPe(bytes,certOffset,certLength);
            cms->Init(bytes,certOffset,certLength);
        } else {
            std::vector<BYTE> encoded;GUID observed{};
            ReadMsiSubject(file,actualPath,encoded,observed);
            if(subject)*subject=observed;
            cms->InitEncodedMessage(encoded.data(),static_cast<DWORD>(encoded.size()));
        }
        phase(LexTrustPhase::WinTrust);operation=std::make_unique<SharedWinTrustSession>(file,actualPath,true);
        RecordSelectedRequest(*operation,out);
        const auto observed=operation->VerifyAndObserve(*cms);out.winTrustResult=observed.result;
        out.requestVerifiedIndex=operation->signature.dwVerifiedSigIndex;out.requestSecondaryCount=operation->signature.cSecondarySigs;
        facts.winTrust=observed.result==0&&observed.primaryCount==1&&observed.signerError==0&&
            operation->signature.cSecondarySigs==0&&operation->signature.dwVerifiedSigIndex==0&&observed.providerMatches&&observed.metadata&&
            cms->primaryCount==1&&cms->tokenCount==1&&cms->nestedCount==0;
        phase(LexTrustPhase::Timestamp);timestamp=std::make_unique<SharedTimestampOperation>(cms->token,cms->tokenBytes,
            cms->signer()->EncryptedHash.pbData,cms->signer()->EncryptedHash.cbData,cms->store);
        auto& resources=timestamp->resources;PurposeObservation primaryPurpose,tsaPurpose;
        if(timestamp->succeeded&&resources.timestamp&&resources.timestamp->pTimeStamp&&resources.tsa){
            const auto stamp=resources.timestamp->pTimeStamp->ftTime;const auto stampValue=FileTimeValue(stamp);
            const auto tsaSha=Sha(resources.tsa->pbCertEncoded,resources.tsa->cbCertEncoded);
            facts.timestamp=stampValue>0&&stampValue<=out.startedUtc&&observed.counters==1&&observed.providerCounters.size()==1&&
                observed.providerPrimary.signerPresent&&observed.providerPrimary.certificatePresent&&observed.providerPrimary.error==0&&
                observed.providerPrimary.verificationTime==stampValue&&observed.providerCounters[0].signerPresent&&
                observed.providerCounters[0].certificatePresent&&observed.providerCounters[0].error==0&&
                observed.providerCounters[0].type==SGNR_TYPE_TIMESTAMP&&observed.providerCounters[0].verificationTime==stampValue&&
                observed.providerCounters[0].certificateSha256==tsaSha;
            phase(LexTrustPhase::Chains);size_t remaining=32;
            primary=ObserveChain(cms->signerCert,cms->store,stamp,started,true,szOID_PKIX_KP_CODE_SIGNING,remaining,false,true,&primaryPurpose);
            tsa=ObserveChain(resources.tsa,resources.store,stamp,started,true,szOID_PKIX_KP_TIMESTAMP_SIGNING,remaining,false,true,&tsaPurpose);
            out.primaryChainFlags=primary.flags;out.timestampChainFlags=tsa.flags;
            out.primaryRevocationFlags=primary.currentRevocation.flags;out.timestampRevocationFlags=tsa.currentRevocation.flags;
            out.primaryOcspChainFlags=primary.currentRevocation.ocspChainFlags;out.timestampOcspChainFlags=tsa.currentRevocation.ocspChainFlags;
            out.primaryResync=primary.currentRevocation.cacheResync;out.timestampResync=tsa.currentRevocation.cacheResync;
            out.primaryRevocationAt=primary.currentRevocation.currentTime;out.timestampRevocationAt=tsa.currentRevocation.currentTime;
            facts.primaryChain=SelectedChainComplete(primary);facts.timestampChain=SelectedChainComplete(tsa);
            const auto provider=operation->CopyProviderChains();
            facts.providerChains=SelectedProviderMatches(provider.primary,primary)&&SelectedProviderMatches(provider.timestamp,tsa);
            facts.purposes=SelectedPurposesComplete(primaryPurpose,tsaPurpose);
            out.primaryChains=primary.chains;out.timestampChains=tsa.chains;
            out.primaryPurposeError=primaryPurpose.error;out.timestampPurposeError=tsaPurpose.error;
            phase(LexTrustPhase::Revocation);facts.revocation=SelectedRevocationComplete(primary,out.startedUtc)&&SelectedRevocationComplete(tsa,out.startedUtc);
        }
    } catch(...) {caught=true;}
    // Every resource is closed once, with errors retained; the destructors see null/closed owners.
    phase(LexTrustPhase::Close);
    if(operation&&operation->trust.attempted){operation->trust.Close();out.requestCloseAction=operation->trust.data.dwStateAction;out.stateCloseResult=operation->trust.closeResult;uncertain=out.stateCloseResult!=0;}
    bool resourcesClosed=true;
    if(timestamp)resourcesClosed=timestamp->resources.CloseObserved()&&resourcesClosed;
    if(cms)resourcesClosed=cms->CloseObserved()&&resourcesClosed;
    uncertain=uncertain||!resourcesClosed;facts.close=operation&&operation->trust.attempted&&operation->trust.closed&&!out.stateCloseResult&&resourcesClosed;
    try {
        if(out.startedUtc){
            phase(LexTrustPhase::FinalIdentity);const auto file=reinterpret_cast<HANDLE>(input.image);
            facts.identityAfter=ExpectedObject(file,input);const auto bytes=ReadSelected(file,input.bytes);
            facts.rawAfter=Sha(bytes.data(),bytes.size())==Hex(input.sha256,32);
            facts.path=facts.path&&!expectedPath.empty()&&_wcsicmp(HeldFinalPath(file).c_str(),expectedPath.c_str())==0;
            if(facts.identityAfter&&facts.rawAfter){
                std::copy(std::begin(input.sha256),std::end(input.sha256),out.sha256);
                std::copy(std::begin(input.fileId),std::end(input.fileId),out.fileId);out.volume=input.volume;
            }
        }
        Need(QueryPerformanceCounter(&end)&&end.QuadPart>=0,"selected_clock_end");GetSystemTimePreciseAsFileTime(&ended);
        out.endedQpc=static_cast<uint64_t>(end.QuadPart);out.endedUtc=FileTimeValue(ended);
        facts.clock=SelectedClockBound(out.startedQpc,out.endedQpc,out.qpcFrequency,out.startedUtc,out.endedUtc);
        facts.issuerRootPeriods=SelectedIssuerRootsCurrent(primary,out.endedUtc)&&SelectedIssuerRootsCurrent(tsa,out.endedUtc);
        facts.revocation=facts.revocation&&primary.currentRevocation.currentTime<=out.endedUtc&&tsa.currentRevocation.currentTime<=out.endedUtc&&
            CurrentRevocationCalls==primary.currentRevocation.rows.size()+tsa.currentRevocation.rows.size();
    }catch(...){caught=true;}
    facts.winTrust=facts.winTrust&&NativeTrustCalls==2&&TimestampMathCalls==1;
    facts.purposes=facts.purposes&&PurposePolicyCalls==2;
    SelectedApplyCloseState(facts,uncertain,CngCloseState);
    out.observedMask=SelectedFactsMask(facts);out.failedMask=LexTrustRequiredMask^out.observedMask;
    out.winTrustCalls=NativeTrustCalls;out.timestampCalls=TimestampMathCalls;out.revocationCalls=CurrentRevocationCalls;
    out.purposeCalls=PurposePolicyCalls;
    out.completion=static_cast<uint32_t>(SelectedCompletion(caught,uncertain,out.observedMask));
    if(!caught&&!uncertain&&out.observedMask==LexTrustRequiredMask)phase(LexTrustPhase::Completed);
    return 0;
}


extern "C" int32_t __cdecl LexRunnerVerifySelectedTrustV2(const LexTrustRequestV2* request,LexTrustResultV2* result) noexcept {
    if(!result)return 1;
    InitializeSelectedResult(*result);
    if(SelectedRequestUsed.test_and_set(std::memory_order_acq_rel)) {
        result->phase=static_cast<uint32_t>(LexTrustPhase::AlreadyUsed);return 2;
    }
    return VerifySelectedCore(request,result,LexTrustFileKind::Pe,nullptr);
}
extern "C" int32_t __cdecl LexRunnerVerifySelectedTrustV3(const LexTrustRequestV3* request,LexTrustResultV3* result) noexcept {
    if(!result)return 1;
    *result={};result->size=sizeof(*result);result->version=LexTrustAbiVersion3;
    InitializeSelectedResult(result->selected);
    if(SelectedRequestUsed.test_and_set(std::memory_order_acq_rel)) {
        result->selected.phase=static_cast<uint32_t>(LexTrustPhase::AlreadyUsed);return 2;
    }
    if(!LexTrustV3HeaderSupported(request))return 1;
    result->fileKind=request->fileKind;
    result->implementedFeatures=LexTrustFeaturesForKind(request->fileKind);
    GUID observed{};
    const auto status=VerifySelectedCore(&request->input,&result->selected,
        static_cast<LexTrustFileKind>(request->fileKind),&observed);
    std::memcpy(result->observedSubject,&observed,sizeof(observed));
    return status;
}
