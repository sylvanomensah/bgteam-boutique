# Publie le site sur Cloudflare (Worker "bgteam-boutique", fichiers statiques).
# Prérequis : Node.js + wrangler (npm install -g wrangler) et "wrangler login".
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$stage = Join-Path $env:TEMP "bgteam-deploy\bgteam"
$site = Join-Path $stage "site"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $site | Out-Null
foreach ($item in "index.html", "manifest.webmanifest", "sw.js", "css", "js", "icons", ".well-known") {
  Copy-Item (Join-Path $src $item) $site -Recurse
}
Push-Location $stage
try {
  wrangler deploy --assets ./site --name bgteam-boutique --compatibility-date 2026-10-01
} finally {
  Pop-Location
}
