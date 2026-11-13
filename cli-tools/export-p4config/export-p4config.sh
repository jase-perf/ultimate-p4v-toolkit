# Export .p4config - macOS (zsh)
#
# Source for a P4V Custom Tool. scripts/build_cli_tools.py encodes this file as
# base64 inside a short, space-free bootstrap, because P4V splits a tool's
# Arguments on spaces and re-quotes them. The bootstrap runs a login zsh with
# IFS set to '^', so P4V's macros ($p $c $u $r) reach this script as $1-$4
# without a workspace root that contains spaces being split.
#
# Writes a P4CONFIG file (usually .p4config) to the root of the current
# workspace, holding P4PORT, P4USER and P4CLIENT, so the p4 command line and
# other tools pick the right server and workspace inside that folder. It never
# overwrites an existing file. Doesn't need p4 on PATH.

IFS=$' \t\n'
port=${1:-$P4PORT}
client=${2:-$P4CLIENT}
user=${3:-$P4USER}
root=$4
pause() { echo; echo 'Press Return to close.'; read -r _ </dev/tty; }
fail() { echo; echo "$*"; pause; exit 1; }

echo "Export .p4config: $client"
echo

[ -z "$client" ] || [ -z "$root" ] && fail 'P4V has no workspace selected. Choose a workspace in P4V, then run Export .p4config again.'
[ -z "$port" ] && fail 'P4V did not say which server it is connected to. Reconnect in P4V and try again.'
[ -d "$root" ] || fail "The workspace root $root does not exist on this computer. Get Latest in P4V creates it, or check the Root in the workspace settings."

# A P4 setting from the environment, or as saved by 'p4 set' (the P4ENVIRO file).
enviro=${P4ENVIRO:-$HOME/.p4enviro}
setting() {
  local value=${(P)1}
  [ -z "$value" ] && [ -f "$enviro" ] && value=$(sed -n "s/^$1=//p" "$enviro" | tail -n 1)
  echo "$value"
}

# p4 only reads the file named by P4CONFIG, so use that name if one is set.
name=$(setting P4CONFIG)
configured=1
[ -z "$name" ] && { name=.p4config; configured=0; }
name=${name##*/}
target="$root/$name"

if [ -e "$target" ]; then
  echo "$target already exists, so it was left as it is:"
  echo
  sed 's/^/  /' "$target"
  pause
  exit 0
fi

lines=("P4PORT=$port" "P4USER=$user" "P4CLIENT=$client")
# Both ignore files are only the default from P4 2023.2; name them for older versions,
# unless P4IGNORE is already set (that choice wins).
[ -z "$(setting P4IGNORE)" ] && lines+=('P4IGNORE=.p4ignore;p4ignore.txt')

printf '%s\n' "${lines[@]}" > "$target" 2>/dev/null || fail "Could not write $target. Check that you can write to that folder."

echo "Wrote $target:"
echo
printf '  %s\n' "${lines[@]}"
if [ "$configured" = 0 ]; then
  echo
  echo 'P4CONFIG is not set on this computer, so p4 will not read this file yet.'
  echo 'Run this once in Terminal to turn it on for every workspace:'
  echo
  echo '  p4 set P4CONFIG=.p4config'
fi
pause
