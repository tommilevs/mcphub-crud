param([string]$RuntimeDirectory=(Join-Path $PSScriptRoot 'staging'))
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$parent=Split-Path -Parent $repo
$guid=[Guid]::NewGuid().ToString('N')
$root=Join-Path $parent "mcphub-install-acceptance-$guid with spaces"
$install=Join-Path $root 'MCPHub Program Files'
$data=Join-Path $root 'Program Data'
$service="MCPHubInstallAcceptance-$guid"
$pipe="mcphub-install-acceptance-$guid"
$lifecycle=Join-Path $PSScriptRoot 'tray\windows\runtime-install.ps1'
$source=Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe'
$RuntimeDirectory=(Resolve-Path -LiteralPath $RuntimeDirectory).Path
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
$base="http://127.0.0.1:$port"
$arguments=@{InstallDirectory=$install;DataDirectory=$data;ServiceName=$service;PipeName=$pipe;GatewayPort=$port;RuntimeDirectory=$RuntimeDirectory}
$agent=$null;$unrelated=$null
function Wait-Gateway {
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    try{if((Invoke-WebRequest "$base/health" -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200){return}}catch{}
    Start-Sleep -Milliseconds 100
  }while([DateTime]::UtcNow -lt $deadline)
  throw 'Installed runtime gateway did not become healthy.'
}
function Assert-Login([string]$Password) {
  $login=Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType 'application/json' -Body (@{username='admin';password=$Password}|ConvertTo-Json -Compress)
  if(-not $login.token){throw 'Installed runtime administrator could not sign in.'}
}
try {
  if(Get-Service -Name $service -ErrorAction SilentlyContinue){throw 'Installer acceptance service collision.'}
  New-Item -ItemType Directory -Path $install | Out-Null
  $binary=Join-Path $install 'mcphub-runtime-service.exe'
  Copy-Item -LiteralPath $source -Destination $binary
  & $lifecycle -Action Prepare @arguments
  & $lifecycle -Action Install @arguments
  Wait-Gateway
  $registration=Get-CimInstance Win32_Service -Filter "Name='$service'"
  if(-not $registration.PathName.StartsWith('"'+$binary+'" ') -or $registration.StartMode -ne 'Auto'){throw 'Installer did not register a quoted automatic service path.'}
  $originalPid=$registration.ProcessId
  $bootstrap=Join-Path $data 'secrets\bootstrap-admin.dpapi'
  $encrypted=[IO.File]::ReadAllBytes($bootstrap)
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  $password=[Text.Encoding]::UTF8.GetString($plain)
  [Array]::Clear($plain,0,$plain.Length)
  if($password.Length -ne 64){throw 'Installer did not initialize a generated administrator credential.'}
  Assert-Login $password
  $settingsPath=Join-Path $data 'mcp_settings.json'
  $settings=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  $settings.mcpServers | Add-Member -NotePropertyName 'retained-cli' -NotePropertyValue @{type='stdio';command='unused-upgrade-fixture';enabled=$false}
  [IO.File]::WriteAllText($settingsPath,($settings|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
  $agent=Start-Process -FilePath $binary -ArgumentList @('--user-agent','--pipe-name',"mcphub-user-install-$guid") -WindowStyle Hidden -PassThru
  $unrelated=Start-Process -FilePath $source -ArgumentList @('--user-agent','--pipe-name',"mcphub-user-unrelated-$guid") -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300
  if($agent.HasExited -or $unrelated.HasExited){throw 'Installer upgrade agent fixtures did not start.'}
  & $lifecycle -Action Prepare @arguments
  if(-not $agent.WaitForExit(5000)){throw 'Preinstall left the old installed user agent alive.'}
  if($unrelated.HasExited){throw 'Preinstall stopped another installation user agent.'}
  if((Get-Service -Name $service).Status -ne 'Stopped'){throw 'Preinstall did not wait for the service to stop.'}
  # A real replacement in a directory containing spaces must no longer hit an executable lock.
  Copy-Item -LiteralPath $source -Destination $binary -Force
  # NSIS upgrades supply the install directory, not the previous custom data path.
  # Intercept before mutation so a regression cannot touch ProgramData or port 3000.
  function Invoke-CimMethod {
    param($InputObject,$MethodName,$Arguments)
    if($Arguments.PathName -notlike ('*--data-dir "'+$data+'"*')){throw 'Upgrade would discard the existing data directory.'}
    if($Arguments.PathName -notlike ('*--gateway-port '+$port+' *')){throw 'Upgrade would discard the existing gateway port.'}
    if($Arguments.PathName -notlike ('*--pipe-name "'+$pipe+'"*')){throw 'Upgrade would discard the existing pipe.'}
    CimCmdlets\Invoke-CimMethod -InputObject $InputObject -MethodName $MethodName -Arguments $Arguments
  }
  try { & $lifecycle -Action Install -InstallDirectory $install -ServiceName $service }
  finally { Remove-Item Function:\Invoke-CimMethod }
  Wait-Gateway
  Assert-Login $password
  $password=$null
  $updated=Get-CimInstance Win32_Service -Filter "Name='$service'"
  if($updated.State -ne 'Running' -or $updated.ProcessId -eq $originalPid){throw 'Upgrade did not restart the installed service.'}
  if([Convert]::ToBase64String([IO.File]::ReadAllBytes($bootstrap)) -ne [Convert]::ToBase64String($encrypted)){throw 'Upgrade replaced the bootstrap credential.'}
  $retained=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  if($retained.mcpServers.'retained-cli'.command -ne 'unused-upgrade-fixture'){throw 'Upgrade lost existing server settings.'}
  & $lifecycle -Action Uninstall @arguments
  if(Get-Service -Name $service -ErrorAction SilentlyContinue){throw 'Uninstall did not remove the service registration.'}
  if(-not (Test-Path -LiteralPath $bootstrap) -or -not (Test-Path -LiteralPath $settingsPath)){throw 'Uninstall removed persistent settings or credentials.'}
  if($unrelated.HasExited){throw 'Uninstall stopped an unrelated user agent.'}
  Write-Output 'Installer lifecycle passed: fresh install/login, quoted paths, agent stop, in-place upgrade, data retention and uninstall.'
}finally{
  foreach($process in @($agent,$unrelated)){
    if($process){try{if(-not $process.HasExited){$process.Kill();$process.WaitForExit()}}finally{$process.Dispose()}}
  }
  if(Get-Service -Name $service -ErrorAction SilentlyContinue){& $lifecycle -Action Uninstall @arguments}
  if(Get-Service -Name $service -ErrorAction SilentlyContinue){throw 'Temporary installer acceptance service remains.'}
  if(Test-Path -LiteralPath $root){
    $resolved=(Resolve-Path -LiteralPath $root).Path
    if($resolved -ne [IO.Path]::GetFullPath((Join-Path $parent "mcphub-install-acceptance-$guid with spaces")) -or
      -not $resolved.StartsWith($parent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
      ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe installer acceptance cleanup target.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if(Test-Path -LiteralPath $resolved){throw 'Temporary installer acceptance directory remains.'}
  }
}
