param([string]$RuntimeBinary=(Join-Path $PSScriptRoot 'target/release/mcphub-runtime-service.exe'))
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows'){
  throw 'Tray service control acceptance requires disposable GitHub-hosted Windows.'
}
$name='MCPHub-Tray-Control-'+[Guid]::NewGuid().ToString('N')
$root=Join-Path $env:RUNNER_TEMP $name
$binary=(Resolve-Path -LiteralPath $RuntimeBinary).Path
$created=$false
$oldFixture=$env:MCPHUB_TRAY_CONTROL_TEST_SERVICE
try{
  New-Item -ItemType Directory -Path $root | Out-Null
  $test=Join-Path $root 'tray-service-control-tests.exe'
  $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  $vs=& $vswhere -latest -products * -property installationPath
  $dev=Join-Path $vs 'Common7/Tools/VsDevCmd.bat'
  $rust=Join-Path $env:USERPROFILE '.cargo/bin/rustc.exe'
  $source=Join-Path $PSScriptRoot 'tests/tray_service_control.rs'
  & cmd.exe /d /c "call `"$dev`" -arch=x64 >nul && `"$rust`" --edition 2021 --test `"$source`" -o `"$test`""
  if($LASTEXITCODE -ne 0){throw 'Cannot compile real SCM control acceptance.'}
  $command='"'+$binary+'" --service-name "'+$name+'" --pipe-name "'+$name+'" --no-gateway --data-dir "'+$root+'" --secret-dir "'+(Join-Path $root 'secrets')+'"'
  $registration=New-Service -Name $name -BinaryPathName $command -StartupType Manual
  $created=$true; $registration.Dispose()
  Start-Service -Name $name
  $env:MCPHUB_TRAY_CONTROL_TEST_SERVICE=$name
  & $test --exact explicit_fixture_service_stops_starts_and_restarts_idempotently --nocapture
  if($LASTEXITCODE -ne 0){throw 'Real tray service control acceptance failed.'}
}finally{
  $env:MCPHUB_TRAY_CONTROL_TEST_SERVICE=$oldFixture
  if($created){
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    & sc.exe delete $name | Out-Null
    if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'Owned SCM fixture remains.'}
  }
  if(Test-Path -LiteralPath $root){
    $resolved=(Resolve-Path -LiteralPath $root).Path
    $parent=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
    if($resolved -ne $root -or -not $resolved.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -or
      ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe fixture cleanup target.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if(Test-Path -LiteralPath $resolved){throw 'Owned fixture directory remains.'}
  }
}
