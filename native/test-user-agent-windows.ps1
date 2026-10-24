param([string]$RuntimeBinary=(Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe'))
$ErrorActionPreference='Stop'
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
if($session -eq 0){throw 'User agent acceptance requires a signed-in user session.'}
$pipe='mcphub-user-test-'+[Guid]::NewGuid().ToString('N')
$oldPipe=$env:MCPHUB_NATIVE_USER_PIPE;$oldSession=$env:MCPHUB_NATIVE_USER_SESSION
$oldBinary=$env:MCPHUB_USER_RUNTIME_TEST_BINARY;$oldWatchPipe=$env:MCPHUB_USER_RUNTIME_TEST_PIPE
$lifecycleTest=Join-Path $PSScriptRoot 'target\agent-lifecycle-tests.exe'
$agent=$null
Push-Location (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
try {
  $agent=Start-Process -FilePath (Resolve-Path -LiteralPath $RuntimeBinary).Path -ArgumentList @('--user-agent','--pipe-name',$pipe) -WindowStyle Hidden -PassThru
  $env:MCPHUB_NATIVE_USER_PIPE="\\.\pipe\$pipe";$env:MCPHUB_NATIVE_USER_SESSION="$session"
  npm run -s test -- --runInBand tests/integration/native-user-agent-windows.test.ts --silent
  if($LASTEXITCODE -ne 0){throw 'User-session runtime acceptance failed.'}
  $duplicate=Start-Process -FilePath (Resolve-Path -LiteralPath $RuntimeBinary).Path -ArgumentList @('--user-agent','--pipe-name',$pipe) -WindowStyle Hidden -PassThru
  try {
    if(-not $duplicate.WaitForExit(5000)){$duplicate.Kill();$duplicate.WaitForExit();throw 'Duplicate user agent accepted an already owned pipe.'}
    if($duplicate.ExitCode -eq 0){throw 'Duplicate user agent did not report a conflict.'}
    if($agent.HasExited){throw 'Duplicate launch stopped the original user agent.'}
  } finally {$duplicate.Dispose()}
  & (Join-Path $env:USERPROFILE '.cargo\bin\rustc.exe') --edition 2021 --test (Join-Path $PSScriptRoot 'tests\agent_lifecycle.rs') -o $lifecycleTest
  if($LASTEXITCODE -ne 0){throw 'Cannot compile agent lifecycle acceptance.'}
  $env:MCPHUB_USER_RUNTIME_TEST_BINARY=(Resolve-Path -LiteralPath $RuntimeBinary).Path
  $env:MCPHUB_USER_RUNTIME_TEST_PIPE="$pipe-watchdog"
  & $lifecycleTest --exact agent_lifecycle::tests::actual_agent_survives_tray_watchdog_exit_is_reused_and_recovers_after_crash
  if($LASTEXITCODE -ne 0){throw 'Agent lifecycle acceptance failed.'}
} finally {
  $env:MCPHUB_NATIVE_USER_PIPE=$oldPipe;$env:MCPHUB_NATIVE_USER_SESSION=$oldSession
  $env:MCPHUB_USER_RUNTIME_TEST_BINARY=$oldBinary;$env:MCPHUB_USER_RUNTIME_TEST_PIPE=$oldWatchPipe
  if($agent){if(-not $agent.HasExited){$agent.Kill();$agent.WaitForExit()};$agent.Dispose()}
  # Only processes carrying this run's unique pipe identifier are disposable.
  Get-CimInstance Win32_Process -Filter "Name='mcphub-runtime-service.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($pipe)} | ForEach-Object {
    $owned=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if($owned){try{$owned.Kill();if(-not $owned.WaitForExit(5000)){throw 'Temporary user agent did not exit.'}}finally{$owned.Dispose()}}
  }
  if(Test-Path -LiteralPath $lifecycleTest){Remove-Item -LiteralPath $lifecycleTest -Force}
  Pop-Location
}
Write-Output 'User-session runtime acceptance passed; temporary agent removed.'
