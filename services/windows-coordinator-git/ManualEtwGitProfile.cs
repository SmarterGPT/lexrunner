#if GIT_IMPORT_FIXTURE
namespace LexRunner.WindowsCoordinator.Git;

// This profile exists only in the fixture image used by the one-command manual
// ETW diagnostic. It does not change production Git import selection.
internal sealed class ManualEtwGitProfile
{
    internal const string FixedGitImage = @"C:\Program Files\Git\bin\git.exe";
    private readonly Dictionary<string, string> _expectedEnvironment;
    internal string GitImage => FixedGitImage;
    internal string ExpectedSha256 { get; }
    internal IReadOnlyDictionary<string, string> Environment { get; }

    private ManualEtwGitProfile(string digest, Dictionary<string, string> environment)
    {
        ExpectedSha256 = digest;
        _expectedEnvironment = new Dictionary<string, string>(environment,
            StringComparer.OrdinalIgnoreCase);
        Environment = new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(
            new Dictionary<string, string>(environment, StringComparer.OrdinalIgnoreCase));
    }

    internal static ManualEtwGitProfile Create(ImportSlot slot, string digest)
    {
        if (digest.Length != 64 || !digest.All(value =>
                value is >= '0' and <= '9' or >= 'a' and <= 'f'))
            throw new InvalidOperationException("manual_etw_digest_invalid");
        var environment = GitBundleImport.ConstructEnvironment(slot);
        var windows = environment["WINDIR"];
        var system = Path.GetDirectoryName(environment["COMSPEC"]);
        if (system is null || !StringComparer.OrdinalIgnoreCase.Equals(
                Path.GetFullPath(Path.Combine(windows, "System32")), system))
            throw new InvalidOperationException("manual_etw_system_path_invalid");
        // The hosted inventory establishes this one PE only. The diagnostic
        // does not guess a Git support directory or inherit the runner PATH.
        environment["PATH"] = system + ";" + windows;
        environment.Remove("GIT_EXEC_PATH");
        return new ManualEtwGitProfile(digest, environment);
    }

    internal void AssertEnvironment(IReadOnlyDictionary<string, string> candidate)
    {
        if (candidate.Count != _expectedEnvironment.Count ||
            candidate.ContainsKey("GIT_EXEC_PATH") ||
            !candidate.TryGetValue("PATH", out var path) ||
            path.Contains(@"\Git\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("manual_etw_environment_invalid");
        foreach (var (key, value) in _expectedEnvironment)
            if (!candidate.TryGetValue(key, out var actual) ||
                !StringComparer.Ordinal.Equals(value, actual))
                throw new InvalidOperationException("manual_etw_environment_changed");
    }

    internal static bool SourceSelfTest()
    {
        try
        {
            var slot = new ImportSlot(@"C:\fixture", @"C:\fixture", @"C:\fixture",
                @"C:\fixture", @"C:\fixture", @"C:\fixture", @"C:\fixture",
                new string('0', 40), new string('a', 64));
            var profile = Create(slot, new string('a', 64));
            profile.AssertEnvironment(profile.Environment);
            var changedPath = new Dictionary<string, string>(profile.Environment,
                StringComparer.OrdinalIgnoreCase)
            {
                ["PATH"] = @"C:\Program Files\Git\bin"
            };
            var changedExec = new Dictionary<string, string>(profile.Environment,
                StringComparer.OrdinalIgnoreCase)
            {
                ["GIT_EXEC_PATH"] = @"C:\Program Files\Git\libexec"
            };
            bool Refused(IReadOnlyDictionary<string, string> candidate)
            {
                try { profile.AssertEnvironment(candidate); return false; }
                catch (InvalidOperationException) { return true; }
            }
            bool badDigestRefused;
            try { Create(slot, new string('A', 64)); badDigestRefused = false; }
            catch (InvalidOperationException) { badDigestRefused = true; }
            return profile.GitImage == FixedGitImage &&
                profile.GitImage != GitBundleImport.GitImage &&
                (profile.Environment is not IDictionary<string, string> exposed ||
                    exposed.IsReadOnly) &&
                profile.Environment["PATH"].IndexOf(@"\Git\",
                    StringComparison.OrdinalIgnoreCase) < 0 &&
                !profile.Environment.ContainsKey("GIT_EXEC_PATH") &&
                Refused(changedPath) && Refused(changedExec) && badDigestRefused;
        }
        catch { return false; }
    }
}

#endif
