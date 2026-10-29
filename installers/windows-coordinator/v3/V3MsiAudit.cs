using System.Runtime.InteropServices;
using System.Text;

// Exact read-only table audit of the committed v3 MSI. Source/attestation and
// installed effective permissions are separate qualification gates.
internal static class V3MsiAudit
{
  internal static void Verify(string msi, GraphV3 graph, IReadOnlyList<V3MsiProgram.PayloadFile> files,
    string version, string recipe, string staged)
  {
    string[][] Query(string sql) => Read(msi, sql);
    var tables = Query("SELECT `Name` FROM `_Tables`").Select(row => row[0])
      .ToHashSet(StringComparer.Ordinal);
    Require(tables.SetEquals(new[] { "Property", "Directory", "Component", "Feature",
      "FeatureComponents", "CreateFolder", "MsiLockPermissionsEx", "File", "MsiFileHash",
      "Media", "ServiceInstall", "MsiServiceConfig", "AppSearch", "Signature",
      "RegLocator", "DrLocator", "LaunchCondition", "InstallExecuteSequence", "InstallUISequence" }),
      "Unexpected v3 MSI table surface");
    Require(Query("SELECT `Name` FROM `_Streams`").Select(row => row[0])
      .ToHashSet(StringComparer.Ordinal).SetEquals(["payload.cab", "\u0005SummaryInformation"]),
      "Unexpected v3 MSI stream");
    var properties = Query("SELECT `Property`,`Value` FROM `Property`")
      .ToDictionary(row => row[0], row => row[1], StringComparer.Ordinal);
    Require(properties.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(new[] {
      "ProductCode", "UpgradeCode", "ProductName", "ProductVersion", "Manufacturer",
      "ProductLanguage", "ALLUSERS", "INSTALLLEVEL", "ARPNOMODIFY",
      "ARPNOREPAIR", "ARPNOREMOVE", "SecureCustomProperties" }) &&
      properties["ProductCode"] == V3MsiProgram.GuidFor("product:" + graph.GenerationId + ":" + version + ":" + recipe) &&
      properties["UpgradeCode"] == V3MsiProgram.GuidFor("upgrade:service-msi-v3") &&
      properties["ProductName"] == "LexRunner Windows coordinator v3 qualification" &&
      properties["ProductVersion"] == version && properties["Manufacturer"] == "SmarterGPT" &&
      properties["ProductLanguage"] == "1033" && properties["INSTALLLEVEL"] == "1" &&
      properties["ALLUSERS"] == "1" && properties["ARPNOMODIFY"] == "1" &&
      properties["ARPNOREPAIR"] == "1" && properties["ARPNOREMOVE"] == "1" &&
      properties["SecureCustomProperties"] == "EXISTINGSERVICE;EXISTINGWORKERSERVICE;ACTIVESELECTION;OCCUPIEDROOT",
      "Unexpected v3 product properties");

    var dirs = Query("SELECT `Directory`,`Directory_Parent`,`DefaultDir` FROM `Directory`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    var prefixes = files.Where(file => file.Path.Contains('/'))
      .Select(file => file.Path[..file.Path.LastIndexOf('/')])
      .SelectMany(path => Enumerable.Range(1, path.Split('/').Length)
        .Select(n => string.Join('/', path.Split('/').Take(n))))
      .Distinct(StringComparer.Ordinal).OrderBy(path => path.Count(c => c == '/'))
      .ThenBy(path => path, StringComparer.Ordinal).ToArray();
    var ids = prefixes.ToDictionary(path => path,
      path => "D" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(path)))[..12], StringComparer.Ordinal);
    Require(dirs.Count == 5 + prefixes.Length &&
      dirs["TARGETDIR"].SequenceEqual(new[] { "TARGETDIR", "", "SourceDir" }) &&
      dirs["ProgramFiles64Folder"].SequenceEqual(new[] { "ProgramFiles64Folder", "TARGETDIR", "." }) &&
      dirs["CoordinatorApplicationRoot"][1] == "ProgramFiles64Folder" &&
      dirs["CoordinatorApplicationRoot"][2] == "LEXRUN~1|SmarterGPT.LexRunner.WindowsCoordinator" &&
      dirs["CoordinatorGenerationsRoot"][1] == "CoordinatorApplicationRoot" &&
      dirs["CoordinatorGenerationRoot"][1] == "CoordinatorGenerationsRoot" &&
      dirs["CoordinatorGenerationRoot"][2] == "G" + graph.GenerationId[..7] + "|" + graph.GenerationId,
      "Unexpected v3 installed root profile");
    for (var i = 0; i < prefixes.Length; i++)
    {
      var path = prefixes[i];
      var parent = path.Contains('/') ? ids[path[..path.LastIndexOf('/')]] : "CoordinatorGenerationRoot";
      Require(dirs[ids[path]][1] == parent &&
        dirs[ids[path]][2] == $"D{i + 1:D7}|" + path[(path.LastIndexOf('/') + 1)..],
        "Unexpected v3 nested installed directory");
    }
    var feature = Query("SELECT `Feature`,`Feature_Parent`,`Title`,`Description`,`Display`,`Level`,`Directory_`,`Attributes` FROM `Feature`");
    Require(feature.Length == 1 && feature[0].SequenceEqual(new[] {
      "Coordinator", "", "Optional Windows coordinator", "Inactive v3 qualification generation",
      "2", "1", "CoordinatorGenerationRoot", "0" }), "Unexpected v3 feature");
    var components = Query("SELECT `Component`,`ComponentId`,`Directory_`,`Attributes`,`Condition`,`KeyPath` FROM `Component`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    var expectedComponents = new HashSet<string>(files.Select(file => file.Component), StringComparer.Ordinal)
    { "ProtectApplicationRoot", "ProtectGenerationsRoot", "ProtectGenerationRoot" };
    foreach (var id in ids.Values) expectedComponents.Add("P" + id[1..]);
    Require(components.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(expectedComponents) &&
      components.Values.All(row => row[1] == V3MsiProgram.GuidFor(
        (row[0] is "ProtectApplicationRoot" or "ProtectGenerationsRoot" ? "shared:" : graph.GenerationId + ":") + row[0]) &&
        row[3] == "256" && row[4] == ""), "Unexpected v3 component identity or retention");
    foreach (var file in files)
      Require(components[file.Component][2] == file.Directory &&
        components[file.Component][5] == file.Id,
        "V3 file component/keypath mismatch");
    foreach (var id in ids.Values)
      Require(components["P" + id[1..]][2] == id &&
        components["P" + id[1..]][5] == "", "V3 directory component mismatch");
    Require(Query("SELECT `Feature_`,`Component_` FROM `FeatureComponents`")
      .All(row => row[0] == "Coordinator") &&
      Query("SELECT `Component_` FROM `FeatureComponents`")
        .Select(row => row[0]).ToHashSet(StringComparer.Ordinal).SetEquals(expectedComponents),
      "Unexpected v3 feature components");
    var folders = Query("SELECT `Directory_`,`Component_` FROM `CreateFolder`")
      .ToDictionary(row => row[1], row => row[0], StringComparer.Ordinal);
    Require(folders.Count == 3 + prefixes.Length &&
      folders["ProtectApplicationRoot"] == "CoordinatorApplicationRoot" &&
      folders["ProtectGenerationsRoot"] == "CoordinatorGenerationsRoot" &&
      folders["ProtectGenerationRoot"] == "CoordinatorGenerationRoot" &&
      ids.Values.All(id => folders["P" + id[1..]] == id),
      "Unexpected v3 CreateFolder surface");

    var installed = Query("SELECT `File`,`Component_`,`FileName`,`FileSize`,`Version`,`Language`,`Attributes`,`Sequence` FROM `File`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    Require(installed.Count == files.Count, "Unexpected v3 file count");
    for (var i = 0; i < files.Count; i++)
    {
      var file = files[i];
      Require(installed[file.Id].SequenceEqual(new[] { file.Id, file.Component,
        file.ShortName + "|" + file.Path[(file.Path.LastIndexOf('/') + 1)..],
        file.Bytes.ToString(), "", "", "512", (i + 1).ToString() }),
        "V3 installed file binding mismatch");
    }
    var hashes = Query("SELECT `File_`,`Options`,`HashPart1`,`HashPart2`,`HashPart3`,`HashPart4` FROM `MsiFileHash`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    Require(hashes.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(files.Select(file => file.Id)) &&
      files.All(file => hashes[file.Id].SequenceEqual(ExpectedFileHash(file.Id,
        Path.Combine(staged, file.Path.Replace('/', Path.DirectorySeparatorChar))))),
      "V3 file hash rows do not match cabinet-bound members");
    var media = Query("SELECT `DiskId`,`LastSequence`,`DiskPrompt`,`Cabinet`,`VolumeLabel`,`Source` FROM `Media`");
    Require(media.Length == 1 && media[0].SequenceEqual(new[] {
      "1", files.Count.ToString(), "", "#payload.cab", "", "" }),
      "V3 media binding mismatch");

    var serviceFile = files.Single(file => file.Role == "service-image");
    var workerFile = files.Single(file => file.Role == "worker-service-image");
    var service = Query("SELECT `ServiceInstall`,`Name`,`DisplayName`,`ServiceType`,`StartType`,`ErrorControl`,`LoadOrderGroup`,`Dependencies`,`StartName`,`Password`,`Arguments`,`Component_`,`Description` FROM `ServiceInstall`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    Require(service.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(new[] {
      "RegisterCoordinatorService", "RegisterWorkerSlotService" }) &&
      service["RegisterCoordinatorService"].SequenceEqual(new[] {
      "RegisterCoordinatorService", V3MsiProgram.ServiceName, "LexRunner Windows Coordinator",
      "16", "3", "32769", "", "", "NT SERVICE\\" + V3MsiProgram.ServiceName,
      "", "--service", serviceFile.Component,
      "Optional governed Windows execution coordinator; inactive until separately qualified." }) &&
      service["RegisterWorkerSlotService"].SequenceEqual(new[] {
        "RegisterWorkerSlotService", V3MsiProgram.WorkerServiceName,
        "LexRunner Windows Worker Slot 1", "16", "3", "32769", "", "",
        "NT AUTHORITY\\LocalService", "", "--service", workerFile.Component,
        "Optional one-slot editing worker; inactive until separately qualified." }),
      "Unexpected v3 service images, identities or startup");
    var configuration = Query("SELECT `MsiServiceConfig`,`Name`,`Event`,`ConfigType`,`Argument`,`Component_` FROM `MsiServiceConfig`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    Require(configuration.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(new[] {
      "RestrictedServiceSid", "RequiredPrivileges",
      "WorkerRestrictedServiceSid", "WorkerRequiredPrivileges" }) &&
      configuration["RestrictedServiceSid"].SequenceEqual(new[] {
        "RestrictedServiceSid", V3MsiProgram.ServiceName, "1", "5", "3", serviceFile.Component }) &&
      configuration["RequiredPrivileges"].SequenceEqual(new[] {
        "RequiredPrivileges", V3MsiProgram.ServiceName, "1", "6", "SeChangeNotifyPrivilege", serviceFile.Component }) &&
      configuration["WorkerRestrictedServiceSid"].SequenceEqual(new[] {
        "WorkerRestrictedServiceSid", V3MsiProgram.WorkerServiceName,
        "1", "5", "3", workerFile.Component }) &&
      configuration["WorkerRequiredPrivileges"].SequenceEqual(new[] {
        "WorkerRequiredPrivileges", V3MsiProgram.WorkerServiceName,
        "1", "6", "SeChangeNotifyPrivilege", workerFile.Component }),
      "Unexpected v3 service SIDs or privileges");
    var permissions = Query("SELECT `MsiLockPermissionsEx`,`LockObject`,`Table`,`SDDLText`,`Condition` FROM `MsiLockPermissionsEx`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    var expectedPermissions = new HashSet<string>(files.Select(file => file.Id), StringComparer.Ordinal) {
      "ProtectCoordinatorService", "ProtectWorkerSlotService",
      "ProtectApplicationRoot", "ProtectGenerationsRoot", "ProtectGenerationRoot"
    };
    foreach (var id in ids.Values) expectedPermissions.Add("P" + id[1..]);
    Require(permissions.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(expectedPermissions) &&
      permissions.Values.All(row => row[4] == "") &&
      permissions["ProtectCoordinatorService"].SequenceEqual(new[] {
        "ProtectCoordinatorService", "RegisterCoordinatorService", "ServiceInstall", V3MsiProgram.ServiceSddl, "" }) &&
      permissions["ProtectWorkerSlotService"].SequenceEqual(new[] {
        "ProtectWorkerSlotService", "RegisterWorkerSlotService", "ServiceInstall",
        V3MsiProgram.WorkerServiceSddl, "" }) &&
      new[] { "ProtectApplicationRoot", "ProtectGenerationsRoot", "ProtectGenerationRoot" }
        .All(id => permissions[id][1] == (id == "ProtectApplicationRoot"
          ? "CoordinatorApplicationRoot" : id == "ProtectGenerationsRoot"
            ? "CoordinatorGenerationsRoot" : "CoordinatorGenerationRoot") &&
          permissions[id][2] == "CreateFolder" && permissions[id][3] == V3MsiProgram.DirectorySddl) &&
      ids.Values.All(id => permissions["P" + id[1..]][1] == id &&
        permissions["P" + id[1..]][2] == "CreateFolder" &&
        permissions["P" + id[1..]][3] == V3MsiProgram.DirectorySddl) &&
      files.All(file => permissions[file.Id][1] == file.Id &&
        permissions[file.Id][2] == "File" && permissions[file.Id][3] == V3MsiProgram.FileSddl),
      "Unexpected v3 ACL table");
    var conditions = Query("SELECT `Condition` FROM `LaunchCondition`")
      .Select(row => row[0]).ToHashSet(StringComparer.Ordinal);
    Require(conditions.SetEquals(new[] { "0", "VersionNT64", "NOT SHORTFILENAMES",
      "(NOT Installed AND NOT REMOVE AND NOT REINSTALL) OR (Installed AND REMOVE=\"ALL\" AND NOT REINSTALL)",
      "NOT EXISTINGSERVICE", "NOT EXISTINGWORKERSERVICE", "NOT ACTIVESELECTION",
      "NOT OCCUPIEDROOT OR Installed" }),
      "V3 maintenance, retirement or collision refusal missing");
    var actionRows = Query("SELECT `Action`,`Condition`,`Sequence` FROM `InstallExecuteSequence`");
    var expectedActions = new Dictionary<string, string>(StringComparer.Ordinal) {
      ["AppSearch"] = "50", ["CostInitialize"] = "800", ["FileCost"] = "900",
      ["CostFinalize"] = "1000", ["InstallValidate"] = "1400",
      ["LaunchConditions"] = "1450", ["InstallInitialize"] = "1500",
      ["ProcessComponents"] = "1600", ["UnpublishFeatures"] = "1800",
      ["RemoveFiles"] = "3500", ["RemoveFolders"] = "3600",
      ["CreateFolders"] = "3700", ["InstallFiles"] = "4000",
      ["InstallServices"] = "5000", ["MsiConfigureServices"] = "5050",
      ["RegisterUser"] = "6000", ["RegisterProduct"] = "6100",
      ["PublishFeatures"] = "6300", ["PublishProduct"] = "6400",
      ["InstallFinalize"] = "6600"
    };
    Require(actionRows.Length == expectedActions.Count &&
      actionRows.All(row => row[1] == "" &&
        expectedActions.TryGetValue(row[0], out var sequence) && sequence == row[2]),
      "Unexpected v3 installer actions");
    var ui = Query("SELECT `Action`,`Condition`,`Sequence` FROM `InstallUISequence`")
      .ToDictionary(row => row[0], row => row, StringComparer.Ordinal);
    Require(ui.Count == 5 && ui["AppSearch"].SequenceEqual(new[] { "AppSearch", "", "50" }) &&
      ui["CostInitialize"].SequenceEqual(new[] { "CostInitialize", "", "800" }) &&
      ui["FileCost"].SequenceEqual(new[] { "FileCost", "", "900" }) &&
      ui["CostFinalize"].SequenceEqual(new[] { "CostFinalize", "", "1000" }) &&
      ui["ExecuteAction"].SequenceEqual(new[] { "ExecuteAction", "", "1300" }),
      "Unexpected v3 installer UI actions");
    var search = Query("SELECT `Property`,`Signature_` FROM `AppSearch`");
    var locator = Query("SELECT `Signature_`,`Root`,`Key`,`Name`,`Type` FROM `RegLocator`");
    Require(search.Length == 4 &&
      search.Any(row => row.SequenceEqual(new[] { "EXISTINGSERVICE", "ExistingCoordinatorService" })) &&
      search.Any(row => row.SequenceEqual(new[] { "EXISTINGWORKERSERVICE", "ExistingWorkerSlotService" })) &&
      search.Any(row => row.SequenceEqual(new[] { "ACTIVESELECTION", "ExistingCoordinatorSelection" })) &&
      search.Any(row => row.SequenceEqual(new[] { "OCCUPIEDROOT", "ExistingCoordinatorRoot" })) &&
      locator.Length == 3 && locator.Any(row => row.SequenceEqual(new[] {
        "ExistingCoordinatorService", "2",
        "SYSTEM\\CurrentControlSet\\Services\\" + V3MsiProgram.ServiceName, "ImagePath", "18" })) &&
      locator.Any(row => row.SequenceEqual(new[] {
        "ExistingWorkerSlotService", "2",
        "SYSTEM\\CurrentControlSet\\Services\\" + V3MsiProgram.WorkerServiceName,
        "ImagePath", "18" })) &&
      locator.Any(row => row.SequenceEqual(new[] { "ExistingCoordinatorSelection", "2",
        "Software\\SmarterGPT.LexRunner.WindowsCoordinator", "ActiveSelection", "18" })) &&
      Query("SELECT `Signature_`,`Parent`,`Path`,`Depth` FROM `DrLocator`")
        .Single().SequenceEqual(new[] { "ExistingCoordinatorRoot", "",
          "[ProgramFiles64Folder]SmarterGPT.LexRunner.WindowsCoordinator", "0" }) &&
      Query("SELECT `Signature` FROM `Signature`").Length == 0,
      "Unexpected v3 service discovery");
  }
  private static void Require(bool condition, string message)
  { if (!condition) throw new InvalidDataException(message); }
  private static string[] ExpectedFileHash(string id, string path)
  {
    var hash = new FileHashInfo { Size = 20 };
    Check(MsiGetFileHashW(path, 0, ref hash));
    return [id, "0", hash.One.ToString(System.Globalization.CultureInfo.InvariantCulture),
      hash.Two.ToString(System.Globalization.CultureInfo.InvariantCulture),
      hash.Three.ToString(System.Globalization.CultureInfo.InvariantCulture),
      hash.Four.ToString(System.Globalization.CultureInfo.InvariantCulture)];
  }
  private static string[][] Read(string path, string sql)
  {
    uint database = 0, view = 0, record = 0;
    var rows = new List<string[]>();
    try
    {
      Check(MsiOpenDatabaseW(path, IntPtr.Zero, out database));
      Check(MsiDatabaseOpenViewW(database, sql, out view));
      Check(MsiViewExecute(view, 0));
      while (true)
      {
        var status = MsiViewFetch(view, out record);
        if (status == 259) break;
        Check(status);
        var fields = MsiRecordGetFieldCount(record);
        if (fields > 16 || rows.Count >= 8192) throw new InvalidDataException("V3 MSI audit budget");
        var row = new string[fields];
        for (uint n = 1; n <= fields; n++)
        {
          uint size = 0;
          status = MsiRecordGetStringW(record, n, null, ref size);
          if (status is not (0 or 234)) Check(status);
          if (size > 16384) throw new InvalidDataException("V3 MSI field budget");
          var value = new StringBuilder(checked((int)size + 1)); size++;
          Check(MsiRecordGetStringW(record, n, value, ref size));
          row[n - 1] = value.ToString();
        }
        rows.Add(row); Close(record); record = 0;
      }
      return rows.ToArray();
    }
    finally
    {
      if (record != 0) Close(record);
      if (view != 0) Close(view);
      if (database != 0) Close(database);
    }
  }
  private static void Check(uint code)
  { if (code != 0) throw new IOException("V3 MSI audit failed: " + code); }
  private static void Close(uint handle) => Check(MsiCloseHandle(handle));
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiOpenDatabaseW(string path, IntPtr mode, out uint database);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiViewExecute(uint view, uint record);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiViewFetch(uint view, out uint record);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiRecordGetFieldCount(uint record);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder? value, ref uint size);
  [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiCloseHandle(uint handle);
  [StructLayout(LayoutKind.Sequential)]
  private struct FileHashInfo { internal uint Size; internal int One, Two, Three, Four; }
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiGetFileHashW(string path, uint options, ref FileHashInfo hash);
}
