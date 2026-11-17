param(
  [Parameter(Mandatory = $true)][string]$CsvPath,
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\..\desktop-shell\license-verifier.json')
)

$ErrorActionPreference = 'Stop'
$rows = @(Import-Csv -LiteralPath $CsvPath)
if ($rows.Count -ne 50) { throw 'The supplied CSV must contain exactly 50 license keys.' }
$hashes = [System.Collections.Generic.List[string]]::new()
foreach ($row in $rows) {
  $key = [string]$row.license_key
  if ($key -cnotmatch '^UPDX(?:-[A-Z0-9]{5}){4}$' -or
      $row.max_devices -ne '10' -or $row.status -ne 'PENDING_IMPORT') {
    throw 'The CSV contains an unexpected key format or metadata.'
  }
  $inputBytes = [Text.Encoding]::UTF8.GetBytes('UpdateX-license-v1:' + $key)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash($inputBytes) } finally { $sha.Dispose() }
  $hashes.Add(([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant())
}
if (@($hashes | Select-Object -Unique).Count -ne 50) { throw 'The CSV contains duplicate keys.' }
$manifest = [ordered]@{ format = 1; algorithm = 'sha256'; keyHashes = @($hashes | Sort-Object) }
$json = ConvertTo-Json -InputObject $manifest -Depth 3
$target = [IO.Path]::GetFullPath($OutputPath)
[IO.File]::WriteAllText($target, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
Write-Output "Wrote 50 key hashes to $target. Raw license keys were not copied."
