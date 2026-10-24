param([string]$ServiceBinary=(Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe'),
  [switch]$WithGateway,
  [switch]$WithGeneratedPassword,
  [switch]$WithDesktop,
  [string]$RuntimeDirectory=(Join-Path $PSScriptRoot 'staging'))
$ErrorActionPreference='Stop'
if($WithDesktop){$WithGateway=$true}
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
$desktop=$null
$oldPipe=$env:MCPHUB_NATIVE_TEST_PIPE
$oldSecrets=$env:MCPHUB_NATIVE_TEST_SECRET_DIR
$oldRestartService=$env:MCPHUB_RESTART_TEST_SERVICE
Push-Location $repo
try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'Acceptance service name collision.'}
  $command='"'+$binary+'" --service-name "'+$name+'" --pipe-name "'+$pipe+'" --secret-dir "'+$secrets+'" --no-gateway'
  if($WithGateway){
    $runtime=(Resolve-Path -LiteralPath $RuntimeDirectory).Path
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
    $command='"'+$binary+'" --service-name "'+$name+'" --pipe-name "'+$pipe+'" --secret-dir "'+$secrets+'" --gateway-port '+$port+' --data-dir "'+$testRoot+'" --runtime-dir "'+$runtime+'"'
  }
  $registration=New-Service -Name $name -BinaryPathName $command -StartupType Manual -DisplayName $name
  $created=$true;$registration.Dispose()
  if($WithGateway){
    # Synthetic acceptance credential only; the service key is deleted in finally.
    $serviceEnvironment=@('USE_DB=false','NODE_ENV=production')
    if(-not $WithGeneratedPassword){$serviceEnvironment+='ADMIN_PASSWORD=MCPHub-Acceptance-Only-42!'}
    New-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name Environment -PropertyType MultiString -Value $serviceEnvironment | Out-Null
  }
  Start-Service -Name $name
  $service=Get-Service -Name $name
  try{$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))}finally{$service.Dispose()}
  $env:MCPHUB_NATIVE_TEST_PIPE="\\.\pipe\$pipe"
  $env:MCPHUB_NATIVE_TEST_SECRET_DIR=$secrets
  npm run -s test -- --runInBand tests/integration/native-service-windows.test.ts --silent
  if($LASTEXITCODE -ne 0){throw "SCM acceptance failed: $LASTEXITCODE"}
  # Exercise the exact tray restart implementation against this service only.
  $controlTest=Join-Path $testRoot 'tray-control-test.exe'
  & (Join-Path $env:USERPROFILE '.cargo\bin\rustc.exe') --edition 2021 --test (Join-Path $PSScriptRoot 'tray\src\gateway_start.rs') -o $controlTest
  if($LASTEXITCODE -ne 0){throw 'Cannot compile tray lifecycle acceptance.'}
  $env:MCPHUB_RESTART_TEST_SERVICE=$name
  $beforeRestart=Get-CimInstance Win32_Service -Filter "Name='$name'"
  & $controlTest --exact tests::restarts_an_explicit_test_service_and_waits_for_running
  if($LASTEXITCODE -ne 0){throw 'Tray restart from Running failed.'}
  $afterRestart=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($afterRestart.State -ne 'Running' -or $afterRestart.ProcessId -eq $beforeRestart.ProcessId){throw 'Tray restart did not create a new running service process.'}
  Stop-Service -Name $name
  & $controlTest --exact tests::restarts_an_explicit_test_service_and_waits_for_running
  if($LASTEXITCODE -ne 0){throw 'Tray restart from Stopped failed.'}
  $env:MCPHUB_RESTART_TEST_SERVICE=$oldRestartService
  if($WithGateway){
    $base="http://127.0.0.1:$port"
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    do {
      try{$health=Invoke-RestMethod "$base/health" -TimeoutSec 2;break}catch{Start-Sleep -Milliseconds 500}
    } while([DateTime]::UtcNow -lt $deadline)
    if(-not $health){throw 'Bundled gateway never became healthy.'}
    $password='MCPHub-Acceptance-Only-42!'
    if($WithGeneratedPassword){
      $encrypted=[IO.File]::ReadAllBytes((Join-Path $secrets 'bootstrap-admin.dpapi'))
      $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
      $password=[Text.Encoding]::UTF8.GetString($plain)
      if($password.Length -ne 64){throw 'Invalid generated bootstrap password.'}
      [Array]::Clear($plain,0,$plain.Length)
    }
    $loginBody=@{username='admin';password=$password}|ConvertTo-Json -Compress
    $login=Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType 'application/json' -Body $loginBody
    $password=$null
    if(-not $login.token){throw 'Bundled gateway login failed.'}
    $status=Invoke-RestMethod "$base/api/native-runtime/status" -Headers @{'x-auth-token'=$login.token}
    if(-not $status.data -or $null -eq $status.data.processes){throw 'Gateway could not query its isolated service pipe.'}
    if(-not (Test-Path -LiteralPath (Join-Path $testRoot 'mcp_settings.json'))){throw 'Gateway did not use isolated settings.'}
    $settings=Get-Content -LiteralPath (Join-Path $testRoot 'mcp_settings.json') -Raw | ConvertFrom-Json
    if($settings.systemConfig.install.baseUrl -ne $base){throw 'New installation advertises the wrong gateway port.'}
    $page=Invoke-WebRequest "$base/" -TimeoutSec 5
    if($page.Content -notmatch '<div id="root"'){throw 'Bundled dashboard was not served.'}
    Write-Output 'Bundled gateway HTTP health/login/native status passed.'
    if($WithDesktop){
      $desktop=Start-Process -FilePath (Join-Path $PSScriptRoot 'target\release\mcphub-tray.exe') -ArgumentList '--open-dashboard' -Environment @{MCPHUB_DESKTOP_PORT="$port"} -WindowStyle Hidden -PassThru
      Write-Output "DESKTOP_ACCEPTANCE_READY port=$port pid=$($desktop.Id)"
      Read-Host 'After checking login and closing the dashboard window, press Enter' | Out-Null
      if($desktop.HasExited){throw 'Closing the dashboard exited the tray.'}
      Invoke-RestMethod "$base/health" -TimeoutSec 2 | Out-Null
      Read-Host 'After Exit tray, press Enter' | Out-Null
      if(-not $desktop.WaitForExit(5000)){throw 'Exit tray did not terminate the desktop app.'}
      Invoke-RestMethod "$base/health" -TimeoutSec 2 | Out-Null
    }
  }
  # Verify SCM recovery independently of the child-process watchdog.
  sc.exe failure $name reset= 60 actions= restart/1000 | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot configure isolated recovery actions.'}
  sc.exe failureflag $name 1 | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot configure isolated failure flag.'}
  $before=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($WithGateway){
    $gatewayPid=(Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -First 1).OwningProcess
    $gatewayProcess=Get-Process -Id $gatewayPid
  }
  Stop-Process -Id $before.ProcessId -Force
  if($WithGateway){
    if(-not $gatewayProcess.WaitForExit(5000)){throw 'Gateway survived a hard service crash.'}
    $gatewayProcess.Dispose()
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $after=Get-CimInstance Win32_Service -Filter "Name='$name'"
  } until(($after.State -eq 'Running' -and $after.ProcessId -ne $before.ProcessId) -or [DateTime]::UtcNow -ge $deadline)
  if($after.State -ne 'Running' -or $after.ProcessId -eq $before.ProcessId){throw 'SCM did not recover the crashed service.'}
  if($WithGateway){
    $recovered=$false;$deadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
      try {
        $again=Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType 'application/json' -Body $loginBody -TimeoutSec 2
        $recovered=[bool]$again.token
      }catch{Start-Sleep -Milliseconds 500}
    }until($recovered -or [DateTime]::UtcNow -ge $deadline)
    $loginBody=$null
    if(-not $recovered){throw 'Gateway login did not survive service recovery.'}
  }
  Stop-Service -Name $name
  Start-Sleep -Seconds 3
  $after=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($after.State -ne 'Stopped'){throw 'Intentional stop triggered SCM recovery.'}
}
finally {
  if($desktop){if(-not $desktop.HasExited){$desktop.Kill();$desktop.WaitForExit()};$desktop.Dispose()}
  $env:MCPHUB_NATIVE_TEST_PIPE=$oldPipe;$env:MCPHUB_NATIVE_TEST_SECRET_DIR=$oldSecrets
  $env:MCPHUB_RESTART_TEST_SERVICE=$oldRestartService
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
