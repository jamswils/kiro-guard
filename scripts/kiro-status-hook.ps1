param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("idle", "working", "waiting", "asking", "done", "error")]
  [string] $Status,

  [Parameter(Mandatory = $false, ValueFromRemainingArguments = $true)]
  [string[]] $Arguments = @()
)

$Phase = "auto"
$Flags = @()

foreach ($argument in $Arguments) {
  if ($Phase -eq "auto" -and $argument -in @("design", "requirements", "tasks")) {
    $Phase = $argument
  } else {
    $Flags += $argument
  }
}

$defaultMessages = @{
  idle = "Kiro is ready"
  working = "Kiro is working"
  waiting = "Kiro is waiting for input"
  asking = "Kiro is asking for your input"
  done = "Kiro finished"
  error = "Kiro hit an error"
}

$phaseTitles = @{
  design = "Design"
  requirements = "Requirements"
  tasks = "Task List"
}

function Get-FlagValue([string] $Prefix) {
  foreach ($flag in $Flags) {
    if ($flag.StartsWith($Prefix)) {
      return $flag.Substring($Prefix.Length)
    }
  }

  return $null
}

function Quote-ProcessArgument([string] $Value) {
  return "`"$($Value -replace '"', '\"')`""
}

function Get-InstallMetadata {
  $metadataPath = Join-Path $PSScriptRoot "install.json"
  if (-not (Test-Path $metadataPath)) {
    return $null
  }

  try {
    return Get-Content -Raw -Path $metadataPath | ConvertFrom-Json
  } catch {
    return $null
  }
}

function ConvertTo-EventObject([string] $RawText) {
  if ([string]::IsNullOrWhiteSpace($RawText)) {
    return $null
  }

  try {
    return $RawText | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-EventValue($Event, [string[]] $Names) {
  if ($null -eq $Event) {
    return $null
  }

  foreach ($name in $Names) {
    if ($Event.PSObject.Properties.Name -contains $name) {
      $value = $Event.$name
      if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
        return [string]$value
      }
    }
  }

  return $null
}

function Get-TruncatedText([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $text = ($Value -replace "\s+", " ").Trim()
  if ($text.Length -gt 120) {
    return $text.Substring(0, 120)
  }

  return $text
}

function Get-BasenameIfPath([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  if ($Value -match "[\\/]") {
    return Split-Path -Leaf $Value
  }

  return $Value
}

function Test-KiroBuddyRunning([string] $PackageRoot) {
  try {
    $escapedRoot = [Regex]::Escape($PackageRoot)
    $matching = Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -match $escapedRoot -and $_.CommandLine -match "kiro-buddy" }
    return $null -ne $matching
  } catch {
    return $false
  }
}

function Start-KiroBuddyIfNeeded {
  if ($env:KIRO_BUDDY_NO_AUTOSTART -eq "1") {
    return
  }

  $metadata = Get-InstallMetadata
  if (-not $metadata -or [string]::IsNullOrWhiteSpace($metadata.packageRoot)) {
    return
  }

  $packageRoot = [string]$metadata.packageRoot
  if (Test-KiroBuddyRunning $packageRoot) {
    return
  }

  $electronModule = Join-Path $packageRoot "node_modules\electron"
  try {
    $electronBinary = node -e "process.stdout.write(require(process.argv[1]))" $electronModule
  } catch {
    return
  }

  if ([string]::IsNullOrWhiteSpace($electronBinary) -or -not (Test-Path $electronBinary)) {
    return
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $electronBinary
  $startInfo.Arguments = "`"$packageRoot`""
  $startInfo.WorkingDirectory = $packageRoot
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["KIRO_BUDDY_EXIT_WITH_KIRO"] = "1"
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($process) {
    $process.Dispose()
  }
}

$statusFilePath = Get-FlagValue "--status-file="
if ([string]::IsNullOrWhiteSpace($statusFilePath)) {
  $statusFilePath = $env:KIRO_BUDDY_STATUS_FILE
}
if ([string]::IsNullOrWhiteSpace($statusFilePath)) {
  $statusFilePath = Join-Path $env:USERPROFILE ".kiro\status.json"
}

$stdinText = ""
if ($env:KIRO_BUDDY_FORCE_READ_STDIN -eq "1") {
  try {
    $stdinText = [Console]::In.ReadToEnd()
  } catch {
    $stdinText = ""
  }
}

$event = ConvertTo-EventObject $env:KIRO_BUDDY_EVENT_JSON
if ($null -eq $event) {
  $event = ConvertTo-EventObject $stdinText
}

$delayMsText = Get-FlagValue "--delay-ms="
if (-not [string]::IsNullOrWhiteSpace($delayMsText)) {
  $delayMs = [int]$delayMsText
  if ($delayMs -gt 0) {
    Start-Sleep -Milliseconds ([Math]::Min($delayMs, 10000))
  }

  $startedAtText = Get-FlagValue "--started-at="
  if (-not [string]::IsNullOrWhiteSpace($startedAtText) -and (Test-Path $statusFilePath)) {
    try {
      $existingForDelay = Get-Content -Raw -Path $statusFilePath | ConvertFrom-Json
      $startedAt = [Int64]$startedAtText
      if ($existingForDelay.timestamp -gt $startedAt) {
        Write-Output "Kiro Buddy: skipped delayed $Status"
        exit 0
      }
    } catch {
      # Continue with the delayed write if the existing status cannot be parsed.
    }
  }
}

$message = $env:KIRO_BUDDY_MESSAGE
if ([string]::IsNullOrWhiteSpace($message) -and $Status -eq "working" -and -not [string]::IsNullOrWhiteSpace($env:USER_PROMPT)) {
  $message = "Prompt: $env:USER_PROMPT"
}
if ([string]::IsNullOrWhiteSpace($message) -and $Status -eq "working") {
  $eventPrompt = Get-EventValue $event @("prompt")
  if ($eventPrompt) {
    $message = "Prompt: $eventPrompt"
  }
}
if ([string]::IsNullOrWhiteSpace($message) -and $Status -eq "working") {
  $toolName = Get-EventValue $event @("tool_name", "toolName", "tool")
  if ($toolName) {
    $message = "Using $toolName"
  }
}
if ([string]::IsNullOrWhiteSpace($message) -and $Status -eq "done") {
  $hookEventName = Get-EventValue $event @("hook_event_name", "hookEventName")
  if ($hookEventName) {
    $message = "Completed $hookEventName"
  }
}

if ([string]::IsNullOrWhiteSpace($message)) {
  $message = $defaultMessages[$Status]
}

$message = ($message -replace "\s+", " ").Trim()
if ($message.Length -gt 120) {
  $message = $message.Substring(0, 120)
}

$existingPhase = $null
if (Test-Path $statusFilePath) {
  try {
    $existing = Get-Content -Raw -Path $statusFilePath | ConvertFrom-Json
    if ($existing.phase -in @("design", "requirements", "tasks")) {
      $existingPhase = [string]$existing.phase
    }
  } catch {
    $existingPhase = $null
  }
}

$phaseCandidates = @(
  $env:KIRO_BUDDY_PHASE,
  $env:USER_PROMPT,
  $env:KIRO_ACTIVE_FILE,
  $env:KIRO_FILE,
  $env:ACTIVE_FILE,
  $env:CURRENT_FILE,
  $env:WORKSPACE_FILE,
  $env:KIRO_BUDDY_EVENT_JSON,
  $stdinText
) -join " "

$resolvedPhase = $null
if ($Phase -ne "auto") {
  $resolvedPhase = $Phase
} elseif ($phaseCandidates -match "(?i)\b(tasks?|task\s*list)\b|tasks\.md") {
  $resolvedPhase = "tasks"
} elseif ($phaseCandidates -match "(?i)\brequirements?\b|requirements\.md") {
  $resolvedPhase = "requirements"
} elseif ($phaseCandidates -match "(?i)\bdesign\b|design\.md") {
  $resolvedPhase = "design"
} elseif ($Status -in @("done", "error", "asking", "waiting") -and $existingPhase) {
  $resolvedPhase = $existingPhase
}

$existingStatus = $null
if (Test-Path $statusFilePath) {
  try {
    $existingForStatus = Get-Content -Raw -Path $statusFilePath | ConvertFrom-Json
    if ($existingForStatus.status -in @("idle", "working", "waiting", "asking", "done", "error")) {
      $existingStatus = [string]$existingForStatus.status
    }
  } catch {
    $existingStatus = $null
  }
}

$requiresPhase = $env:KIRO_BUDDY_REQUIRE_PHASE -eq "1" -or $Flags -contains "--require-phase"
$canResumeFromInput = $Status -eq "working" -and $existingStatus -in @("asking", "waiting")
$isSpecActivityDuringInput = $Status -eq "working" -and $resolvedPhase -and $existingStatus -in @("asking", "waiting")

if ($requiresPhase -and -not $resolvedPhase -and -not $canResumeFromInput) {
  Write-Output "Kiro Buddy: skipped $Status without phase"
  exit 0
}

if ($isSpecActivityDuringInput) {
  Write-Output "Kiro Buddy: skipped spec activity during input"
  exit 0
}

if (
  $resolvedPhase -and
  $Status -eq "working" -and
  [string]::IsNullOrWhiteSpace($env:KIRO_BUDDY_MESSAGE) -and
  [string]::IsNullOrWhiteSpace($env:USER_PROMPT) -and
  $message -eq $defaultMessages[$Status]
) {
  $message = "$($phaseTitles[$resolvedPhase]) in progress"
}

$payload = [ordered]@{
  status = $Status
  message = $message
  timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

if ($resolvedPhase) {
  $payload.phase = $resolvedPhase
}

$context = Get-TruncatedText $env:KIRO_BUDDY_CONTEXT
if (-not $context) {
  $fileContext = @(
    $env:KIRO_ACTIVE_FILE,
    $env:KIRO_FILE,
    $env:ACTIVE_FILE,
    $env:CURRENT_FILE,
    $env:WORKSPACE_FILE
  ) | ForEach-Object { Get-BasenameIfPath $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
  $context = Get-TruncatedText $fileContext
}
if (-not $context -and -not [string]::IsNullOrWhiteSpace($env:USER_PROMPT)) {
  $context = Get-TruncatedText "Prompt: $env:USER_PROMPT"
}
if (-not $context) {
  $eventPrompt = Get-EventValue $event @("prompt")
  if ($eventPrompt) {
    $context = Get-TruncatedText "Prompt: $eventPrompt"
  }
}
if (-not $context) {
  $eventContext = Get-EventValue $event @("file_path", "filePath", "path", "relative_path", "tool_name", "toolName", "tool", "hook_event_name", "hookEventName")
  if ($eventContext) {
    $context = Get-TruncatedText (Get-BasenameIfPath $eventContext)
  }
}
if ($context) {
  $payload.context = $context
}

$directory = Split-Path -Parent $statusFilePath
if (-not (Test-Path $directory)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$json = $payload | ConvertTo-Json -Compress
$tempFile = "$statusFilePath.$PID.tmp"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tempFile, "$json`n", $utf8NoBom)
Move-Item -Force -Path $tempFile -Destination $statusFilePath

$fallbackAskingMsText = Get-FlagValue "--fallback-asking-ms="
if ([string]::IsNullOrWhiteSpace($fallbackAskingMsText)) {
  $fallbackAskingMsText = Get-FlagValue "--fallback-waiting-ms="
}
if (
  $Status -eq "working" -and
  -not [string]::IsNullOrWhiteSpace($fallbackAskingMsText)
) {
  $scriptArgs = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $PSCommandPath,
    "asking",
    $(if ($resolvedPhase) { $resolvedPhase } else { "auto" }),
    "--status-file=$statusFilePath",
    "--delay-ms=$fallbackAskingMsText",
    "--started-at=$($payload.timestamp)"
  )
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "powershell.exe"
  $startInfo.Arguments = ($scriptArgs | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["KIRO_BUDDY_MESSAGE"] = "Kiro is asking for your input"
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($process) {
    $process.Dispose()
  }
}

Write-Output "Kiro Buddy: $Status"
