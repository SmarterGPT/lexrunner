#include "HeldTrustSdkCore.h"

namespace {
struct ModuleClose { bool operator()(HMODULE value) const noexcept { return FreeLibrary(value)!=FALSE; } };

}

void ReadMsiSubject(HANDLE image,const std::wstring& finalPath,
    std::vector<BYTE>& encoded,GUID& observedSubject) {
    Need(image&&image!=INVALID_HANDLE_VALUE&&!finalPath.empty(),"msi_subject_input");
    Need(CryptSIPRetrieveSubjectGuid(finalPath.c_str(),image,&observedSubject)!=FALSE,
        "msi_subject_guid_unavailable");
    Need(IsEqualGUID(observedSubject,ExpectedMsiSubject)!=FALSE,"msi_subject_unsupported");
    SIP_DISPATCH_INFO dispatch{};dispatch.cbSize=sizeof(dispatch);
    Need(CryptSIPLoad(&observedSubject,0,&dispatch)!=FALSE,"msi_sip_dispatch_unavailable");
    // hSIP is reserved, not a library handle owned or released by this caller.
    // Retain/release only our documented FROM_ADDRESS reference through extraction.
    const auto function=dispatch.pfGet;
    Need(function!=nullptr,"msi_sip_get_function_missing");
    HMODULE module{};
    Need(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        reinterpret_cast<LPCWSTR>(function),&module)!=FALSE,"msi_sip_module_reference");
    SingleCloseOwner<HMODULE,ModuleClose> owner(module,CngCloseState,{});
    wchar_t system[513]{},actual[513]{};
    const auto systemCount=GetSystemDirectoryW(system,513);
    const auto actualCount=GetModuleFileNameW(module,actual,513);
    Need(systemCount>0&&systemCount<513&&actualCount>0&&actualCount<513,"msi_sip_module_path_bound");
    const auto expected=std::wstring(system,systemCount)+L"\\crypt32.dll";
    Need(_wcsicmp(expected.c_str(),actual)==0,"msi_sip_dispatch_module_mismatch");
    // The supported SDK dispatch is the exact Crypt32 export, not an import
    // thunk in this executable or an arbitrary returned provider. This binds
    // the dispatch entry only; the underlying SIP load graph still needs
    // independently protected loading before installed authoritative use.
    const auto expectedFunction=GetProcAddress(module,"CryptSIPGetSignedDataMsg");
    Need(expectedFunction&&reinterpret_cast<FARPROC>(function)==expectedFunction,
        "msi_sip_dispatch_export_mismatch");
    SIP_SUBJECTINFO subject{};subject.cbSize=sizeof(subject);
    subject.pgSubjectType=&observedSubject;
    // Documented file-subject API: this extraction uses the retained filename,
    // NOT the borrowed hFile. WinTrust uses hFile separately in the common core.
    subject.hFile=INVALID_HANDLE_VALUE;subject.pwsFileName=finalPath.c_str();
    subject.dwEncodingType=X509_ASN_ENCODING|PKCS_7_ASN_ENCODING;
    DWORD encoding=0,size=0;
    Need(function(&subject,&encoding,0,&size,nullptr)!=FALSE&&
        size>0&&size<=4*1024*1024,"msi_signature_size");
    encoded.resize(size);
    // Reuse this initialized subject; index0 only. Index1 is reserved behavior,
    // never an absence/cardinality proof. Shared CMS/provider checks enforce it.
    Need(function(&subject,&encoding,0,&size,encoded.data())!=FALSE&&
        size>0&&size<=encoded.size()&&(encoding==PKCS_7_ASN_ENCODING||
        encoding==(X509_ASN_ENCODING|PKCS_7_ASN_ENCODING)),
        "msi_signature_read");
    encoded.resize(size);
    Need(owner.CloseObserved(),"msi_sip_module_close_uncertain");
}
