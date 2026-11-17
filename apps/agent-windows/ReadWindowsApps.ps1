$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$apps = @(Get-AppxPackage -PackageTypeFilter Main -ErrorAction Stop | Where-Object {
    -not $_.IsFramework -and -not $_.IsResourcePackage -and -not $_.NonRemovable -and
    $_.Name -notmatch '^(Microsoft\.Windows\.|Microsoft\.NET\.|Windows\.|Microsoft\.VCLibs|Microsoft\.UI\.|Microsoft\.DesktopAppInstaller)'
})
$records = @($apps | ForEach-Object {
    [pscustomobject]@{
        Name = [string] $_.Name
        PackageFamilyName = [string] $_.PackageFamilyName
        Version = [string] $_.Version
        Publisher = [string] $_.Publisher
        Architecture = [string] $_.Architecture
        SignatureKind = [string] $_.SignatureKind
    }
})
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $records -Depth 3 -Compress))
