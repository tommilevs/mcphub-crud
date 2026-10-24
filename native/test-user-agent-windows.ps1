param([string]$RuntimeBinary=(Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe'))
$ErrorActionPreference='Stop'
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
if($session -eq 0){throw 'User agent acceptance requires a signed-in user session.'}
$pipe='mcphub-user-test-'+[Guid]::NewGuid().ToString('N')
$oldPipe=$env:MCPHUB_NATIVE_USER_PIPE;$oldSession=$env:MCPHUB_NATIVE_USER_SESSION
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
} finally {
  $env:MCPHUB_NATIVE_USER_PIPE=$oldPipe;$env:MCPHUB_NATIVE_USER_SESSION=$oldSession
  if($agent){if(-not $agent.HasExited){$agent.Kill();$agent.WaitForExit()};$agent.Dispose()}
  Pop-Location
}
Write-Output 'User-session runtime acceptance passed; temporary agent removed.'
