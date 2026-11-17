$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDotnet = Join-Path $projectRoot '.local\dotnet-sdk\dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else {
    (Get-Command dotnet -ErrorAction Stop).Source
}
if ($dotnet -eq $localDotnet) {
    $env:DOTNET_CLI_HOME = Join-Path $projectRoot '.local'
    $env:NUGET_PACKAGES = Join-Path $projectRoot '.local\nuget-packages'
}
& $dotnet run --project (Join-Path $projectRoot 'apps\agent-windows.tests\UpdatePilot.Agent.Tests.csproj')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
