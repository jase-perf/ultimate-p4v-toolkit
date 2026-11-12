"""Build the importable P4V / P4Admin tool definition files.

Writes to site/xml/ (served by Pages, so admins can also point P4VJS.HTMLTabs /
P4VJS.HTMLWindows at the URLs):

  tabs.xml                 HTML Tabs     (Manage Tools > HTML Tabs > Import)
  windows.xml              HTML Windows for P4V     (%D)
  p4admin-windows.xml      HTML Windows for P4Admin (%F)
  custom-tools-windows.xml Custom Tools  (Manage Tools > Custom Tools > Import)
  custom-tools-macos.xml

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
    ("Project Activity", "tools/project-activity/index.html", "project-activity"),
    ("Server Activity", "tools/server-activity/index.html", "server-activity"),
    ("Depot Size Map", "tools/depot-size-map/index.html", "depot-size-map"),
    ("Typemap Editor", "tools/typemap/index.html", "typemap"),
    ("AI Help", "tools/ai-help/index.html", "ai-help"),
]

# (name, path, P4V argument, P4Admin argument or None, width, height, refresh)
WINDOWS = [
    ("Revert Exclusive Checkouts", "tools/revert-exclusive-checkouts/index.html", "%D", "%F", 960, 760, True),
    ("Project Activity (selected folders)", "tools/project-activity/index.html", "%D", None, 1280, 820, False),
    ("Depot Size Map (selected folder)", "tools/depot-size-map/index.html", "%D", None, 1280, 820, False),
]

CUSTOM_TOOLS = ["reset-password"]

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
    for name, path, p4v_arg, admin_arg, width, height, refresh in WINDOWS:
        arg = p4v_arg if app == "p4v" else admin_arg
        if arg is None:
            continue
        ident = uuid.uuid5(ID_NAMESPACE, f"{app}:{name}")
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


def custom_tools_xml(os_key: str) -> str:
    parts = [HEADER, '<CustomToolDefList varName="customtooldeflist">\n']
    for tool_id in CUSTOM_TOOLS:
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
        "tabs.xml": tabs_xml(),
        "windows.xml": windows_xml("p4v"),
        "p4admin-windows.xml": windows_xml("p4admin"),
        "custom-tools-windows.xml": custom_tools_xml("windows"),
        "custom-tools-macos.xml": custom_tools_xml("macos"),
    }
    for name, text in files.items():
        (OUT / name).write_text(text, encoding="utf-8", newline="\n")
        print("Wrote", OUT / name)


if __name__ == "__main__":
    main()
