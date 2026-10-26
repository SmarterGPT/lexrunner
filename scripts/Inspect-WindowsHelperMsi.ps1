[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedGeneration,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedManifestDigest,
    [Parameter(Mandatory)][string]$ReceiptPath
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows Installer read APIs require native Windows' }
$artifact = (Resolve-Path -LiteralPath $Path).Path
$receipt = [IO.Path]::GetFullPath($ReceiptPath)
if (Test-Path -LiteralPath $receipt) { throw 'Receipt already exists' }
if (-not ('LexRunnerMsiReadV1' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class LexRunnerMsiReadV1 {
  static void Check(uint code) { if(code != 0) throw new IOException("MSI read failed: " + code); }
  public static string[][] Query(string path, string sql) {
    uint database=0, view=0, record=0;
    var rows=new List<string[]>();
    try {
      Check(MsiOpenDatabaseW(path, IntPtr.Zero, out database));
      Check(MsiDatabaseOpenViewW(database, sql, out view)); Check(MsiViewExecute(view,0));
      while(true) {
        var code=MsiViewFetch(view,out record); if(code==259) break; Check(code);
        try {
          var count=MsiRecordGetFieldCount(record);
          if(count>32 || rows.Count>=512) throw new IOException("MSI read budget");
          var row=new string[count];
          for(uint i=1;i<=count;i++) {
            uint size=0; code=MsiRecordGetStringW(record,i,null,ref size);
            if(code!=0 && code!=234) Check(code);
            if(size>16384) throw new IOException("MSI field budget");
            var value=new StringBuilder(checked((int)size+1)); size++;
            Check(MsiRecordGetStringW(record,i,value,ref size)); row[i-1]=value.ToString();
          }
          rows.Add(row);
        } finally { MsiCloseHandle(record); record=0; }
      }
      return rows.ToArray();
    } finally { if(record!=0) MsiCloseHandle(record); if(view!=0) MsiCloseHandle(view); if(database!=0) MsiCloseHandle(database); }
  }
  public static void ExtractPayload(string path, string destination) {
    uint database=0, view=0, record=0;
    string cabinet=System.IO.Path.Combine(destination,"payload.cab");
    try {
      Check(MsiOpenDatabaseW(path,IntPtr.Zero,out database));
      Check(MsiDatabaseOpenViewW(database,"SELECT `Data` FROM `_Streams` WHERE `Name`='payload.cab'",out view));
      Check(MsiViewExecute(view,0)); Check(MsiViewFetch(view,out record));
      using(var output=new FileStream(cabinet,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
        var buffer=new byte[65536]; long total=0;
        while(true) { uint read=(uint)buffer.Length; Check(MsiRecordReadStream(record,1,buffer,ref read)); if(read==0) break;
          total+=read; if(total>68157440) throw new IOException("Cabinet budget"); output.Write(buffer,0,(int)read); }
      }
    } finally { if(record!=0) MsiCloseHandle(record); if(view!=0) MsiCloseHandle(view); if(database!=0) MsiCloseHandle(database); }
    var seen=new HashSet<string>(StringComparer.Ordinal); string failure=null;
    CabinetCallback callback=(context,notification,first,second)=> {
      try {
        if(notification==17) { // SPFILENOTIFY_FILEINCABINET
          var name=Marshal.PtrToStringUni(Marshal.ReadIntPtr(first));
          var length=unchecked((uint)Marshal.ReadInt32(first,IntPtr.Size));
          if(name==null || (name!="HelperImage" && name!="GenerationManifest" && name!="InstalledMarker") || !seen.Add(name) || length>67108864)
            throw new IOException("Unexpected cabinet member");
          var target=System.IO.Path.Combine(destination,name);
          if(target.Length>=260 || File.Exists(target)) throw new IOException("Cabinet target budget");
          // FILE_IN_CABINET_INFO_W.FullTargetName starts after pointer, two DWORDs,
          // and three WORDs; do not replace native-owned NameInCabinet storage.
          var text=(target+"\0").ToCharArray(); Marshal.Copy(text,0,IntPtr.Add(first,IntPtr.Size+14),text.Length);
          return 1; // FILEOP_DOIT
        }
        if(notification==18) throw new IOException("Multiple cabinets unsupported");
        if(notification==19 && Marshal.ReadInt32(first,IntPtr.Size*2)!=0) throw new IOException("Cabinet extraction error");
        return 0;
      } catch(Exception error) { failure=error.Message; return notification==17 ? 0u : 1223u; }
    };
    if(!SetupIterateCabinetW(cabinet,0,callback,IntPtr.Zero) || failure!=null || seen.Count!=3) throw new IOException(failure??"Cabinet extraction failed");
    GC.KeepAlive(callback);
  }
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiOpenDatabaseW(string path,IntPtr mode,out uint database);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiDatabaseOpenViewW(uint database,string sql,out uint view);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiViewExecute(uint view,uint record);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiViewFetch(uint view,out uint record);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiRecordGetFieldCount(uint record);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiRecordGetStringW(uint record,uint field,StringBuilder value,ref uint size);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiCloseHandle(uint handle);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiRecordReadStream(uint record,uint field,byte[] buffer,ref uint size);
  delegate uint CabinetCallback(IntPtr context,uint notification,IntPtr first,IntPtr second);
  [DllImport("setupapi.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool SetupIterateCabinetW(string cabinet,uint reserved,CabinetCallback callback,IntPtr context);
}
'@
}
function Query([string]$Sql) {
    foreach ($row in [LexRunnerMsiReadV1]::Query($artifact, $Sql)) { Write-Output -NoEnumerate $row }
}
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$clock = [Diagnostics.Stopwatch]::StartNew()
$held = [IO.File]::Open($artifact, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $tables = @(Query 'SELECT `Name` FROM `_Tables`' | ForEach-Object { $_[0] })
    $allowedTables = @('Property','Directory','Component','Feature','FeatureComponents','CreateFolder','MsiLockPermissionsEx','File','MsiFileHash','Media','Registry','AppSearch','RegLocator','LaunchCondition','InstallExecuteSequence','InstallUISequence')
    Require ($tables.Count -eq $allowedTables.Count -and @($tables | Where-Object { $_ -notin $allowedTables }).Count -eq 0) 'Unexpected MSI table surface'
    foreach ($forbidden in @('CustomAction', 'ServiceInstall', 'ServiceControl', 'Upgrade', 'Environment', 'Shortcut')) {
        Require ($forbidden -notin $tables) 'Unexpected active installer mechanism'
    }
    $properties = @{}
    foreach ($row in @(Query 'SELECT `Property`,`Value` FROM `Property`')) { $properties[$row[0]] = $row[1] }
    Require ($properties['ALLUSERS'] -eq '1' -and $properties['ARPNOMODIFY'] -eq '1' -and $properties['ARPNOREPAIR'] -eq '1') 'Unexpected install/repair scope'
    $files = @(Query 'SELECT `File`,`Component_`,`FileName` FROM `File`')
    Require ($files.Count -eq 3 -and @($files | Where-Object { $_[0] -notin @('HelperImage', 'GenerationManifest', 'InstalledMarker') }).Count -eq 0) 'Unexpected MSI file payload'
    $expectedFiles = @{ HelperImage = @('RetainedHelperImage','LEXRUN~1.EXE|lexrunner-windows-boundary-helper.exe'); GenerationManifest = @('RetainedGenerationManifest','GENERA~1.JSO|generation.json'); InstalledMarker = @('InstallationMarker','INSTAL~1.JSO|installed.json') }
    foreach ($file in $files) { Require ($file[1] -ceq $expectedFiles[$file[0]][0] -and $file[2] -ceq $expectedFiles[$file[0]][1]) 'Unexpected installed file mapping' }
    $hashes = @(Query 'SELECT `File_` FROM `MsiFileHash`')
    Require ($hashes.Count -eq 3 -and @($hashes | Where-Object { $_[0] -notin $expectedFiles.Keys }).Count -eq 0) 'Windows Installer file hashes missing'
    $components = @{}
    $componentRows = @(Query 'SELECT `Component`,`Attributes`,`Directory_`,`Condition`,`KeyPath`,`ComponentId` FROM `Component`')
    foreach ($row in $componentRows) { $components[$row[0]] = [int]$row[1] }
    Require ($components.Count -eq 7) 'Unexpected component surface'
    foreach ($name in @('RetainedHelperImage', 'RetainedGenerationManifest', 'ProtectApplicationRoot', 'ProtectGenerationsRoot', 'ProtectGenerationRoot', 'RetainedGenerationCatalog')) {
        Require ($components.ContainsKey($name) -and (($components[$name] -band 16) -eq 16)) 'Generation retention missing'
    }
    Require ($components.ContainsKey('InstallationMarker') -and (($components['InstallationMarker'] -band 16) -eq 0)) 'Installation marker must be removed on uninstall'
    $componentBindings = @{ ProtectApplicationRoot = @('272','HelperApplicationRoot',''); ProtectGenerationsRoot = @('272','HelperGenerationsRoot',''); ProtectGenerationRoot = @('272','HelperGenerationRoot',''); RetainedHelperImage = @('272','HelperGenerationRoot','HelperImage'); RetainedGenerationManifest = @('272','HelperGenerationRoot','GenerationManifest'); InstallationMarker = @('256','HelperGenerationRoot','InstalledMarker'); RetainedGenerationCatalog = @('276','HelperGenerationRoot','ManifestDigest') }
    foreach ($row in $componentRows) {
        $expected = $componentBindings[$row[0]]
        Require ($row[1] -ceq $expected[0] -and $row[2] -ceq $expected[1] -and $row[3] -ceq '' -and $row[4] -ceq $expected[2] -and $row[5] -match '^\{[0-9A-F-]{36}\}$') 'Unexpected component binding or condition'
    }
    $features = @(Query 'SELECT `Feature_`,`Component_` FROM `FeatureComponents`')
    Require ($features.Count -eq 7 -and @($features | Where-Object { $_[0] -cne 'Helper' -or $_[1] -notin $componentBindings.Keys }).Count -eq 0) 'Unexpected feature component binding'
    $registry = @(Query 'SELECT `Root`,`Key`,`Name`,`Value` FROM `Registry`')
    $registryRoot = 'Software\SmarterGPT.LexRunner.WindowsHelper'
    Require ($registry.Count -eq 6 -and @($registry | Where-Object { $_[0] -ne '2' -or ($_[1] -cne $registryRoot -and -not $_[1].StartsWith($registryRoot + '\', [StringComparison]::Ordinal)) -or $_[2] -notin @('+','ManifestDigest','State','ProductCode') }).Count -eq 0) 'Unexpected registry scope or activation'
    Require (@($registry | Where-Object { $_[2] -eq 'ManifestDigest' -and $_[3] -ceq $ExpectedManifestDigest -and $_[1].EndsWith($ExpectedGeneration) }).Count -eq 1) 'Generation catalog mismatch'
    $directories = @(Query 'SELECT `Directory`,`Directory_Parent`,`DefaultDir` FROM `Directory`')
    $expectedDirectories = @{ TARGETDIR = @('','SourceDir'); ProgramFiles64Folder = @('TARGETDIR','.'); HelperApplicationRoot = @('ProgramFiles64Folder','LEXRUN~1|SmarterGPT.LexRunner.WindowsHelper'); HelperGenerationsRoot = @('HelperApplicationRoot','GENERA~1|generations'); HelperGenerationRoot = @('HelperGenerationsRoot',('G' + $ExpectedGeneration.Substring(0,7) + '|' + $ExpectedGeneration)) }
    Require ($directories.Count -eq 5) 'Unexpected directory surface'
    foreach ($directory in $directories) { Require ($expectedDirectories.ContainsKey($directory[0]) -and $directory[1] -ceq $expectedDirectories[$directory[0]][0] -and $directory[2] -ceq $expectedDirectories[$directory[0]][1]) 'Generation directory mismatch' }
    $permissions = @(Query 'SELECT `MsiLockPermissionsEx`,`LockObject`,`Table`,`SDDLText`,`Condition` FROM `MsiLockPermissionsEx`')
    $directorySddl = 'O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)'
    $fileSddl = 'O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)'
    $registrySddl = 'O:SYG:SYD:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KR;;;BU)'
    $permissionBindings = @{ ProtectApplicationRoot = @('HelperApplicationRoot','CreateFolder',$directorySddl); ProtectGenerationsRoot = @('HelperGenerationsRoot','CreateFolder',$directorySddl); ProtectGenerationRoot = @('HelperGenerationRoot','CreateFolder',$directorySddl); HelperImage = @('HelperImage','File',$fileSddl); GenerationManifest = @('GenerationManifest','File',$fileSddl); InstalledMarker = @('InstalledMarker','File',$fileSddl); CatalogRoot = @('CatalogRoot','Registry',$registrySddl); CatalogGenerations = @('CatalogGenerations','Registry',$registrySddl); CatalogGeneration = @('CatalogGeneration','Registry',$registrySddl) }
    Require ($permissions.Count -eq 9) 'Required permission rows missing'
    foreach ($row in $permissions) {
        Require ($permissionBindings.ContainsKey($row[0])) 'Unexpected permission object'
        $expected = $permissionBindings[$row[0]]
        Require ($row[1] -ceq $expected[0] -and $row[2] -ceq $expected[1] -and $row[3] -ceq $expected[2] -and $row[4] -ceq '') 'Unexpected authored ownership/permissions or condition'
    }
    $media = @(Query 'SELECT `Cabinet` FROM `Media`')
    Require ($media.Count -eq 1 -and $media[0][0] -ceq '#payload.cab') 'Payload must use the single expected embedded cabinet'
    $conditions = @(Query 'SELECT `Condition` FROM `LaunchCondition`')
    Require (@($conditions | Where-Object { $_[0] -eq 'NOT Installed OR REMOVE = "ALL"' }).Count -eq 1) 'In-place repair refusal missing'
    Require (@($conditions | Where-Object { $_[0] -eq 'Installed OR NOT EXISTINGGENERATION' }).Count -eq 1) 'Generation overwrite refusal missing'
    Require ($conditions.Count -eq 4 -and @($conditions | Where-Object { $_[0] -ceq 'VersionNT64' }).Count -eq 1 -and @($conditions | Where-Object { $_[0] -ceq 'NOT SHORTFILENAMES' }).Count -eq 1) 'Long-name x64 profile refusal missing'
    $expectedActions = [ordered]@{ AppSearch=50; LaunchConditions=100; CostInitialize=800; FileCost=900; CostFinalize=1000; InstallValidate=1400; InstallInitialize=1500; ProcessComponents=1600; UnpublishFeatures=1800; RemoveRegistryValues=2600; RemoveFiles=3500; RemoveFolders=3600; CreateFolders=3700; InstallFiles=4000; WriteRegistryValues=5000; RegisterUser=6000; RegisterProduct=6100; PublishFeatures=6300; PublishProduct=6400; InstallFinalize=6600 }
    foreach ($sequence in @('InstallExecuteSequence','InstallUISequence')) {
        $actions = @(Query ('SELECT `Action`,`Condition`,`Sequence` FROM `' + $sequence + '`'))
        $expectedSequence = if ($sequence -ceq 'InstallExecuteSequence') { $expectedActions } else { [ordered]@{ AppSearch=50; LaunchConditions=100; CostInitialize=800; FileCost=900; CostFinalize=1000; ExecuteAction=1300 } }
        Require ($actions.Count -eq $expectedSequence.Count) 'Unexpected standard action surface'
        foreach ($row in $actions) { Require ($expectedSequence.Contains($row[0]) -and $row[1] -ceq '' -and [int]$row[2] -eq $expectedSequence[$row[0]]) 'Unexpected installer action, condition or sequence' }
    }
    $extracted = $receipt + '.payload'
    Require (-not (Test-Path -LiteralPath $extracted)) 'Extraction output already exists'
    New-Item -ItemType Directory -Path $extracted | Out-Null
    [LexRunnerMsiReadV1]::ExtractPayload($artifact, $extracted)
    Require ((Get-FileHash -LiteralPath (Join-Path $extracted 'HelperImage') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExpectedGeneration) 'Embedded helper digest mismatch'
    Require ((Get-FileHash -LiteralPath (Join-Path $extracted 'GenerationManifest') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExpectedManifestDigest) 'Embedded manifest digest mismatch'
    $marker = Get-Content -LiteralPath (Join-Path $extracted 'InstalledMarker') -Raw | ConvertFrom-Json
    Require ($marker.generationId -ceq $ExpectedGeneration -and $marker.manifestSha256 -ceq $ExpectedManifestDigest -and $marker.productionReady -eq $false) 'Embedded installation marker mismatch'
    $clock.Stop()
    $result = [ordered]@{
        schemaVersion = 'windows-helper-msi-inspection/1'; outcome = 'passed'; artifact = $artifact
        artifactSha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
        generationId = $ExpectedGeneration; manifestSha256 = $ExpectedManifestDigest
        fileCount = $files.Count; permissionRowCount = $permissions.Count; tableCount = $tables.Count
        embeddedPayloadVerified = $true; extractedArtifactDirectory = $extracted
        scope = 'read-only MSI table/payload inspection into a new artifact directory; no installation, signature approval or ACL enforcement established'
        productionReady = $false; installed = $false; durationMs = $clock.ElapsedMilliseconds
    }
    [IO.File]::WriteAllText($receipt, (($result | ConvertTo-Json -Depth 6) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
} finally { $held.Dispose() }
Write-Output "MSI structure inspection passed; installation was not executed: $receipt"
