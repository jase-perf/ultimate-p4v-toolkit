# Reset User Password (Custom Tool)

Right-click a user, run the tool, and it:

1. checks that you're a super user (and stops with an explanation if not)
2. refuses LDAP accounts and your own account
3. asks you to press Enter to confirm
4. sets a random 12-character temporary password with `p4 passwd`
5. requires the user to choose a new password at next login (`p4 admin resetpassword -u`)
6. prints a message you can send to the user, and puts it on your clipboard:

```
----------------------------------
Username: jdoe
Password: AuQtTU6Uw37s
----------------------------------
```

It's a command-line Custom Tool rather than an HTML Window. At security level 2 and above, `p4 passwd` only accepts the new password at its prompts, and P4V's JavaScript API can't answer prompts. The `p4` command line client can, so it must be installed and on your PATH.

## Setup

In P4Admin (or P4V), go to **Tools > Manage Tools > Custom Tools**, choose **New > Tool…**, and enter:

| Field | Value |
|---|---|
| Name | Reset User Password |
| Application | Windows: `powershell.exe` · macOS: `/bin/zsh` |
| Arguments | Copy the value for your OS from the [toolkit site](https://jase.town/ultimate-p4v-toolkit/), or from [`site/custom-tools/reset-password.json`](../../site/custom-tools/reset-password.json) |
| Add to applicable context menus | ✓ |
| Run tool in terminal window | ✓ |

Paste the Arguments exactly as shown, without adding quotes around them. The value ends with `%u`, the selected user.

On macOS the tool runs a login `zsh`, so `p4` is found on the same PATH as in Terminal.

## How the Arguments work

P4V splits a Custom Tool's Arguments on spaces and re-quotes the pieces before launching the program, so a long script with spaces and quotes doesn't survive intact. The Arguments therefore carry the script encoded as base64, inside a short bootstrap in which no piece contains a space or quote:

- **Windows:** `-NoProfile -Command Invoke-Command -ScriptBlock ([scriptblock]::Create(…FromBase64String('…'))) -ArgumentList %u`
- **macOS:** `-o shwordsplit -lc :;echo${IFS}…|base64${IFS}--decode|zsh${IFS}-s${IFS}--${IFS}$1 reset-password %u` (written with `$$` in the Arguments, which is P4V's escape for `$`)

The base64 decodes to the readable sources here, minus comments and blank lines: [`reset-password.ps1`](reset-password.ps1) (Windows) and [`reset-password.sh`](reset-password.sh) (macOS).

## Editing

After changing a source file, regenerate the Arguments values:

```
uv run --no-project python scripts/build_cli_tools.py
```

This writes [`site/custom-tools/reset-password.json`](../../site/custom-tools/reset-password.json), which the toolkit site displays.
