$ErrorActionPreference='Stop'
$guid=[Guid]::NewGuid().ToString('N')
$service="MCPHubPortAcceptance-$guid"
$install=Join-Path (Split-Path -Parent $PSScriptRoot) "unused-install-$guid"
$helper=Join-Path $PSScriptRoot 'tray\windows\runtime-install.ps1'
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
try {
  $listener.Start()
  $port=$listener.LocalEndpoint.Port
  $rejected=$false
  try { & $helper -Action Prepare -InstallDirectory $install -ServiceName $service -GatewayPort $port }
  catch {
    if($_.Exception.Message -notlike '*gateway port*already in use*'){throw}
    $rejected=$true
  }
  if(-not $rejected){throw 'Fresh installation accepted an occupied gateway port.'}
  if(Get-Service -Name $service -ErrorAction SilentlyContinue){throw 'Preflight created a service.'}
  if(Test-Path -LiteralPath $install){throw 'Preflight created an installation directory.'}
  $listener.Stop()
  & $helper -Action Prepare -InstallDirectory $install -ServiceName $service -GatewayPort $port
  Write-Output 'Installer preflight passed: occupied port rejected, no service/files created, released port accepted.'
}finally{$listener.Stop()}
