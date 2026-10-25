param(
  [ValidateSet('check', 'release', 'test', 'bundle', 'service')][string]$Action = 'release'
)

$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products * -property installationPath
if (-not $vs) { throw 'Visual Studio Build Tools 2022 was not found.' }
$devCmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$cargoAction = if ($Action -eq 'check') { 'check' } else { 'build --release' }

$build = if ($Action -eq 'test') { "`"$cargo`" test -p mcphub-runtime-core -p mcphub-runtime-service" } else { "`"$cargo`" build -p mcphub-runtime-service --release && `"$cargo`" $cargoAction -p mcphub-tray" }
if ($Action -eq 'service') { $build = "`"$cargo`" build -p mcphub-runtime-service --release" }
if ($Action -eq 'bundle') { $build = "`"$cargo`" build -p mcphub-runtime-service --release && cd tray && `"$cargo`" tauri build --bundles nsis" }
$cargoDirectory = Split-Path -Parent $cargo
# Expand PATH after VsDevCmd has installed the MSVC/SDK paths. Ordinary %PATH%
# expansion happens before the batch runs and can select Git's Unix link.exe.
# Keep VsDevCmd's matching SDK/toolset LIB selection too: the newest SDK directory
# can be incomplete on hosted runners (for example, missing kernel32.lib).
$command = "cd /d `"$PSScriptRoot`" && call `"$devCmd`" -arch=x64 >nul && set `"PATH=$cargoDirectory;!PATH!`" && $build"
& cmd.exe /d /v:on /c $command
if ($LASTEXITCODE -ne 0) { throw "Native Windows build failed with exit code $LASTEXITCODE" }
