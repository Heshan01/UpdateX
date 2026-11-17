param()
$ErrorActionPreference = 'Stop'

# Available immediately on this Windows host: an Edge app window with no
# address bar or tabs. This is a preview launcher, not a packaged Electron app.
$edgeCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge is not installed.' }

foreach ($url in @('http://127.0.0.1:4000/api/v1/health', 'http://127.0.0.1:3000/overview')) {
  try { $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5 }
  catch { throw "UpdateX local service is unavailable at $url. Start pnpm dev and the read-only agent first." }
  if ($response.StatusCode -ne 200) { throw "UpdateX local service returned HTTP $($response.StatusCode) at $url." }
}

Start-Process -FilePath $edge -ArgumentList @('--app=http://127.0.0.1:3000/overview', '--window-size=980,650')
