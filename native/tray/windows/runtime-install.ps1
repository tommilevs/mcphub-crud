param(
  [Parameter(Mandatory=$true)][ValidateSet('Prepare','Install','Uninstall')][string]$Action,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [string]$ServiceName='MCPHub',
  [string]$PipeName='mcphub-runtime',
  [ValidateRange(1,65535)][int]$GatewayPort=3000,
  [string]$DataDirectory=(Join-Path $env:ProgramData 'MCPHub'),
  [string]$RuntimeDirectory
)
$ErrorActionPreference='Stop'
foreach($name in @($ServiceName,$PipeName)) {
  if($name -notmatch '^[A-Za-z0-9_.-]{1,128}$'){throw 'Invalid runtime service or pipe name.'}
}
# An ordinary NSIS upgrade only supplies InstallDirectory. Preserve previously
# selected service endpoints and data location unless explicitly overridden.
$registered=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if($registered){
  foreach($entry in @(
    @{Parameter='DataDirectory';Flag='data-dir'},
    @{Parameter='RuntimeDirectory';Flag='runtime-dir'},
    @{Parameter='PipeName';Flag='pipe-name'}
  )){
    if(-not $PSBoundParameters.ContainsKey($entry.Parameter)){
      $match=[regex]::Match($registered.PathName,'(?:^|\s)--'+$entry.Flag+'\s+"([^"\r\n]+)"')
      if($match.Success){Set-Variable -Name $entry.Parameter -Value $match.Groups[1].Value}
    }
  }
  if(-not $PSBoundParameters.ContainsKey('GatewayPort')){
    $match=[regex]::Match($registered.PathName,'(?:^|\s)--gateway-port\s+([0-9]+)(?:\s|$)')
    if($match.Success){
      $GatewayPort=[int]$match.Groups[1].Value
      if($GatewayPort -lt 1 -or $GatewayPort -gt 65535){throw 'Invalid registered gateway port.'}
    }
  }
  if($PipeName -notmatch '^[A-Za-z0-9_.-]{1,128}$'){throw 'Invalid registered runtime pipe.'}
}
foreach($path in @($InstallDirectory,$DataDirectory)) {
  if(-not [IO.Path]::IsPathRooted($path) -or $path.Contains('"')){throw 'Runtime directories must be absolute Windows paths.'}
}
$InstallDirectory=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$runtimeBinary=Join-Path $InstallDirectory 'mcphub-runtime-service.exe'
$trayBinary=Join-Path $InstallDirectory 'mcphub-tray.exe'
if(-not $RuntimeDirectory){$RuntimeDirectory=Join-Path $InstallDirectory 'runtime'}
if(-not [IO.Path]::IsPathRooted($RuntimeDirectory) -or $RuntimeDirectory.Contains('"')){throw 'Runtime bundle path must be absolute.'}

function Stop-InstalledRuntime {
  $service=Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if($service){
    try{
      if($service.Status -ne 'Stopped'){
        $service.Stop()
        $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
      }
    }finally{$service.Dispose()}
  }
  # Stop the tray first so its watcher cannot relaunch the old user agent.
  # Match executable paths, never process names alone or other installations.
  foreach($binary in @($trayBinary,$runtimeBinary)) {
    $leaf=[IO.Path]::GetFileName($binary)
    $processes=Get-CimInstance Win32_Process -Filter "Name='$leaf'" | Where-Object {
      $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath),$binary,[StringComparison]::OrdinalIgnoreCase)
    }
    foreach($process in $processes){
      $running=Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
      if($running){
        try{
          # Hold the process handle before rechecking identity. CIM also works when
          # a 32-bit NSIS PowerShell process is inspecting the 64-bit runtime.
          $null=$running.Handle
          $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)"
          if(-not $current){continue}
          if(-not [string]::Equals($current.ExecutablePath,$binary,[StringComparison]::OrdinalIgnoreCase)){
            throw 'Runtime process identity changed during installation.'
          }
          $running.Kill()
          if(-not $running.WaitForExit(30000)){throw 'Installed runtime process did not stop.'}
        }finally{$running.Dispose()}
      }
    }
  }
}

# NSIS calls Prepare before extracting files. A fresh install must not report
# success while an older gateway or another application owns its requested port.
# Existing service upgrades retain their registered endpoint and stop it below.
if($Action -ne 'Uninstall' -and -not $registered){
  $listeners=[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  if($listeners | Where-Object {$_.Port -eq $GatewayPort}){
    throw "MCPHub gateway port $GatewayPort is already in use. Stop or migrate the existing gateway before installing, or select another GatewayPort."
  }
}
Stop-InstalledRuntime
if($Action -eq 'Prepare'){return}
$sc=Join-Path $env:SystemRoot 'System32\sc.exe'
if($Action -eq 'Uninstall'){
  if(Get-Service -Name $ServiceName -ErrorAction SilentlyContinue){
    & $sc delete $ServiceName | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Cannot remove the runtime service registration.'}
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do {
      $remaining=Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
      if(-not $remaining){break}
      $remaining.Dispose()
      Start-Sleep -Milliseconds 100
    }while([DateTime]::UtcNow -lt $deadline)
    if($remaining){throw 'Runtime service is still marked for deletion.'}
  }
  # Settings, databases and DPAPI credentials are intentionally preserved.
  return
}
foreach($file in @($runtimeBinary,(Join-Path $RuntimeDirectory 'node.exe'),(Join-Path $RuntimeDirectory 'dist\index.js'))){
  if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'The installed runtime bundle is incomplete.'}
}
$secretDirectory=Join-Path $DataDirectory 'secrets'
$binaryPath='"'+$runtimeBinary+'" --service-name "'+$ServiceName+'" --pipe-name "'+$PipeName+'" --gateway-port '+$GatewayPort+' --data-dir "'+$DataDirectory+'" --secret-dir "'+$secretDirectory+'" --runtime-dir "'+$RuntimeDirectory+'"'
$existing=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if($existing){
  # Update in place: no delete/create race with SCM recovery or open service handles.
  $changed=Invoke-CimMethod -InputObject $existing -MethodName Change -Arguments @{PathName=$binaryPath;StartMode='Automatic'}
  if($changed.ReturnValue -ne 0){throw "Cannot update runtime service: $($changed.ReturnValue)"}
}else{
  $registration=New-Service -Name $ServiceName -BinaryPathName $binaryPath -StartupType Automatic -DisplayName "$ServiceName Runtime Service"
  $registration.Dispose()
}
& $sc failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot configure runtime service recovery.'}
& $sc description $ServiceName 'MCPHub managed stdio MCP runtime and watchdog' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot configure runtime service description.'}
Start-Service -Name $ServiceName
$service=Get-Service -Name $ServiceName
try{$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(30))}finally{$service.Dispose()}
