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
    $expectedFiles = @{ HelperImage = @('RetainedHelperImage','lexrunner-windows-boundary-helper.exe'); GenerationManifest = @('RetainedGenerationManifest','generation.json'); InstalledMarker = @('InstallationMarker','installed.json') }
    foreach ($file in $files) { Require ($file[1] -ceq $expectedFiles[$file[0]][0] -and $file[2] -ceq $expectedFiles[$file[0]][1]) 'Unexpected installed file mapping' }
    $hashes = @(Query 'SELECT `File_` FROM `MsiFileHash`')
    Require ($hashes.Count -eq 3 -and @($hashes | Where-Object { $_[0] -notin $expectedFiles.Keys }).Count -eq 0) 'Windows Installer file hashes missing'
    $components = @{}
    foreach ($row in @(Query 'SELECT `Component`,`Attributes` FROM `Component`')) { $components[$row[0]] = [int]$row[1] }
    Require ($components.Count -eq 7) 'Unexpected component surface'
    foreach ($name in @('RetainedHelperImage', 'RetainedGenerationManifest', 'ProtectApplicationRoot', 'ProtectGenerationsRoot', 'ProtectGenerationRoot', 'RetainedGenerationCatalog')) {
        Require ($components.ContainsKey($name) -and (($components[$name] -band 16) -eq 16)) 'Generation retention missing'
    }
    Require ($components.ContainsKey('InstallationMarker') -and (($components['InstallationMarker'] -band 16) -eq 0)) 'Installation marker must be removed on uninstall'
    $registry = @(Query 'SELECT `Root`,`Key`,`Name`,`Value` FROM `Registry`')
    $registryRoot = 'Software\SmarterGPT.LexRunner.WindowsHelper'
    Require ($registry.Count -eq 6 -and @($registry | Where-Object { $_[0] -ne '2' -or ($_[1] -cne $registryRoot -and -not $_[1].StartsWith($registryRoot + '\', [StringComparison]::Ordinal)) -or $_[2] -notin @('+','ManifestDigest','State','ProductCode') }).Count -eq 0) 'Unexpected registry scope or activation'
    Require (@($registry | Where-Object { $_[2] -eq 'ManifestDigest' -and $_[3] -ceq $ExpectedManifestDigest -and $_[1].EndsWith($ExpectedGeneration) }).Count -eq 1) 'Generation catalog mismatch'
    $directories = @(Query 'SELECT `Directory`,`Directory_Parent`,`DefaultDir` FROM `Directory`')
    $expectedDirectories = @{ TARGETDIR = @('','SourceDir'); ProgramFiles64Folder = @('TARGETDIR','.'); HelperApplicationRoot = @('ProgramFiles64Folder','SmarterGPT.LexRunner.WindowsHelper'); HelperGenerationsRoot = @('HelperApplicationRoot','generations'); HelperGenerationRoot = @('HelperGenerationsRoot',$ExpectedGeneration) }
    Require ($directories.Count -eq 5) 'Unexpected directory surface'
    foreach ($directory in $directories) { Require ($expectedDirectories.ContainsKey($directory[0]) -and $directory[1] -ceq $expectedDirectories[$directory[0]][0] -and $directory[2] -ceq $expectedDirectories[$directory[0]][1]) 'Generation directory mismatch' }
    $permissions = @(Query 'SELECT `SDDLText` FROM `MsiLockPermissionsEx`')
    Require ($permissions.Count -ge 8) 'Required permission rows missing'
    Require (@($permissions | Where-Object { $_[0] -notmatch '^O:SYG:SYD:P' -or $_[0] -notmatch ';;;SY\)' -or $_[0] -notmatch ';;;BA\)' -or $_[0] -match '(?:FA|GA|GW|KA);;;BU' }).Count -eq 0) 'Unexpected authored ownership/permissions'
    $media = @(Query 'SELECT `Cabinet` FROM `Media`')
    Require ($media.Count -eq 1 -and $media[0][0] -ceq '#payload.cab') 'Payload must use the single expected embedded cabinet'
    $conditions = @(Query 'SELECT `Condition` FROM `LaunchCondition`')
    Require (@($conditions | Where-Object { $_[0] -eq 'NOT Installed OR REMOVE = "ALL"' }).Count -eq 1) 'In-place repair refusal missing'
    Require (@($conditions | Where-Object { $_[0] -eq 'Installed OR NOT EXISTINGGENERATION' }).Count -eq 1) 'Generation overwrite refusal missing'
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
