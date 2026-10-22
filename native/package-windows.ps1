param(
  [string]$NodeExecutable = (Join-Path ${env:ProgramFiles} 'nodejs\node.exe')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$staging = Join-Path $PSScriptRoot 'staging'

if (-not (Test-Path -LiteralPath $NodeExecutable)) {
  throw "Node executable not found: $NodeExecutable. Pass -NodeExecutable with a portable node.exe."
}

Push-Location $repo
try {
  npm run -s backend:build
  if ($LASTEXITCODE -ne 0) { throw "Backend build failed with exit code $LASTEXITCODE" }
  npm run -s frontend:build
  if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Path $staging | Out-Null
  & corepack pnpm --filter . deploy --prod --legacy $staging
  if ($LASTEXITCODE -ne 0) { throw "Production dependency staging failed with exit code $LASTEXITCODE" }
  # Tauri resource copying does not preserve pnpm junctions. Materialize the
  # root dependency links so the installed runtime has ordinary directories.
  $nodeModules = Join-Path $staging 'node_modules'
  $flatNodeModules = Join-Path $staging 'node_modules-flat'
  New-Item -ItemType Directory -Path $flatNodeModules | Out-Null
  Get-ChildItem -LiteralPath $nodeModules -Force |
    Where-Object { $_.Name -notin @('.pnpm', '.bin', '.modules.yaml', '.pnpm-workspace-state.json') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $flatNodeModules $_.Name) -Recurse -Force }
  Remove-Item -LiteralPath $nodeModules -Recurse -Force
  Move-Item -LiteralPath $flatNodeModules -Destination $nodeModules
  Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination (Join-Path $staging 'dist') -Recurse -Force
  Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $staging 'node.exe')
  Write-Output "Staged backend runtime (dist + production dependencies) in $staging"
}
finally {
  Pop-Location
}
