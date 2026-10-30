[CmdletBinding()]
param([switch]$CrashAfterStage,[switch]$CrashAfterRemoval,[switch]$NoRestore)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows) { throw 'native_windows_required' }
if ($CrashAfterStage -and $CrashAfterRemoval) { throw 'mutually_exclusive_faults' }
if (-not $env:WINDIR) { $env:WINDIR=$env:SystemRoot }
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$artifact=Join-Path $repo 'artifacts\windows-coordinator-git-selected-transition'
[IO.Directory]::CreateDirectory($artifact) | Out-Null
$git='C:\Program Files\Git\bin\git.exe'
$expectedGitSha='3b64043b9e4dc225225f43ff9c1173b57493ff72e5b729accfae051eb160cca3'
if ($env:GITHUB_ACTIONS -ceq 'true' -and $env:ImageOS -cne 'win22') {
    throw 'hosted_git_fixture_runner_not_windows_2022'
}
if (-not [IO.File]::Exists($git) -or
    ([IO.File]::GetAttributes($git) -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'fixed_hosted_git_image_missing_or_reparse'
}
$gitHold=[IO.File]::Open($git,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
if($gitHold.Length -ne 44872) { throw 'fixed_hosted_git_image_size_mismatch' }
$gitSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($gitHold)).ToLowerInvariant()
$gitHold.Position=0
if($gitSha -cne $expectedGitSha) { throw 'fixed_hosted_git_image_digest_mismatch' }
$dotnet=(Get-Command dotnet.exe -ErrorAction Stop).Source
$parent=[IO.Path]::GetFullPath((Join-Path $repo 'services\windows-coordinator-git\tmp')).TrimEnd('\')
[IO.Directory]::CreateDirectory($parent) | Out-Null
if((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'fixture_parent_reparse'
}
$nonce=[guid]::NewGuid().ToString('N')
$root=Join-Path $parent "import-$nonce"
if(Test-Path -LiteralPath $root) { throw 'fixture_root_occupied' }
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root '.fixture-marker'),$nonce,[Text.UTF8Encoding]::new($false))
Add-Type -Path (Join-Path $repo 'services\windows-coordinator-git\VerifierBoundedProcess.cs') -ErrorAction Stop
$records=[Collections.Generic.List[object]]::new()
$started=[DateTimeOffset]::UtcNow.ToString('O')
$watch=[Diagnostics.Stopwatch]::StartNew()
$result='failed'; $errorText=$null; $cleaned=$false
$stageResult=$null; $publishResult=$null; $before=$null; $afterStage=$null; $afterPublish=$null; $afterRemove=$null; $dirtyRefusal=$null
$sameMirrorPreserved=$false; $foreignPreserved=$false; $sameMirrorRefusal=$null; $sourceHead=$null; $sourceHeadError=$null; $negative=$null; $markerRefusal=$null; $foreignRefusal=$null; $pin=$null; $bundleSha=$null; $imageSha=$null; $normalRefused=$false; $officialFixturePassed=$false
function Require([bool]$value,[string]$message) { if(-not $value) { throw $message } }
function Invoke-Bounded([string]$phase,[string]$executable,[string]$cwd,[string[]]$argv,
    [int[]]$accepted,[int]$timeoutMs=120000) {
    $start=[Diagnostics.ProcessStartInfo]::new($executable)
    $start.WorkingDirectory=$cwd; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    foreach($arg in $argv) { [void]$start.ArgumentList.Add($arg) }
    $start.Environment['GIT_CONFIG_NOSYSTEM']='1'
    $start.Environment['GIT_CONFIG_GLOBAL']='NUL'
    $start.Environment['GIT_ATTR_NOSYSTEM']='1'
    $start.Environment['GIT_TEMPLATE_DIR']=(Join-Path $root 'template')
    $start.Environment['GIT_TERMINAL_PROMPT']='0'
    $run=[GraphGitVerifierProcess]::Run($start,$timeoutMs,65536,32768)
    $stdout=$run.Stdout
    $stderr=$run.Stderr
    $record=[ordered]@{ phase=$phase; executable=$executable; cwd=$cwd; argv=$argv
      durationMs=$run.DurationMs; exitCode=$run.ExitCode; outcome=$run.Outcome.ToString()
      totalOutputBytes=$run.TotalOutputBytes; captureTruncated=$run.CaptureTruncated
      stdoutSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($stdout))).ToLowerInvariant()
      stderrSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($stderr))).ToLowerInvariant()
      stdoutTail=if($stdout.Length -le 512){$stdout}else{$stdout.Substring($stdout.Length-512)}
      stderrTail=if($stderr.Length -le 512){$stderr}else{$stderr.Substring($stderr.Length-512)} }
    [void]$records.Add($record)
    Require ($run.Outcome.ToString() -ceq 'Exited' -and -not $run.CaptureTruncated -and
        $run.ExitCode -in $accepted) "child_failed:$phase exit=$($run.ExitCode) outcome=$($run.Outcome) stderr=$($record.stderrTail)"
    $stdout
}
function Git([string]$phase,[string]$cwd,[string[]]$argv) {
    Invoke-Bounded $phase $git $cwd (@('-C',$cwd)+$argv) @(0)
}
function Fixture([string]$phase,[string[]]$argv,[int[]]$accepted) {
    Invoke-Bounded $phase $fixtureImage $root $argv $accepted
}
try {
    foreach($leaf in @('hooks','template','home','tmp','final','source','fixture-publish')) {
        [IO.Directory]::CreateDirectory((Join-Path $root $leaf)) | Out-Null
    }
    $official=Join-Path $repo 'services\windows-coordinator-git\LexRunner.WindowsCoordinator.Git.csproj'
    $fixtureProject=Join-Path $repo 'services\windows-coordinator-git\selected-transition-fixture\SelectedTransitionFixture.csproj'
    $normalOut=Join-Path $root 'normal-publish'
    $officialFixtureOut=Join-Path $root 'fixture-official-publish'
    $fixtureOut=Join-Path $root 'fixture-publish'
    $restoreOption=if($NoRestore){@('--no-restore')}else{@()}
    $null=Invoke-Bounded 'official-normal-build' $dotnet $repo (@('publish',$official)+$restoreOption+@('-c','Release','-r','win-x64','-p:NuGetAudit=false','-p:GitImportFixture=false','-o',$normalOut,'-v:q')) @(0) 600000
    $null=Invoke-Bounded 'official-fixture-build' $dotnet $repo (@('publish',$official)+$restoreOption+@('-c','Release','-r','win-x64','-p:NuGetAudit=false','-p:GitImportFixture=true','-o',$officialFixtureOut,'-v:q')) @(0) 600000
    $null=Invoke-Bounded 'selected-fixture-build' $dotnet $repo (@('publish',$fixtureProject)+$restoreOption+@('-c','Release','-r','win-x64','-p:NuGetAudit=false','-p:HostedGit2022Fixture=true','-o',$fixtureOut,'-v:q')) @(0) 600000
    $normalImage=Join-Path $normalOut 'LexRunner.WindowsCoordinator.Git.exe'
    $officialFixtureImage=Join-Path $officialFixtureOut 'LexRunner.WindowsCoordinator.Git.exe'
    $fixtureImage=Join-Path $fixtureOut 'SelectedTransitionFixture.exe'
    foreach($required in @($normalImage,$officialFixtureImage,$fixtureImage)) { Require ([IO.File]::Exists($required)) "published_image_missing:$required" }
    $normal=Invoke-Bounded 'normal-entrypoint-refusal' $normalImage $root @('--fixture-graph-parser-selftest') @(2)
    $normalRefused=([string]$normal).Trim().Length -eq 0 -and $records[$records.Count-1].stderrTail.Trim() -ceq 'no_production_git_entrypoint'
    $officialFixture=Invoke-Bounded 'official-fixture-parser' $officialFixtureImage $root @('--fixture-graph-parser-selftest') @(0)
    $officialFixturePassed=$officialFixture.Trim() -ceq 'graph_parser_selftest_pass'
    Require ($normalRefused -and $officialFixturePassed) 'official_image_route_incorrect'
    $profile=Invoke-Bounded 'selected-hosted-profile-selftest' $fixtureImage $root @('--hosted-profile-selftest') @(0) 10000
    Require ($profile.Trim() -ceq 'hosted_profile_source_selftest_pass') 'selected_hosted_profile_selftest_failed'
    $imageSha=(Get-FileHash -LiteralPath $fixtureImage -Algorithm SHA256).Hash.ToLowerInvariant()
    $source=Join-Path $root 'source'
    [IO.File]::WriteAllText((Join-Path $source 'README.txt'),"bounded fixture`n",[Text.UTF8Encoding]::new($false))
    $null=Git 'source-init' $source @('init','--initial-branch=main')
    $null=Git 'source-user-name' $source @('config','user.name','LexRunner fixture')
    $null=Git 'source-user-email' $source @('config','user.email','fixture@example.invalid')
    $null=Git 'source-add' $source @('add','README.txt')
    $null=Git 'source-commit' $source @('-c',("core.hooksPath="+(Join-Path $root 'hooks')),'commit','-m','fixture')
    $pin=(Git 'source-pin' $source @('rev-parse','HEAD')).Trim()
    Require ($pin -match '^[0-9a-f]{40}$') 'pin_invalid'
    $bundle=Join-Path $root 'source.bundle'
    $null=Git 'source-bundle' $source @('bundle','create',$bundle,'refs/heads/main')
    $bundleSha=(Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
    $slot=[ordered]@{ Root=$root; Bundle=$bundle; Mirror=(Join-Path $root 'mirror')
      EmptyHooks=(Join-Path $root 'hooks'); EmptyTemplate=(Join-Path $root 'template')
      Home=(Join-Path $root 'home'); Temp=(Join-Path $root 'tmp')
      PinnedCommit=$pin; ExpectedBundleSha256=$bundleSha }
    $slotFile=Join-Path $root 'slot.json'
    [IO.File]::WriteAllText($slotFile,($slot | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    $import=(Fixture 'mirror-import' @('--import',$slotFile) @(0) | ConvertFrom-Json)
    Require ($import.Imported -eq $true -and $import.UnknownEffects -eq $true) 'mirror_import_not_uncertain_success'
    [IO.Directory]::CreateDirectory((Join-Path $root 'mirror\worktrees')) | Out-Null
    $selection=Join-Path $root 'selection.json'
    $null=Fixture 'selected-roots' @('--select',$slotFile,(Join-Path $root 'final'),$selection) @(0)
    $markerFile=Join-Path $root '.fixture-marker'
    [IO.File]::WriteAllText($markerFile,('0'*32),[Text.UTF8Encoding]::new($false))
    $markerRefusal=Fixture 'wrong-nonce-marker-refuses-stage' @('--stage',$slotFile,$selection,'marker-negative') @(1) | ConvertFrom-Json
    Require ($markerRefusal.Disposition -ceq 'selected_stage_refused_before_git' -and -not (Test-Path -LiteralPath (Join-Path $root 'marker-negative'))) 'marker_refusal_failed'
    [IO.File]::WriteAllText($markerFile,$nonce,[Text.UTF8Encoding]::new($false))
    $foreign=Join-Path $root 'final\foreign'
    $null=Git 'source-foreign-linked-worktree' $source @('worktree','add','--no-checkout','--detach',$foreign,$pin)
    $issuedFile=Join-Path $root 'issued-publish-result.json'
    $foreignRefusal=Fixture 'foreign-real-worktree-without-issued-row-refused' @('--remove',$slotFile,$selection,$issuedFile,'s1','foreign') @(3)
    Require ((Test-Path -LiteralPath $foreign) -and $records[$records.Count-1].stderrTail.Contains('FileNotFoundException')) 'foreign_real_worktree_removed'
    $foreignPreserved=$true
    Require (([IO.File]::ReadAllText($markerFile)) -ceq $nonce -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($foreign)) -ieq (Join-Path $root 'final')) 'foreign_fixture_cleanup_scope_invalid'
    $null=Git 'source-foreign-worktree-cleanup' $source @('worktree','remove','--force',$foreign)
    Require (-not (Test-Path -LiteralPath $foreign)) 'foreign_fixture_cleanup_incomplete'
    $before=Fixture 'observe-before-stage' @('--observe',$slotFile,$selection,'s1','f1') @(0) | ConvertFrom-Json
    Require ($before.Disposition -ceq 'absent_or_unlisted_unresolved' -and
      $before.UnknownEffects -eq $true -and $before.AuthorizesContinuation -eq $false) 'before_stage_claimed_authority'
    $tampered=Join-Path $root 'tampered-selection.json'
    $bad=Get-Content -LiteralPath $selection -Raw | ConvertFrom-Json
    $bad.mirror.file_id='00000000000000000000000000000000'
    [IO.File]::WriteAllText($tampered,($bad | ConvertTo-Json -Compress -Depth 8),[Text.UTF8Encoding]::new($false))
    $negative=Fixture 'wrong-held-mirror-refusal' @('--stage',$slotFile,$tampered,'s2') @(1) | ConvertFrom-Json
    Require ($negative.Disposition -ceq 'selected_stage_refused_before_git' -and
      -not (Test-Path -LiteralPath (Join-Path $root 's2'))) 'tampered_selection_effect'
    if ($CrashAfterStage) {
      $lost=Fixture 'abrupt-exit-after-stage-effect' @('--stage-exit-after-effect',$slotFile,$selection,'s1') @(73)
      Require ([string]::IsNullOrEmpty($lost)) 'crash_fixture_sent_reply'
    } else {
      $stageResult=Fixture 'selected-stage' @('--stage',$slotFile,$selection,'s1') @(0) | ConvertFrom-Json
      Require ($stageResult.Staged -eq $true -and $stageResult.StageIdentity -and
        $stageResult.UnknownEffects -eq $true -and $stageResult.AuthorizesExecution -eq $false) 'stage_result_invalid'
    }
    # Restart-style observation occurs before the result is persisted to a
    # stage-identity file. It cannot authorize another effect from a fresh name.
    $afterStage=Fixture 'observe-after-lost-stage-reply' @('--observe',$slotFile,$selection,'s1','f1') @(0) | ConvertFrom-Json
    Require ($afterStage.Disposition -ceq 'stage_observed_unresolved' -and
      $afterStage.AuthorizesContinuation -eq $false -and
      $afterStage.UnknownEffects -eq $true) 'stage_recovery_claimed_authority'
    $sameMirrorForeign=Join-Path $root 'final\same-mirror-foreign'
    $null=Git 'same-mirror-foreign-linked-worktree' (Join-Path $root 'mirror') @('worktree','add','--no-checkout','--detach',$sameMirrorForeign,$pin)
    $missingIssuedRefusal=Fixture 'same-mirror-without-issued-row-refused' @('--remove',$slotFile,$selection,$issuedFile,'s1','same-mirror-foreign') @(3)
    Require ((Test-Path -LiteralPath $sameMirrorForeign) -and $records[$records.Count-1].stderrTail.Contains('FileNotFoundException')) 'same_mirror_foreign_removed'
    $sameMirrorPreserved=$true
    Require ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($sameMirrorForeign)) -ieq (Join-Path $root 'final') -and [IO.File]::ReadAllText($markerFile) -ceq $nonce) 'same_mirror_cleanup_scope_invalid'
    $null=Git 'same-mirror-foreign-cleanup' (Join-Path $root 'mirror') @('worktree','remove','--force',$sameMirrorForeign)
    Require (-not (Test-Path -LiteralPath $sameMirrorForeign)) 'same_mirror_cleanup_incomplete'
    if(-not $CrashAfterStage) {
      $stageFile=Join-Path $root 'durable-stage-result.json'
      [IO.File]::WriteAllText($stageFile,($stageResult | ConvertTo-Json -Compress -Depth 12),[Text.UTF8Encoding]::new($false))
      $publishResult=Fixture 'selected-publish' @('--publish',$slotFile,$selection,$stageFile,'s1','f1') @(0) | ConvertFrom-Json
      Require ($publishResult.Published -eq $true -and $publishResult.FinalIdentity -and
        $publishResult.UnknownEffects -eq $true -and $publishResult.AuthorizesExecution -eq $false) 'publish_result_invalid'
      $afterPublish=Fixture 'observe-after-lost-publish-reply' @('--observe',$slotFile,$selection,'s1','f1') @(0) | ConvertFrom-Json
      Require ($afterPublish.Disposition -ceq 'final_observed_unresolved' -and
        $afterPublish.AuthorizesContinuation -eq $false) 'publish_recovery_claimed_authority'
    }
    if(-not $CrashAfterStage) {
      $publishFile=Join-Path $root 'issued-publish-result.json'
      Require ([IO.File]::Exists($publishFile)) 'fixture_publish_did_not_issue_durable_row'
      $issued=Get-Content -LiteralPath $publishFile -Raw | ConvertFrom-Json
      Require ($issued.Published -eq $true -and $issued.FinalIdentity.path -ceq $publishResult.FinalIdentity.path) 'issued_row_mismatch'
      $sameMirrorForeign=Join-Path $root 'final\same-mirror-foreign'
      $null=Git 'same-mirror-foreign-after-publish' (Join-Path $root 'mirror') @('worktree','add','--no-checkout','--detach',$sameMirrorForeign,$pin)
      $sameMirrorRefusal=Fixture 'same-mirror-with-wrong-issued-identity-refused' @('--remove',$slotFile,$selection,$publishFile,'s1','same-mirror-foreign') @(1) | ConvertFrom-Json
      Require ($sameMirrorRefusal.Disposition -ceq 'selected_remove_refused_before_git_effect' -and $sameMirrorRefusal.Commands.Count -eq 0 -and (Test-Path -LiteralPath $sameMirrorForeign)) 'same_mirror_wrong_issued_identity_removed'
      Require ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($sameMirrorForeign)) -ieq (Join-Path $root 'final') -and [IO.File]::ReadAllText($markerFile) -ceq $nonce) 'same_mirror_cleanup_scope_invalid'
      $null=Git 'same-mirror-foreign-after-publish-cleanup' (Join-Path $root 'mirror') @('worktree','remove','--force',$sameMirrorForeign)
      Require (-not (Test-Path -LiteralPath $sameMirrorForeign)) 'same_mirror_cleanup_incomplete'
      $dirty=Join-Path $root 'final\f1\untracked.txt'
      [IO.File]::WriteAllText($dirty,'preserve fixture content',[Text.UTF8Encoding]::new($false))
      $dirtyRefusal=Fixture 'dirty-final-refused-before-remove' @('--remove',$slotFile,$selection,$publishFile,'s1','f1') @(1) | ConvertFrom-Json
      Require ($dirtyRefusal.Disposition -ceq 'selected_remove_refused_before_git_effect' -and
        (Test-Path -LiteralPath $dirty) -and $dirtyRefusal.UnknownEffects -eq $true) 'dirty_content_not_preserved'
      Remove-Item -LiteralPath $dirty -Force
      if($CrashAfterRemoval) {
        $lostRemove=Fixture 'abrupt-exit-after-remove-effect' @('--remove-exit-after-effect',$slotFile,$selection,$publishFile,'s1','f1') @(74)
        Require ([string]::IsNullOrEmpty($lostRemove)) 'removal_crash_fixture_sent_reply'
      } else {
        $removeResult=Fixture 'selected-remove-once' @('--remove',$slotFile,$selection,$publishFile,'s1','f1') @(0) | ConvertFrom-Json
        Require ($removeResult.Removed -eq $true -and $removeResult.UnknownEffects -eq $true -and
          $removeResult.AuthorizesExecution -eq $false) 'selected_remove_result_invalid'
      }
      $afterRemove=Fixture 'observe-after-lost-removal-reply' @('--observe',$slotFile,$selection,'s1','f1') @(0) | ConvertFrom-Json
      Require ($afterRemove.Disposition -ceq 'absent_or_unlisted_unresolved' -and
        $afterRemove.AuthorizesContinuation -eq $false) 'removal_recovery_claimed_authority'
    }
    $leaf=if(-not $CrashAfterStage){Join-Path $root 'final\f1'}else{Join-Path $root 's1'}
    if(-not $CrashAfterStage) {
      Require (-not (Test-Path -LiteralPath $leaf)) 'native_remove_leaf_present'
    } else {
      $entries=@(Get-ChildItem -LiteralPath $leaf -Force)
      Require ($entries.Count -eq 1 -and $entries[0].Name -ceq '.git' -and
        -not ($entries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) 'cleanup_leaf_not_only_git_pointer'
      $null=Git 'fixture-only-worktree-cleanup' (Join-Path $root 'mirror') @('worktree','remove','--force',$leaf)
      Require (-not (Test-Path -LiteralPath $leaf)) 'git_cleanup_leaf_present'
    }
    $rootFull=[IO.Path]::GetFullPath($root).TrimEnd('\')
    Require ($rootFull.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetDirectoryName($rootFull) -ieq $parent -and
      [IO.File]::ReadAllText((Join-Path $rootFull '.fixture-marker')) -ceq $nonce) 'cleanup_root_not_owned'
    $stack=[Collections.Generic.Stack[string]]::new(); $stack.Push($rootFull)
    while($stack.Count -gt 0) {
      foreach($entry in @(Get-ChildItem -LiteralPath ($stack.Pop()) -Force)) {
        Require (-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
          $entry.FullName.StartsWith($rootFull+'\',[StringComparison]::OrdinalIgnoreCase)) 'cleanup_descendant_redirected'
        if($entry.PSIsContainer) { $stack.Push($entry.FullName) }
      }
    }
    Remove-Item -LiteralPath $rootFull -Recurse -Force
    $cleaned=-not (Test-Path -LiteralPath $rootFull)
    Require $cleaned 'cleanup_unconfirmed'
    $gitHold.Position=0
    Require ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($gitHold)).ToLowerInvariant() -ceq $expectedGitSha) 'fixed_hosted_git_image_changed'
    $result='passed'
} catch { $errorText=$_.Exception.GetType().Name+':'+$_.Exception.Message }
try {
    $sourceHead=(Git 'source-head-readback' $repo @('rev-parse','--verify','HEAD')).Trim()
    Require ($sourceHead -match '^[0-9a-f]{40}$') 'source_head_invalid'
} catch {
    $sourceHeadError=$_.Exception.GetType().Name+':'+$_.Exception.Message
    if($result -ceq 'passed') { $result='failed'; $errorText='source_head_readback_failed' }
}
$watch.Stop()
$receipt=[ordered]@{ schemaVersion='windows-git-view-transition-source/1'; drive=[IO.Path]::GetPathRoot($root).Substring(0,1)
  result=$result; error=$errorText; crashAfterStage=[bool]$CrashAfterStage; crashAfterRemoval=[bool]$CrashAfterRemoval; sourceHead=$sourceHead; sourceHeadError=$sourceHeadError
  cwd=$repo; command="pwsh -NoLogo -NoProfile -File $PSCommandPath -CrashAfterStage:$CrashAfterStage -CrashAfterRemoval:$CrashAfterRemoval -NoRestore:$NoRestore"
  startedAt=$started; durationMs=$watch.ElapsedMilliseconds; exitCode=if($result -ceq 'passed'){0}else{1}
  fixtureRoot=$root; fixtureRemoved=$cleaned; fixedGitImage=$git; fixedGitSha256=$gitSha
  fixedGitRootImagePinned=$true; gitExecPathSelected=$false; loaderGraphQualified=$false
  fixtureImageSha256=$imageSha; pin=$pin; bundleSha256=$bundleSha
  observations=[ordered]@{ before=${before}?.Disposition; stage=${afterStage}?.Disposition
    published=${afterPublish}?.Disposition; removed=${afterRemove}?.Disposition; dirtyRefusal=${dirtyRefusal}?.Disposition; wrongSelection=${negative}?.Disposition; wrongMarker=${markerRefusal}?.Disposition; foreignWorktreePreserved=$foreignPreserved; sameMirrorWorktreePreserved=$sameMirrorPreserved; sameMirrorWorktree=${sameMirrorRefusal}?.Disposition; normalRefused=$normalRefused; officialFixturePassed=$officialFixturePassed
    stageResultDurableBeforeRecovery=$false; removalRoute='fixture_only_no_installed_authority' }
  commands=$records
  authorizesExecution=$false; installedCrossAccountProof=$false }
$receiptFile=Join-Path $artifact "receipt-$nonce.json"
[IO.File]::WriteAllText($receiptFile,($receipt|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
$gitHold.Dispose()
[pscustomobject]@{ result=$result; error=$errorText; drive=[IO.Path]::GetPathRoot($root).Substring(0,1); receipt=$receiptFile
  durationMs=$watch.ElapsedMilliseconds; fixtureRemoved=$cleaned
  observations=$receipt.observations } | ConvertTo-Json -Depth 5
if($result -cne 'passed') { exit 1 }
