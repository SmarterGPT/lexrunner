using System.Security.Principal;
using System.Runtime.Versioning;

// This type is the sole source of process-launch inputs in the normal service.
// No client packet, CLI flag, or caller-supplied file path can construct it.
#if COORDINATOR_SERVICE_FIXTURE_TESTS
internal enum FixtureChildCase { Normal, BadNonce, Flood, Sleep, Nonzero }
#endif

internal sealed class ProtectedGenerationLease : IDisposable
{
    private readonly object _lifetime = new();
    private bool _disposeRequested;
    private bool _childActive;
    private ProtectedGenerationLease(string imagePath, string? entryPath,
        string workingDirectory, string expectedSid, FileStream heldImage
#if COORDINATOR_SERVICE_FIXTURE_TESTS
        , FixtureChildCase fixtureCase
#endif
        )
    {
        ImagePath = imagePath;
        EntryPath = entryPath;
        WorkingDirectory = workingDirectory;
        ExpectedSid = expectedSid;
        HeldImage = heldImage;
#if COORDINATOR_SERVICE_FIXTURE_TESTS
        FixtureCase = fixtureCase;
#endif
    }

    internal string ImagePath { get; }
    internal string? EntryPath { get; }
    internal string WorkingDirectory { get; }
    internal string ExpectedSid { get; }
    internal FileStream HeldImage { get; }
#if COORDINATOR_SERVICE_FIXTURE_TESTS
    internal FixtureChildCase FixtureCase { get; }
#endif

    internal static bool TryOpenInstalled(out ProtectedGenerationLease? generation)
    {
        // A path or hash read from the unqualified v2 selection fixture cannot
        // grant a lease. This gate must be replaced by signed installed-graph,
        // SCM, protected ACL, high-water and loader-custody readback together.
        generation = null;
        return false;
    }

    // Only one child may use the held image stream at a time. Disposal during
    // launch defers handle release until the child reaches terminal cleanup.
    internal IDisposable HoldForChild()
    {
        lock (_lifetime)
        {
            if (_disposeRequested) throw new ObjectDisposedException(nameof(ProtectedGenerationLease));
            if (_childActive) throw new InvalidOperationException("generation_child_already_active");
            _childActive = true;
            return new ChildHold(this);
        }
    }

#if COORDINATOR_SERVICE_FIXTURE_TESTS
    [SupportedOSPlatform("windows")]
    internal static ProtectedGenerationLease OpenSelfFixture(FixtureChildCase fixtureCase)
    {
        var image = Environment.ProcessPath ?? throw new InvalidOperationException("fixture_image_missing");
        if (!Path.IsPathFullyQualified(image) || image.Contains('"') || image.Contains('\0') ||
            !image.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("fixture_image_invalid");
        var cwd = Path.GetDirectoryName(image) ?? throw new InvalidOperationException("fixture_cwd_missing");
        var held = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            var sid = WindowsIdentity.GetCurrent().User?.Value ??
                throw new InvalidOperationException("fixture_sid_missing");
            return new ProtectedGenerationLease(image, null, cwd, sid, held, fixtureCase);
        }
        catch { held.Dispose(); throw; }
    }
#endif

    public void Dispose()
    {
        lock (_lifetime)
        {
            _disposeRequested = true;
            if (!_childActive) HeldImage.Dispose();
        }
    }

    private sealed class ChildHold(ProtectedGenerationLease owner) : IDisposable
    {
        private ProtectedGenerationLease? _owner = owner;

        public void Dispose()
        {
            var owner = Interlocked.Exchange(ref _owner, null);
            if (owner is null) return;
            lock (owner._lifetime)
            {
                owner._childActive = false;
                if (owner._disposeRequested) owner.HeldImage.Dispose();
            }
        }
    }
}
