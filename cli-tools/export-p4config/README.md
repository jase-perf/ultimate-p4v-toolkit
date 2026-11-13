# Export .p4config (Custom Tool)

Run it from P4V's **Tools** menu and it writes a `.p4config` file to the root of your current workspace:

```
P4PORT=ssl:perforce.example.com:1666
P4USER=jdoe
P4CLIENT=jdoe_game_ws
P4IGNORE=.p4ignore;p4ignore.txt
```

With that file in place, the `p4` command line, game engines and other tools that read P4 settings connect to the same server, as the same user, with the same workspace as P4V whenever they work inside that folder.

- **It never overwrites a file.** If one is already there, it shows you what's in it and leaves it alone.
- **It uses your P4CONFIG name.** `p4` only reads the file named by the P4CONFIG setting. If you've set it (for example to `p4config.txt`), the tool writes that file. If P4CONFIG isn't set, it writes `.p4config` and tells you the one command that turns it on: `p4 set P4CONFIG=.p4config`.
- **P4IGNORE names both ignore files.** From P4 Server 2023.2 (with the 2023.2 `p4` client or P4V 2023.4) `.p4ignore` and `p4ignore.txt` are read by default. Before that there was no default, so the line makes older servers and clients read them too ([P4IGNORE reference](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/P4IGNORE.html)). It's left out if P4IGNORE is already set on your computer, so your own setting still applies.
- **It doesn't need `p4` installed.** P4V passes in the server, user, workspace and root (`$p $c $u $r`).

It's a command-line Custom Tool rather than an HTML tool, because P4V's JavaScript API can't write files.

## Setup

Import [`p4v-custom-tools-pc.xml`](https://jase.town/ultimate-p4v-toolkit/xml/p4v-custom-tools-pc.xml) (Windows) or [`p4v-custom-tools-mac.xml`](https://jase.town/ultimate-p4v-toolkit/xml/p4v-custom-tools-mac.xml) (Mac) in P4V under **Tools > Manage Tools > Custom Tools > Import**.

Or add it by hand under **Tools > Manage Tools > Custom Tools**, **New > Tool…**:

| Field | Value |
|---|---|
| Name | Export .p4config |
| Application | Windows: `powershell.exe` · macOS: `/bin/zsh` |
| Arguments | Copy the value for your OS from the [toolkit site](https://jase.town/ultimate-p4v-toolkit/), or from [`site/custom-tools/export-p4config.json`](../../site/custom-tools/export-p4config.json) |
| Run tool in terminal window | ✓ |

Paste the Arguments exactly as shown, without adding quotes. They end with `$p $c $u $r`.

## How the Arguments work

P4V splits a Custom Tool's Arguments on spaces, so the script travels as base64 inside a short command in which no piece has a space or quote (see [Reset User Password](../reset-password/README.md#how-the-arguments-work)). This tool has one more problem: the workspace root often contains spaces, and it must reach the script as one value.

- **Windows:** the macros come after a `#`, so PowerShell treats them as a comment and never parses them: `… -ScriptBlock (…) # $p $c $u $r`. The script reads them from `[Environment]::GetCommandLineArgs()`, where each one is still a separate value. The root comes last, so if it ever arrives in pieces they're joined back together.
- **macOS:** the bootstrap sets `IFS=^`. `${IFS}` still separates the words of the bootstrap itself, but `$@` is split only on `^`, so a root with spaces reaches the script as `$4`.

The base64 decodes to the readable sources here, minus comments and blank lines: [`export-p4config.ps1`](export-p4config.ps1) (Windows) and [`export-p4config.sh`](export-p4config.sh) (macOS).

## Editing

After changing a source file, regenerate the Arguments and the import files:

```
uv run --no-project python scripts/build_cli_tools.py
uv run --no-project python scripts/build_install_xml.py
```
