param([string]$ServiceBinary=(Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe'))
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'This disposable PostgreSQL/SCM harness runs only on GitHub-hosted acceptance workers.'}
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=(Resolve-Path -LiteralPath $ServiceBinary).Path
$guid=[Guid]::NewGuid().ToString('N')
$root=[IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP "mcphub-acquisition-$guid"))
$name="MCPHubAcquisition-$guid";$pipe="mcphub-acquisition-$guid"
$pgBin=$env:PGBIN
if(-not (Test-Path -LiteralPath (Join-Path $pgBin 'initdb.exe'))){throw 'Hosted worker PostgreSQL binaries are unavailable.'}
function Get-FreePort {
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  try{$listener.Start();return $listener.LocalEndpoint.Port}finally{$listener.Stop()}
}
$pgPort=Get-FreePort;$registryPort=Get-FreePort
$runtime=Join-Path $root 'runtime';$pgData=Join-Path $root 'postgres';$data=Join-Path $root 'data'
$pgStarted=$false;$serviceCreated=$false
Push-Location $repo
try {
  New-Item -ItemType Directory -Path $runtime,$data | Out-Null
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $runtime 'node.exe')
  $npmSource=Join-Path (Split-Path -Parent (Get-Command node.exe).Source) 'node_modules\npm'
  Copy-Item -LiteralPath $npmSource -Destination (Join-Path $runtime 'npm') -Recurse
  & (Join-Path $runtime 'node.exe') (Join-Path $runtime 'npm\bin\npm-cli.js') pack (Join-Path $PSScriptRoot 'tests\acquisition-fixture') --pack-destination $root --ignore-scripts --silent
  if($LASTEXITCODE -ne 0){throw 'Cannot pack offline MCP acceptance fixture.'}
  # New loopback-only disposable cluster, never the preinstalled worker service.
  Write-Output 'Initializing isolated PostgreSQL cluster.'
  $initOut=Join-Path $root 'initdb.stdout.log';$initErr=Join-Path $root 'initdb.stderr.log'
  $init=Start-Process -FilePath (Join-Path $pgBin 'initdb.exe') -ArgumentList @('-D',('"'+$pgData+'"'),'-U','postgres','--auth=trust','--encoding=UTF8','--no-locale') -WindowStyle Hidden -PassThru -RedirectStandardOutput $initOut -RedirectStandardError $initErr
  try {
    if(-not $init.WaitForExit(60000)){
      $init.Kill($true);$init.WaitForExit()
      Get-Content -LiteralPath $initOut,$initErr -ErrorAction SilentlyContinue
      throw 'Disposable PostgreSQL initialization exceeded 60 seconds.'
    }
    if($init.ExitCode -ne 0){Get-Content -LiteralPath $initOut,$initErr;throw 'Cannot initialize disposable PostgreSQL.'}
  } finally {$init.Dispose()}
  Write-Output 'Starting isolated PostgreSQL cluster.'
  & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $root 'postgres.log') -o "-p $pgPort -h 127.0.0.1" -t 30 -w start
  if($LASTEXITCODE -ne 0){throw 'Cannot start disposable PostgreSQL.'}
  $pgStarted=$true
  $command='"'+$binary+'" --service-name "'+$name+'" --pipe-name "'+$pipe+'" --secret-dir "'+(Join-Path $data 'secrets')+'" --data-dir "'+$data+'" --runtime-dir "'+$runtime+'" --no-gateway'
  $registration=New-Service -Name $name -BinaryPathName $command -StartupType Manual -DisplayName $name
  $serviceCreated=$true;$registration.Dispose()
  New-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name Environment -PropertyType MultiString -Value @(
    "npm_config_registry=http://127.0.0.1:$registryPort",'npm_config_audit=false','npm_config_fund=false',"npm_config_cache=$(Join-Path $root 'npm-cache')"
  ) | Out-Null
  Start-Service -Name $name
  $service=Get-Service -Name $name
  try{$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))}finally{$service.Dispose()}
  $env:MCPHUB_ACQUISITION_TEST_ROOT=$data
  $env:MCPHUB_ACQUISITION_TEST_TARBALL=Join-Path $root 'mcphub-acquisition-fixture-1.0.0.tgz'
  $env:MCPHUB_ACQUISITION_REGISTRY_PORT="$registryPort"
  $env:MCPHUB_NATIVE_TEST_PIPE="\\.\pipe\$pipe"
  $env:MCPHUB_ATTRIBUTION_TEST_PORT="$pgPort"
  $env:MCPHUB_ATTRIBUTION_TEST_PASSWORD='synthetic-test-only'
  node node_modules/jest/bin/jest.js --runInBand tests/integration/acquisition-native-windows.test.ts
  if($LASTEXITCODE -ne 0){throw 'Native acquisition HTTP/PostgreSQL/DPAPI acceptance failed.'}
} finally {
  if($serviceCreated){
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    & sc.exe delete $name | Out-Null
    if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'Owned acquisition service remains.'}
  }
  if($pgStarted){& (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -m immediate -w stop | Out-Null}
  Pop-Location
  if(Test-Path -LiteralPath $root){
    $resolved=(Resolve-Path -LiteralPath $root).Path
    $parent=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
    if($resolved -ne $root -or -not $resolved.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -or
       ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe acceptance cleanup target.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if(Test-Path -LiteralPath $resolved){throw 'Owned acquisition directory remains.'}
  }
}
