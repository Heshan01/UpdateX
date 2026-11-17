$ErrorActionPreference = 'Stop'

$envPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    throw 'Missing .env. Copy .env.example to .env first.'
}

$securePassword = Read-Host 'PostgreSQL password for the local postgres role' -AsSecureString
if ($securePassword.Length -eq 0) {
    throw 'The database password cannot be empty.'
}

$passwordPointer = [IntPtr]::Zero
try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $encodedPassword = [Uri]::EscapeDataString($plainPassword)
    $databaseUrl = "postgresql://postgres:$encodedPassword@127.0.0.1:5432/updatepilot?schema=public"

    $content = [IO.File]::ReadAllText($envPath)
    $replacement = 'DATABASE_URL="' + $databaseUrl + '"'
    if ($content -match '(?m)^DATABASE_URL=') {
        $updated = [Text.RegularExpressions.Regex]::Replace(
            $content,
            '(?m)^DATABASE_URL=.*$',
            [Text.RegularExpressions.MatchEvaluator] { param($match) $replacement }
        )
    } else {
        $updated = $content.TrimEnd() + [Environment]::NewLine + $replacement + [Environment]::NewLine
    }

    [IO.File]::WriteAllText($envPath, $updated, [Text.UTF8Encoding]::new($false))
    Write-Host 'Local database configuration saved to the ignored .env file.'
} finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $plainPassword = $null
    $encodedPassword = $null
    $databaseUrl = $null
    $securePassword.Dispose()
}
