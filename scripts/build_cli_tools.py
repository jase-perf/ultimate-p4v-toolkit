"""Build P4V / P4Admin Custom Tool definitions from readable script sources.

P4V splits a Custom Tool's Arguments on spaces and re-quotes the pieces, and
treats '$' and '%' as its own macros ($u, %u, ...). A long script can't survive
that, so each readable source in cli-tools/<tool>/ is embedded as base64
inside a short bootstrap command that contains no spaces or quotes within any
argument. The selected item (e.g. %u) is passed as a normal argument.

Writes the exact Application and Arguments values to
site/custom-tools/<tool>.json for the site's index page.

Usage:  uv run --no-project python scripts/build_cli_tools.py
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "cli-tools"
OUTPUT = ROOT / "site" / "custom-tools"

TOOLS = {
    "reset-password": {
        "name": "Reset User Password",
        "description": (
            "Sets a random temporary password for the selected user, requires them to "
            "choose a new one at next login, and copies a ready-to-send message to your "
            "clipboard. Super users only. Needs the p4 command line client on PATH."
        ),
        "argument": "%u",
        "where": "P4Admin (or P4V), on a user",
        "options": [
            "Add to applicable context menus",
            "Run tool in terminal window",
        ],
    },
}


def b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def compact(source: str) -> str:
    """Drop blank lines and full-line comments (they're in the readable source)."""
    lines = [
        line.rstrip()
        for line in source.replace("\r\n", "\n").split("\n")
        if line.strip() and not line.lstrip().startswith("#")
    ]
    return "\n".join(lines) + "\n"


def windows_arguments(source: str, argument: str) -> str:
    # Every piece is space-free, so P4V's splitting yields exactly these arguments;
    # PowerShell's -Command joins them back with spaces.
    script = (
        "([scriptblock]::Create([Text.Encoding]::UTF8.GetString("
        f"[Convert]::FromBase64String('{b64(source)}'))))"
    )
    return f"-NoProfile -Command Invoke-Command -ScriptBlock {script} -ArgumentList {argument}"


def macos_arguments(source: str, tool: str, argument: str) -> str:
    # zsh doesn't word-split ${IFS} by default; -o shwordsplit lets it act as a space.
    # The leading ':;' (a no-op) keeps the first word from being an expansion.
    # '$$' is P4V's escape for a literal '$'.
    command = (
        f":;echo${{IFS}}{b64(source)}|base64${{IFS}}--decode|zsh${{IFS}}-s${{IFS}}--${{IFS}}$1"
    ).replace("$", "$$")
    return f"-o shwordsplit -lc {command} {tool} {argument}"


def check(arguments: str, argument: str) -> None:
    pieces = arguments.split(" ")
    stray = [p for p in pieces if '"' in p or ("%" in p and p != argument)]
    if stray:
        raise SystemExit(f"argument pieces contain quotes or stray '%': {stray}")


def build(tool: str, meta: dict) -> dict:
    folder = SOURCES / tool
    ps1 = (folder / f"{tool}.ps1").read_text(encoding="utf-8")
    sh = (folder / f"{tool}.sh").read_text(encoding="utf-8")
    windows = windows_arguments(compact(ps1), meta["argument"])
    macos = macos_arguments(compact(sh), tool, meta["argument"])
    check(windows, meta["argument"])
    check(macos, meta["argument"])
    return {
        "name": meta["name"],
        "description": meta["description"],
        "where": meta["where"],
        "options": meta["options"],
        "windows": {
            "application": "powershell.exe",
            "arguments": windows,
            "source": f"cli-tools/{tool}/{tool}.ps1",
        },
        "macos": {
            "application": "/bin/zsh",
            "arguments": macos,
            "source": f"cli-tools/{tool}/{tool}.sh",
        },
    }


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for tool, meta in TOOLS.items():
        try:
            definition = build(tool, meta)
        except SystemExit as err:
            print(f"{tool}: {err}", file=sys.stderr)
            return 1
        path = OUTPUT / f"{tool}.json"
        path.write_text(json.dumps(definition, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)}")
        for os_name in ("windows", "macos"):
            arguments = definition[os_name]["arguments"]
            print(f"  {os_name}: {definition[os_name]['application']} ({len(arguments)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
