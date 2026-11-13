# Export .p4config - Windows (PowerShell)
#
# Source for a P4V Custom Tool. scripts/build_cli_tools.py encodes this file as
# base64 inside a short, space-free bootstrap command, because P4V splits a
# tool's Arguments on spaces and re-quotes them. P4V's macros follow a '#' at
# the end of that command ('# $p $c $u $r'), so PowerShell treats them as a
# comment and never parses them. This script reads them back from the process's
# own argument list instead, where a workspace root with spaces stays intact.
#
# Writes a P4CONFIG file (usually .p4config) to the root of the current
# workspace, holding P4PORT, P4USER and P4CLIENT, so the p4 command line and
# other tools pick the right server and workspace inside that folder. It never
# overwrites an existing file. Doesn't need p4 on PATH.

$nl = [Environment]::NewLine
function Stop-Tool($Message) { Write-Host ''; Write-Host $Message -ForegroundColor Red; Write-Host ''; Read-Host 'Press Enter to close' | Out-Null; exit 1 }
function Pause-Tool { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }

# The values after '#': port, workspace, user, then the root (which may have been split on spaces).
$all = [Environment]::GetCommandLineArgs()
$at = [Array]::IndexOf($all, '#')
$rest = if ($at -ge 0) { @($all[($at + 1)..($all.Length - 1)]) } else { @() }
$port = if ($rest.Count -gt 0) { $rest[0] } else { $env:P4PORT }
$client = if ($rest.Count -gt 1) { $rest[1] } else { $env:P4CLIENT }
$user = if ($rest.Count -gt 2) { $rest[2] } else { $env:P4USER }
$root = if ($rest.Count -gt 3) { ($rest[3..($rest.Count - 1)] -join ' ').Trim() } else { '' }

Write-Host ('Export .p4config: ' + $client)
Write-Host ''

if (-not $client -or -not $root) { Stop-Tool 'P4V has no workspace selected. Choose a workspace in P4V, then run Export .p4config again.' }
if (-not $port) { Stop-Tool 'P4V did not say which server it is connected to. Reconnect in P4V and try again.' }
if (-not (Test-Path -LiteralPath $root -PathType Container)) { Stop-Tool ('The workspace root ' + $root + ' does not exist on this computer.' + $nl + 'Get Latest in P4V creates it, or check the Root in the workspace settings.') }

# A P4 setting from the environment, or as saved by 'p4 set' (the registry).
function Get-P4Setting($Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { return $value }
  foreach ($key in 'HKCU:\Software\Perforce\environment', 'HKLM:\Software\Perforce\environment') {
    $item = Get-ItemProperty -LiteralPath $key -Name $Name -ErrorAction SilentlyContinue
    if ($item -and $item.$Name) { return $item.$Name }
  }
  return ''
}

# p4 only reads the file named by P4CONFIG, so use that name if one is set.
$configName = Get-P4Setting 'P4CONFIG'
$configured = [bool]$configName
if (-not $configured) { $configName = '.p4config' }
$configName = Split-Path -Leaf $configName
$target = Join-Path $root $configName

if (Test-Path -LiteralPath $target) {
  Write-Host ($target + ' already exists, so it was left as it is:')
  Write-Host ''
  Get-Content -LiteralPath $target | ForEach-Object { Write-Host ('  ' + $_) }
  Pause-Tool
  exit 0
}

$lines = @(('P4PORT=' + $port), ('P4USER=' + $user), ('P4CLIENT=' + $client))
# Both ignore files are only the default from P4 2023.2; name them for older versions,
# unless P4IGNORE is already set (that choice wins).
if (-not (Get-P4Setting 'P4IGNORE')) { $lines += 'P4IGNORE=.p4ignore;p4ignore.txt' }

try {
  [IO.File]::WriteAllText($target, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
} catch {
  Stop-Tool ('Could not write ' + $target + ':' + $nl + $_.Exception.Message)
}

Write-Host ('Wrote ' + $target + ':') -ForegroundColor Green
Write-Host ''
$lines | ForEach-Object { Write-Host ('  ' + $_) }
if (-not $configured) {
  Write-Host ''
  Write-Host 'P4CONFIG is not set on this computer, so p4 will not read this file yet.' -ForegroundColor Yellow
  Write-Host 'Run this once in a command prompt to turn it on for every workspace:'
  Write-Host ''
  Write-Host '  p4 set P4CONFIG=.p4config'
}
Pause-Tool
