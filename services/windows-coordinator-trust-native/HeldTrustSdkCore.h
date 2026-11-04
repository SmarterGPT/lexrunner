#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define CERT_REVOCATION_PARA_HAS_EXTRA_FIELDS
#define CERT_CHAIN_PARA_HAS_EXTRA_FIELDS
#include <windows.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <bcrypt.h>
#include <mssip.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <exception>
#include <atomic>
#include <utility>
#include <type_traits>
extern DWORD NativeTrustCalls, CurrentRevocationCalls, TimestampMathCalls, PurposePolicyCalls;
inline constexpr char ExpectedSubjectDer[] = "3079310e300c060355041113053533313138310b30090603550406130255533112301006035504081309576973636f6e73696e3110300e06035504071307446f75736d616e31193017060355040a13104a6f7365706820477573746176736f6e31193017060355040313104a6f7365706820477573746176736f6e";

inline constexpr wchar_t Subject[] = L"CN=Joseph Gustavson, O=Joseph Gustavson, L=Dousman, S=Wisconsin, C=US, PostalCode=53118";

inline constexpr char IdentityOid[] = "1.3.6.1.4.1.311.97.664386437.910814316.510550690.722133748";

inline constexpr char NestedOid[] = "1.3.6.1.4.1.311.2.4.1";

inline constexpr char TimestampOid[] = "1.3.6.1.4.1.311.3.3.1";

struct Stop : std::exception { const char* phase; explicit Stop(const char* p) : phase(p) {} };

void Need(bool b, const char* p);

void RequirePin(const std::string& actual, const char* expected, const char* phase);

std::string Hex(const BYTE* b, size_t count);

// Shared once-only close owner. The selected verifier's process-wide latch is
// never reset: even a late failed close survives every subsequent cleanup path.
struct NativeCloseState {
    std::atomic<bool> uncertain{false};
    void Observe(bool success) noexcept { if(!success)uncertain.store(true,std::memory_order_relaxed); }
    bool Uncertain() const noexcept { return uncertain.load(std::memory_order_relaxed); }
};
extern NativeCloseState CngCloseState;
template<class Handle,class CloseOperation> class SingleCloseOwner {
    static_assert(std::is_nothrow_invocable_r_v<bool,CloseOperation,Handle>);
    Handle handle_{}; NativeCloseState& state_; CloseOperation close_;
    bool attempted_=false,failed_=false;
public:
    SingleCloseOwner(Handle handle,NativeCloseState& state,CloseOperation close) noexcept:
        handle_(handle),state_(state),close_(close) {}
    SingleCloseOwner(const SingleCloseOwner&)=delete;
    SingleCloseOwner& operator=(const SingleCloseOwner&)=delete;
    ~SingleCloseOwner(){(void)CloseObserved();}
    bool CloseObserved() noexcept {
        if(!attempted_){
            attempted_=true;const auto handle=std::exchange(handle_,Handle{});
            if(handle)failed_=!close_(handle);
            state_.Observe(!failed_);
        }
        return !failed_;
    }
};
void RequireHashAndCloseStatus(NTSTATUS hashStatus,bool closed);
std::string Sha(const BYTE* b, size_t count);

bool BlobEqual(const CRYPT_DATA_BLOB& a, const CRYPT_DATA_BLOB& b);

bool InBuffer(const std::vector<BYTE>& b, const void* p, size_t count);

void CheckPe(const std::vector<BYTE>& bytes, DWORD& certOffset, DWORD& certLength);

struct Cms {
    HCERTSTORE store = nullptr;
    HCRYPTMSG message = nullptr;
    std::vector<BYTE> signerBytes;
    PCCERT_CONTEXT signerCert = nullptr;
    DWORD primaryCount = 0, tokenCount = 0, nestedCount = 0;
    const BYTE* token = nullptr; DWORD tokenBytes = 0;
    Cms() = default;
    void Init(const std::vector<BYTE>& bytes, DWORD offset, DWORD length);
    void InitEncodedMessage(const BYTE* encoded, DWORD bytes);
    Cms(const Cms&) = delete;
    ~Cms();
    bool CloseObserved() noexcept;
    bool closeFailed = false;
    CMSG_SIGNER_INFO* signer();
};

bool SubjectDerMatches(const BYTE* bytes, size_t count);

bool EkuPolicyMatches(const std::vector<std::string>& usages);

bool MetadataMatches(PCCERT_CONTEXT cert);

uint64_t FileTimeValue(const FILETIME& value);

bool TimeInPeriod(uint64_t time, uint64_t before, uint64_t after);

struct ChainElementObservation {
    DWORD simpleChainIndex = 0, elementIndex = 0, errors = 0, info = 0;
    uint64_t notBefore = 0, notAfter = 0;
    bool validAtTimestamp = false, validAtObservation = false;
    std::string certificateSha256;
};

struct CurrentRevocationRow {
    DWORD certificateRow = 0, issuerRow = 0, nativeError = 0, statusError = 0, statusIndex = 0, reason = 0, crlAgeSeconds = 0;
    bool succeeded = false, statusAvailable = false, reasonAvailable = false, freshnessAvailable = false;
};

struct CurrentRevocationObservation {
    bool requested = false, contextsAvailable = false;
    const char* disposition = "not_requested";
    uint64_t timeToUse = 0, currentTime = 0, cacheResync = 0;
    DWORD flags = 0, timeoutMs = 0, ocspChainFlags = 0;
    std::vector<CurrentRevocationRow> rows;
};

struct PurposeObservation { bool called=false,apiSucceeded=false; DWORD error=MAXDWORD; };

struct ProviderChainCopy { bool present=false; std::vector<ChainElementObservation> elements; DWORD chainCount=0,errors=MAXDWORD; };

struct ProviderChainsCopy { ProviderChainCopy primary,timestamp; };

struct ChainObservation {
    bool called = false, built = false, contextPresent = false, freshnessAvailable = false;
    DWORD apiError = 0, errors = 0, info = 0, chains = 0, freshnessSeconds = 0, flags = 0;
    uint64_t requestedTime = 0, observationTime = 0;
    std::vector<ChainElementObservation> elements;
    CurrentRevocationObservation currentRevocation;
};

struct ChainContextOwner {
    PCCERT_CHAIN_CONTEXT value = nullptr;
    ChainContextOwner() = default;
    ChainContextOwner(const ChainContextOwner&) = delete;
    ChainContextOwner& operator=(const ChainContextOwner&) = delete;
    ~ChainContextOwner();
};

inline constexpr DWORD RequestedChainFlags(bool online, bool timestampTime) {
    return CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT |
        (timestampTime ? CERT_CHAIN_TIMESTAMP_TIME : 0) | CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE |
        (online ? 0 : CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY | CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL);
}

inline constexpr DWORD RequestedRevocationFlags(bool online) {
    return CERT_VERIFY_REV_ACCUMULATIVE_TIMEOUT_FLAG | (online ? 0 : CERT_VERIFY_CACHE_ONLY_BASED_REVOCATION);
}

CurrentRevocationObservation ObserveCurrentRevocation(PCCERT_CHAIN_CONTEXT context, const ChainObservation& baseline,
    HCERTSTORE store, const FILETIME& started, bool online);

ChainObservation ObserveChain(PCCERT_CONTEXT cert, HCERTSTORE store, const FILETIME& at,
    const FILETIME& started, bool online, const char* usage, size_t& remainingElements, bool timestampTime = true, bool currentRevocation = false, PurposeObservation* purpose = nullptr);

bool SameChainIdentities(const ChainObservation& actual, const ChainObservation& baseline);

struct ProviderSignerObservation {
    bool signerPresent = false, certificatePresent = false;
    uint64_t verificationTime = 0;
    DWORD error = MAXDWORD, type = 0;
    std::string certificateSha256;
};

ProviderSignerObservation ObserveProviderSigner(PCRYPT_PROVIDER_SGNR signer, PCCERT_CONTEXT certificate);

struct TimestampResources {
    PCRYPT_TIMESTAMP_CONTEXT timestamp = nullptr;
    PCCERT_CONTEXT tsa = nullptr;
    HCERTSTORE store = nullptr;
    TimestampResources() = default;
    TimestampResources(const TimestampResources&) = delete;
    TimestampResources& operator=(const TimestampResources&) = delete;
    ~TimestampResources();
    bool CloseObserved() noexcept;
    bool closeFailed = false;
};

struct TrustState {
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    WINTRUST_DATA data{};
    bool attempted = false, closed = false;
    LONG closeResult = 0;
    void Close();
    ~TrustState();
};

struct SharedWinTrustObservation {
    LONG result = 0;
    DWORD primaryCount = 0, counters = 0, signerError = MAXDWORD, providerChainErrors = MAXDWORD, providerAge = 0;
    bool providerMatches = false, metadata = false, providerFresh = false;
    ProviderSignerObservation providerPrimary;
    std::vector<ProviderSignerObservation> providerCounters;
};

struct SharedWinTrustSession {
    std::wstring path_;
    WINTRUST_FILE_INFO file{};
    WINTRUST_SIGNATURE_SETTINGS signature{};
    TrustState trust;
    SharedWinTrustSession(HANDLE image, const std::wstring& path, bool online);
    SharedWinTrustSession(const SharedWinTrustSession&) = delete;
    SharedWinTrustSession& operator=(const SharedWinTrustSession&) = delete;
    SharedWinTrustObservation VerifyAndObserve(Cms& cms);
    ProviderChainsCopy CopyProviderChains() const;
};

void ValidateTimestampInput(const BYTE* token, size_t tokenBytes, const BYTE* data, size_t dataBytes);

struct SharedTimestampOperation {
    TimestampResources resources;
    BOOL succeeded = FALSE;
    DWORD error = 0;
    SharedTimestampOperation(const BYTE* token, DWORD tokenBytes, const BYTE* data, DWORD dataBytes, HCERTSTORE store);
    SharedTimestampOperation(const SharedTimestampOperation&) = delete;
    SharedTimestampOperation& operator=(const SharedTimestampOperation&) = delete;
};

// Fixed MSI SIP identity from independent Microsoft Windows HKLM64 registration,
// not from a candidate's returned GUID. Provider path observation is diagnostic;
// actual MSI hFile use and loader custody remain separately unqualified.
inline constexpr GUID ExpectedMsiSubject{0x000c10f1,0,0,{0xc0,0,0,0,0,0,0,0x46}};
void ReadMsiSubject(HANDLE image,const std::wstring& finalPath,
    std::vector<BYTE>& encoded,GUID& observedSubject);
