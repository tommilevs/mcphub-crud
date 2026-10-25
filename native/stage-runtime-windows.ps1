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
  & corepack pnpm@10.12.4 --filter '@samanhappy/mcphub' --fail-if-no-match deploy --prod --legacy $Destination
  if($LASTEXITCODE -ne 0){throw 'Production dependency deployment failed.'}
  Copy-Item -LiteralPath (Get-Command node -CommandType Application).Source -Destination (Join-Path $Destination 'node.exe')
  foreach($file in @('node.exe','package.json','dist\index.js','frontend\dist\index.html')){
    if(-not(Test-Path -LiteralPath (Join-Path $Destination $file))){throw "Staged runtime is missing $file"}
  }
  Write-Output 'Windows runtime staged with pinned pnpm and production dependencies.'
}finally{Pop-Location}
