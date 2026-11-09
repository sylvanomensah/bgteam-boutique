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
# Numéro de version sur les fichiers : la page charge toujours le programme de la même version
# (évite qu'un ancien app.js resté en cache tourne avec une nouvelle page).
$v = Get-Date -Format "yyyyMMddHHmmss"
$utf8 = New-Object System.Text.UTF8Encoding $false
$idx = Join-Path $site "index.html"
$html = [IO.File]::ReadAllText($idx)
$html = $html.Replace('href="css/style.css"', "href=`"css/style.css?v=$v`"").Replace('src="js/config.js"', "src=`"js/config.js?v=$v`"").Replace('src="js/app.js"', "src=`"js/app.js?v=$v`"").Replace("__APP_VERSION__", $v)
[IO.File]::WriteAllText($idx, $html, $utf8)
# Même numéro dans le programme : il vérifie qu'il correspond à la page (garde-fou anti-cache)
$appf = Join-Path $site "js\app.js"
[IO.File]::WriteAllText($appf, [IO.File]::ReadAllText($appf, [Text.Encoding]::UTF8).Replace('"__APP_VERSION__"', "`"$v`""), $utf8)
$swf = Join-Path $site "sw.js"
[IO.File]::WriteAllText($swf, [IO.File]::ReadAllText($swf).Replace('const CACHE = "bgteam-v1";', "const CACHE = `"bgteam-$v`";"), $utf8)
Write-Host "Version : $v"
Push-Location $stage
try {
  wrangler deploy --assets ./site --name bgteam-boutique --compatibility-date 2026-10-01
} finally {
  Pop-Location
}
