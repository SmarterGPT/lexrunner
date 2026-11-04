#include "SelectedTrustPolicy.h"
#include <iostream>
#include <memory>

namespace {
struct FileClose { bool operator()(HANDLE h) const noexcept { return CloseHandle(h)!=FALSE; } };
using FileOwner=SingleCloseOwner<HANDLE,FileClose>;
struct HeldFile {
    std::vector<std::unique_ptr<FileOwner>> owners;
    HANDLE image{};
    FILE_ID_INFO identity{};
    uint64_t bytes{};
    std::wstring finalPath;
    std::vector<BYTE> content;
    bool Close() noexcept {
        bool ok=true;
        for(auto i=owners.rbegin();i!=owners.rend();++i)ok=(*i)->CloseObserved()&&ok;
        return ok;
    }
    ~HeldFile(){(void)Close();}
    HeldFile(const HeldFile&)=delete;
    HeldFile()=default;
    void Hold(const std::wstring& path,bool directory) {
        const auto h=CreateFileW(path.c_str(),directory?FILE_READ_ATTRIBUTES:GENERIC_READ,
            directory?(FILE_SHARE_READ|FILE_SHARE_WRITE):FILE_SHARE_READ,nullptr,
            OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr);
        Need(h!=INVALID_HANDLE_VALUE,"probe_open_refused");
        auto owner=std::make_unique<FileOwner>(h,CngCloseState,FileClose{});
        FILE_ATTRIBUTE_TAG_INFO tag{};
        Need(GetFileType(h)==FILE_TYPE_DISK&&GetFileInformationByHandleEx(h,FileAttributeTagInfo,&tag,sizeof(tag))&&
            !(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&
            ((tag.FileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=0)==directory,"probe_type_or_reparse");
        owners.push_back(std::move(owner));
        if(!directory)image=h;
    }
    void Open(const std::wstring& path) {
        wchar_t absolute[513]{};
        const auto n=GetFullPathNameW(path.c_str(),513,absolute,nullptr);
        Need(n>3&&n<513&&absolute[1]==L':'&&absolute[2]==static_cast<wchar_t>(0x5c)&&path==absolute,"probe_fixed_absolute_path");
        std::wstring normalized=absolute;
        Need(normalized.find(L':',2)==std::wstring::npos,"probe_stream_refused");
        Hold(normalized.substr(0,3),true);
        for(size_t i=3;i<normalized.size();++i)if(normalized[i]==static_cast<wchar_t>(0x5c))Hold(normalized.substr(0,i),true);
        Hold(normalized,false);
        wchar_t actual[513]{};
        const auto count=GetFinalPathNameByHandleW(image,actual,513,0);
        Need(count>0&&count<513,"probe_final_path_bound");finalPath.assign(actual,count);
        const auto slash=static_cast<wchar_t>(0x5c);
        const auto expectedFinal=std::wstring(2,slash)+L"?"+slash+normalized;
        Need(_wcsicmp(finalPath.c_str(),expectedFinal.c_str())==0,"probe_final_path_mismatch");
        FILE_STANDARD_INFO standard{};
        Need(GetFileInformationByHandleEx(image,FileStandardInfo,&standard,sizeof(standard))&&
            !standard.Directory&&!standard.DeletePending&&standard.NumberOfLinks==1&&
            standard.EndOfFile.QuadPart>0&&standard.EndOfFile.QuadPart<=64*1024*1024&&
            GetFileInformationByHandleEx(image,FileIdInfo,&identity,sizeof(identity)),"probe_identity_bound");
        bytes=static_cast<uint64_t>(standard.EndOfFile.QuadPart);content.resize(static_cast<size_t>(bytes));
        size_t at=0;
        while(at<content.size()) {DWORD got=0;const auto ask=static_cast<DWORD>(std::min<size_t>(content.size()-at,1024*1024));
            Need(ReadFile(image,content.data()+at,ask,&got,nullptr)&&got>0&&got<=ask,"probe_read");at+=got;}
        LARGE_INTEGER zero{};Need(SetFilePointerEx(image,zero,nullptr,FILE_BEGIN)!=FALSE,"probe_rewind");
    }
};
std::string NarrowAscii(const wchar_t* value) {
    std::string out;
    for(const auto* p=value;*p;++p){Need(*p>=32&&*p<127,"probe_ascii_input");out.push_back(static_cast<char>(*p));}
    return out;
}
LexTrustRequestV3 Request(uint32_t kind,const HeldFile& held,const std::string& pin,uint64_t expectedBytes) {
    Need(pin.size()==64&&pin.find_first_not_of("0123456789abcdefABCDEF")==std::string::npos,"probe_pin_shape");
    LexTrustRequestV3 r{};r.size=sizeof(r);r.version=3;r.fileKind=kind;r.requiredFeatures=LexTrustFeaturesForKind(kind);
    r.input.size=sizeof(r.input);r.input.version=2;r.input.image=reinterpret_cast<uintptr_t>(held.image);
    r.input.volume=held.identity.VolumeSerialNumber;std::memcpy(r.input.fileId,held.identity.FileId.Identifier,16);
    r.input.bytes=expectedBytes;
    for(size_t i=0;i<32;++i)r.input.sha256[i]=static_cast<uint8_t>(std::stoul(pin.substr(2*i,2),nullptr,16));
    r.input.finalPath=reinterpret_cast<const uint16_t*>(held.finalPath.c_str());
    r.input.pathChars=static_cast<uint32_t>(held.finalPath.size());return r;
}
int Abi(const std::string& name) {
    LexTrustRequestV3 r{};r.size=sizeof(r);r.version=3;r.fileKind=2;r.requiredFeatures=LexTrustFeaturesForKind(2);
    r.input.size=sizeof(r.input);r.input.version=2;
    if(name=="version")r.version=4;
    else if(name=="size")--r.size;
    else if(name=="kind")r.fileKind=99;
    else if(name=="features")r.requiredFeatures|=0x80000000;
    else if(name=="reserved")r.reserved[3]=1;
    else Need(name=="missing-handle"||name=="v2-then-v3"||name=="v3-then-v2","abi_case_unknown");
    LexTrustResultV3 a{},b{};LexTrustResultV2 v2{};int32_t first=0,second=0;
    if(name=="v2-then-v3") {first=LexRunnerVerifySelectedTrustV2(nullptr,&v2);second=LexRunnerVerifySelectedTrustV3(&r,&b);}
    else {first=LexRunnerVerifySelectedTrustV3(&r,&a);
        second=name=="v3-then-v2"?LexRunnerVerifySelectedTrustV2(nullptr,&v2):LexRunnerVerifySelectedTrustV3(&r,&b);}
    const auto phase=(name=="v3-then-v2")?v2.phase:b.selected.phase;
    Need(first==1&&second==2&&phase==static_cast<uint32_t>(LexTrustPhase::AlreadyUsed)&&
        NativeTrustCalls==0&&CurrentRevocationCalls==0&&TimestampMathCalls==0&&PurposePolicyCalls==0&&!CngCloseState.Uncertain(),"abi_refusal_or_once_failed");
    std::cout<<"{\"result\":\"abi_refusal_pure_pass\",\"case\":\""<<name<<"\",\"first\":"<<first
        <<",\"second\":"<<second<<",\"sdkTrustCalls\":0,\"authorizesExecution\":false}\n";return 0;
}
int Functional(int argc,wchar_t** argv) {
    Need(argc==6||argc==7,"probe_argument_count");
    const auto kindText=NarrowAscii(argv[2]);
    const uint32_t kind=(kindText=="pe"||kindText=="pe-v2")?1:kindText=="msi"?2:0;Need(kind!=0,"probe_kind_unsupported");
    HeldFile held;held.Open(argv[3]);
    const auto pin=NarrowAscii(argv[4]),sizeText=NarrowAscii(argv[5]);
    Need(sizeText.size()<=8&&sizeText.find_first_not_of("0123456789")==std::string::npos,"probe_size_shape");
    auto request=Request(kind,held,pin,std::stoull(sizeText));LexTrustResultV3 result{};
    std::wstring changedPath;
    if(argc==7) {
        const auto control=NarrowAscii(argv[6]);
        if(control=="file-id")request.input.fileId[0]^=1;
        else if(control=="volume")request.input.volume^=1;
        else if(control=="path") {
            changedPath=held.finalPath+L".different";
            request.input.finalPath=reinterpret_cast<const uint16_t*>(changedPath.c_str());
            request.input.pathChars=static_cast<uint32_t>(changedPath.size());
        } else Need(false,"probe_input_control_unknown");
    }
    int32_t status=0;
    if(kindText=="pe-v2") {
        result.size=sizeof(result);result.version=3;result.fileKind=1;
        result.implementedFeatures=LexTrustFeaturesForKind(1);
        status=LexRunnerVerifySelectedTrustV2(&request.input,&result.selected);
    } else status=LexRunnerVerifySelectedTrustV3(&request,&result);
    const bool closed=held.Close();
    // Outputs are diagnostic data, never bootstrap/qualification/installation.
    std::cout<<"{\"result\":\"trust_subject_observation\",\"nativeStatus\":"<<status
        <<",\"fileKind\":"<<kind<<",\"completion\":"<<result.selected.completion
        <<",\"observedMask\":"<<result.selected.observedMask<<",\"failedMask\":"<<result.selected.failedMask
        <<",\"ownersClosed\":"<<(closed?"true":"false")<<",\"phase\":"<<result.selected.phase
        <<",\"winTrustCalls\":"<<result.selected.winTrustCalls
        <<",\"timestampCalls\":"<<result.selected.timestampCalls
        <<",\"winTrustResult\":"<<result.selected.winTrustResult
        <<",\"resultAbiHex\":\""
        <<Hex(reinterpret_cast<const BYTE*>(&result),sizeof(result))
        <<"\",\"msiObjectConsumptionQualified\":false,\"authorizesExecution\":false}\n";
    return closed&&!CngCloseState.Uncertain()?0:3;
}
// Explicit extraction-only diagnostic. It consumes the SAME retained finalPath
// and fixed helper as the refused MSI request; no normalization or provider,
// GUID, core-policy, ABI or filename/hFile rule is changed here.
int MsiExtractionOnly(int argc,wchar_t** argv) {
    Need(argc==5,"extraction_argument_count");
    HeldFile held;held.Open(argv[2]);
    const auto pin=NarrowAscii(argv[3]),sizeText=NarrowAscii(argv[4]);
    Need(sizeText.size()<=8&&sizeText.find_first_not_of("0123456789")==std::string::npos,"extraction_size_shape");
    const auto request=Request(2,held,pin,std::stoull(sizeText));
    Need(held.bytes==request.input.bytes&&Sha(held.content.data(),held.content.size())==Hex(request.input.sha256,32),"extraction_original_pin_mismatch");
    std::vector<BYTE> encoded;GUID subject{};
    ReadMsiSubject(held.image,held.finalPath,encoded,subject);
    Cms cms;cms.InitEncodedMessage(encoded.data(),static_cast<DWORD>(encoded.size()));
    bool closed=cms.CloseObserved();closed=held.Close()&&closed;
    Need(closed&&!CngCloseState.Uncertain(),"extraction_close_uncertain");
    Need(NativeTrustCalls==0&&TimestampMathCalls==0&&CurrentRevocationCalls==0&&PurposePolicyCalls==0,"extraction_no_trust_calls");
    std::cout<<R"({"result":"msi_extraction_only_observation","encodedCmsBytes":)"<<encoded.size()
        <<R"(,"subjectGuidBytesHex":")"<<Hex(reinterpret_cast<const BYTE*>(&subject),sizeof(subject))
        <<R"(","primarySigners":)"<<cms.primaryCount<<R"(,"timestampTokens":)"<<cms.tokenCount
        <<R"(,"nestedSignatures":)"<<cms.nestedCount
        <<R"(,"ownersClosed":true,"localWinTrustCalls":0,"localTimestampMathCalls":0,"localRevocationCalls":0,"localPurposeCalls":0,"msiObjectConsumptionQualified":false,"authorizesExecution":false})"<<'\n';
    return 0;
}
// Observe addresses only: no dispatch extraction callback, CMS, WVT or chains.
// Fixed module names are independently documented Windows OS data; observations
// never become a provider allowlist or weaken ReadMsiSubject's existing check.
struct ProbeModuleClose { bool operator()(HMODULE h) const noexcept { return FreeLibrary(h)!=FALSE; } };
using ProbeModuleOwner=SingleCloseOwner<HMODULE,ProbeModuleClose>;
std::string JsonPath(const std::wstring& value) {
    std::string out="\"";constexpr char digits[]="0123456789abcdef";
    for(const wchar_t c:value) {
        if(c==L'\\'||c==L'"'){out+='\\';out+=static_cast<char>(c);}
        else if(c>=32&&c<127)out+=static_cast<char>(c);
        else {out+="\\u";for(int shift=12;shift>=0;shift-=4)out+=digits[(static_cast<unsigned>(c)>>shift)&15];}
    }
    return out+'"';
}
std::wstring ProbeModulePath(HMODULE module) {
    wchar_t path[513]{};const auto n=GetModuleFileNameW(module,path,513);
    Need(n>0&&n<513,"address_module_path_bound");return std::wstring(path,n);
}
int MsiProviderAddressOnly(int argc,wchar_t** argv) {
    Need(argc==5,"address_argument_count");HeldFile held;held.Open(argv[2]);
    const auto pin=NarrowAscii(argv[3]),sizeText=NarrowAscii(argv[4]);
    Need(sizeText.size()<=8&&sizeText.find_first_not_of("0123456789")==std::string::npos,"address_size_shape");
    const auto request=Request(2,held,pin,std::stoull(sizeText));
    Need(held.bytes==request.input.bytes&&Sha(held.content.data(),held.content.size())==Hex(request.input.sha256,32),"address_original_pin_mismatch");
    GUID subject{};Need(CryptSIPRetrieveSubjectGuid(held.finalPath.c_str(),held.image,&subject)!=FALSE,"address_subject_guid");
    Need(IsEqualGUID(subject,ExpectedMsiSubject)!=FALSE,"address_subject_unsupported");
    SIP_DISPATCH_INFO dispatch{};dispatch.cbSize=sizeof(dispatch);
    Need(CryptSIPLoad(&subject,0,&dispatch)!=FALSE&&dispatch.pfGet,"address_dispatch_unavailable");
    HMODULE dispatchModule{},publicModule{};
    Need(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,reinterpret_cast<LPCWSTR>(dispatch.pfGet),&dispatchModule)!=FALSE,"address_dispatch_reference");
    ProbeModuleOwner dispatchOwner(dispatchModule,CngCloseState,{});
    const auto publicGet=&CryptSIPGetSignedDataMsg;
    Need(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,reinterpret_cast<LPCWSTR>(publicGet),&publicModule)!=FALSE,"address_public_reference");
    ProbeModuleOwner publicOwner(publicModule,CngCloseState,{});
    const auto dispatchPath=ProbeModulePath(dispatchModule),publicPath=ProbeModulePath(publicModule);
    wchar_t system[513]{};const auto n=GetSystemDirectoryW(system,513);
    Need(n>0&&n<513,"address_system_path_bound");
    const auto fixedMsiPath=std::wstring(system,n)+L"\\msisip.dll",fixedPublicPath=std::wstring(system,n)+L"\\crypt32.dll";
    // Query ALREADY loaded fixed modules; do not load a guessed provider to make
    // an expected address appear. Missing module/export is diagnostic data.
    HMODULE fixedMsi{},fixedPublic{};
    const bool msiPresent=GetModuleHandleExW(0,fixedMsiPath.c_str(),&fixedMsi)!=FALSE;
    const auto msiLookupError=msiPresent?0:GetLastError();
    ProbeModuleOwner msiOwner(fixedMsi,CngCloseState,{});
    const bool publicPresent=GetModuleHandleExW(0,fixedPublicPath.c_str(),&fixedPublic)!=FALSE;
    const auto publicLookupError=publicPresent?0:GetLastError();
    ProbeModuleOwner fixedPublicOwner(fixedPublic,CngCloseState,{});
    const auto msiExport=msiPresent?GetProcAddress(fixedMsi,"MsiSIPGetSignedDataMsg"):nullptr;
    const auto publicExport=publicPresent?GetProcAddress(fixedPublic,"CryptSIPGetSignedDataMsg"):nullptr;
    bool closed=fixedPublicOwner.CloseObserved();closed=msiOwner.CloseObserved()&&closed;
    closed=publicOwner.CloseObserved()&&closed;closed=dispatchOwner.CloseObserved()&&closed;closed=held.Close()&&closed;
    Need(closed&&!CngCloseState.Uncertain(),"address_close_uncertain");
    Need(NativeTrustCalls==0&&TimestampMathCalls==0&&CurrentRevocationCalls==0&&PurposePolicyCalls==0,"address_no_trust_calls");
    std::cout<<R"({"result":"msi_provider_address_observation","dispatchModulePath":)"<<JsonPath(dispatchPath)
        <<R"(,"publicModulePath":)"<<JsonPath(publicPath)<<R"(,"fixedMsiPath":)"<<JsonPath(fixedMsiPath)<<R"(,"fixedPublicPath":)"<<JsonPath(fixedPublicPath)
        <<R"(,"dispatchAddress":)"<<reinterpret_cast<uintptr_t>(dispatch.pfGet)<<R"(,"publicAddress":)"<<reinterpret_cast<uintptr_t>(publicGet)
        <<R"(,"fixedMsiExportAddress":)"<<reinterpret_cast<uintptr_t>(msiExport)<<R"(,"fixedPublicExportAddress":)"<<reinterpret_cast<uintptr_t>(publicExport)
        <<R"(,"dispatchEqualsPublic":)"<<(reinterpret_cast<FARPROC>(dispatch.pfGet)==reinterpret_cast<FARPROC>(publicGet)?"true":"false")
        <<R"(,"dispatchEqualsFixedMsiExport":)"<<(msiExport&&reinterpret_cast<FARPROC>(dispatch.pfGet)==msiExport?"true":"false")
        <<R"(,"publicEqualsFixedPublicExport":)"<<(publicExport&&reinterpret_cast<FARPROC>(publicGet)==publicExport?"true":"false")
        <<R"(,"fixedMsiAlreadyLoaded":)"<<(msiPresent?"true":"false")<<R"(,"fixedPublicAlreadyLoaded":)"<<(publicPresent?"true":"false")
        <<R"(,"fixedMsiLookupError":)"<<msiLookupError<<R"(,"fixedPublicLookupError":)"<<publicLookupError
        <<R"(,"dispatchReservedHandleNull":)"<<(dispatch.hSIP==nullptr?"true":"false")
        <<R"(,"ownersClosed":true,"dispatchExtractionCalls":0,"publicExtractionCalls":0,"localWinTrustCalls":0,"localTimestampMathCalls":0,"localRevocationCalls":0,"localPurposeCalls":0,"qualification":false,"authorizesExecution":false})"<<'\n';
    return 0;
}
int ProviderControl(int argc,wchar_t** argv) {
    Need(argc==5,"provider_control_argument_count");
    HeldFile image,path,reference;image.Open(argv[2]);path.Open(argv[3]);reference.Open(argv[4]);
    std::vector<BYTE> encoded;GUID subject{};ReadMsiSubject(reference.image,reference.finalPath,encoded,subject);
    Cms cms;cms.InitEncodedMessage(encoded.data(),static_cast<DWORD>(encoded.size()));
    SharedWinTrustSession session(image.image,path.finalPath,true);
    const auto observed=session.VerifyAndObserve(cms);session.trust.Close();
    bool closed=cms.CloseObserved();
    closed=image.Close()&&closed;closed=path.Close()&&closed;closed=reference.Close()&&closed;
    std::cout<<"{\"result\":\"provider_object_consumption_observation\",\"winTrustResult\":"<<observed.result
        <<",\"providerMatchesReferenceCms\":"<<(observed.providerMatches?"true":"false")
        <<",\"winTrustCloseResult\":"<<session.trust.closeResult<<",\"ownersClosed\":"<<(closed?"true":"false")
        <<",\"selectedCompletion\":false,\"authorizesExecution\":false}\n";
    return closed&&!session.trust.closeResult&&!CngCloseState.Uncertain()?0:3;
}
}
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc==2&&std::wstring(argv[1])==L"--layout-selftest") {
            Need(sizeof(LexTrustRequestV2)==96&&sizeof(LexTrustResultV2)==272&&sizeof(LexTrustRequestV3)==128&&sizeof(LexTrustResultV3)==320,"layout_failed");
            std::cout<<"{\"result\":\"layout_pure_pass\",\"v2Request\":96,\"v2Result\":272,\"v3Request\":128,\"v3Result\":320,\"sdkTrustCalls\":0,\"authorizesExecution\":false}\n";return 0;
        }
        if(argc==3&&std::wstring(argv[1])==L"--abi-refusal")return Abi(NarrowAscii(argv[2]));
        // Explicit diagnostic modes only. The qualification verifier defaults to
        // build/pure; root must separately admit the complete functional profile.
        if(argc>1&&std::wstring(argv[1])==L"--msi-provider-address-only")return MsiProviderAddressOnly(argc,argv);
        if(argc>1&&std::wstring(argv[1])==L"--msi-extraction-only")return MsiExtractionOnly(argc,argv);
        if(argc>1&&std::wstring(argv[1])==L"--diagnostic-read-only")return Functional(argc,argv);
        if(argc>1&&std::wstring(argv[1])==L"--provider-control")return ProviderControl(argc,argv);
        std::cerr<<"read_only_probe_mode_required\n";return 2;
    }catch(const Stop& error){
        const auto lastErrorAfterUnwind=GetLastError();
        if(argc>1&&(std::wstring(argv[1])==L"--msi-extraction-only"||std::wstring(argv[1])==L"--msi-provider-address-only")) {
            // Existing Stop.phase survives unwind. This Win32 value may have
            // changed during cleanup; it is NOT the failing API's captured error.
            std::cout<<R"({"result":")"<<(std::wstring(argv[1])==L"--msi-provider-address-only"?"msi_provider_address_refused":"msi_extraction_only_refused")<<R"(","failurePhase":")"<<error.phase
                <<R"(","lastErrorAfterUnwind":)"<<lastErrorAfterUnwind
                <<R"(,"lastErrorCorrelatedWithFailingApi":false,"closeDispositionProvenOnFailure":false,"localWinTrustCalls":)"<<NativeTrustCalls
                <<R"(,"localTimestampMathCalls":)"<<TimestampMathCalls<<R"(,"localRevocationCalls":)"<<CurrentRevocationCalls
                <<R"(,"closeUncertain":)"<<(CngCloseState.Uncertain()?"true":"false")
                <<R"(,"authorizesExecution":false})"<<'\n';
            return 4;
        }
        std::cout<<"{\"result\":\"probe_refused\",\"reason\":\""<<error.phase<<"\",\"authorizesExecution\":false}\n";return 4;}
    catch(...){std::cout<<"{\"result\":\"probe_refused\",\"reason\":\"exception\",\"authorizesExecution\":false}\n";return 4;}
}
