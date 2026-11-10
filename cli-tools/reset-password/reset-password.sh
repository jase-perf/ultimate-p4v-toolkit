# Reset User Password - macOS (zsh)
#
# Source for a P4V / P4Admin Custom Tool. scripts/build_cli_tools.py encodes
# this file as base64 inside a short, space-free bootstrap, because P4V splits
# a tool's Arguments on spaces and re-quotes them. The bootstrap runs a login
# zsh (so p4 is found on the same PATH as in Terminal), decodes this script and
# pipes it into 'zsh -s' with the selected user (%u) as $1. Because the script
# arrives on stdin, interactive reads come from /dev/tty.
#
# Sets a random temporary password for the selected user with 'p4 passwd'
# (answering its prompts through stdin, which works at every security level),
# requires a new password at next login, then prints a message to send to the
# user and copies it to the clipboard. Requires super access and p4 on PATH.

export LC_ALL=C
user=$1
pause() { echo; echo 'Press Return to close.'; read -r _ </dev/tty; }
fail() { echo; echo $@; pause; exit 1; }

[ -z $user ] && fail No user was selected. Right-click a user and run Reset User Password again.
command -v p4 >/dev/null 2>&1 || fail The p4 command line client was not found on your PATH. Install it or add it to PATH in your shell profile, then try again.

# Super users only
access=$(p4 protects -m 2>&1) || fail Could not check your permissions: $access
case $access in super) ;; *) fail Reset User Password can only be run by a super user. Your highest access level on this server is: $access ;; esac

# The account must exist, not be LDAP, and not be your own
p4 -ztag users -a $user 2>/dev/null | grep -q '^[.][.][.] User ' || fail There is no user named $user on this server.
p4 user -o $user 2>/dev/null | grep -qi '^AuthMethod:[[:space:]]*ldap' && fail $user signs in with LDAP, so their password is managed by your directory service, not Perforce.
me=$P4USER
[ -z $me ] && me=$(p4 -ztag info 2>/dev/null | sed -n 's/^[.][.][.] userName //p')
[ x$user = x$me ] && fail This is your own account. Change your own password with Connection, Change Password in P4V instead.

echo "Resetting the password for $user..."

# 12 characters from an alphabet without look-alikes (0/O, 1/l/I); must mix upper, lower and digits
while true; do pw=$(tr -dc 'A-HJ-NP-Za-km-z2-9' < /dev/urandom | head -c 12); echo $pw | grep -q '[A-Z]' && echo $pw | grep -q '[a-z]' && echo $pw | grep -q '[0-9]' && break; done

# p4 passwd prompts twice for the new password; answer both through stdin
result=$( (echo $pw; echo $pw) | p4 passwd $user 2>&1 ) || fail The password was not changed: $result

forced=$(p4 admin resetpassword -u $user 2>&1) && forceok=1 || forceok=0

# The message to send the user (shown and copied to the clipboard)
if [ "$forceok" = 1 ]; then
  closing='You will be prompted to change it when you log in.'
else
  closing='Please change it after you log in.'
fi
message() {
  echo 'Your password has been reset.'
  echo 'You can log in with this temporary password:'
  echo
  echo '----------------------------------'
  echo "Username: $user"
  echo "Password: $pw"
  echo '----------------------------------'
  echo
  echo "$closing"
}
message | pbcopy 2>/dev/null && copied=1 || copied=0

echo
message
echo
if [ "$copied" = 1 ]; then
  echo "This message is on your clipboard. Paste it straight to $user."
else
  echo 'Could not copy to the clipboard. Select the message above and copy it manually.'
fi
[ "$forceok" = 1 ] || echo "Note: the password was set, but requiring a new password at next login failed: $forced"
pause
