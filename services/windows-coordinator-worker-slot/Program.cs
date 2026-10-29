using System.Runtime.InteropServices;
using System.Runtime.Versioning;

// Inactive source slice. No worker, pipe, filesystem, Git, or child route
// exists. Even a correctly identified SCM service reports STOPPED with a
// service-specific failure until a later reviewed lease/worker design exists.
internal static class Program
{
    internal const string ServiceName = "LexRunnerWorkerSlot1";

    private const uint ServiceWin32OwnProcess = 0x00000010;
    private const uint ServiceStopped = 0x00000001;
    private const uint ServiceStartPending = 0x00000002;
    private const uint ErrorServiceSpecific = 1066;

    private static ServiceMainDelegate? ServiceMainCallback;
    private static readonly ServiceControlDelegate ServiceControlCallback = ServiceControl;

    private static int Main(string[] args)
    {
#if WORKER_SLOT_FIXTURE_TESTS
        if (args is ["--policy-selftest"])
        {
            var passed = WorkerSlotFixtureTests.PolicySelfTest();
            Console.WriteLine(passed ? "policy_selftest_pass" : "policy_selftest_fail");
            return passed ? 0 : 1;
        }
        if (args is ["--token-refusal-selftest"])
        {
            var passed = WorkerSlotFixtureTests.CurrentTokenRefusalSelfTest();
            Console.WriteLine(passed ? "token_refusal_selftest_pass" : "token_refusal_selftest_fail");
            return passed ? 0 : 1;
        }
#endif
        if (!OperatingSystem.IsWindows() || IntPtr.Size != 8 || args is not ["--service"])
        {
            Console.Error.WriteLine("scm_only");
            return 2;
        }

        ServiceMainCallback = ServiceMain;
        var name = Marshal.StringToHGlobalUni(ServiceName);
        var table = new[]
        {
            new ServiceTableEntry(name, Marshal.GetFunctionPointerForDelegate(ServiceMainCallback)),
            default(ServiceTableEntry)
        };
        var dispatched = false;
        try { dispatched = StartServiceCtrlDispatcher(table); }
        catch { }
        if (dispatched)
        {
            // SCM may terminate immediately after the terminal status.
            // Retain the service-table name until process exit.
            return 3;
        }
        Marshal.FreeHGlobal(name);
        Console.Error.WriteLine("scm_required");
        return 3;
    }

    [SupportedOSPlatform("windows")]
    private static void ServiceMain(uint argumentCount, IntPtr arguments)
    {
        var handle = RegisterServiceCtrlHandlerEx(ServiceName, ServiceControlCallback, IntPtr.Zero);
        if (handle == IntPtr.Zero) return;
        var start = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = ServiceStartPending,
            ControlsAccepted = 0,
            WaitHint = 10000,
            CheckPoint = 1
        };
        if (!SetServiceStatus(handle, ref start))
        {
            ReportStopped(handle);
            return;
        }

        try
        {
            var snapshot = WorkerSlotTokenCapture.CaptureCurrent();
            if (WorkerSlotTokenPolicy.ServiceRefusal(snapshot) is not null) return;
        }
        catch
        {
            // Capture failure is a refusal, never a fallback identity.
        }
        finally
        {
            // This source image has no worker lease or RUNNING state.
            // A single terminal report follows identity observation.
            ReportStopped(handle);
        }
    }

    private static void ReportStopped(IntPtr handle)
    {
        var stopped = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = ServiceStopped,
            ControlsAccepted = 0,
            Win32ExitCode = ErrorServiceSpecific,
            ServiceSpecificExitCode = 1
        };
        SetServiceStatus(handle, ref stopped);
    }

    private static uint ServiceControl(uint control, uint eventType, IntPtr eventData, IntPtr context) => 120;

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceTableEntry
    {
        public IntPtr Name;
        public IntPtr ServiceProc;

        public ServiceTableEntry(IntPtr name, IntPtr serviceProc)
        {
            Name = name;
            ServiceProc = serviceProc;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        public uint ServiceType;
        public uint CurrentState;
        public uint ControlsAccepted;
        public uint Win32ExitCode;
        public uint ServiceSpecificExitCode;
        public uint CheckPoint;
        public uint WaitHint;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ServiceMainDelegate(uint argumentCount, IntPtr arguments);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate uint ServiceControlDelegate(uint control, uint eventType, IntPtr eventData, IntPtr context);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", EntryPoint = "StartServiceCtrlDispatcherW", SetLastError = true)]
    private static extern bool StartServiceCtrlDispatcher([In] ServiceTableEntry[] table);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", EntryPoint = "RegisterServiceCtrlHandlerExW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterServiceCtrlHandlerEx(string name, ServiceControlDelegate handler,
        IntPtr context);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetServiceStatus(IntPtr statusHandle, ref ServiceStatus status);
}
