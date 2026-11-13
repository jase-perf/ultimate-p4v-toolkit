"""Build the importable P4V / P4Admin tool definition files.

Writes to site/xml/ (served by Pages, so admins can also point P4VJS.HTMLTabs /
P4VJS.HTMLWindows at the URLs). File names avoid the word "windows" so it only
ever means the operating system:

  p4v-tabs.xml                   P4V HTML Tabs (Manage Tools > HTML Tabs > Import)
  p4v-right-click-tools.xml      P4V HTML Windows (Manage Tools > HTML Windows > Import)
  p4admin-right-click-tools.xml  The same for P4Admin (offered on the tool's card)
  p4v-custom-tools-pc.xml        P4V Custom Tools for Windows PCs
  p4v-custom-tools-mac.xml       P4V Custom Tools for Macs
  p4admin-custom-tools-pc.xml    P4Admin Custom Tools for Windows PCs
  p4admin-custom-tools-mac.xml   P4Admin Custom Tools for Macs
                                 (Manage Tools > Custom Tools > Import)

Each tool is offered one way only (a tab or a right-click window, not both),
so P4V's menus don't list the same tool twice.

Tab icons come from site/icons/<tool>.png (see scripts/make_icons.py).
Custom Tool commands come from site/custom-tools/<tool>.json
(see scripts/build_cli_tools.py), so run that first if a script changed.

Usage:  uv run --no-project python scripts/build_install_xml.py
"""

from __future__ import annotations

import base64
import json
import uuid
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = SITE / "xml"
BASE_URL = "https://jase.town/ultimate-p4v-toolkit/"

# Fixed namespace so each window keeps the same Identifier on every build.
ID_NAMESPACE = uuid.UUID("6f1d9a52-3c1e-4b8e-9a7e-2f0f5d4c8b11")

CONTEXT_MENUS = ["Back", "Forward", "Reload", "Stop", "Inspect"]

TABS = [
    ("Active Files", "tools/project-activity/index.html", "project-activity"),
    ("Server Activity", "tools/server-activity/index.html", "server-activity"),
    ("Depot Size Map", "tools/depot-size-map/index.html", "depot-size-map"),
    ("Typemap Editor (Admin)", "tools/typemap/index.html", "typemap"),
    ("AI Help", "tools/ai-help/index.html", "ai-help"),
]

# Tools that need elevated access say so in their name, so people can untick
# them in P4V's Import Preview.
#
# (key, name, path, P4V argument, P4Admin argument or None, width, height, refresh)
# The key seeds the window's Identifier, so renaming a window doesn't change it.
WINDOWS = [
    ("Revert Exclusive Checkouts", "Revert Exclusive Checkouts (Admin)", "tools/revert-exclusive-checkouts/index.html", "%D", "%F", 960, 760, True),
    ("Virtual Stream Utility", "Virtual Stream Utility", "tools/virtual-stream-utility/index.html", "%t", None, 1100, 800, True),
]

# Command-line Custom Tools, by the app they're meant for.
P4V_CUSTOM_TOOLS = ["export-p4config"]
P4ADMIN_CUSTOM_TOOLS = ["reset-password"]

HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<!--perforce-xml-version=1-->\n'


def icon(name: str) -> str:
    return base64.b64encode((SITE / "icons" / f"{name}.png").read_bytes()).decode("ascii")


def menus(indent: str) -> str:
    items = "".join(f"{indent}  <item>{m}</item>\n" for m in CONTEXT_MENUS)
    return f"{indent}<HTMLContextMenus>\n{items}{indent}</HTMLContextMenus>\n"


def tabs_xml() -> str:
    parts = [HEADER, '<HtmlTabList varName="htmltablist">\n']
    for name, path, icon_name in TABS:
        parts.append(
            "  <HtmlTab>\n"
            "    <Definition>\n"
            f"      <Name>{escape(name)}</Name>\n"
            f"      <Url>{escape(BASE_URL + path)}</Url>\n"
            f"      <Image>{icon(icon_name)}</Image>\n"
            "      <Shortcut></Shortcut>\n"
            + menus("      ")
            + "    </Definition>\n"
            "  </HtmlTab>\n"
        )
    parts.append("</HtmlTabList>\n")
    return "".join(parts)


def windows_xml(app: str) -> str:
    parts = [HEADER, '<HtmlWindowList varName="htmlwindowlist">\n']
    for key, name, path, p4v_arg, admin_arg, width, height, refresh in WINDOWS:
        arg = p4v_arg if app == "p4v" else admin_arg
        if arg is None:
            continue
        ident = uuid.uuid5(ID_NAMESPACE, f"{app}:{key}")
        parts.append(
            "  <HtmlWindow>\n"
            "    <Definition>\n"
            f"      <Name>{escape(name)}</Name>\n"
            f"      <Url>{escape(BASE_URL + path)}</Url>\n"
            f"      <Argument>{escape(arg)}</Argument>\n"
            "      <Shortcut></Shortcut>\n"
            f"      <Width>{width}</Width>\n"
            # P4V's own spelling.
            f"      <Heigth>{height}</Heigth>\n"
            + menus("      ")
            + f"      <Identifier>{ident}</Identifier>\n"
            "    </Definition>\n"
            "    <AddToContext>true</AddToContext>\n"
            + ("    <Refresh>true</Refresh>\n" if refresh else "")
            + "  </HtmlWindow>\n"
        )
    parts.append("</HtmlWindowList>\n")
    return "".join(parts)


def custom_tools_xml(os_key: str, tools: list[str]) -> str:
    parts = [HEADER, '<CustomToolDefList varName="customtooldeflist">\n']
    for tool_id in tools:
        tool = json.loads((SITE / "custom-tools" / f"{tool_id}.json").read_text(encoding="utf-8"))
        cmd = tool[os_key]
        options = tool.get("options", [])
        parts.append(
            "  <CustomToolDef>\n"
            "    <Definition>\n"
            f"      <Name>{escape(tool['name'])}</Name>\n"
            f"      <Command>{escape(cmd['application'])}</Command>\n"
            f"      <Arguments>{escape(cmd['arguments'])}</Arguments>\n"
            "      <Shortcut></Shortcut>\n"
            "    </Definition>\n"
            + (
                "    <Console>\n      <CloseOnExit>false</CloseOnExit>\n    </Console>\n"
                if "Run tool in terminal window" in options
                else ""
            )
            + ("    <AddToContext>true</AddToContext>\n" if "Add to applicable context menus" in options else "")
            + "  </CustomToolDef>\n"
        )
    parts.append("</CustomToolDefList>\n")
    return "".join(parts)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files = {
        "p4v-tabs.xml": tabs_xml(),
        "p4v-right-click-tools.xml": windows_xml("p4v"),
        "p4admin-right-click-tools.xml": windows_xml("p4admin"),
        "p4v-custom-tools-pc.xml": custom_tools_xml("windows", P4V_CUSTOM_TOOLS),
        "p4v-custom-tools-mac.xml": custom_tools_xml("macos", P4V_CUSTOM_TOOLS),
        "p4admin-custom-tools-pc.xml": custom_tools_xml("windows", P4ADMIN_CUSTOM_TOOLS),
        "p4admin-custom-tools-mac.xml": custom_tools_xml("macos", P4ADMIN_CUSTOM_TOOLS),
    }
    for name, text in files.items():
        (OUT / name).write_text(text, encoding="utf-8", newline="\n")
        print("Wrote", OUT / name)


if __name__ == "__main__":
    main()
