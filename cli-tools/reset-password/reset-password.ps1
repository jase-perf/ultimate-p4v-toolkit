# Reset User Password - Windows (PowerShell)
#
# Source for a P4V / P4Admin Custom Tool. scripts/build_cli_tools.py encodes
# this file as base64 inside a short, space-free bootstrap command, because P4V
# splits a tool's Arguments on spaces and re-quotes them. The selected user (%u)
# arrives as $User.
#
# Sets a random temporary password for the selected user with 'p4 passwd'
# (answering its prompts through stdin, which works at every security level),
# requires a new password at next login, then prints a message to send to the
# user and copies it to the clipboard. Requires super access and p4 on PATH.

param($User)
$User = ([string]$User).Trim()
$nl = [Environment]::NewLine
function Stop-Tool($Message) { Write-Host ''; Write-Host $Message -ForegroundColor Red; Write-Host ''; Read-Host 'Press Enter to close' | Out-Null; exit 1 }
function Invoke-P4 { $out = & p4 @args 2>&1; $script:p4Exit = $LASTEXITCODE; return ((@($out) | ForEach-Object { $_.ToString() }) -join $nl).Trim() }

if (-not $User) { Stop-Tool 'No user was selected. Right-click a user and run Reset User Password again.' }
if (-not (Get-Command p4 -ErrorAction SilentlyContinue)) { Stop-Tool 'The p4 command line client was not found on your PATH. Install it, or add its folder to PATH, and try again.' }

# Super users only
$access = Invoke-P4 protects -m
if ($script:p4Exit -ne 0) { Stop-Tool ('Could not check your permissions:' + $nl + $access) }
if ($access -ne 'super') { Stop-Tool ('Reset User Password can only be run by a super user.' + $nl + 'Your highest access level on this server is: ' + $access) }

# The account must exist, not be LDAP, and not be your own
$found = Invoke-P4 -ztag users -a $User
if ($found -notmatch '(?m)^\.\.\. User ') { Stop-Tool ('There is no user named ' + $User + ' on this server.') }
$spec = Invoke-P4 user -o $User
if ($spec -match '(?mi)^AuthMethod:\s*ldap') { Stop-Tool ($User + ' signs in with LDAP, so their password is managed by your directory service, not Perforce.') }
$me = $env:P4USER
if (-not $me) { $me = ((Invoke-P4 -ztag info) -split $nl | Where-Object { $_ -like '... userName *' }) -replace '^\.\.\. userName ', '' }
if ($User -eq $me) { Stop-Tool 'This is your own account. Change your own password with Connection > Change Password in P4V instead.' }

Write-Host ('Resetting the password for ' + $User + '...')

# 12 characters from an alphabet without look-alikes (0/O, 1/l/I); must mix upper, lower and digits
$chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$buf = New-Object byte[] 1
do { $pw = ''; while ($pw.Length -lt 12) { $rng.GetBytes($buf); $b = [int]$buf[0]; if ($b -lt 228) { while ($b -ge 57) { $b -= 57 }; $pw += $chars[$b] } } } until (($pw -cmatch '[A-Z]') -and ($pw -cmatch '[a-z]') -and ($pw -match '[0-9]'))

# p4 passwd prompts twice for the new password; answer both through stdin
$result = (@(($pw + $nl + $pw + $nl) | & p4 passwd $User 2>&1) | ForEach-Object { $_.ToString() }) -join $nl
if ($LASTEXITCODE -ne 0) { Stop-Tool ('The password was not changed:' + $nl + $result.Trim()) }

$forced = Invoke-P4 admin resetpassword -u $User
$forceOk = ($script:p4Exit -eq 0)

# The message to send the user (shown and copied to the clipboard)
$line = '----------------------------------'
if ($forceOk) { $closing = 'You will be prompted to change it when you log in.' } else { $closing = 'Please change it after you log in.' }
$message = ('Your password has been reset.', 'You can log in with this temporary password:', '', $line, ('Username: ' + $User), ('Password: ' + $pw), $line, '', $closing) -join $nl
$copied = $false
try { Set-Clipboard -Value $message; $copied = $true } catch { $copied = $false }

Write-Host ''
Write-Host $message
Write-Host ''
if ($copied) { Write-Host ('This message is on your clipboard. Paste it straight to ' + $User + '.') -ForegroundColor Green } else { Write-Host 'Could not copy to the clipboard. Select the message above and copy it manually.' -ForegroundColor Yellow }
if (-not $forceOk) { Write-Host ('Note: the password was set, but requiring a new password at next login failed:' + $nl + $forced) -ForegroundColor Yellow }
Write-Host ''
Read-Host 'Press Enter to close' | Out-Null
