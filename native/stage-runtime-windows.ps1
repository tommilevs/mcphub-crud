param([string]$Destination=(Join-Path $PSScriptRoot 'staging'))
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'Windows runtime staging requires Windows.'}
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$Destination=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $Destination){throw 'Staging destination already exists; use a fresh directory. Existing staging is never deleted.'}
foreach($file in @('dist\index.js','frontend\dist\index.html')){
  if(-not(Test-Path -LiteralPath (Join-Path $repo $file))){throw 'Build backend and frontend before staging.'}
}
Push-Location $repo
try{
  New-Item -ItemType Directory -Path $Destination | Out-Null
  foreach($file in @('package.json','pnpm-lock.yaml','.pnpmfile.cjs','patches')){
    Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $Destination $file) -Recurse
  }
  # NSIS needs real package files, not deploy's junctions into a staging .pnpm
  # store. Use the same portable layout as the locally accepted package builder.
  & corepack pnpm@10.12.4 install --prod --node-linker=hoisted --config.dangerouslyAllowAllBuilds=true --dir $Destination --ignore-workspace --frozen-lockfile
  if($LASTEXITCODE -ne 0){throw 'Production dependency deployment failed.'}
  Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination (Join-Path $Destination 'dist') -Recurse
  New-Item -ItemType Directory -Path (Join-Path $Destination 'frontend') | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'frontend/dist') -Destination (Join-Path $Destination 'frontend/dist') -Recurse
  Copy-Item -LiteralPath (Get-Command node -CommandType Application).Source -Destination (Join-Path $Destination 'node.exe')
  foreach($file in @('node.exe','package.json','dist\index.js','frontend\dist\index.html')){
    if(-not(Test-Path -LiteralPath (Join-Path $Destination $file))){throw "Staged runtime is missing $file"}
  }
  Write-Output 'Windows runtime staged with pinned pnpm and production dependencies.'
}finally{Pop-Location}
