internal static class WorkerSlotFixtureTests
{
    internal static bool PolicySelfTest()
    {
        var valid = new WorkerSlotTokenSnapshot(
            WorkerSlotTokenPolicy.LocalServiceSid,
            new[] { WorkerSlotTokenPolicy.WorkerServiceSid },
            new[] { WorkerSlotTokenPolicy.WorkerServiceSid },
            false,
            Array.Empty<string>());
        if (WorkerSlotTokenPolicy.ServiceRefusal(valid) is not null ||
            WorkerSlotTokenPolicy.ChildRefusal(valid) is not null)
            return false;
        var withAllServices = valid with
        {
            EnabledGroupSids = new[] {
                WorkerSlotTokenPolicy.WorkerServiceSid, WorkerSlotTokenPolicy.AllServicesSid },
            RestrictingSids = new[] {
                WorkerSlotTokenPolicy.WorkerServiceSid, WorkerSlotTokenPolicy.AllServicesSid }
        };
        if (WorkerSlotTokenPolicy.ServiceRefusal(withAllServices) is not null)
            return false;

        var cases = new[]
        {
            valid with { UserSid = "S-1-5-18" },
            valid with { EnabledGroupSids = Array.Empty<string>() },
            valid with { RestrictingSids = Array.Empty<string>() },
            valid with { Elevated = true },
            valid with { EnabledGroupSids = new[] {
                WorkerSlotTokenPolicy.WorkerServiceSid, "S-1-5-32-544" } },
            valid with { EnabledGroupSids = new[] {
                WorkerSlotTokenPolicy.WorkerServiceSid,
                WorkerSlotTokenPolicy.CoordinatorServiceSid } },
            valid with { RestrictingSids = new[] {
                WorkerSlotTokenPolicy.WorkerServiceSid,
                WorkerSlotTokenPolicy.CoordinatorServiceSid } },
            valid with { EnabledGroupSids = new[] {
                WorkerSlotTokenPolicy.WorkerServiceSid, "S-1-5-80-1-2-3-4-5" } },
            valid with { RestrictingSids = new[] {
                WorkerSlotTokenPolicy.WorkerServiceSid, "S-1-5-80-1-2-3-4-5" } }
        };
        if (cases.Any(item => WorkerSlotTokenPolicy.ServiceRefusal(item) is null))
            return false;

        var serviceWithPrivilege = valid with
        {
            PresentForbiddenPrivileges = new[] { "SeImpersonatePrivilege" }
        };
        return WorkerSlotTokenPolicy.ServiceRefusal(serviceWithPrivilege) is null &&
               WorkerSlotTokenPolicy.ChildRefusal(serviceWithPrivilege) ==
                   "worker_child_privilege_present";
    }

    internal static bool CurrentTokenRefusalSelfTest()
    {
        if (!OperatingSystem.IsWindows() || IntPtr.Size != 8) return false;
        try
        {
            var snapshot = WorkerSlotTokenCapture.CaptureCurrent();
            return WorkerSlotTokenPolicy.ServiceRefusal(snapshot) is not null &&
                   WorkerSlotTokenPolicy.ChildRefusal(snapshot) is not null;
        }
        catch
        {
            return false;
        }
    }
}
