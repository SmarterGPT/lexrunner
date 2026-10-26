// Specific, declarative Windows Installer 5.0 recipe. No custom action is authored.
internal static class MsiRecipe
{
  internal static void Build(NativeDatabase db, string generation, string manifest, string version, string recipe, int[] lengths, string cabinet, string payload)
  {
    db.Create("Property", "`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE", "`Property`");
    foreach (var item in new (string, string)[] { ("ProductCode", Program.GuidFor("product:" + generation)), ("ProductName", "LexRunner Windows helper qualification"), ("ProductVersion", version), ("Manufacturer", "SmarterGPT"), ("ProductLanguage", "1033"), ("ALLUSERS", "1"), ("INSTALLLEVEL", "1"), ("ARPNOMODIFY", "1"), ("ARPNOREPAIR", "1"), ("SecureCustomProperties", "EXISTINGGENERATION") }) db.Insert("Property", item.Item1, item.Item2);
    db.Create("Directory", "`Directory` CHAR(72) NOT NULL, `Directory_Parent` CHAR(72), `DefaultDir` CHAR(255) NOT NULL LOCALIZABLE", "`Directory`");
    db.Insert("Directory", "TARGETDIR", null, "SourceDir"); db.Insert("Directory", "ProgramFiles64Folder", "TARGETDIR", ".");
    db.Insert("Directory", "HelperApplicationRoot", "ProgramFiles64Folder", "LEXRUN~1|SmarterGPT.LexRunner.WindowsHelper");
    db.Insert("Directory", "HelperGenerationsRoot", "HelperApplicationRoot", "GENERA~1|generations"); db.Insert("Directory", "HelperGenerationRoot", "HelperGenerationsRoot", "G" + generation[..7] + "|" + generation);
    db.Create("Component", "`Component` CHAR(72) NOT NULL, `ComponentId` CHAR(38), `Directory_` CHAR(72) NOT NULL, `Attributes` SHORT NOT NULL, `Condition` CHAR(255), `KeyPath` CHAR(72)", "`Component`");
    db.Create("Feature", "`Feature` CHAR(38) NOT NULL, `Feature_Parent` CHAR(38), `Title` CHAR(64) LOCALIZABLE, `Description` CHAR(255) LOCALIZABLE, `Display` SHORT, `Level` SHORT NOT NULL, `Directory_` CHAR(72), `Attributes` SHORT NOT NULL", "`Feature`");
    db.Insert("Feature", "Helper", null, "Optional Windows helper", "Qualification generation; not production activation", 2, 1, "HelperGenerationRoot", 0);
    db.Create("FeatureComponents", "`Feature_` CHAR(38) NOT NULL, `Component_` CHAR(72) NOT NULL", "`Feature_`, `Component_`");
    void Component(string id, string directory, bool permanent, string? key, bool registry = false)
    {
      var identity = id is "ProtectApplicationRoot" or "ProtectGenerationsRoot" ? "shared:" : generation + ":";
      db.Insert("Component", id, Program.GuidFor(identity + id), directory, 256 + (permanent ? 16 : 0) + (registry ? 4 : 0), null, key);
      db.Insert("FeatureComponents", "Helper", id);
    }
    db.Create("CreateFolder", "`Directory_` CHAR(72) NOT NULL, `Component_` CHAR(72) NOT NULL", "`Directory_`, `Component_`");
    db.Create("MsiLockPermissionsEx", "`MsiLockPermissionsEx` CHAR(72) NOT NULL, `LockObject` CHAR(72) NOT NULL, `Table` CHAR(32) NOT NULL, `SDDLText` CHAR(0) NOT NULL, `Condition` CHAR(255)", "`MsiLockPermissionsEx`");
    void Permission(string id, string target, string table, string sddl) => db.Insert("MsiLockPermissionsEx", id, target, table, sddl, null);
    foreach (var item in new[] { ("ProtectApplicationRoot", "HelperApplicationRoot"), ("ProtectGenerationsRoot", "HelperGenerationsRoot"), ("ProtectGenerationRoot", "HelperGenerationRoot") })
    { Component(item.Item1, item.Item2, true, null); db.Insert("CreateFolder", item.Item2, item.Item1); Permission(item.Item1, item.Item2, "CreateFolder", Program.DirectorySddl); }
    db.Create("File", "`File` CHAR(72) NOT NULL, `Component_` CHAR(72) NOT NULL, `FileName` CHAR(255) NOT NULL LOCALIZABLE, `FileSize` LONG NOT NULL, `Version` CHAR(72), `Language` CHAR(20), `Attributes` SHORT NOT NULL, `Sequence` SHORT NOT NULL", "`File`");
    for (var i = 0; i < Program.Files.Length; i++)
    { var file = Program.Files[i]; Component(file.Component, "HelperGenerationRoot", file.Permanent, file.Id); var shortName = new[] { "LEXRUN~1.EXE", "GENERA~1.JSO", "INSTAL~1.JSO" }[i]; db.Insert("File", file.Id, file.Component, shortName + "|" + file.Name, lengths[i], null, null, 512, i + 1); Permission(file.Id, file.Id, "File", Program.FileSddl); }
    db.Create("MsiFileHash", "`File_` CHAR(72) NOT NULL, `Options` SHORT NOT NULL, `HashPart1` LONG NOT NULL, `HashPart2` LONG NOT NULL, `HashPart3` LONG NOT NULL, `HashPart4` LONG NOT NULL", "`File_`");
    foreach (var file in Program.Files) db.FileHash(file.Id, Path.Combine(payload, file.Name));
    db.Create("Media", "`DiskId` SHORT NOT NULL, `LastSequence` SHORT NOT NULL, `DiskPrompt` CHAR(64) LOCALIZABLE, `Cabinet` CHAR(255), `VolumeLabel` CHAR(32), `Source` CHAR(72)", "`DiskId`");
    db.Insert("Media", 1, Program.Files.Length, null, "#payload.cab", null, null); db.Stream("payload.cab", cabinet);
    db.Create("Registry", "`Registry` CHAR(72) NOT NULL, `Root` SHORT NOT NULL, `Key` CHAR(255) NOT NULL LOCALIZABLE, `Name` CHAR(255) LOCALIZABLE, `Value` CHAR(0) LOCALIZABLE, `Component_` CHAR(72) NOT NULL", "`Registry`");
    Component("RetainedGenerationCatalog", "HelperGenerationRoot", true, "ManifestDigest", true);
    var root = "Software\\SmarterGPT.LexRunner.WindowsHelper";
    foreach (var item in new[] { ("CatalogRoot", root), ("CatalogGenerations", root + "\\Generations"), ("CatalogGeneration", root + "\\Generations\\" + generation) })
    { db.Insert("Registry", item.Item1, 2, item.Item2, "+", null, "RetainedGenerationCatalog"); Permission(item.Item1, item.Item1, "Registry", Program.RegistrySddl); }
    db.Insert("Registry", "ManifestDigest", 2, root + "\\Generations\\" + generation, "ManifestDigest", manifest, "RetainedGenerationCatalog");
    db.Insert("Registry", "GenerationState", 2, root + "\\Generations\\" + generation, "State", "provisioned-unqualified", "RetainedGenerationCatalog");
    db.Insert("Registry", "GenerationProduct", 2, root + "\\Generations\\" + generation, "ProductCode", "[ProductCode]", "RetainedGenerationCatalog");
    db.Create("AppSearch", "`Property` CHAR(72) NOT NULL, `Signature_` CHAR(72) NOT NULL", "`Property`, `Signature_`"); db.Insert("AppSearch", "EXISTINGGENERATION", "ExistingGeneration");
    db.Create("RegLocator", "`Signature_` CHAR(72) NOT NULL, `Root` SHORT, `Key` CHAR(255) NOT NULL, `Name` CHAR(255), `Type` SHORT", "`Signature_`");
    db.Insert("RegLocator", "ExistingGeneration", 2, root + "\\Generations\\" + generation, "ManifestDigest", 18);
    db.Create("LaunchCondition", "`Condition` CHAR(255) NOT NULL, `Description` CHAR(255) NOT NULL LOCALIZABLE", "`Condition`");
    db.Insert("LaunchCondition", "VersionNT64", "This helper qualification package requires 64-bit Windows.");
    db.Insert("LaunchCondition", "NOT SHORTFILENAMES", "This immutable generation profile requires long file names.");
    db.Insert("LaunchCondition", "NOT Installed OR REMOVE = \"ALL\"", "This immutable generation cannot be repaired or modified in place. Provision a separately reviewed new generation.");
    db.Insert("LaunchCondition", "Installed OR NOT EXISTINGGENERATION", "This generation already exists. Reconciliation is required; its files will not be overwritten.");
    var actions = new (string, int)[] { ("AppSearch", 50), ("LaunchConditions", 100), ("CostInitialize", 800), ("FileCost", 900), ("CostFinalize", 1000), ("InstallValidate", 1400), ("InstallInitialize", 1500), ("ProcessComponents", 1600), ("UnpublishFeatures", 1800), ("RemoveRegistryValues", 2600), ("RemoveFiles", 3500), ("RemoveFolders", 3600), ("CreateFolders", 3700), ("InstallFiles", 4000), ("WriteRegistryValues", 5000), ("RegisterUser", 6000), ("RegisterProduct", 6100), ("PublishFeatures", 6300), ("PublishProduct", 6400), ("InstallFinalize", 6600) };
    db.Create("InstallExecuteSequence", "`Action` CHAR(72) NOT NULL, `Condition` CHAR(255), `Sequence` SHORT", "`Action`");
    foreach (var action in actions) db.Insert("InstallExecuteSequence", action.Item1, null, action.Item2);
    db.Create("InstallUISequence", "`Action` CHAR(72) NOT NULL, `Condition` CHAR(255), `Sequence` SHORT", "`Action`");
    foreach (var action in actions.Where(a => a.Item2 <= 1000)) db.Insert("InstallUISequence", action.Item1, null, action.Item2);
    db.Insert("InstallUISequence", "ExecuteAction", null, 1300);
    db.Summary(Program.GuidFor("package:" + generation + ":" + manifest + ":" + version + ":" + recipe)); db.Commit();
  }
}
