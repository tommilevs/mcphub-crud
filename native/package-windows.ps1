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
  Copy-Item -LiteralPath (Join-Path $repo 'package.json') -Destination (Join-Path $staging 'package.json')
  Copy-Item -LiteralPath (Join-Path $repo 'pnpm-lock.yaml') -Destination (Join-Path $staging 'pnpm-lock.yaml')
  Copy-Item -LiteralPath (Join-Path $repo 'patches') -Destination (Join-Path $staging 'patches') -Recurse -Force
  & corepack pnpm install --prod --node-linker=hoisted --config.dangerouslyAllowAllBuilds=true --dir $staging --ignore-workspace
  if ($LASTEXITCODE -ne 0) { throw "Production dependency staging failed with exit code $LASTEXITCODE" }
  Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination (Join-Path $staging 'dist') -Recurse -Force
  $stagedFrontend = Join-Path $staging 'frontend\dist'
  New-Item -ItemType Directory -Path $stagedFrontend -Force | Out-Null
  Copy-Item -Path (Join-Path $repo 'frontend\dist\*') -Destination $stagedFrontend -Recurse -Force
  Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $staging 'node.exe')
  Write-Output "Staged gateway runtime (backend + frontend + production dependencies) in $staging"
}
finally {
  Pop-Location
}
