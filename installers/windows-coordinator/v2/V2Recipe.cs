// Windows Installer 5.0 source recipe. No service start, selection, writable
// root, custom action, or name-based service retirement is authored. Full
// uninstall requires prior guarded retirement of the exact installed service.
internal static class V2Recipe
{
  internal static void Build(NativeDatabase db, GraphV2 graph, IReadOnlyList<Program.PayloadFile> files,
    string version, string recipe, string cabinet, string staged)
  {
    db.Create("Property", "`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE", "`Property`");
    foreach (var item in new (string, string)[] {
      ("ProductCode", Program.GuidFor("product:" + graph.GenerationId + ":" + version + ":" + recipe)),
      ("UpgradeCode", Program.GuidFor("upgrade:service-msi-v2")),
      ("ProductName", "LexRunner Windows coordinator v2 qualification"),
      ("ProductVersion", version), ("Manufacturer", "SmarterGPT"),
      ("ProductLanguage", "1033"), ("ALLUSERS", "1"), ("INSTALLLEVEL", "1"),
      ("ARPNOMODIFY", "1"), ("ARPNOREPAIR", "1"), ("ARPNOREMOVE", "1"),
      ("SecureCustomProperties", "EXISTINGSERVICE;ACTIVESELECTION;OCCUPIEDROOT")
    }) db.Insert("Property", item.Item1, item.Item2);

    db.Create("Directory", "`Directory` CHAR(72) NOT NULL, `Directory_Parent` CHAR(72), `DefaultDir` CHAR(255) NOT NULL LOCALIZABLE", "`Directory`");
    db.Insert("Directory", "TARGETDIR", null, "SourceDir");
    db.Insert("Directory", "ProgramFiles64Folder", "TARGETDIR", ".");
    db.Insert("Directory", "CoordinatorApplicationRoot", "ProgramFiles64Folder", "LEXRUN~1|SmarterGPT.LexRunner.WindowsCoordinator");
    db.Insert("Directory", "CoordinatorGenerationsRoot", "CoordinatorApplicationRoot", "GENERA~1|generations");
    db.Insert("Directory", "CoordinatorGenerationRoot", "CoordinatorGenerationsRoot",
      "G" + graph.GenerationId[..7] + "|" + graph.GenerationId);
    var directories = files.Where(file => file.Path.Contains('/'))
      .Select(file => file.Path[..file.Path.LastIndexOf('/')])
      .SelectMany(path => Enumerable.Range(1, path.Split('/').Length)
        .Select(n => string.Join('/', path.Split('/').Take(n))))
      .Distinct(StringComparer.Ordinal).OrderBy(path => path.Count(c => c == '/'))
      .ThenBy(path => path, StringComparer.Ordinal).ToArray();
    var ids = directories.ToDictionary(path => path,
      path => "D" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(path)))[..12], StringComparer.Ordinal);
    for (var i = 0; i < directories.Length; i++)
    {
      var path = directories[i];
      var parent = path.Contains('/') ? ids[path[..path.LastIndexOf('/')]] : "CoordinatorGenerationRoot";
      db.Insert("Directory", ids[path], parent, $"D{i + 1:D7}|" + path[(path.LastIndexOf('/') + 1)..]);
    }

    db.Create("Component", "`Component` CHAR(72) NOT NULL, `ComponentId` CHAR(38), `Directory_` CHAR(72) NOT NULL, `Attributes` SHORT NOT NULL, `Condition` CHAR(255), `KeyPath` CHAR(72)", "`Component`");
    db.Create("Feature", "`Feature` CHAR(38) NOT NULL, `Feature_Parent` CHAR(38), `Title` CHAR(64) LOCALIZABLE, `Description` CHAR(255) LOCALIZABLE, `Display` SHORT, `Level` SHORT NOT NULL, `Directory_` CHAR(72), `Attributes` SHORT NOT NULL", "`Feature`");
    db.Insert("Feature", "Coordinator", null, "Optional Windows coordinator", "Inactive v2 qualification generation", 2, 1, "CoordinatorGenerationRoot", 0);
    db.Create("FeatureComponents", "`Feature_` CHAR(38) NOT NULL, `Component_` CHAR(72) NOT NULL", "`Feature_`, `Component_`");
    void Component(string id, string directory, string? key, bool shared = false)
    {
      db.Insert("Component", id, Program.GuidFor((shared ? "shared:" : graph.GenerationId + ":") + id),
        directory, 256, null, key); // 64-bit and removable; no permanent bit
      db.Insert("FeatureComponents", "Coordinator", id);
    }
    db.Create("CreateFolder", "`Directory_` CHAR(72) NOT NULL, `Component_` CHAR(72) NOT NULL", "`Directory_`, `Component_`");
    db.Create("MsiLockPermissionsEx", "`MsiLockPermissionsEx` CHAR(72) NOT NULL, `LockObject` CHAR(72) NOT NULL, `Table` CHAR(32) NOT NULL, `SDDLText` CHAR(0) NOT NULL, `Condition` CHAR(255)", "`MsiLockPermissionsEx`");
    void Permission(string id, string target, string table, string sddl) =>
      db.Insert("MsiLockPermissionsEx", id, target, table, sddl, null);
    foreach (var item in new[] {
      ("ProtectApplicationRoot", "CoordinatorApplicationRoot", true),
      ("ProtectGenerationsRoot", "CoordinatorGenerationsRoot", true),
      ("ProtectGenerationRoot", "CoordinatorGenerationRoot", false)
    })
    {
      Component(item.Item1, item.Item2, null, item.Item3);
      db.Insert("CreateFolder", item.Item2, item.Item1);
      Permission(item.Item1, item.Item2, "CreateFolder", Program.DirectorySddl);
    }
    foreach (var path in directories)
    {
      var id = "P" + ids[path][1..];
      Component(id, ids[path], null);
      db.Insert("CreateFolder", ids[path], id);
      Permission(id, ids[path], "CreateFolder", Program.DirectorySddl);
    }

    db.Create("File", "`File` CHAR(72) NOT NULL, `Component_` CHAR(72) NOT NULL, `FileName` CHAR(255) NOT NULL LOCALIZABLE, `FileSize` LONG NOT NULL, `Version` CHAR(72), `Language` CHAR(20), `Attributes` SHORT NOT NULL, `Sequence` SHORT NOT NULL", "`File`");
    for (var i = 0; i < files.Count; i++)
    {
      var file = files[i];
      Component(file.Component, file.Directory, file.Id);
      db.Insert("File", file.Id, file.Component, file.ShortName + "|" +
        file.Path[(file.Path.LastIndexOf('/') + 1)..], file.Bytes, null, null, 512, i + 1);
      Permission(file.Id, file.Id, "File", Program.FileSddl);
    }
    db.Create("MsiFileHash", "`File_` CHAR(72) NOT NULL, `Options` SHORT NOT NULL, `HashPart1` LONG NOT NULL, `HashPart2` LONG NOT NULL, `HashPart3` LONG NOT NULL, `HashPart4` LONG NOT NULL", "`File_`");
    foreach (var file in files)
      db.FileHash(file.Id, Path.Combine(staged, file.Path.Replace('/', Path.DirectorySeparatorChar)));
    db.Create("Media", "`DiskId` SHORT NOT NULL, `LastSequence` SHORT NOT NULL, `DiskPrompt` CHAR(64) LOCALIZABLE, `Cabinet` CHAR(255), `VolumeLabel` CHAR(32), `Source` CHAR(72)", "`DiskId`");
    db.Insert("Media", 1, files.Count, null, "#payload.cab", null, null);
    db.Stream("payload.cab", cabinet);

    var service = files.Single(file => file.Role == "service-image");
    db.Create("ServiceInstall", "`ServiceInstall` CHAR(72) NOT NULL, `Name` CHAR(255) NOT NULL, `DisplayName` CHAR(255) LOCALIZABLE, `ServiceType` LONG NOT NULL, `StartType` LONG NOT NULL, `ErrorControl` LONG NOT NULL, `LoadOrderGroup` CHAR(255), `Dependencies` CHAR(255), `StartName` CHAR(255), `Password` CHAR(255), `Arguments` CHAR(255), `Component_` CHAR(72) NOT NULL, `Description` CHAR(255) LOCALIZABLE", "`ServiceInstall`");
    db.Insert("ServiceInstall", "RegisterCoordinatorService", Program.ServiceName,
      "LexRunner Windows Coordinator", 16, 3, 32769, null, null,
      "NT SERVICE\\" + Program.ServiceName, null, "--service", service.Component,
      "Optional governed Windows execution coordinator; inactive until separately qualified.");
    Permission("ProtectCoordinatorService", "RegisterCoordinatorService", "ServiceInstall", Program.ServiceSddl);
    db.Create("MsiServiceConfig", "`MsiServiceConfig` CHAR(72) NOT NULL, `Name` CHAR(255) NOT NULL, `Event` SHORT NOT NULL, `ConfigType` SHORT NOT NULL, `Argument` CHAR(255), `Component_` CHAR(72) NOT NULL", "`MsiServiceConfig`");
    db.Insert("MsiServiceConfig", "RestrictedServiceSid", Program.ServiceName, 1, 5, "3", service.Component);
    db.Insert("MsiServiceConfig", "RequiredPrivileges", Program.ServiceName, 1, 6,
      "SeChangeNotifyPrivilege", service.Component);

    db.Create("AppSearch", "`Property` CHAR(72) NOT NULL, `Signature_` CHAR(72) NOT NULL", "`Property`, `Signature_`");
    db.Insert("AppSearch", "EXISTINGSERVICE", "ExistingCoordinatorService");
    db.Insert("AppSearch", "ACTIVESELECTION", "ExistingCoordinatorSelection");
    db.Insert("AppSearch", "OCCUPIEDROOT", "ExistingCoordinatorRoot");
    db.Create("Signature", "`Signature` CHAR(72) NOT NULL, `FileName` CHAR(255) NOT NULL, `MinVersion` CHAR(20), `MaxVersion` CHAR(20), `MinSize` LONG, `MaxSize` LONG, `MinDate` LONG, `MaxDate` LONG, `Languages` CHAR(255)", "`Signature`");
    db.Create("RegLocator", "`Signature_` CHAR(72) NOT NULL, `Root` SHORT, `Key` CHAR(255) NOT NULL, `Name` CHAR(255), `Type` SHORT", "`Signature_`");
    db.Insert("RegLocator", "ExistingCoordinatorService", 2,
      "SYSTEM\\CurrentControlSet\\Services\\" + Program.ServiceName, "ImagePath", 18);
    db.Insert("RegLocator", "ExistingCoordinatorSelection", 2,
      "Software\\SmarterGPT.LexRunner.WindowsCoordinator", "ActiveSelection", 18);
    db.Create("DrLocator", "`Signature_` CHAR(72) NOT NULL, `Parent` CHAR(72), `Path` CHAR(255), `Depth` SHORT", "`Signature_`");
    db.Insert("DrLocator", "ExistingCoordinatorRoot", null,
      "[ProgramFiles64Folder]SmarterGPT.LexRunner.WindowsCoordinator", 0);
    db.Create("LaunchCondition", "`Condition` CHAR(255) NOT NULL, `Description` CHAR(255) NOT NULL LOCALIZABLE", "`Condition`");
    // This source builder is an offline table/cabinet fixture. Even a complete
    // caller-supplied graph cannot turn its MSI into an installable release.
    // A production builder requires a separate reviewed provenance and
    // installation contract; it must not remove this guard implicitly.
    db.Insert("LaunchCondition", "0",
      "This synthetic Windows coordinator MSI is an offline source fixture and cannot be installed.");
    db.Insert("LaunchCondition", "VersionNT64", "This coordinator package requires 64-bit Windows.");
    db.Insert("LaunchCondition", "NOT SHORTFILENAMES", "This immutable generation requires long file names.");
    db.Insert("LaunchCondition", "(NOT Installed AND NOT REMOVE AND NOT REINSTALL) OR (Installed AND REMOVE=\"ALL\" AND NOT REINSTALL)",
      "Only fresh install and full retired uninstall are supported; repair and partial maintenance are refused.");
    db.Insert("LaunchCondition", "NOT EXISTINGSERVICE", "The coordinator SCM service must be absent; guarded retirement is required before full uninstall.");
    db.Insert("LaunchCondition", "NOT ACTIVESELECTION", "An active coordinator selection must be retired before this package can install or uninstall.");
    db.Insert("LaunchCondition", "NOT OCCUPIEDROOT OR Installed", "The production coordinator Program Files root is already occupied.");
    var actions = new (string, int)[] {
      ("AppSearch", 50), ("CostInitialize", 800),
      ("FileCost", 900), ("CostFinalize", 1000), ("InstallValidate", 1400),
      ("LaunchConditions", 1450), ("InstallInitialize", 1500),
      ("ProcessComponents", 1600), ("UnpublishFeatures", 1800),
      ("RemoveFiles", 3500), ("RemoveFolders", 3600),
      ("CreateFolders", 3700), ("InstallFiles", 4000), ("InstallServices", 5000),
      ("MsiConfigureServices", 5050), ("RegisterUser", 6000), ("RegisterProduct", 6100),
      ("PublishFeatures", 6300), ("PublishProduct", 6400), ("InstallFinalize", 6600)
    };
    db.Create("InstallExecuteSequence", "`Action` CHAR(72) NOT NULL, `Condition` CHAR(255), `Sequence` SHORT", "`Action`");
    foreach (var action in actions) db.Insert("InstallExecuteSequence", action.Item1, null, action.Item2);
    db.Create("InstallUISequence", "`Action` CHAR(72) NOT NULL, `Condition` CHAR(255), `Sequence` SHORT", "`Action`");
    foreach (var action in actions.Where(action => action.Item2 <= 1000))
      db.Insert("InstallUISequence", action.Item1, null, action.Item2);
    db.Insert("InstallUISequence", "ExecuteAction", null, 1300);
    db.Summary(Program.GuidFor("package:" + graph.GenerationId + ":" +
      graph.ManifestSha256 + ":" + version + ":" + recipe));
    db.Commit();
  }
}
