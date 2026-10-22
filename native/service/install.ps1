param(
  [ValidateSet('install', 'uninstall')][string]$Action = 'install',
  [string]$ServiceBinary = (Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe')
)

$serviceName = 'MCPHub'
if ($Action -eq 'uninstall') {
  sc.exe stop $serviceName | Out-Null
  sc.exe delete $serviceName | Out-Null
  exit 0
}

if (-not (Test-Path -LiteralPath $ServiceBinary)) { throw "Service binary not found: $ServiceBinary" }
sc.exe create $serviceName binPath= ('"' + $ServiceBinary + '"') start= auto DisplayName= 'MCPHub Runtime Service' | Out-Null
sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
sc.exe description $serviceName 'MCPHub managed stdio MCP runtime and watchdog' | Out-Null
sc.exe start $serviceName | Out-Null
