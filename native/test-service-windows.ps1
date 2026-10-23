param([string]$ServiceBinary=(Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe'))
$ErrorActionPreference='Stop'
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'SCM acceptance requires an elevated Windows administrator.'}
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$workRoot=(Resolve-Path -LiteralPath (Join-Path $repo '..')).Path
$guid=[Guid]::NewGuid().ToString('N')
$name="MCPHubAcceptance-$guid"
$pipe="mcphub-acceptance-$guid"
$testRoot=[IO.Path]::GetFullPath((Join-Path $workRoot "mcphub-service-acceptance-$guid"))
$secrets=Join-Path $testRoot 'secrets'
$binary=(Resolve-Path -LiteralPath $ServiceBinary).Path
$created=$false
$oldPipe=$env:MCPHUB_NATIVE_TEST_PIPE
$oldSecrets=$env:MCPHUB_NATIVE_TEST_SECRET_DIR
Push-Location $repo
try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'Acceptance service name collision.'}
  $command='"'+$binary+'" --service-name "'+$name+'" --pipe-name "'+$pipe+'" --secret-dir "'+$secrets+'" --no-gateway'
  $registration=New-Service -Name $name -BinaryPathName $command -StartupType Manual -DisplayName $name
  $created=$true;$registration.Dispose()
  Start-Service -Name $name
  $service=Get-Service -Name $name
  try{$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))}finally{$service.Dispose()}
  $env:MCPHUB_NATIVE_TEST_PIPE="\\.\pipe\$pipe"
  $env:MCPHUB_NATIVE_TEST_SECRET_DIR=$secrets
  npm run -s test -- --runInBand tests/integration/native-service-windows.test.ts --silent
  if($LASTEXITCODE -ne 0){throw "SCM acceptance failed: $LASTEXITCODE"}
  # Verify SCM recovery independently of the child-process watchdog.
  sc.exe failure $name reset= 60 actions= restart/1000 | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot configure isolated recovery actions.'}
  sc.exe failureflag $name 1 | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot configure isolated failure flag.'}
  $before=Get-CimInstance Win32_Service -Filter "Name='$name'"
  Stop-Process -Id $before.ProcessId -Force
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $after=Get-CimInstance Win32_Service -Filter "Name='$name'"
  } until(($after.State -eq 'Running' -and $after.ProcessId -ne $before.ProcessId) -or [DateTime]::UtcNow -ge $deadline)
  if($after.State -ne 'Running' -or $after.ProcessId -eq $before.ProcessId){throw 'SCM did not recover the crashed service.'}
  Stop-Service -Name $name
  Start-Sleep -Seconds 3
  $after=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($after.State -ne 'Stopped'){throw 'Intentional stop triggered SCM recovery.'}
}
finally {
  $env:MCPHUB_NATIVE_TEST_PIPE=$oldPipe;$env:MCPHUB_NATIVE_TEST_SECRET_DIR=$oldSecrets
  if($created){
    Stop-Service -Name $name -ErrorAction SilentlyContinue
    $service=Get-Service -Name $name -ErrorAction SilentlyContinue
    if($service){try{$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15))}finally{$service.Dispose()}}
    sc.exe delete $name | Out-Null
    if($LASTEXITCODE -ne 0){throw "Cannot remove acceptance service $name"}
    if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw "Acceptance service still exists: $name"}
  }
  if(Test-Path -LiteralPath $testRoot){
    $resolved=(Resolve-Path -LiteralPath $testRoot).Path
    $expected=[IO.Path]::GetFullPath((Join-Path $workRoot "mcphub-service-acceptance-$guid"))
    if($resolved -ne $expected -or -not $resolved.StartsWith($workRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe acceptance cleanup path.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if(Test-Path -LiteralPath $resolved){throw 'Acceptance directory was not removed.'}
  }
  Pop-Location
}
Write-Output 'SCM acceptance passed; isolated service and test directory removed.'
