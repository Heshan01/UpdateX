param([ValidateSet('protect', 'unprotect')][string]$Action)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$text = [Console]::In.ReadToEnd()
if ($Action -eq 'protect') {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  try {
    $scope = 'CU'
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } catch {
    # Some local API processes run without a loaded Windows user profile.
    # Machine protection still keeps the record encrypted and device-bound;
    # the file stays under this user's LocalAppData ACL.
    $scope = 'LM'
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
  }
  [Console]::Out.Write("${scope}:" + [Convert]::ToBase64String($protected))
} else {
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($text.StartsWith('LM:')) {
    $scope = [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    $text = $text.Substring(3)
  } elseif ($text.StartsWith('CU:')) {
    $text = $text.Substring(3)
  }
  # An unprefixed value is a prior CurrentUser record.
  $bytes = [Convert]::FromBase64String($text)
  $clear = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $bytes, $null, $scope)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($clear))
}
