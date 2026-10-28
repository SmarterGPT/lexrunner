using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;

internal static class Program
{
    internal const string ServiceName = "LexRunnerCoordinator";
    internal const string PipeName = @"\\.\pipe\LexRunner.Coordinator.Service.v1";

    private const uint ServiceWin32OwnProcess = 0x00000010;
    private const uint ServiceControlStop = 0x00000001;
    private const uint ServiceControlShutdown = 0x00000005;

    private static ServiceMainDelegate? ServiceMainCallback;
    private static readonly ServiceControlDelegate ServiceControlCallback = ServiceControl;
    private static readonly CancellationTokenSource Stop = new();
    private static readonly object RegistrationGate = new();
    private static IntPtr _statusHandle;
    private static ServiceLifecycle? _lifecycle;
    private static int _callbackFailed;

    private static int Main(string[] args)
    {
#if COORDINATOR_SERVICE_FIXTURE_TESTS
        if (args.Length == 1 && args[0] == "--protocol-selftest")
        {
            var passed = CoordinatorProtocol.SelfTest();
            Console.WriteLine(passed ? "protocol_selftest_pass" : "protocol_selftest_fail");
            return passed ? 0 : 1;
        }
        if (args.Length == 1 && args[0] == "--lifecycle-selftest")
        {
            var passed = ServiceLifecycle.SelfTest();
            Console.WriteLine(passed ? "lifecycle_selftest_pass" : "lifecycle_selftest_fail");
            return passed ? 0 : 1;
        }
#endif
        if (!OperatingSystem.IsWindows() || args.Length != 1 || args[0] != "--service")
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
        if (!StartServiceCtrlDispatcher(table))
        {
            // This path was not launched by SCM (or dispatch failed). No
            // SERVICE_STOPPED report has occurred, so cleanup is still safe.
            Marshal.FreeHGlobal(name);
            Console.Error.WriteLine("scm_required");
            return 3;
        }
        // SCM may terminate the process immediately after SERVICE_STOPPED.
        // Keep the service-table name allocation for process lifetime. The
        // terminal status contains the failure code; do no teardown here.
        return 0;
    }

    [SupportedOSPlatform("windows")]
    private static void ServiceMain(uint argumentCount, IntPtr arguments)
    {
        var lifecycle = new ServiceLifecycle(PublishStatus, () => Stop.Cancel());
        lock (RegistrationGate)
        {
            _lifecycle = lifecycle;
            _statusHandle = RegisterServiceCtrlHandlerEx(ServiceName, ServiceControlCallback,
                IntPtr.Zero);
        }
        if (_statusHandle == IntPtr.Zero)
        {
            return;
        }
        var failed = false;
        try
        {
            if (!lifecycle.ReportStartPending()) return;
            var serviceSid = VerifyServiceIdentity();
            // The pipe's using scope ends before the single terminal SCM
            // status publication in finally, including on a stop request.
            using (var pipe = CoordinatorPipe.Create(PipeName, serviceSid))
            {
                if (lifecycle.ReportRunning())
                {
                    CoordinatorPipe.ServeAsync(pipe, Stop.Token).GetAwaiter().GetResult();
                    if (!Stop.IsCancellationRequested) failed = true;
                }
                else if (!Stop.IsCancellationRequested) failed = true;
            }
        }
        catch (Exception)
        {
            // No retry under an uncertain service or pipe state. SCM receives
            // a stopped service; no effect or admission route exists here.
            failed = true;
        }
        finally
        {
            // The using scope has released the pipe. Gather all failure state
            // before the single terminal status report; do nothing afterward.
            var terminalFailure = failed || lifecycle.StatusFailure ||
                Volatile.Read(ref _callbackFailed) != 0;
            lifecycle.ReportStopped(terminalFailure);
        }
    }

    [SupportedOSPlatform("windows")]
    private static string VerifyServiceIdentity()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var expected = (SecurityIdentifier)new NTAccount("NT SERVICE", ServiceName)
            .Translate(typeof(SecurityIdentifier));
        if (identity.User?.Value != expected.Value ||
            new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            throw new UnauthorizedAccessException("service_identity_unavailable");
        return expected.Value;
    }

    private static uint ServiceControl(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        if (control is ServiceControlStop or ServiceControlShutdown)
        {
            // Never let an exception cross an unmanaged SCM callback. Report
            // STOP_PENDING before cancellation/drain when the handler runs.
            try
            {
                ServiceLifecycle? lifecycle;
                lock (RegistrationGate) lifecycle = _lifecycle;
                if (lifecycle is null)
                {
                    Interlocked.Exchange(ref _callbackFailed, 1);
                    Stop.Cancel();
                }
                else lifecycle.RequestStop();
            }
            catch
            {
                Interlocked.Exchange(ref _callbackFailed, 1);
                try { Stop.Cancel(); } catch { }
            }
            return 0;
        }
        return 0;
    }

    private static bool PublishStatus(ServiceReport report)
    {
        var status = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = report.State,
            ControlsAccepted = report.Controls,
            Win32ExitCode = report.ExitCode,
            ServiceSpecificExitCode =
                report.ExitCode == ServiceLifecycle.ErrorServiceSpecific ? 1u : 0u,
            CheckPoint = report.State is ServiceLifecycle.StartPending or
                ServiceLifecycle.StopPending ? 1u : 0u,
            WaitHint = report.WaitHint
        };
        return _statusHandle != IntPtr.Zero && SetServiceStatus(_statusHandle, ref status);
    }

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

    [DllImport("advapi32.dll", EntryPoint = "StartServiceCtrlDispatcherW", SetLastError = true)]
    private static extern bool StartServiceCtrlDispatcher([In] ServiceTableEntry[] table);

    [DllImport("advapi32.dll", EntryPoint = "RegisterServiceCtrlHandlerExW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterServiceCtrlHandlerEx(string name, ServiceControlDelegate handler,
        IntPtr context);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetServiceStatus(IntPtr statusHandle, ref ServiceStatus status);
}
