# Standalone test of expanded auth strategies. Tries:
#   - Domain validation (fails when DC unreachable / off-VPN)
#   - Machine validation (only works for local accounts)
#   - LogonUser with LOGON32_LOGON_NETWORK
#   - LogonUser with LOGON32_LOGON_INTERACTIVE (uses cached domain creds)
# Prints verbose output for each attempt.

$ErrorActionPreference = 'Continue'
try {
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement

  # Pre-fill with the FULL domain-qualified username so the user doesn't
  # have to remember to type "ANT\..."
  $defaultUser = $env:USERNAME
  if ($env:USERDOMAIN) { $defaultUser = "$($env:USERDOMAIN)\$($env:USERNAME)" }

  $cred = $host.ui.PromptForCredential('Kiro Guard auth test', "Enter your Windows password (username: $defaultUser)", $defaultUser, '')
  if ($null -eq $cred) {
    Write-Output 'CANCEL'
    exit 0
  }

  $username = $cred.UserName
  $password = $cred.GetNetworkCredential().Password
  Write-Output "username typed: $username"
  $valid = $false

  # Parse domain\user or user@domain.com
  $domainPart = ''
  $userPart = $username
  if ($username -match '^([^\\]+)\\(.+)$') { $domainPart = $matches[1]; $userPart = $matches[2] }
  elseif ($username -match '^(.+)@(.+)$')   { $userPart = $matches[1]; $domainPart = $matches[2] }
  Write-Output "parsed user='$userPart' domain='$domainPart'"

  # Strategy 1: Domain via AD (fails off-VPN)
  if ((Get-CimInstance Win32_ComputerSystem).PartOfDomain) {
    try {
      $adDomain = (Get-CimInstance Win32_ComputerSystem).Domain
      Write-Output "[1] Domain($adDomain)..."
      $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Domain, $adDomain)
      $valid = $ctx.ValidateCredentials($username, $password)
      Write-Output "    -> $valid"
    } catch { Write-Output "    threw: $($_.Exception.Message)" }
  }

  # Strategy 2: Machine
  if (-not $valid) {
    try {
      Write-Output "[2] Machine..."
      $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Machine)
      $valid = $ctx.ValidateCredentials($username, $password)
      Write-Output "    -> $valid"
    } catch { Write-Output "    threw: $($_.Exception.Message)" }
  }

  # Strategy 3 & 4: LogonUser with both NETWORK and INTERACTIVE
  if (-not $valid) {
    $signature = @"
[DllImport("advapi32.dll", SetLastError=true)]
public static extern bool LogonUser(string user, string domain, string password, int logonType, int logonProvider, out IntPtr token);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr handle);
"@
    $type = Add-Type -MemberDefinition $signature -Name 'KGAuthTest' -Namespace 'KGTest' -PassThru
    $token = [IntPtr]::Zero

    foreach ($logonType in @(@(3, 'NETWORK'), @(2, 'INTERACTIVE'), @(7, 'UNLOCK'))) {
      if ($valid) { break }
      try {
        Write-Output "[3] LogonUser type=$($logonType[1]) ($($logonType[0]))..."
        $token = [IntPtr]::Zero
        $result = $type::LogonUser($userPart, $domainPart, $password, $logonType[0], 0, [ref]$token)
        if ($result) {
          Write-Output "    -> True"
          $valid = $true
          $type::CloseHandle($token) | Out-Null
        } else {
          $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
          Write-Output "    -> False (err $err)"
        }
      } catch { Write-Output "    threw: $($_.Exception.Message)" }
    }
  }

  if ($valid) { Write-Output 'OK' } else { Write-Output 'BAD' }
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
}
