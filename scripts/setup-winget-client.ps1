$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $projectRoot '.local\modules'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Save-Module -Name 'Microsoft.WinGet.Client' -RequiredVersion '1.29.380' -Repository 'PSGallery' -Path $destination -Force -ErrorAction Stop
Write-Output 'Microsoft WinGet Client 1.29.380 is available in the project-local .local/modules directory.'
