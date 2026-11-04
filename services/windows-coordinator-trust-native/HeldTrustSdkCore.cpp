#include "HeldTrustSdkCore.h"
DWORD NativeTrustCalls=0, CurrentRevocationCalls=0, TimestampMathCalls=0, PurposePolicyCalls=0;

void Need(bool b, const char* p) { if (!b) throw Stop(p); }

void RequirePin(const std::string& actual, const char* expected, const char* phase) { Need(actual == expected, phase); }

std::string Hex(const BYTE* b, size_t count) {
    static constexpr char alphabet[] = "0123456789abcdef";
    std::string out; out.reserve(count * 2);
    for (size_t i = 0; i < count; ++i) { out += alphabet[b[i] >> 4]; out += alphabet[b[i] & 15]; }
    return out;
}

NativeCloseState CngCloseState;
namespace {
struct CloseAlgorithmProvider {
    bool operator()(BCRYPT_ALG_HANDLE handle) const noexcept {
        return BCryptCloseAlgorithmProvider(handle,0)>=0;
    }
};
}
void RequireHashAndCloseStatus(NTSTATUS hashStatus,bool closed) {
    Need(hashStatus>=0,"sha_hash");
    Need(closed,"sha_close_uncertain");
}
std::string Sha(const BYTE* b, size_t count) {
    std::array<BYTE, 32> digest{};
    Need(count <= MAXDWORD, "hash_input_bound");
    BCRYPT_ALG_HANDLE alg = nullptr;
    const auto openStatus=BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0);
    SingleCloseOwner<BCRYPT_ALG_HANDLE,CloseAlgorithmProvider> owner(alg,CngCloseState,{});
    Need(openStatus>=0,"sha_open");
    const auto status=BCryptHash(alg,nullptr,0,const_cast<BYTE*>(b),static_cast<ULONG>(count),
        digest.data(),static_cast<ULONG>(digest.size()));
    const bool closed=owner.CloseObserved();
    RequireHashAndCloseStatus(status,closed);
    return Hex(digest.data(),digest.size());
}

bool BlobEqual(const CRYPT_DATA_BLOB& a, const CRYPT_DATA_BLOB& b) {
    return a.cbData == b.cbData && a.cbData && a.pbData && b.pbData &&
        std::memcmp(a.pbData, b.pbData, a.cbData) == 0;
}

bool InBuffer(const std::vector<BYTE>& b, const void* p, size_t count) {
    const auto start = reinterpret_cast<uintptr_t>(b.data());
    const auto ptr = reinterpret_cast<uintptr_t>(p);
    return ptr >= start && count <= b.size() && ptr - start <= b.size() - count;
}

void CheckPe(const std::vector<BYTE>& bytes, DWORD& certOffset, DWORD& certLength) {
    Need(bytes.size() >= sizeof(IMAGE_DOS_HEADER), "pe_dos_size");
    const auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(bytes.data());
    Need(dos->e_magic == IMAGE_DOS_SIGNATURE && dos->e_lfanew >= 0, "pe_dos");
    Need(bytes.size() >= sizeof(IMAGE_NT_HEADERS64) &&
        static_cast<size_t>(dos->e_lfanew) <= bytes.size() - sizeof(IMAGE_NT_HEADERS64), "pe_nt_range");
    const auto nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(bytes.data() + dos->e_lfanew);
    Need(nt->Signature == IMAGE_NT_SIGNATURE && nt->FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64 &&
        nt->OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC &&
        nt->OptionalHeader.NumberOfRvaAndSizes > IMAGE_DIRECTORY_ENTRY_SECURITY, "pe_architecture");
    const auto dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_SECURITY];
    Need(dir.VirtualAddress >= static_cast<DWORD>(dos->e_lfanew) + sizeof(IMAGE_NT_HEADERS64) &&
        dir.Size >= 8 && dir.VirtualAddress <= bytes.size() && dir.Size <= bytes.size() - dir.VirtualAddress,
        "pe_certificate_range");
    const auto entry = reinterpret_cast<const WIN_CERTIFICATE*>(bytes.data() + dir.VirtualAddress);
    Need(entry->dwLength >= 8 && entry->dwLength <= dir.Size &&
        ((static_cast<uint64_t>(entry->dwLength) + 7) & ~uint64_t(7)) == dir.Size &&
        entry->wRevision == WIN_CERT_REVISION_2_0 && entry->wCertificateType == WIN_CERT_TYPE_PKCS_SIGNED_DATA,
        "one_embedded_signature_required");
    certOffset = dir.VirtualAddress + 8; certLength = entry->dwLength - 8;
}

void Cms::Init(const std::vector<BYTE>& bytes, DWORD offset, DWORD length) {
        CRYPT_DATA_BLOB blob{length, const_cast<BYTE*>(bytes.data() + offset)};
        Need(CryptQueryObject(CERT_QUERY_OBJECT_BLOB, &blob, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED,
            CERT_QUERY_FORMAT_FLAG_BINARY, 0, nullptr, nullptr, nullptr, &store, &message, nullptr), "cms_query");
        DWORD size = sizeof(primaryCount);
        Need(CryptMsgGetParam(message, CMSG_SIGNER_COUNT_PARAM, 0, &primaryCount, &size) &&
            primaryCount == 1, "cms_primary_count");
        size = 0;
        Need(CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, nullptr, &size) &&
            size >= sizeof(CMSG_SIGNER_INFO) && size <= 524288, "cms_signer_size");
        signerBytes.resize(size);
        Need(CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, signerBytes.data(), &size), "cms_signer");
        auto s = signer();
        Need(s->UnauthAttrs.cAttr <= 32 && InBuffer(signerBytes, s->EncryptedHash.pbData, s->EncryptedHash.cbData) &&
            s->EncryptedHash.cbData > 0 && s->EncryptedHash.cbData <= 16384, "cms_signature_bounds");
        if (s->UnauthAttrs.cAttr) Need(InBuffer(signerBytes, s->UnauthAttrs.rgAttr,
            sizeof(CRYPT_ATTRIBUTE) * s->UnauthAttrs.cAttr), "cms_attributes_bounds");
        for (DWORD i = 0; i < s->UnauthAttrs.cAttr; ++i) {
            const auto& a = s->UnauthAttrs.rgAttr[i];
            Need(a.pszObjId && InBuffer(signerBytes, a.pszObjId, 1), "cms_oid_bounds");
            const auto available = signerBytes.size() - (reinterpret_cast<const BYTE*>(a.pszObjId) - signerBytes.data());
            const auto end = static_cast<const char*>(std::memchr(a.pszObjId, 0, available));
            Need(end && end - a.pszObjId <= 128, "cms_oid_length");
            if (std::strcmp(a.pszObjId, NestedOid) == 0) ++nestedCount;
            if (std::strcmp(a.pszObjId, TimestampOid) == 0) {
                ++tokenCount;
                Need(a.cValue == 1 && InBuffer(signerBytes, a.rgValue, sizeof(CRYPT_ATTR_BLOB)), "timestamp_value_count");
                token = a.rgValue[0].pbData; tokenBytes = a.rgValue[0].cbData;
                Need(tokenBytes > 0 && tokenBytes <= 262144 && InBuffer(signerBytes, token, tokenBytes), "timestamp_token_bounds");
            }
        }
        Need(nestedCount == 0 && tokenCount == 1, "timestamp_or_nested_policy");
        Need(InBuffer(signerBytes, s->Issuer.pbData, s->Issuer.cbData) && s->Issuer.cbData &&
            InBuffer(signerBytes, s->SerialNumber.pbData, s->SerialNumber.cbData) && s->SerialNumber.cbData,
            "cms_issuer_serial_bounds");
        CERT_INFO info{}; info.Issuer = s->Issuer; info.SerialNumber = s->SerialNumber;
        signerCert = CertFindCertificateInStore(store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
            0, CERT_FIND_SUBJECT_CERT, &info, nullptr);
        Need(signerCert != nullptr, "cms_signer_certificate");
    }

Cms::~Cms() { (void)CloseObserved(); }
bool Cms::CloseObserved() noexcept {
    bool ok=!closeFailed;
    if(signerCert){auto p=signerCert;signerCert=nullptr;ok=CertFreeCertificateContext(p)!=FALSE&&ok;}
    if(message){auto p=message;message=nullptr;ok=CryptMsgClose(p)!=FALSE&&ok;}
    if(store){auto p=store;store=nullptr;ok=CertCloseStore(p,0)!=FALSE&&ok;}
    closeFailed=closeFailed||!ok;return !closeFailed;
}

CMSG_SIGNER_INFO* Cms::signer() { return reinterpret_cast<CMSG_SIGNER_INFO*>(signerBytes.data()); }

bool SubjectDerMatches(const BYTE* bytes, size_t count) {
    return bytes && count == (sizeof(ExpectedSubjectDer) - 1) / 2 && Hex(bytes, count) == ExpectedSubjectDer;
}

bool EkuPolicyMatches(const std::vector<std::string>& usages) {
    return std::count(usages.begin(), usages.end(), szOID_PKIX_KP_CODE_SIGNING) == 1 &&
        std::count(usages.begin(), usages.end(), IdentityOid) == 1;
}

bool MetadataMatches(PCCERT_CONTEXT cert) {
    DWORD size = 0;
    Need(CertStrToNameW(X509_ASN_ENCODING, Subject, CERT_X500_NAME_STR | CERT_NAME_STR_REVERSE_FLAG, nullptr, nullptr, &size, nullptr), "subject_size");
    Need(size <= 4096, "subject_bounds"); std::vector<BYTE> subject(size);
    Need(CertStrToNameW(X509_ASN_ENCODING, Subject, CERT_X500_NAME_STR | CERT_NAME_STR_REVERSE_FLAG, nullptr, subject.data(), &size, nullptr), "subject_encode");
    Need(SubjectDerMatches(subject.data(), size), "approved_subject_der_encoding");
    if (!SubjectDerMatches(cert->pCertInfo->Subject.pbData, cert->pCertInfo->Subject.cbData)) return false;
    size = 0;
    if (!CertGetEnhancedKeyUsage(cert, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, nullptr, &size) ||
        size < sizeof(CERT_ENHKEY_USAGE) || size > 16384) return false;
    std::vector<BYTE> usages(size);
    if (!CertGetEnhancedKeyUsage(cert, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG,
        reinterpret_cast<PCERT_ENHKEY_USAGE>(usages.data()), &size)) return false;
    const auto u = reinterpret_cast<PCERT_ENHKEY_USAGE>(usages.data());
    if (u->cUsageIdentifier > 64 ||
        !InBuffer(usages, u->rgpszUsageIdentifier, sizeof(LPSTR) * u->cUsageIdentifier)) return false;
    std::vector<std::string> observedUsages;
    for (DWORD i = 0; i < u->cUsageIdentifier; ++i) {
        const auto text = u->rgpszUsageIdentifier[i];
        if (!InBuffer(usages, text, 1)) return false;
        const size_t available = usages.size() - (reinterpret_cast<const BYTE*>(text) - usages.data());
        if (!std::memchr(text, 0, available)) return false;
        observedUsages.emplace_back(text);
    }
    return EkuPolicyMatches(observedUsages);
}

uint64_t FileTimeValue(const FILETIME& value) {
    return (static_cast<uint64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}

bool TimeInPeriod(uint64_t time, uint64_t before, uint64_t after) {
    return before <= time && time <= after;
}

ChainContextOwner::~ChainContextOwner() { if (value) CertFreeCertificateChain(value); }

CurrentRevocationObservation ObserveCurrentRevocation(PCCERT_CHAIN_CONTEXT context, const ChainObservation& baseline,
    HCERTSTORE store, const FILETIME& started, bool online) {
    CurrentRevocationObservation out; out.requested = true; out.contextsAvailable = context != nullptr;
    out.flags = RequestedRevocationFlags(online); out.timeoutMs = 10000;
    out.cacheResync = online ? FileTimeValue(started) : 0; out.ocspChainFlags = RequestedChainFlags(online, false);
    if (!context) { out.disposition = "unavailable_chain"; return out; }
    if (!baseline.chains || (baseline.errors & (CERT_TRUST_IS_PARTIAL_CHAIN | CERT_TRUST_IS_UNTRUSTED_ROOT))) {
        out.disposition = "unsupported_chain"; return out;
    }
    out.disposition = "observed";
    FILETIME current{}; GetSystemTimeAsFileTime(&current);
    out.timeToUse = out.currentTime = FileTimeValue(current);
    size_t flat = 0;
    for (DWORD ci = 0; ci < context->cChain; ++ci) {
        const auto simple = context->rgpChain[ci];
        for (DWORD ei = 0; ei < simple->cElement; ++ei, ++flat) {
            if (ei + 1 == simple->cElement) continue; // Terminal trust anchor is not a revocation target.
            Need(flat + 1 < baseline.elements.size() && out.rows.size() < 32, "revocation_context_index_bound");
            const auto target = simple->rgpElement[ei]->pCertContext;
            const auto issuer = simple->rgpElement[ei + 1]->pCertContext;
            const auto& targetRow = baseline.elements[flat]; const auto& issuerRow = baseline.elements[flat + 1];
            Need(targetRow.simpleChainIndex == ci && targetRow.elementIndex == ei && issuerRow.simpleChainIndex == ci &&
                issuerRow.elementIndex == ei + 1 && Sha(target->pbCertEncoded, target->cbCertEncoded) == targetRow.certificateSha256 &&
                Sha(issuer->pbCertEncoded, issuer->cbCertEncoded) == issuerRow.certificateSha256, "revocation_context_identity");
            // SDK wincrypt.h14249: pIssuerCert is issuer of rgpvContext[cContext-1]. Here cContext is exactly1.
            CERT_REVOCATION_PARA para{}; para.cbSize = sizeof(para); para.pIssuerCert = issuer;
            HCERTSTORE stores[]{store}; if (store) { para.cCertStore = 1; para.rgCertStore = stores; }
            para.pftTimeToUse = &current; para.pftCurrentTime = &current; para.dwUrlRetrievalTimeout = out.timeoutMs;
            if (online) para.pftCacheResync = const_cast<FILETIME*>(&started);
            CERT_REVOCATION_CHAIN_PARA ocsp{}; ocsp.cbSize = sizeof(ocsp); ocsp.hChainEngine = HCCE_LOCAL_MACHINE;
            ocsp.hAdditionalStore = store; ocsp.dwChainFlags = out.ocspChainFlags; ocsp.dwUrlRetrievalTimeout = out.timeoutMs;
            ocsp.pftCurrentTime = &current; if (online) ocsp.pftCacheResync = const_cast<FILETIME*>(&started);
            para.pChainPara = &ocsp;
            CERT_REVOCATION_STATUS status{}; status.cbSize = sizeof(status);
            PVOID contexts[]{const_cast<PCERT_CONTEXT>(target)};
            ++CurrentRevocationCalls;
            const BOOL ok = CertVerifyRevocation(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, CERT_CONTEXT_REVOCATION_TYPE,
                1, contexts, out.flags, &para, &status);
            const DWORD error = ok ? 0 : GetLastError();
            Need(ok || error != 0, "revocation_failure_without_error");
            Need(!ok || (status.dwError == 0 && status.dwIndex == 0 && status.dwReason == 0), "revocation_success_status_uncertain");
            CurrentRevocationRow row; row.certificateRow = static_cast<DWORD>(flat); row.issuerRow = static_cast<DWORD>(flat + 1);
            row.succeeded = ok != FALSE; row.nativeError = error;
            row.statusAvailable = !ok && error != static_cast<DWORD>(E_INVALIDARG);
            if (row.statusAvailable) {
                Need(status.dwError == error && status.dwIndex == 0, "revocation_failure_status_uncertain");
                row.statusError = status.dwError; row.statusIndex = status.dwIndex;
            }
            row.reasonAvailable = row.statusAvailable && error == static_cast<DWORD>(CRYPT_E_REVOKED);
            if (row.reasonAvailable) row.reason = status.dwReason;
            row.freshnessAvailable = error != static_cast<DWORD>(E_INVALIDARG) && status.fHasFreshnessTime != FALSE;
            if (row.freshnessAvailable) row.crlAgeSeconds = status.dwFreshnessTime;
            out.rows.push_back(row); // Individual failure is retained; later contexts are still checked.
        }
    }
    return out;
}

ChainObservation ObserveChain(PCCERT_CONTEXT cert, HCERTSTORE store, const FILETIME& at,
    const FILETIME& started, bool online, const char* usage, size_t& remainingElements, bool timestampTime, bool currentRevocation, PurposeObservation* purpose) {
    ChainObservation out; out.called = true; out.requestedTime = FileTimeValue(at);
    FILETIME observation{}; GetSystemTimeAsFileTime(&observation); out.observationTime = FileTimeValue(observation);
    CERT_CHAIN_PARA para{}; para.cbSize = sizeof(para);
    auto oid = const_cast<char*>(usage);
    para.RequestedUsage.dwType = USAGE_MATCH_TYPE_AND;
    para.RequestedUsage.Usage.cUsageIdentifier = 1;
    para.RequestedUsage.Usage.rgpszUsageIdentifier = &oid;
    para.dwUrlRetrievalTimeout = 10000;
    // A cache resync request does not establish response/download freshness.
    if (online) para.pftCacheResync = const_cast<FILETIME*>(&started);
    out.flags = RequestedChainFlags(online, timestampTime);
    ChainContextOwner chain;
    out.built = CertGetCertificateChain(HCCE_LOCAL_MACHINE, cert, const_cast<FILETIME*>(&at), store, &para, out.flags, nullptr, &chain.value) != FALSE;
    out.apiError = out.built ? 0 : GetLastError(); out.contextPresent = chain.value != nullptr;
    if (chain.value) {
        out.errors = chain.value->TrustStatus.dwErrorStatus; out.info = chain.value->TrustStatus.dwInfoStatus;
        out.chains = chain.value->cChain; out.freshnessAvailable = chain.value->fHasRevocationFreshnessTime != FALSE;
        out.freshnessSeconds = out.freshnessAvailable ? chain.value->dwRevocationFreshnessTime : 0;
        Need(out.chains <= 8 && (!out.chains || chain.value->rgpChain), "chain_simple_count_bound");
        for (DWORD ci = 0; ci < out.chains; ++ci) {
            const auto simple = chain.value->rgpChain[ci];
            Need(simple && simple->cElement > 0 && simple->cElement <= remainingElements && simple->rgpElement,
                "chain_element_count_bound");
            remainingElements -= simple->cElement;
            for (DWORD ei = 0; ei < simple->cElement; ++ei) {
                const auto element = simple->rgpElement[ei];
                Need(element && element->pCertContext && element->pCertContext->pCertInfo &&
                    element->pCertContext->pbCertEncoded && element->pCertContext->cbCertEncoded > 0 &&
                    element->pCertContext->cbCertEncoded <= 4 * 1024 * 1024, "chain_certificate_bound");
                const auto context = element->pCertContext;
                ChainElementObservation row; row.simpleChainIndex = ci; row.elementIndex = ei;
                row.errors = element->TrustStatus.dwErrorStatus; row.info = element->TrustStatus.dwInfoStatus;
                row.notBefore = FileTimeValue(context->pCertInfo->NotBefore);
                row.notAfter = FileTimeValue(context->pCertInfo->NotAfter);
                Need(row.notBefore <= row.notAfter, "chain_certificate_period");
                row.validAtTimestamp = TimeInPeriod(out.requestedTime, row.notBefore, row.notAfter);
                row.validAtObservation = TimeInPeriod(out.observationTime, row.notBefore, row.notAfter);
                row.certificateSha256 = Sha(context->pbCertEncoded, context->cbCertEncoded);
                out.elements.push_back(std::move(row));
            }
        }
    }
    if (purpose) {
        purpose->called=true;
        if (chain.value) {
            const LPCSTR kind=std::strcmp(usage,szOID_PKIX_KP_CODE_SIGNING)==0?CERT_CHAIN_POLICY_AUTHENTICODE:
                std::strcmp(usage,szOID_PKIX_KP_TIMESTAMP_SIGNING)==0?CERT_CHAIN_POLICY_AUTHENTICODE_TS:nullptr;
            Need(kind!=nullptr,"selected_purpose_fixed_usage");
            CERT_CHAIN_POLICY_PARA policy{};policy.cbSize=sizeof(policy);
            CERT_CHAIN_POLICY_STATUS status{};status.cbSize=sizeof(status);
            ++PurposePolicyCalls;
            purpose->apiSucceeded=CertVerifyCertificateChainPolicy(kind,chain.value,&policy,&status)!=FALSE;
            purpose->error=purpose->apiSucceeded?status.dwError:GetLastError();
            Need(purpose->apiSucceeded||purpose->error!=0,"purpose_failure_without_error");
        }
    }
    if (currentRevocation) out.currentRevocation = ObserveCurrentRevocation(chain.value, out, store, started, online);
    return out;
}

bool SameChainIdentities(const ChainObservation& actual, const ChainObservation& baseline) {
    if (!actual.contextPresent || !baseline.contextPresent || actual.chains != baseline.chains ||
        actual.elements.empty() || actual.elements.size() != baseline.elements.size()) return false;
    for (size_t i = 0; i < actual.elements.size(); ++i) {
        const auto& a = actual.elements[i]; const auto& b = baseline.elements[i];
        if (a.simpleChainIndex != b.simpleChainIndex || a.elementIndex != b.elementIndex ||
            a.certificateSha256 != b.certificateSha256) return false;
    }
    return true;
}

ProviderSignerObservation ObserveProviderSigner(PCRYPT_PROVIDER_SGNR signer, PCCERT_CONTEXT certificate) {
    ProviderSignerObservation out;
    if (!signer) return out;
    out.signerPresent = true; out.verificationTime = FileTimeValue(signer->sftVerifyAsOf);
    out.error = signer->dwError; out.type = signer->dwSignerType;
    if (certificate) {
        Need(certificate->pbCertEncoded && certificate->cbCertEncoded > 0 && certificate->cbCertEncoded <= 4 * 1024 * 1024,
            "provider_signer_certificate_bound");
        out.certificatePresent = true; out.certificateSha256 = Sha(certificate->pbCertEncoded, certificate->cbCertEncoded);
    }
    return out;
}

TimestampResources::~TimestampResources() { (void)CloseObserved(); }
bool TimestampResources::CloseObserved() noexcept {
    bool ok=!closeFailed;
    if(timestamp){auto p=timestamp;timestamp=nullptr;CryptMemFree(p);}
    if(tsa){auto p=tsa;tsa=nullptr;ok=CertFreeCertificateContext(p)!=FALSE&&ok;}
    if(store){auto p=store;store=nullptr;ok=CertCloseStore(p,0)!=FALSE&&ok;}
    closeFailed=closeFailed||!ok;return !closeFailed;
}

void TrustState::Close() { if (attempted && !closed) { data.dwStateAction = WTD_STATEACTION_CLOSE;
        ++NativeTrustCalls;
        closeResult = WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE), &action, &data); closed = true; } }

TrustState::~TrustState() { Close(); }

SharedWinTrustSession::SharedWinTrustSession(HANDLE image, const std::wstring& path, bool online) : path_(path) {
        file.cbStruct = sizeof(file); file.pcwszFilePath = path_.c_str(); file.hFile = image;
        signature.cbStruct = sizeof(signature);
        signature.dwIndex = 0; signature.dwFlags = WSS_GET_SECONDARY_SIG_COUNT | WSS_VERIFY_SPECIFIC;
        trust.data.cbStruct = sizeof(trust.data); trust.data.dwUIChoice = WTD_UI_NONE;
        trust.data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN; trust.data.dwUnionChoice = WTD_CHOICE_FILE;
        trust.data.pFile = &file; trust.data.dwStateAction = WTD_STATEACTION_VERIFY;
        trust.data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_DISABLE_MD2_MD4;
        if (!online) trust.data.dwProvFlags |= WTD_CACHE_ONLY_URL_RETRIEVAL;
        trust.data.pSignatureSettings = &signature;
    }

SharedWinTrustObservation SharedWinTrustSession::VerifyAndObserve(Cms& cms) {
        Need(!trust.attempted, "shared_wintrust_once");
        trust.attempted = true; ++NativeTrustCalls;
        SharedWinTrustObservation out;
        out.result = WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE), &trust.action, &trust.data);
        if (trust.data.hWVTStateData) {
            auto provider = WTHelperProvDataFromStateData(trust.data.hWVTStateData);
            if (provider && provider->csSigners <= 8) {
                out.primaryCount = provider->csSigners;
                auto signer = WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0);
                if (signer && signer->csCertChain && signer->csCertChain <= 16 && signer->csCounterSigners <= 8) {
                    out.counters = signer->csCounterSigners; out.signerError = signer->dwError;
                    auto cert = WTHelperGetProvCertFromChain(signer, 0);
                    out.providerPrimary = ObserveProviderSigner(signer, cert ? cert->pCert : nullptr);
                    for (DWORD i = 0; i < signer->csCounterSigners; ++i) {
                        auto counter = WTHelperGetProvSignerFromChain(provider, 0, TRUE, i);
                        PCCERT_CONTEXT counterCert = nullptr;
                        if (counter) {
                            Need(counter->csCertChain <= 16, "provider_counter_chain_bound");
                            if (counter->csCertChain) { auto entry = WTHelperGetProvCertFromChain(counter, 0); if (entry) counterCert = entry->pCert; }
                        }
                        out.providerCounters.push_back(ObserveProviderSigner(counter, counterCert));
                    }
                    if (cert && cert->pCert && signer->psSigner) {
                        out.providerMatches = cert->pCert->cbCertEncoded == cms.signerCert->cbCertEncoded &&
                            std::memcmp(cert->pCert->pbCertEncoded, cms.signerCert->pbCertEncoded, cert->pCert->cbCertEncoded) == 0 &&
                            BlobEqual(signer->psSigner->EncryptedHash, cms.signer()->EncryptedHash);
                        out.metadata = MetadataMatches(cert->pCert);
                    }
                    if (signer->pChainContext) { out.providerChainErrors = signer->pChainContext->TrustStatus.dwErrorStatus;
                        out.providerFresh = signer->pChainContext->fHasRevocationFreshnessTime != FALSE;
                        out.providerAge = out.providerFresh ? signer->pChainContext->dwRevocationFreshnessTime : 0; }
                }
            }
        }
        return out;
    }

void ValidateTimestampInput(const BYTE* token, size_t tokenBytes, const BYTE* data, size_t dataBytes) {
    Need(token && tokenBytes > 0 && tokenBytes <= 262144 && data && dataBytes > 0 && dataBytes <= 16384,
        "shared_timestamp_input_bound");
}

SharedTimestampOperation::SharedTimestampOperation(const BYTE* token, DWORD tokenBytes, const BYTE* data, DWORD dataBytes, HCERTSTORE store) {
        ValidateTimestampInput(token, tokenBytes, data, dataBytes);
        ++TimestampMathCalls;
        succeeded = CryptVerifyTimeStampSignature(token, tokenBytes, data, dataBytes,
            store, &resources.timestamp, &resources.tsa, &resources.store);
        error = succeeded ? 0 : GetLastError();
    }

// New selected-policy observation. The legacy diagnostic path does not call it.
static ProviderChainCopy SnapshotProviderChain(PCRYPT_PROVIDER_SGNR signer) {
    ProviderChainCopy out;
    if(!signer||!signer->pChainContext)return out;
    const auto context=signer->pChainContext;out.present=true;out.chainCount=context->cChain;
    out.errors=context->TrustStatus.dwErrorStatus;
    Need(context->cChain>0&&context->cChain<=8&&context->rgpChain,"provider_chain_bound");
    size_t remaining=32;
    for(DWORD ci=0;ci<context->cChain;++ci){
        const auto simple=context->rgpChain[ci];
        Need(simple&&simple->cElement>=2&&simple->cElement<=remaining&&simple->rgpElement,"provider_elements_bound");
        remaining-=simple->cElement;
        for(DWORD ei=0;ei<simple->cElement;++ei){
            const auto entry=simple->rgpElement[ei];
            Need(entry&&entry->pCertContext&&entry->pCertContext->pCertInfo&&entry->pCertContext->pbCertEncoded&&
                entry->pCertContext->cbCertEncoded>0&&entry->pCertContext->cbCertEncoded<=4*1024*1024,"provider_certificate_bound");
            const auto cert=entry->pCertContext;
            ChainElementObservation row;row.simpleChainIndex=ci;row.elementIndex=ei;
            row.errors=entry->TrustStatus.dwErrorStatus;row.info=entry->TrustStatus.dwInfoStatus;
            row.notBefore=FileTimeValue(cert->pCertInfo->NotBefore);row.notAfter=FileTimeValue(cert->pCertInfo->NotAfter);
            Need(row.notBefore<=row.notAfter,"provider_certificate_period");
            row.certificateSha256=Sha(cert->pbCertEncoded,cert->cbCertEncoded);out.elements.push_back(std::move(row));
        }
    }
    return out;
}
ProviderChainsCopy SharedWinTrustSession::CopyProviderChains() const {
    Need(trust.attempted&&!trust.closed,"provider_chain_lifetime");
    ProviderChainsCopy out;
    if(!trust.data.hWVTStateData)return out;
    const auto provider=WTHelperProvDataFromStateData(trust.data.hWVTStateData);
    if(!provider||provider->csSigners!=1)return out;
    const auto signer=WTHelperGetProvSignerFromChain(provider,0,FALSE,0);
    if(!signer||signer->csCounterSigners!=1)return out;
    out.primary=SnapshotProviderChain(signer);
    out.timestamp=SnapshotProviderChain(WTHelperGetProvSignerFromChain(provider,0,TRUE,0));
    return out;
}
