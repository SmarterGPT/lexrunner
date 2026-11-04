[CmdletBinding()]
param([switch]$PureOnly,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:OS){$env:OS='Windows_NT'}
if(-not $env:WINDIR){$env:WINDIR=$env:SystemRoot}
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if($OutputDirectory -and -not [IO.Path]::IsPathFullyQualified($OutputDirectory)){throw 'source_output_must_be_absolute'}
$artifactRoot=if($OutputDirectory){[IO.Path]::GetFullPath($OutputDirectory)}else{
    Join-Path $repo ('artifacts/windows-coordinator-service-source/qualification-'+[Guid]::NewGuid().ToString('N'))
}
$allowed=[IO.Path]::GetFullPath((Join-Path $repo 'artifacts'))+[IO.Path]::DirectorySeparatorChar
if(-not $artifactRoot.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or
    $artifactRoot.IndexOfAny([char[]]@(';','"','%','&','|','<','>','^','!',"`r","`n")) -ge 0){throw 'source_output_outside_artifacts'}
$cursor=$artifactRoot
while($cursor){
    if(Test-Path -LiteralPath $cursor){
        $item=Get-Item -LiteralPath $cursor -Force
        if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'source_output_ancestor_redirected'}
    }
    $cursor=[IO.Path]::GetDirectoryName($cursor)
}
if(Test-Path -LiteralPath $artifactRoot){throw 'source_output_must_be_fresh'}
$null=New-Item -ItemType Directory -Path $artifactRoot
$clock=[Diagnostics.Stopwatch]::StartNew()
# Engineering capture proves only the owned direct process and its two streams.
# No timeout/kill is descendant-terminal proof. Unsettled owners remain retained.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed record CoordinatorSourceResult(string Outcome,int? ExitCode,long DurationMs,
    string Stdout,string Stderr,long OutputBytes,bool KillAttempted,bool KillUncertain,
    bool ProcessExited,bool StreamsSettled,byte[] StdoutBytes,byte[] StderrBytes);
public static class CoordinatorSourceCapture {
    static readonly List<Process> RetainedUncertain=new();
    public static CoordinatorSourceResult Run(ProcessStartInfo info,int timeoutMs)=>RunAsync(info,timeoutMs).GetAwaiter().GetResult();
    static async Task<CoordinatorSourceResult> RunAsync(ProcessStartInfo info,int timeoutMs) {
        if(timeoutMs<1||timeoutMs>180000||info.UseShellExecute||!info.RedirectStandardOutput||!info.RedirectStandardError)
            throw new ArgumentException("invalid_source_capture_profile");
        var watch=Stopwatch.StartNew();var process=new Process{StartInfo=info};var capture=new Capture();
        bool started=false,exited=false,settled=false,killUncertain=false;int kill=0;int? code=null;
        string outcome="terminal_uncertain";
        void KillOnce(){if(Interlocked.Exchange(ref kill,1)!=0)return;try{if(!process.HasExited)process.Kill();}catch{killUncertain=true;}}
        try {
            started=process.Start();if(!started)throw new IOException("source_process_not_started");
            var output=Drain(process.StandardOutput.BaseStream,capture,false);
            var error=Drain(process.StandardError.BaseStream,capture,true);
            var exit=process.WaitForExitAsync();
            var deadline=Task.Delay(Math.Max(1,timeoutMs-(int)Math.Min(int.MaxValue,watch.ElapsedMilliseconds)));
            var first=await Task.WhenAny(exit,capture.Stop.Task,deadline);
            outcome=watch.ElapsedMilliseconds>=timeoutMs||first==deadline?"timed_out":first==exit?"exited":"stream_or_output_failure";
            if(outcome!="exited")KillOnce();
            if(await Task.WhenAny(exit,Task.Delay(5000))==exit){try{await exit;code=process.ExitCode;exited=true;}catch{outcome="terminal_uncertain";}}
            var streams=Task.WhenAll(output,error);
            if(await Task.WhenAny(streams,Task.Delay(5000))==streams){await streams;settled=true;}
            if(!exited||!settled)outcome="terminal_uncertain";else if(capture.Failed)outcome="stream_or_output_failure";
        }catch{if(started)KillOnce();outcome="terminal_uncertain";}
        if(!exited||!settled){lock(RetainedUncertain)RetainedUncertain.Add(process);}
        else{try{process.Dispose();}catch{outcome="close_uncertain";lock(RetainedUncertain)RetainedUncertain.Add(process);}}
        watch.Stop();string stdout="",stderr="";
        try{var utf8=new UTF8Encoding(false,true);stdout=utf8.GetString(capture.Bytes(false));stderr=utf8.GetString(capture.Bytes(true));}
        catch{outcome="encoding_failure";}
        return new CoordinatorSourceResult(outcome,code,watch.ElapsedMilliseconds,stdout,stderr,
            capture.Total,kill!=0,killUncertain,exited,settled,capture.Bytes(false),capture.Bytes(true));
    }
    static async Task Drain(Stream stream,Capture capture,bool error){var bytes=new byte[1024];
        try{while(true){int count=await stream.ReadAsync(bytes);if(count==0)return;capture.Add(bytes,count,error);}}
        catch{capture.Fail();}}
    sealed class Capture {
        readonly object gate=new();readonly MemoryStream output=new(),errors=new();long total;bool failed;
        internal TaskCompletionSource<bool> Stop=new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal long Total{get{lock(gate)return total;}}internal bool Failed{get{lock(gate)return failed;}}
        internal void Add(byte[] bytes,int count,bool error){lock(gate){total+=count;var target=error?errors:output;
            int keep=Math.Min(count,32768-(int)target.Length);if(keep>0)target.Write(bytes,0,keep);
            if(keep<count||total>65536){failed=true;Stop.TrySetResult(true);}}}
        internal void Fail(){lock(gate){failed=true;Stop.TrySetResult(true);}}
        internal byte[] Bytes(bool error){lock(gate)return(error?errors:output).ToArray();}
    }
}
'@
$checks=[Collections.Generic.List[object]]::new()
function Invoke-Image([string]$Name,[string]$Image,[string[]]$Argv,[int]$ExpectedExit){
    $info=[Diagnostics.ProcessStartInfo]::new($Image)
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.WorkingDirectory=$repo
    foreach($argument in $Argv){$info.ArgumentList.Add($argument)}
    $result=[CoordinatorSourceCapture]::Run($info,120000)
    $checks.Add([ordered]@{name=$Name;command=@($Image)+$Argv;cwd=$repo;head=(& git -C $repo rev-parse HEAD).Trim();
        outcome=$result.Outcome;durationMs=$result.DurationMs;exitCode=$result.ExitCode;
        stdout=$result.Stdout;stderr=$result.Stderr;outputBytes=$result.OutputBytes;
        stdoutBase64=[Convert]::ToBase64String($result.StdoutBytes);stderrBase64=[Convert]::ToBase64String($result.StderrBytes);
        deadlineMs=120000;terminalGraceMs=5000;streamGraceMs=5000;retainedBytesPerStream=32768;totalOutputBudgetBytes=65536;
        killAttempted=$result.KillAttempted;killUncertain=$result.KillUncertain;
        processExited=$result.ProcessExited;streamsSettled=$result.StreamsSettled;directParentAndStreamsOnly=$true})
    [IO.File]::WriteAllText((Join-Path $artifactRoot 'process-checks.json'),
        (($checks.ToArray()|ConvertTo-Json -Depth 8).Replace("`r`n","`n")+"`n"),[Text.UTF8Encoding]::new($false))
    if($result.Outcome -cne 'exited' -or $result.ExitCode -ne $ExpectedExit -or $result.KillAttempted -or
        $result.KillUncertain -or -not $result.ProcessExited -or -not $result.StreamsSettled){throw ('source_process_refused_or_uncertain:'+$Name)}
    return $result
}
function Exact-Line($Result,[string]$Text,[bool]$ErrorStream=$false){
    $expected=$Text+[Environment]::NewLine
    if($ErrorStream){if($Result.Stderr -cne $expected -or $Result.Stdout.Length){throw 'source_stderr_mismatch'}}
    elseif($Result.Stdout -cne $expected -or $Result.Stderr.Length){throw 'source_stdout_mismatch'}
}
function Service-SourceHashes {
    $sourceHashes=[ordered]@{}
    foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File|Where-Object { $_.Extension -in '.cs','.csproj','.ps1','.json','.md' -or $_.Name -ceq '.gitignore' }){
        $sourceHashes[$file.Name]=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
    foreach($file in Get-ChildItem -LiteralPath (Split-Path -Parent $nativeBuilder) -File){
        $sourceHashes['trust-native/'+$file.Name]=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
    foreach($name in @('CustodyContract.cs','CustodyContractV3.cs','PublicationContractV3.cs','PublicationContractV3FixtureTests.cs','NativeRegistryReaderV3.cs','NativeInstalledPublicationReader.cs')){
        $sourceHashes['selection-custody/'+$name]=(Get-FileHash -LiteralPath (Join-Path $repo ('services/windows-coordinator-selection-custody/'+$name))).Hash.ToLowerInvariant()
    }
    foreach($name in @('NativeProtectedPublicationStore.cs','NativePublicationAdministration.cs','NativePublicationMutex.cs','PublicationAdminEntrypoint.cs')){
        $sourceHashes['selection-publisher/'+$name]=(Get-FileHash -LiteralPath (Join-Path $repo ('services/windows-coordinator-selection-publisher/'+$name))).Hash.ToLowerInvariant()
    }
    foreach($name in @('PublicationStoragePure.cs','PublicationStoragePure.csproj','global.json','Verify-PublicationStorageSource.ps1','.gitignore')){
        $sourceHashes['tests/'+$name]=(Get-FileHash -LiteralPath (Join-Path $repo ('tests/'+$name))).Hash.ToLowerInvariant()
    }
    $sourceHashes
}
$nativeBuilder=Join-Path $repo 'services/windows-coordinator-trust-native/Build-NativeTrustCore.ps1'
$sourceHashesBefore=Service-SourceHashes
$native=& $nativeBuilder -OutputDirectory (Join-Path $artifactRoot 'native') -ServiceArtifactRoot $artifactRoot
$builds=[Collections.Generic.List[object]]::new()
foreach($mode in @('normal','fixture')){
    $script=if($mode -eq 'normal'){$native.normalPublishScript}else{$native.fixturePublishScript}
    $buildWatch=[Diagnostics.Stopwatch]::StartNew()
    $output=@(& cmd.exe /d /c $script 2>&1);$code=$LASTEXITCODE;$buildWatch.Stop()
    $log=($output|ForEach-Object {$_.ToString()}) -join "`n"
    [IO.File]::WriteAllText((Join-Path $artifactRoot ($mode+'-build.log')),($log+"`n"),[Text.UTF8Encoding]::new($false))
    $logPath=Join-Path $artifactRoot ($mode+'-build.log')
    $builds.Add([ordered]@{mode=$mode;command=@('cmd.exe','/d','/c',$script);cwd=$PWD.Path;head=(& git -C $repo rev-parse HEAD).Trim();durationMs=$buildWatch.ElapsedMilliseconds;exitCode=$code;outputBytes=(Get-Item -LiteralPath $logPath).Length;outputSha256=(Get-FileHash -LiteralPath $logPath).Hash})
    [IO.File]::WriteAllText((Join-Path $artifactRoot 'build-checks.json'),(($builds.ToArray()|ConvertTo-Json -Depth 8).Replace("`r`n","`n")+"`n"),[Text.UTF8Encoding]::new($false))
    if((Get-Item -LiteralPath $logPath).Length -gt 131072 -or $code -ne 0){throw ('source_publish_failed_or_output_bound:'+$mode)}
}
$normalImage=Join-Path $artifactRoot 'publish/LexRunner.WindowsCoordinator.Service.exe'
$fixtureImage=Join-Path $artifactRoot 'fixture/LexRunner.WindowsCoordinator.Service.exe'
$nativePure=Invoke-Image 'native_policy_pure' $native.pureImage @() 0
# This unchanged console CRT unit emits one compact JSON object plus CRLF.
# Parse original bytes; diagnostic/product LF wire contracts are unchanged.
if($nativePure.Stderr.Length -ne 0 -or $nativePure.Stdout -cnotmatch '\A\{[^\r\n]*\}\r\n\z'){throw 'native_pure_frame_failed'}
$document=[Text.Json.JsonDocument]::Parse($nativePure.Stdout)
try{
    $root=$document.RootElement
    $names=@($root.EnumerateObject()|ForEach-Object {$_.Name})
    if($names.Count -ne 5 -or @($names|Sort-Object -Unique).Count -ne 5 -or
       $root.GetProperty('result').ValueKind -ne [Text.Json.JsonValueKind]::String -or
       $root.GetProperty('result').GetString() -cne 'pure_pass' -or
       $root.GetProperty('sdkTrustCalls').ValueKind -ne [Text.Json.JsonValueKind]::Number -or
       $root.GetProperty('sdkTrustCalls').GetInt64() -ne 0 -or
       $root.GetProperty('childStarted').ValueKind -ne [Text.Json.JsonValueKind]::False -or
       $root.GetProperty('authorizesExecution').ValueKind -ne [Text.Json.JsonValueKind]::False -or
       $root.GetProperty('cases').ValueKind -ne [Text.Json.JsonValueKind]::Number){throw 'native_pure_failed'}
    $nativePureCases=$root.GetProperty('cases').GetInt64()
    if($nativePureCases -lt 1 -or $nativePureCases -gt 2000){throw 'native_pure_count_failed'}
}finally{$document.Dispose()}
foreach($entry in @(@('publication','--v3-publication-contract-selftest'),@('protocol','--protocol-selftest'),
    @('pipe','--pipe-selftest'),@('lifecycle','--lifecycle-selftest'),@('launch','--private-launch-selftest'),@('trust','--trust-contract-selftest'),
    @('custom_controls','--custom-control-selftest'))){
    Exact-Line (Invoke-Image ('normal_refuses_'+$entry[0]) $normalImage @($entry[1]) 2) 'scm_only' $true
}
Exact-Line (Invoke-Image 'normal_refuses_private_child' $normalImage @('--private-child-fixture','Normal') 2) 'scm_only' $true
Exact-Line (Invoke-Image 'normal_closed_trust_context' $normalImage @('--private-trust-child') 3) 'protected_bootstrap_unavailable' $true
Exact-Line (Invoke-Image 'normal_trust_no_extra_args' $normalImage @('--private-trust-child','extra') 2) 'scm_only' $true
foreach($mode in @('--publication-preview','--admin-publication','--admin-publication-recover')){
    Exact-Line (Invoke-Image ('normal_publication_no_extra_args_'+$mode) $normalImage @($mode,'extra') 2) 'scm_only' $true
}
Exact-Line (Invoke-Image 'fixture_trust_abi_pure' $fixtureImage @('--trust-contract-selftest') 0) 'trust_contract_pure_pass sdkTrustCalls=0 authorizesExecution=false'
$publication=Invoke-Image 'fixture_publication_pure' $fixtureImage @('--v3-publication-contract-selftest') 0
if($publication.Stderr.Length -ne 0 -or -not $publication.Stdout.EndsWith(
    'publication_contract_pure_selftest PASS cases=74 failures=0 authorizesLaunch=false authorizesEffect=false nativeEffects=0'+[Environment]::NewLine)){throw 'publication_pure_failed'}
Exact-Line (Invoke-Image 'fixture_protocol_pure' $fixtureImage @('--protocol-selftest') 0) 'protocol_selftest_pass'
Exact-Line (Invoke-Image 'fixture_lifecycle_pure' $fixtureImage @('--lifecycle-selftest') 0) 'lifecycle_selftest_pass'
Exact-Line (Invoke-Image 'fixture_custom_controls_pure' $fixtureImage @('--custom-control-selftest') 0) 'custom_control_selftest_pass'
if(-not $PureOnly){
    Exact-Line (Invoke-Image 'normal_direct_service_refusal' $normalImage @('--service') 3) 'scm_required' $true
    Exact-Line (Invoke-Image 'fixture_pipe' $fixtureImage @('--pipe-selftest') 0) 'pipe_selftest_pass'
    Exact-Line (Invoke-Image 'fixture_private_launch' $fixtureImage @('--private-launch-selftest') 0) 'private_launch_selftest_pass'
}
$sourceHashes=Service-SourceHashes
if(($sourceHashesBefore|ConvertTo-Json -Compress) -cne ($sourceHashes|ConvertTo-Json -Compress)){throw 'combined_source_changed_during_verification'}
$clock.Stop()
$receipt=[ordered]@{result=$(if($PureOnly){'source_pure_only_pass'}else{'source_fixture_pass'});cwd=$PSScriptRoot;
    repoHead=(& git -C $repo rev-parse HEAD).Trim();durationMs=$clock.ElapsedMilliseconds;pureOnly=[bool]$PureOnly;
    normalImageSha256=(Get-FileHash -LiteralPath $normalImage).Hash.ToLowerInvariant();
    fixtureImageSha256=(Get-FileHash -LiteralPath $fixtureImage).Hash.ToLowerInvariant();
    nativeArchiveSha256=$native.sha256;nativePureCases=$nativePureCases;publicationPureTestCount=74;
    customControlCallbackCases=128;customControlSourceSelfTest='custom_control_selftest_pass';retainedScmControlHandlesQualified=$false;
    historicalPipeAndPrivateLaunchExecuted=(-not $PureOnly);installedServiceQualified=$false;
    sdkFunctionalExecution=$false;sourceSha256=$sourceHashes;sourceSha256Before=$sourceHashesBefore;sourceSha256After=$sourceHashes;
    publicationLiveOriginQualified=$false;helperMissingCleared=$false}
$receiptPath=Join-Path $artifactRoot 'verification-receipt.json'
[IO.File]::WriteAllText($receiptPath,(($receipt|ConvertTo-Json -Depth 8).Replace("`r`n","`n")+"`n"),[Text.UTF8Encoding]::new($false))
[pscustomobject]@{result=$receipt.result;durationMs=$receipt.durationMs;receiptPath=$receiptPath;pureOnly=[bool]$PureOnly}|ConvertTo-Json -Compress
