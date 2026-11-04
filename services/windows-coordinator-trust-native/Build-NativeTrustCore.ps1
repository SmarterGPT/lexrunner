[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory,
      [Parameter(Mandatory)][string]$ServiceArtifactRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:OS){$env:OS='Windows_NT'}
if(-not $env:WINDIR){$env:WINDIR=$env:SystemRoot}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$allowed=[IO.Path]::GetFullPath((Join-Path $repo 'artifacts'))+[IO.Path]::DirectorySeparatorChar
$out=[IO.Path]::GetFullPath($OutputDirectory)
$serviceOut=[IO.Path]::GetFullPath($ServiceArtifactRoot)
foreach($path in @($out,$serviceOut)) {
    if(-not $path.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or $path.IndexOfAny([char[]]"`"`r`n") -ge 0) {
        throw 'native_build_output_outside_artifacts'
    }
}
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$install=& $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if($LASTEXITCODE -ne 0 -or @($install).Count -ne 1 -or [string]::IsNullOrWhiteSpace($install)){throw 'qualified_msvc17_unavailable'}
$dev=Join-Path $install 'Common7/Tools/VsDevCmd.bat'
if(-not(Test-Path -LiteralPath $dev -PathType Leaf)){throw 'native_developer_environment_missing'}
if($dev.IndexOfAny([char[]]"`"`r`n") -ge 0){throw 'native_developer_path_invalid'}
[IO.Directory]::CreateDirectory($out)|Out-Null
[IO.Directory]::CreateDirectory($serviceOut)|Out-Null
$lib=Join-Path $out 'LexRunner.TrustSdkCore.lib'
$sdk=Join-Path $PSScriptRoot 'HeldTrustSdkCore.cpp'
$policy=Join-Path $PSScriptRoot 'SelectedTrustPolicy.cpp'
$pure=Join-Path $out 'trust-core-pure.exe'
$cmd=Join-Path $out 'compile-native.cmd'
$lines=@('@echo off',('call "'+$dev+'" -no_logo -host_arch=x64 -arch=x64'),'if errorlevel 1 exit /b %errorlevel%',
    ('cl.exe /nologo /std:c++20 /EHsc /W4 /WX /MT /O2 /guard:cf /DUNICODE /D_UNICODE /c "'+$sdk+'" /Fo:"'+(Join-Path $out 'sdk-core.obj')+'"'),
    'if errorlevel 1 exit /b %errorlevel%',
    ('cl.exe /nologo /std:c++20 /EHsc /W4 /WX /MT /O2 /guard:cf /DUNICODE /D_UNICODE /c "'+$policy+'" /Fo:"'+(Join-Path $out 'selected-policy.obj')+'"'),
    'if errorlevel 1 exit /b %errorlevel%',
    ('lib.exe /nologo /out:"'+$lib+'" "'+(Join-Path $out 'sdk-core.obj')+'" "'+(Join-Path $out 'selected-policy.obj')+'"'),
    'if errorlevel 1 exit /b %errorlevel%',
    ('cl.exe /nologo /std:c++20 /EHsc /W4 /WX /MT /O2 /guard:cf /DUNICODE /D_UNICODE "'+(Join-Path $PSScriptRoot 'TrustCorePureTests.cpp')+'" "'+$lib+'" /Fe:"'+$pure+'" /Fo:"'+(Join-Path $out 'pure-tests.obj')+'" /link bcrypt.lib crypt32.lib wintrust.lib /DEPENDENTLOADFLAG:0x800 /DYNAMICBASE /NXCOMPAT /guard:cf'),
    'exit /b %errorlevel%')
[IO.File]::WriteAllText($cmd,($lines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
$clock=[Diagnostics.Stopwatch]::StartNew();$began=[DateTimeOffset]::UtcNow.ToString('o')
$output=& cmd.exe /d /c $cmd 2>&1
$code=$LASTEXITCODE;$clock.Stop()
$source=@{};foreach($name in @('HeldTrustSdkCore.h','HeldTrustSdkCore.cpp','SelectedTrustAbi.h','SelectedTrustPolicy.h','SelectedTrustPolicy.cpp','Build-NativeTrustCore.ps1','TrustCorePureTests.cpp')) {
    $source[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()
}
$record=[ordered]@{command=@('cmd.exe','/d','/c',$cmd);cwd=$PWD.Path;startedUtc=$began;durationMs=$clock.ElapsedMilliseconds;
    exitCode=$code;sourceSha256=$source;toolchain='MSVC17 x64 /W4 /WX /MT';boundedOutput=($output -join "`n");nativeFunctionalExecution=$false}
[IO.File]::WriteAllText((Join-Path $out 'build-receipt.json'),(($record|ConvertTo-Json -Depth 6).Replace("`r`n","`n")+"`n"),[Text.UTF8Encoding]::new($false))
if($code -ne 0){throw ('native_trust_compile_failed:'+(($output|Select-Object -Last 8) -join ' | '))}
$project=Join-Path $repo 'services/windows-coordinator-service/LexRunner.WindowsCoordinator.Service.csproj'
foreach($mode in @('normal','fixture')) {
    $fixture=if($mode -eq 'fixture'){'true'}else{'false'}
    $dest=Join-Path $serviceOut $(if($mode -eq 'normal'){'publish'}else{'fixture'})
    $obj=Join-Path $serviceOut ($mode+'-obj')
    $objArgument=$obj.Replace('\','/')+'/'
    $binArgument=(Join-Path $serviceOut ($mode+'-bin')).Replace('\','/')+'/'
    $publish=@('@echo off',('call "'+$dev+'" -no_logo -host_arch=x64 -arch=x64'),'if errorlevel 1 exit /b %errorlevel%',
        ('dotnet publish "'+$project+'" -c Release -r win-x64 -p:IlcUseEnvironmentalTools=true -p:IlcGenerateMapFile=true -p:CoordinatorServiceFixtureTests='+$fixture+
        ' "-p:CoordinatorTrustNativeLibrary='+$lib+'" "-p:BaseIntermediateOutputPath='+$objArgument+'" "-p:BaseOutputPath='+$binArgument+'" -o "'+$dest+'"'),
        'exit /b %errorlevel%')
    [IO.File]::WriteAllText((Join-Path $out ('publish-'+$mode+'.cmd')),($publish -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{pureImage=$pure;library=$lib;sha256=(Get-FileHash -LiteralPath $lib).Hash.ToLowerInvariant();
    normalPublishScript=(Join-Path $out 'publish-normal.cmd');fixturePublishScript=(Join-Path $out 'publish-fixture.cmd');
    buildReceipt=(Join-Path $out 'build-receipt.json')}
