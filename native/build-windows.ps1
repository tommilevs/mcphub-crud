param(
  [ValidateSet('check', 'release')][string]$Action = 'release'
)

$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products * -property installationPath
if (-not $vs) { throw 'Visual Studio Build Tools 2022 was not found.' }
$devCmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$sdk = 'C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0'
$msvc = Get-ChildItem (Join-Path $vs 'VC\Tools\MSVC') -Directory | Sort-Object Name | Select-Object -Last 1
if (-not $msvc) { throw 'MSVC toolset was not found.' }
$vc = Join-Path $msvc.FullName 'lib\x64'
$lib = "$sdk\um\x64;$sdk\ucrt\x64;$vc"
$cargoAction = if ($Action -eq 'check') { 'check' } else { 'build --release' }

$command = "cd /d `"$PSScriptRoot`" && call `"$devCmd`" -arch=x64 >nul && set `"LIB=$lib`" && `"$cargo`" build -p mcphub-runtime-service --release && `"$cargo`" $cargoAction -p mcphub-tray"
& cmd.exe /d /c $command
if ($LASTEXITCODE -ne 0) { throw "Native Windows build failed with exit code $LASTEXITCODE" }
