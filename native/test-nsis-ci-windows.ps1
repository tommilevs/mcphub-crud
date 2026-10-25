param([Parameter(Mandatory=$true)][string]$InstallerPath,[switch]$CheckTray)
$ErrorActionPreference='Stop'
# This test installs the real default service. It must never run on a user's PC
# or a self-hosted runner that could contain an existing installation.
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows'){
  throw 'Full NSIS acceptance is restricted to disposable GitHub-hosted Windows runners.'
}
Add-Type -AssemblyName System.Security
$InstallerPath=(Resolve-Path -LiteralPath $InstallerPath).Path
$install=Join-Path $env:RUNNER_TEMP 'MCPHub-Installer-Acceptance'
$data=Join-Path $env:ProgramData 'MCPHub'
if((Get-Service -Name MCPHub -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $data)){
  throw 'Runner is not clean; existing runtime objects will not be changed.'
}
if([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {$_.Port -eq 3000}){
  throw 'Runner gateway port is occupied.'
}
function Invoke-Installer {
  $process=Start-Process -FilePath $InstallerPath -ArgumentList @('/S',"/D=$install") -WindowStyle Hidden -Wait -PassThru
  try{if($process.ExitCode -ne 0){throw "NSIS exited with code $($process.ExitCode)"}}finally{$process.Dispose()}
}
function Wait-Gateway {
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  do{
    try{if((Invoke-WebRequest http://127.0.0.1:3000/health -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200){return}}catch{}
    Start-Sleep -Milliseconds 250
  }while([DateTime]::UtcNow -lt $deadline)
  throw 'Installed gateway did not become healthy.'
}
function Assert-Login([string]$Password){
  $response=Invoke-RestMethod http://127.0.0.1:3000/api/auth/login -Method Post -ContentType 'application/json' -Body (@{username='admin';password=$Password}|ConvertTo-Json -Compress)
  if(-not $response.token){throw 'Installed gateway rejected its bootstrap administrator.'}
}
try{
  Invoke-Installer
  foreach($file in @('mcphub-tray.exe','mcphub-runtime-service.exe','runtime-install.ps1','runtime\node.exe','runtime\dist\index.js','runtime\frontend\dist\index.html')){
    if(-not(Test-Path -LiteralPath (Join-Path $install $file))){throw "Installed bundle is missing $file"}
  }
  Push-Location (Join-Path $install 'runtime')
  try{
    # Probe installed files, not the build tree. No settings or credentials read.
    & ./node.exe -e "try { for (const name of ['express','pg','bcryptjs','gpt-tokenizer']) require(name); console.log('Installed dependency imports passed.'); } catch(e) { console.error('Installed dependency import failed: '+e.code); process.exit(1); }"
    if($LASTEXITCODE -ne 0){throw 'Installed production dependencies are not loadable.'}
  }finally{Pop-Location}
  Wait-Gateway
  $registration=Get-CimInstance Win32_Service -Filter "Name='MCPHub'"
  if($registration.State -ne 'Running' -or -not $registration.PathName.StartsWith('"'+(Join-Path $install 'mcphub-runtime-service.exe')+'" ')){
    throw 'Installed service registration does not target this bundle.'
  }
  $bootstrap=Join-Path $data 'secrets\bootstrap-admin.dpapi'
  $encrypted=[IO.File]::ReadAllBytes($bootstrap)
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  $password=[Text.Encoding]::UTF8.GetString($plain);[Array]::Clear($plain,0,$plain.Length)
  Assert-Login $password
  if($CheckTray){
    $trayStart=[Diagnostics.ProcessStartInfo]::new((Join-Path $install 'mcphub-tray.exe'))
    $trayStart.ArgumentList.Add('--open-dashboard')
    $trayStart.UseShellExecute=$false
    $trayStart.CreateNoWindow=$true
    $trayStart.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $trayStart.RedirectStandardError=$true
    $tray=[Diagnostics.Process]::Start($trayStart)
    $trayErrors=$tray.StandardError.ReadToEndAsync()
    try{
      $deadline=[DateTime]::UtcNow.AddSeconds(60)
      do{
        $tray.Refresh()
        if($tray.HasExited){throw "Installed tray exited before opening its dashboard (code $($tray.ExitCode))."}
        if($tray.MainWindowHandle -ne [IntPtr]::Zero -and $tray.MainWindowTitle -match 'MCPHub'){break}
        Start-Sleep -Milliseconds 250
      }while([DateTime]::UtcNow -lt $deadline)
      if($tray.MainWindowHandle -eq [IntPtr]::Zero -or $tray.MainWindowTitle -notmatch 'MCPHub'){
        throw 'Installed tray did not create its dashboard window.'
      }
      if(-not $tray.CloseMainWindow()){throw 'Installed dashboard did not accept a close request.'}
      $deadline=[DateTime]::UtcNow.AddSeconds(10)
      do{
        Start-Sleep -Milliseconds 100
        $tray.Refresh()
        if($tray.HasExited){throw "Closing the dashboard terminated the tray (code $($tray.ExitCode))."}
        if($tray.MainWindowHandle -eq [IntPtr]::Zero){break}
      }while([DateTime]::UtcNow -lt $deadline)
      if($tray.MainWindowHandle -ne [IntPtr]::Zero){throw 'Closing the dashboard did not hide its window.'}
      Wait-Gateway
      Assert-Login $password
      Write-Output 'Installed tray passed: dashboard window created, close hides without exiting, service gateway and login remain available.'
    }finally{
      if(-not $tray.HasExited){$tray.Kill();$tray.WaitForExit(10000)|Out-Null}
      # Only extract known failure categories; never publish arbitrary stderr.
      if($trayErrors.IsCompleted){
        $stderr=$trayErrors.GetAwaiter().GetResult()
        $categories=[regex]::Matches($stderr,'(?i)WebView2|tray icon|error while running tauri application|panicked|access denied|os error [0-9]+|0x[0-9a-f]{8}') | ForEach-Object {$_.Value} | Select-Object -Unique
        if($categories){Write-Output ('Tray diagnostic categories: '+($categories -join ', '))}
        $stderr=$null
      }
      $tray.Dispose()
    }
  }
  $shortcutRoots=@([Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Programs'))
  $links=@($shortcutRoots | Where-Object {$_ -and (Test-Path -LiteralPath $_)} | ForEach-Object {Get-ChildItem -LiteralPath $_ -Filter 'MCPHub.lnk' -Recurse})
  $shell=New-Object -ComObject WScript.Shell
  if(-not($links | Where-Object {$shell.CreateShortcut($_.FullName).TargetPath -eq (Join-Path $install 'mcphub-tray.exe')})){
    throw 'Start Menu shortcut does not target the installed tray.'
  }
  $settingsPath=Join-Path $data 'mcp_settings.json'
  $settings=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  $settings.mcpServers | Add-Member -NotePropertyName 'nsis-retained-fixture' -NotePropertyValue @{type='stdio';command='unused';enabled=$false}
  [IO.File]::WriteAllText($settingsPath,($settings|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
  Invoke-Installer
  Wait-Gateway
  Assert-Login $password;$password=$null
  if([Convert]::ToBase64String([IO.File]::ReadAllBytes($bootstrap)) -ne [Convert]::ToBase64String($encrypted)){throw 'Upgrade changed the bootstrap credential.'}
  if((Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).mcpServers.'nsis-retained-fixture'.command -ne 'unused'){throw 'NSIS upgrade lost existing settings.'}
  $uninstaller=Join-Path $install 'uninstall.exe'
  $process=Start-Process -FilePath $uninstaller -ArgumentList @('/S',"_?=$install") -WindowStyle Hidden -Wait -PassThru
  try{if($process.ExitCode -ne 0){throw 'NSIS uninstall failed.'}}finally{$process.Dispose()}
  if(Get-Service -Name MCPHub -ErrorAction SilentlyContinue){throw 'NSIS uninstall left a service registration.'}
  if(-not(Test-Path -LiteralPath $settingsPath) -or -not(Test-Path -LiteralPath $bootstrap)){throw 'NSIS uninstall deleted persistent data.'}
  Write-Output 'Full silent NSIS passed: installed layout, SCM, health, bootstrap login, shortcut, upgrade, data retention and uninstall.'
}finally{
  $password=$null
  # Runner disposal removes this test's synthetic retained data. Never upload it.
  # Best-effort shutdown is scoped to the verified test installation only.
  $service=Get-CimInstance Win32_Service -Filter "Name='MCPHub'"
  if($service -and $service.PathName.StartsWith('"'+(Join-Path $install 'mcphub-runtime-service.exe')+'" ')){
    & (Join-Path $install 'runtime-install.ps1') -Action Uninstall -InstallDirectory $install
  }
}
