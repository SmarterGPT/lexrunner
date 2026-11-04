[CmdletBinding()]
param([switch]$Functional)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $IsWindows -or -not [Environment]::Is64BitProcess){throw 'Native Windows x64 required'}
if(-not $env:WINDIR){$env:WINDIR=$env:SystemRoot}
if(-not $env:OS){$env:OS='Windows_NT'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Add-Type -Path (Join-Path $repo 'services/windows-coordinator-selection-publisher/VerifierBoundedProcess.cs')
function Require([bool]$ok,[string]$why){if(-not $ok){throw $why}}
function Plain([string]$path){
    $cursor=[IO.Path]::GetFullPath($path)
    while($cursor){$item=Get-Item -LiteralPath $cursor -Force;Require ($item.PSIsContainer -and -not($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Output ancestor redirected';$cursor=[IO.Path]::GetDirectoryName($cursor)}
}
$parent=Join-Path $repo 'artifacts/windows-coordinator-msi-subject'
Plain (Split-Path -Parent $parent)
if(-not(Test-Path -LiteralPath $parent)){[SelectionPublisherVerifierFiles]::CreateNewDirectory($parent)}
Plain $parent
$run=Join-Path $parent ('qualification-'+[Guid]::NewGuid().ToString('N'))
[SelectionPublisherVerifierFiles]::CreateNewDirectory($run);Plain $run
$head=(& git.exe -C $repo rev-parse HEAD).Trim()
$records=[Collections.Generic.List[object]]::new()
# Shared by the pure truth table and the actual functional observer. A native
# input refusal/unknown status or incomplete/uncertain result is never a valid
# negative observation and must stop before any subsequent command.
function Selected-OutcomeAllowed([long]$nativeStatus,[long]$completion){
    $nativeStatus -eq 0 -and ($completion -eq 1 -or $completion -eq 2)
}
function Hashes {
    $rows=[ordered]@{}
    foreach($p in Get-ChildItem -LiteralPath $PSScriptRoot -File|Where-Object {$_.Extension -in '.cpp','.h','.ps1','.md'}){$rows[$p.Name]=(Get-FileHash -LiteralPath $p.FullName -Algorithm SHA256).Hash}
    $rows['VerifierBoundedProcess.cs']=(Get-FileHash -LiteralPath (Join-Path $repo 'services/windows-coordinator-selection-publisher/VerifierBoundedProcess.cs') -Algorithm SHA256).Hash
    $rows
}
function Step([string]$name,[string]$exe,[string[]]$arguments,[int]$expected=0,[int]$timeout=120000){
    $info=[Diagnostics.ProcessStartInfo]::new($exe);$info.WorkingDirectory=$PSScriptRoot
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    foreach($arg in $arguments){$info.ArgumentList.Add($arg)}
    $r=[SelectionPublisherVerifierProcess]::Run($info,$timeout,262144,16384)
    $row=[ordered]@{name=$name;command=@($exe)+$arguments;cwd=$PSScriptRoot;head=$head;durationMs=$r.DurationMs;outcome=$r.Outcome.ToString();exitCode=$r.ExitCode;stdout=$r.Stdout;stderr=$r.Stderr;outputBytes=$r.TotalOutputBytes;captureTruncated=$r.CaptureTruncated;directChildAndStreamsOnly=$true}
    $records.Add($row)
    [IO.File]::WriteAllText((Join-Path $run 'commands.json'),(($records.ToArray()|ConvertTo-Json -Depth 12).Replace("`r`n","`n")+"`n"),[Text.UTF8Encoding]::new($false))
    Require ($row.outcome -ceq 'Exited' -and $row.exitCode -eq $expected -and -not $row.captureTruncated) ('Step failed or uncertain: '+$name)
    $row
}
# Pure file-format fixture helper. It reads only the already pinned MSI bytes;
# no Installer, SIP, WinTrust, COM, registration or signing API is called here.
# Deliberately narrow to this pinned CFB fixture (header DIFAT only), with all chain,
# directory, stream and DER offsets bounded. Unsupported shape refuses.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
public static class MsiSubjectFixtureOffsets {
    const uint End=0xfffffffe;
    sealed class Entry { public string Name=""; public byte Kind;public uint Start;public long Size; }
    sealed class Cfb {
        readonly byte[] b;readonly uint[] fat,mini;readonly List<uint> rootChain;
        readonly int sectors,sector;readonly List<Entry> entries=new();
        static void Need(bool ok){if(!ok)throw new InvalidOperationException("unsupported_bounded_msi_fixture");}
        uint U(int p){Need(p>=0&&p<=b.Length-4);return BitConverter.ToUInt32(b,p);}
        int Physical(uint id){Need(id<(uint)sectors);return checked(((int)id+1)*sector);}
        List<uint> Chain(uint first,uint[] table,int max) {
            var result=new List<uint>();var seen=new HashSet<uint>();
            for(uint id=first;id!=End;id=table[id]){
                Need(id<(uint)table.Length&&id<(uint)max&&seen.Add(id)&&result.Count<max);result.Add(id);
            }
            return result;
        }
        byte[] Normal(List<uint> chain,long size) {
            Need(size>=0&&size<=64*1024*1024&&chain.Count*(long)sector>=size);
            var data=new byte[(int)size];for(int i=0;i<data.Length;i++)data[i]=b[Physical(chain[i/sector])+i%sector];return data;
        }
        public Cfb(byte[] data) {
            b=data;Need(b.Length>=1536&&b.Length<=64*1024*1024);
            int major=BitConverter.ToUInt16(b,26),shift=BitConverter.ToUInt16(b,30);
            Need((major==3&&shift==9)||(major==4&&shift==12));sector=1<<shift;
            Need(b.Length>=3*sector&&b.Length%sector==0&&
                b.Take(8).SequenceEqual(new byte[]{0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1})&&
                BitConverter.ToUInt16(b,28)==0xfffe&&BitConverter.ToUInt16(b,32)==6&&
                (major==4||U(40)==0)&&U(56)==4096&&U(72)==0);
            sectors=b.Length/sector-1;uint count=U(44);Need(count>0&&count<=109);
            var f=new List<uint>();var used=new HashSet<uint>();
            for(int i=0;i<count;i++){uint id=U(76+4*i);Need(used.Add(id));int p=Physical(id);for(int j=0;j<sector/4;j++)f.Add(U(p+4*j));}fat=f.ToArray();
            var directoryChain=Chain(U(48),fat,sectors);Need(directoryChain.Count>0&&directoryChain.Count<=1024);
            Need(major==3||U(40)==directoryChain.Count);
            var directory=Normal(directoryChain,directoryChain.Count*(long)sector);Need(directory[66]==5);
            for(int p=0;p<directory.Length;p+=128){byte kind=directory[p+66];if(kind==0)continue;
                int chars=BitConverter.ToUInt16(directory,p+64);Need(chars>=2&&chars<=64&&chars%2==0);
                var name=Encoding.Unicode.GetString(directory,p,chars-2);Need(directory[p+chars-2]==0&&directory[p+chars-1]==0);
                long size=BitConverter.ToInt64(directory,p+120);Need(size>=0&&size<=64*1024*1024);
                entries.Add(new Entry{Name=name,Kind=kind,Start=BitConverter.ToUInt32(directory,p+116),Size=size});}
            Need(entries.Count>0&&entries[0].Kind==5);var root=entries[0];rootChain=Chain(root.Start,fat,sectors);Need(rootChain.Count*(long)sector>=root.Size);
            uint miniCount=U(64);Need(miniCount<=1024);
            if(miniCount==0)mini=Array.Empty<uint>();else{
                var chain=Chain(U(60),fat,sectors);Need(chain.Count==miniCount);
                var bytes=Normal(chain,miniCount*(long)sector);mini=new uint[bytes.Length/4];for(int i=0;i<mini.Length;i++)mini[i]=BitConverter.ToUInt32(bytes,4*i);}
        }
        List<uint> StreamChain(Entry e){return e.Size<4096?Chain(e.Start,mini,checked((int)((entries[0].Size+63)/64))):Chain(e.Start,fat,sectors);}
        int Map(Entry e,List<uint> chain,int offset) {
            Need(offset>=0&&offset<e.Size);
            if(e.Size>=4096){Need(offset/sector<chain.Count);return Physical(chain[offset/sector])+offset%sector;}
            Need(offset/64<chain.Count);long logical=chain[offset/64]*64L+offset%64;Need(logical<entries[0].Size&&logical/sector<rootChain.Count);
            return Physical(rootChain[(int)(logical/sector)])+(int)(logical%sector);
        }
        static (int begin,int end) Tlv(byte[] data,int at,byte tag) {
            Need(at>=0&&at<=data.Length-2&&data[at++]==tag);int size=data[at++];
            if((size&128)!=0){int n=size&127;Need(n>0&&n<=4&&at<=data.Length-n);size=0;for(int i=0;i<n;i++)size=checked(size*256+data[at++]);}
            Need(size>0&&size<=data.Length-at);return(at,at+size);
        }
        // Locate the primary SignerInfo signature VALUE, not an arbitrary byte
        // in the signature stream. Unused certificates/unsigned attributes may
        // legitimately change without invalidating the primary signature.
        static int PrimarySignatureValueOffset(byte[] encoded) {
            var outer=Tlv(encoded,0,0x30);Need(outer.end==encoded.Length);
            var oid=Tlv(encoded,outer.begin,0x06);
            Need(encoded.Skip(oid.begin).Take(oid.end-oid.begin).SequenceEqual(
                new byte[]{0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x07,0x02}));
            var explicitData=Tlv(encoded,oid.end,0xa0);Need(explicitData.end==outer.end);
            var data=Tlv(encoded,explicitData.begin,0x30);Need(data.end==explicitData.end);
            var version=Tlv(encoded,data.begin,0x02);
            var algorithms=Tlv(encoded,version.end,0x31);
            var content=Tlv(encoded,algorithms.end,0x30);int at=content.end;
            Need(at<data.end);
            if(encoded[at]==0xa0){at=Tlv(encoded,at,0xa0).end;Need(at<data.end);}
            if(encoded[at]==0xa1){at=Tlv(encoded,at,0xa1).end;Need(at<data.end);}
            var infos=Tlv(encoded,at,0x31);Need(infos.end==data.end);
            var signer=Tlv(encoded,infos.begin,0x30);Need(signer.end==infos.end);
            var signerVersion=Tlv(encoded,signer.begin,0x02);at=signerVersion.end;
            Need(at<signer.end&&(encoded[at]==0x30||encoded[at]==0x80));
            at=Tlv(encoded,at,encoded[at]).end;
            at=Tlv(encoded,at,0x30).end;Need(at<signer.end);
            if(encoded[at]==0xa0)at=Tlv(encoded,at,0xa0).end;
            at=Tlv(encoded,at,0x30).end;
            var signature=Tlv(encoded,at,0x04);int length=signature.end-signature.begin;
            Need(length>0&&length<=16384);at=signature.end;
            if(at<signer.end)at=Tlv(encoded,at,0xa1).end;
            Need(at==signer.end);
            return signature.begin+length/2;
        }
        public long[] Offsets() {
            var signatures=entries.Where(e=>e.Kind==2&&e.Name==((char)5)+"DigitalSignature").ToArray();Need(signatures.Length==1);
            var s=signatures[0];Need(s.Size>128&&s.Size<=4*1024*1024);var chain=StreamChain(s);
            var encoded=new byte[(int)s.Size];for(int i=0;i<encoded.Length;i++)encoded[i]=b[Map(s,chain,i)];
            byte[] oid={0x06,0x0a,0x2b,0x06,0x01,0x04,0x01,0x82,0x37,0x03,0x03,0x01};int found=-1;
            for(int i=0;i<=encoded.Length-oid.Length;i++){bool match=true;for(int j=0;j<oid.Length;j++)match&=encoded[i+j]==oid[j];if(match){Need(found<0);found=i;}}
            Need(found>=0);var set=Tlv(encoded,found+oid.Length,0x31);var token=Tlv(encoded,set.begin,0x30);Need(token.end==set.end);
            var payload=entries.Where(e=>e.Kind==2&&!e.Name.Contains("DigitalSignature")&&e.Size>128).OrderByDescending(e=>e.Size).FirstOrDefault();Need(payload!=null);
            return new long[]{Map(payload!,StreamChain(payload!),checked((int)(payload!.Size/2))),Map(s,chain,PrimarySignatureValueOffset(encoded)),Map(s,chain,token.end-1)};
        }
    }
    public static long[] Locate(byte[] bytes){return new Cfb(bytes).Offsets();}
}
'@
$msi=Join-Path $repo 'artifacts/windows-helper-msi/signed-f59ade4/msi/LexRunner.WindowsHelper.qualification.win-x64.msi'
$pe=Join-Path $repo 'artifacts/windows-helper-msi/signed-f59ade4/helper/lexrunner-windows-boundary-helper.exe'
$msiPin='4571cb855cc0d98eb34e73b69578e87eb1b672598acaaef8b34a046bd03fba4a'
$pePin='d0a1f14cf5ba8203fcbe0fef401fd585cb6856b07a9b49f30bc2fb05a8c1066f'
$before=$null;$after=$null;$failure=$null;$offsets=$null;$functionalExecuted=$false;$pureCount=0;$images=$null;$guardPureCases=0
$pendingControls=@('raw-only-outside-SIP-coverage','unsigned-MSI','truncated-MSI','injected-actual-close-failure','injected-actual-deadline-failure')
$native=Join-Path $run 'native';$probe=Join-Path $native 'trust-subject-probe.exe'
$watch=[Diagnostics.Stopwatch]::StartNew()
try {
    $before=Hashes
    foreach($v in @(@(0,0,$false),@(0,1,$true),@(0,2,$true),@(0,3,$false),@(0,99,$false),@(1,1,$false),@(1,2,$false),@(2,1,$false),@(-1,1,$false))){
        Require ((Selected-OutcomeAllowed $v[0] $v[1]) -eq $v[2]) 'Selected outcome guard truth table failed'
        $guardPureCases++
    }
    Require ((Get-Item -LiteralPath $msi).Length -eq 1327104 -and (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $msiPin) 'Approved MSI data pin changed'
    Require ((Get-Item -LiteralPath $pe).Length -eq 2753944 -and (Get-FileHash -LiteralPath $pe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $pePin) 'Approved PE data pin changed'
    $offsets=[MsiSubjectFixtureOffsets]::Locate([IO.File]::ReadAllBytes($msi))
    $null=Step 'build-native-archive-pure-and-probe' (Get-Command pwsh.exe).Source @('-NoLogo','-NoProfile','-File',(Join-Path $PSScriptRoot 'Build-NativeTrustCore.ps1'),'-OutputDirectory',$native,'-ServiceArtifactRoot',(Join-Path $run 'unexecuted-service-build-plan')) 0 180000
    $images=[ordered]@{}
    foreach($leaf in @('LexRunner.TrustSdkCore.lib','trust-core-pure.exe','trust-subject-probe.exe')){
        $path=Join-Path $native $leaf;$images[$leaf]=[ordered]@{path=$path;bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}
    }
    $pure=Step 'native-policy-pure' (Join-Path $native 'trust-core-pure.exe') @()
    $pureResult=$pure.stdout|ConvertFrom-Json
    Require ($pureResult.result -ceq 'pure_pass' -and $pureResult.cases -eq 89 -and $pureResult.sdkTrustCalls -eq 0) 'Pure vectors failed'
    $pureCount=$pureResult.cases
    $layout=Step 'probe-layout-pure' $probe @('--layout-selftest')
    Require (($layout.stdout|ConvertFrom-Json).result -ceq 'layout_pure_pass') 'Layout result failed'
    foreach($case in @('version','size','kind','features','reserved','missing-handle','v2-then-v3','v3-then-v2')){
        $r=Step ('abi-'+$case) $probe @('--abi-refusal',$case)
        $parsed=$r.stdout|ConvertFrom-Json
        Require ($parsed.result -ceq 'abi_refusal_pure_pass' -and $parsed.sdkTrustCalls -eq 0) 'ABI refusal failed'
    }
    $planned=[ordered]@{source='Previously approved signed-f59 artifacts as DATA only';msi=$msi;msiSha256=$msiPin;pe=$pe;peSha256=$pePin;mutationOffsets=@($offsets);offsetKinds=@('longest-nonsignature-stream-middle','primary-encryptedHash-value','rfc3161-token-final-byte');singleProcessRequest=$true;deadlineMs=120000;coreVerificationWindowSeconds=30;maxOutputBytes=262144;captureBytesPerStream=16384;nativeInputMaxBytes=67108864;msiObjectConsumptionQualified=$false;rootFunctionalProfileAdmissionRequired=$true;completeQualificationProfile=$false;pendingControls=$pendingControls;images=$images;sourceHashes=$before;selectedOutcomeGuard='nativeStatus0 and completion1or2; negatives exactly1';guardPureCases=$guardPureCases;functionalRunRebuildsFreshArchiveAndProbe=$true}
    $planned['mutations']=@(for($i=0;$i -lt 3;$i++){
        $bytes=[IO.File]::ReadAllBytes($msi);$bytes[$offsets[$i]]=$bytes[$offsets[$i]] -bxor 1
        [ordered]@{kind=$planned.offsetKinds[$i];offset=$offsets[$i];path=(Join-Path $run ('owned-negative-'+$i+'.msi'));bytes=$bytes.Length;expectedFixtureSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant();comparisonDataNotApproval=$true}
    })
    $planned['plannedNativeCommands']=@(
        @($probe,'--diagnostic-read-only','msi',$msi,$msiPin,'1327104'),
        @($probe,'--diagnostic-read-only','pe',$pe,$pePin,'2753944'),
        @($probe,'--diagnostic-read-only','pe-v2',$pe,$pePin,'2753944')
    )
    foreach($control in @('file-id','volume','path')){$planned.plannedNativeCommands+=,@($probe,'--diagnostic-read-only','msi',$msi,$msiPin,'1327104',$control)}
    $planned.plannedNativeCommands+=,@($probe,'--diagnostic-read-only','msi',$msi,('0'*64),'1327104')
    $planned.plannedNativeCommands+=,@($probe,'--diagnostic-read-only','msi',$msi,$msiPin,'1327103')
    $planned.plannedNativeCommands+=,@($probe,'--diagnostic-read-only','msi',$pe,$pePin,'2753944')
    foreach($mutation in $planned.mutations){$planned.plannedNativeCommands+=,@($probe,'--diagnostic-read-only','msi',$mutation.path,$mutation.expectedFixtureSha256,$mutation.bytes.ToString())}
    $planned.plannedNativeCommands+=,@($probe,'--provider-control',$msi,$planned.mutations[0].path,$msi)
    $planned.plannedNativeCommands+=,@($probe,'--provider-control',$planned.mutations[0].path,$msi,$msi)
    [IO.File]::WriteAllText((Join-Path $run 'functional-profile.json'),(($planned|ConvertTo-Json -Depth 10).Replace("`r`n","`n")+"`n"),[Text.UTF8Encoding]::new($false))
    if($Functional){
        # STOP: only explicitly invoke -Functional after root has reviewed and
        # admitted this actual source, artifacts and complete command profile.
        $functionalExecuted=$true
        function Observe([string]$name,[string]$kind,[string]$path,[string]$pin,[long]$bytes,[string]$control=''){
            $probeArguments=@('--diagnostic-read-only',$kind,$path,$pin,$bytes.ToString([Globalization.CultureInfo]::InvariantCulture));if($control){$probeArguments+=$control}
            $row=Step $name $probe $probeArguments
            $p=$row.stdout|ConvertFrom-Json
            Require ($p.result -ceq 'trust_subject_observation' -and $p.ownersClosed -and -not $p.authorizesExecution -and (Selected-OutcomeAllowed $p.nativeStatus $p.completion)) 'Functional frame, native status, outcome or close refused or uncertain'
            $p
        }
        foreach($entry in @(@('msi',$msi,$msiPin,1327104),@('pe',$pe,$pePin,2753944),@('pe-v2',$pe,$pePin,2753944))){
            $p=Observe ('positive-'+$entry[0]) $entry[0] $entry[1] $entry[2] $entry[3]
            Require ($p.nativeStatus -eq 0 -and $p.completion -eq 2 -and $p.observedMask -eq 8191 -and $p.failedMask -eq 0) 'Actual selected policy not satisfied'
        }
        foreach($control in @('file-id','volume','path')){$p=Observe ('wrong-'+$control) 'msi' $msi $msiPin 1327104 $control;Require ($p.completion -eq 1) 'Wrong identity/path accepted'}
        $p=Observe 'wrong-pin' 'msi' $msi ('0'*64) 1327104;Require ($p.completion -eq 1) 'Wrong pin accepted'
        $p=Observe 'wrong-size' 'msi' $msi $msiPin 1327103;Require ($p.completion -eq 1) 'Wrong size accepted'
        $p=Observe 'pe-as-msi' 'msi' $pe $pePin 2753944;Require ($p.completion -eq 1) 'Wrong kind accepted'
        $copies=[Collections.Generic.List[string]]::new()
        for($i=0;$i -lt 3;$i++){
            $bytes=[IO.File]::ReadAllBytes($msi);$bytes[$offsets[$i]]=$bytes[$offsets[$i]] -bxor 1
            $destination=Join-Path $run ('owned-negative-'+$i+'.msi')
            $stream=[IO.FileStream]::new($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
            $copies.Add($destination);$pin=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            Require ($pin -ceq $planned.mutations[$i].expectedFixtureSha256) 'Generated fixture bytes differ from reviewed profile'
            $p=Observe ('mutated-'+$planned.offsetKinds[$i]) 'msi' $destination $pin $bytes.Length
            Require ($p.completion -eq 1 -and ($p.observedMask -band 1) -eq 1) 'Mutated subject accepted or pin failure hid control'
            if($i -eq 0 -or $i -eq 1){Require ($p.winTrustCalls -eq 2 -and $p.winTrustResult -ne 0) 'Payload or primary signature mutation did not reach actual WVT refusal'}
            if($i -eq 2){Require ($p.timestampCalls -eq 1 -and ($p.failedMask -band 4) -eq 4) 'Timestamp mutation did not fail actual timestamp predicate'}
        }
        $ab=Step 'provider-good-handle-bad-path' $probe @('--provider-control',$msi,$copies[0],$msi)
        $a=$ab.stdout|ConvertFrom-Json
        Require ($a.result -ceq 'provider_object_consumption_observation' -and $a.ownersClosed -and $a.winTrustCloseResult -eq 0 -and -not $a.selectedCompletion -and -not $a.authorizesExecution -and $a.winTrustResult -eq 0 -and $a.providerMatchesReferenceCms) 'Provider A unsupported, inconsistent or uncertain; stop before B'
        $ba=Step 'provider-bad-handle-good-path' $probe @('--provider-control',$copies[0],$msi,$msi)
        $b=$ba.stdout|ConvertFrom-Json
        Require ($b.result -ceq 'provider_object_consumption_observation' -and $b.ownersClosed -and $b.winTrustCloseResult -eq 0 -and -not $b.selectedCompletion -and -not $b.authorizesExecution -and $b.winTrustResult -ne 0) 'Provider B unsupported, inconsistent or uncertain'
    }
    $after=Hashes;Require (($before|ConvertTo-Json -Compress) -ceq ($after|ConvertTo-Json -Compress)) 'Source changed during verification'
    Require ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $msiPin -and (Get-FileHash -LiteralPath $pe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $pePin) 'Original data changed'
    Require ((& git.exe -C $repo rev-parse HEAD).Trim() -ceq $head) 'Source head changed'
}catch{$failure=$_.Exception.Message}
finally{
    $watch.Stop()
    $receipt=[ordered]@{schemaVersion='native-msi-subject-source-verification/1';result=$(if($failure){'failed'}elseif($Functional){'functional_observations_only'}else{'source_pure_only_pass'});head=$head;cwd=$PSScriptRoot;durationMs=$watch.ElapsedMilliseconds;exitCode=$(if($failure){1}else{0});failure=$failure;commands=$records;sourceBefore=$before;sourceAfter=$after;legacyPureCases=75;pureCases=$pureCount;newPureHeaderLayoutVectors=14;guardPureCases=$guardPureCases;abiChildren=8;functionalExecuted=$functionalExecuted;functionalProfileAdmissionGrantedByThisReceipt=$false;completeQualificationProfile=$false;pendingControls=$pendingControls;images=$images;installedAuthority=$false;helperMissingCleared=$false;outputsRetained=$true}
    $receiptPath=Join-Path $run 'verification-receipt.json'
    [IO.File]::WriteAllText($receiptPath,(($receipt|ConvertTo-Json -Depth 14).Replace("`r`n","`n")+"`n"),[Text.UTF8Encoding]::new($false))
}
Write-Output ([ordered]@{result=$receipt.result;receipt=$receiptPath;functionalExecuted=$functionalExecuted;failure=$failure}|ConvertTo-Json -Compress)
if($failure){exit 1}
