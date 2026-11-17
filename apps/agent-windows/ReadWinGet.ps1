param([Parameter(Mandatory = $true)][string] $ModulePath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'Continue'
$InformationPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module -Name $ModulePath -ErrorAction Stop

$packages = @(Get-WinGetPackage -Source winget -ErrorAction Stop)
$records = [System.Collections.Generic.List[object]]::new()
$lookupFailures = 0
foreach ($package in $packages) {
    if ($package.Source -ne 'winget' -or $package.Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$') { continue }
    $target = $null
    # The installed-package object already carries catalog versions. Use it first;
    # an exact catalog query is a fallback only for an updateable package with no version.
    $catalogVersions = @($package.AvailableVersions | Where-Object { $_ -and [string]$_ -ne '' })
    if ($catalogVersions.Count -gt 0) { $target = [string] $catalogVersions[0] }
    if ($package.IsUpdateAvailable -and -not $target) {
        try {
            $found = @(Find-WinGetPackage -Id $package.Id -Source winget -MatchOption Equals -ErrorAction Stop)
            $exact = @($found | Where-Object { $_.Id -eq $package.Id -and $_.Source -eq 'winget' })
            if ($exact.Count -eq 1 -and $exact[0].Version) { $target = [string] $exact[0].Version }
            else { $lookupFailures++ }
        }
        catch { $lookupFailures++ }
    }
    $records.Add([pscustomobject]@{
        PackageId = [string] $package.Id
        DisplayName = [string] $package.Name
        InstalledVersion = if ($package.InstalledVersion) { [string] $package.InstalledVersion } else { $null }
        TargetVersion = if ($target) { [string] $target } else { $null }
        IsUpdateAvailable = [bool] $package.IsUpdateAvailable
        Publisher = if ($package.Publisher) { [string] $package.Publisher } else { $null }
        Architecture = if ($package.Architecture) { [string] $package.Architecture } else { $null }
    })
}

[Console]::Out.WriteLine((ConvertTo-Json -InputObject ([pscustomobject]@{
    Packages = @($records)
    LookupFailures = $lookupFailures
}) -Depth 4 -Compress))
