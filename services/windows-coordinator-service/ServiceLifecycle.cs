internal readonly record struct ServiceReport(uint State, uint Controls, uint ExitCode, uint WaitHint);

// SCM status is serialized with stop callbacks. Terminal status is attempted
// once, after the owner has disposed the pipe, even when publishing fails.
internal sealed class ServiceLifecycle(Func<ServiceReport, bool> publish, Action cancel)
{
    internal const uint Stopped = 0x00000001;
    internal const uint StartPending = 0x00000002;
    internal const uint StopPending = 0x00000003;
    internal const uint Running = 0x00000004;
    internal const uint AcceptStopAndShutdown = 0x00000005;
    internal const uint ErrorServiceSpecific = 1066;

    private readonly object _gate = new();
    private uint _state;
    private bool _stopRequested;
    private bool _terminal;
    private bool _statusFailure;

    internal bool StatusFailure
    {
        get { lock (_gate) return _statusFailure; }
    }

    internal bool ReportStartPending()
    {
        lock (_gate)
        {
            if (_state != 0 || _terminal) return false;
            Publish(new ServiceReport(StartPending, 0, 0, 30000));
            if (_stopRequested) Publish(new ServiceReport(StopPending, 0, 0, 10000));
            return !_statusFailure && !_stopRequested;
        }
    }

    internal bool ReportRunning()
    {
        lock (_gate)
        {
            if (_state != StartPending || _stopRequested || _terminal || _statusFailure)
                return false;
            Publish(new ServiceReport(Running, AcceptStopAndShutdown, 0, 0));
            return !_statusFailure;
        }
    }

    internal void RequestStop()
    {
        var shouldCancel = false;
        lock (_gate)
        {
            if (_terminal || _stopRequested) return;
            _stopRequested = true;
            shouldCancel = true;
            if (_state is StartPending or Running)
                Publish(new ServiceReport(StopPending, 0, 0, 10000));
        }
        if (shouldCancel)
        {
            try { cancel(); }
            catch { lock (_gate) _statusFailure = true; }
        }
    }

    internal void ReportStopped(bool failed)
    {
        lock (_gate)
        {
            if (_terminal) return;
            _terminal = true;
            var code = failed || _statusFailure ? ErrorServiceSpecific : 0u;
            Publish(new ServiceReport(Stopped, 0, code, 0));
        }
    }

    private void Publish(ServiceReport report)
    {
        // Advance logical state even if SCM rejects the publication. This
        // prevents a retry from reporting RUNNING or duplicate STOPPED.
        _state = report.State;
        try { if (!publish(report)) _statusFailure = true; }
        catch { _statusFailure = true; }
    }

#if COORDINATOR_SERVICE_FIXTURE_TESTS
    internal static bool SelfTest()
    {
        var events = new List<string>();
        var cleaned = false;
        var normal = new ServiceLifecycle(report =>
        {
            if (report.State == Stopped && !cleaned) return false;
            events.Add(report.State.ToString());
            return true;
        }, () => events.Add("cancel"));
        if (!normal.ReportStartPending() || !normal.ReportRunning()) return false;
        normal.RequestStop();
        cleaned = true;
        normal.ReportStopped(false);
        normal.ReportStopped(true);
        normal.RequestStop();
        if (normal.StatusFailure ||
            !events.SequenceEqual(new[] { "2", "4", "3", "cancel", "1" }))
            return false;

        events.Clear();
        cleaned = false;
        var earlyStop = new ServiceLifecycle(report =>
        {
            if (report.State == Stopped && !cleaned) return false;
            events.Add(report.State.ToString());
            return true;
        }, () => events.Add("cancel"));
        if (!earlyStop.ReportStartPending()) return false;
        earlyStop.RequestStop();
        if (earlyStop.ReportRunning()) return false;
        cleaned = true;
        earlyStop.ReportStopped(false);
        if (earlyStop.StatusFailure ||
            !events.SequenceEqual(new[] { "2", "3", "cancel", "1" }))
            return false;

        events.Clear();
        var failedPublish = new ServiceLifecycle(report =>
        {
            events.Add(report.State.ToString());
            return report.State != StopPending;
        }, () => events.Add("cancel"));
        if (!failedPublish.ReportStartPending() || !failedPublish.ReportRunning()) return false;
        failedPublish.RequestStop();
        failedPublish.ReportStopped(false);
        failedPublish.ReportStopped(false);
        return failedPublish.StatusFailure &&
               events.SequenceEqual(new[] { "2", "4", "3", "cancel", "1" });
    }
#endif
}
