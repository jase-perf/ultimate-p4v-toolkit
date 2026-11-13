"""Draw the 36x36 tab icons used in the install XML (and on the site).

P4V shows an HTML Tab's icon on its tab and in the View menu. Icons are drawn
at 8x and scaled down, so edges stay smooth. They avoid thin dark outlines so
they read on both the light and dark P4V themes.

Usage:  uv run --no-project --with pillow python scripts/make_icons.py
Writes: site/icons/<tool>.png
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "icons"
SIZE = 36
S = 8  # supersampling factor
CANVAS = SIZE * S


def px(v: float) -> int:
    return round(v * S)


def rect(d: ImageDraw.ImageDraw, x0, y0, x1, y1, fill, r=1.2):
    d.rounded_rectangle([px(x0), px(y0), px(x1) - 1, px(y1) - 1], radius=px(r), fill=fill)


def finish(img: Image.Image, name: str) -> None:
    small = img.resize((SIZE, SIZE), Image.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    small.save(OUT / f"{name}.png", optimize=True)


def base() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def plate(d, fill="#1f3a5c"):
    """Rounded backing tile shared by all the icons."""
    rect(d, 1, 1, 35, 35, fill, r=6)


def project_activity():
    # Checked-out files as a treemap, each person a colour, one tile locked.
    img, d = base()
    plate(d)
    g = 1.2
    tiles = [
        (4, 4, 21, 22, "#3b82f6"),
        (21 + g, 4, 32, 14, "#f59e0b"),
        (21 + g, 14 + g, 32, 22, "#10b981"),
        (4, 22 + g, 13, 32, "#a855f7"),
        (13 + g, 22 + g, 24, 32, "#3b82f6"),
        (24 + g, 22 + g, 32, 32, "#ef4444"),
    ]
    for x0, y0, x1, y1, c in tiles:
        rect(d, x0, y0, x1, y1, c, r=1.4)
    # padlock on the big tile (an exclusive checkout)
    white = "#ffffff"
    cx, cy = 12.5, 13.5
    d.arc(
        [px(cx - 3.4), px(cy - 6.6), px(cx + 3.4), px(cy + 0.4)],
        start=180, end=360, fill=white, width=px(1.6),
    )
    d.line([px(cx - 3.4) + px(0.8), px(cy - 3.1), px(cx - 3.4) + px(0.8), px(cy)], fill=white, width=px(1.6))
    d.line([px(cx + 3.4) - px(0.8), px(cy - 3.1), px(cx + 3.4) - px(0.8), px(cy)], fill=white, width=px(1.6))
    rect(d, cx - 5, cy - 0.6, cx + 5, cy + 6.4, white, r=1.2)
    rect(d, cx - 0.8, cy + 1.4, cx + 0.8, cy + 4.2, "#3b82f6", r=0.6)
    finish(img, "project-activity")


def server_activity():
    # A GitHub-style activity calendar with a trend line across it.
    img, d = base()
    plate(d)
    levels = ["#2b4a6e", "#0e6b3a", "#16a34a", "#22c55e", "#86efac"]
    grid = [
        [0, 1, 2, 1, 3],
        [1, 2, 3, 2, 4],
        [2, 1, 4, 3, 3],
        [1, 3, 2, 4, 4],
        [0, 2, 3, 3, 2],
    ]
    cell, gap, ox, oy = 4.9, 1.3, 3.6, 3.6
    for row in range(5):
        for col in range(5):
            x = ox + col * (cell + gap)
            y = oy + row * (cell + gap)
            rect(d, x, y, x + cell, y + cell, levels[grid[row][col]], r=0.9)
    finish(img, "server-activity")


def depot_size_map():
    # Folder sizes as a squarified treemap in one hue, biggest darkest.
    img, d = base()
    plate(d)
    g = 1.2
    tiles = [
        (4, 4, 20, 32, "#0284c7"),
        (20 + g, 4, 32, 19, "#0ea5e9"),
        (20 + g, 19 + g, 27, 32, "#38bdf8"),
        (27 + g, 19 + g, 32, 26, "#7dd3fc"),
        (27 + g, 26 + g, 32, 32, "#bae6fd"),
    ]
    for x0, y0, x1, y1, c in tiles:
        rect(d, x0, y0, x1, y1, c, r=1.4)
    # size bars on the big tile, like a disk-usage readout
    white = (255, 255, 255, 235)
    for i, w in enumerate((10, 7, 4.5)):
        y = 22 + i * 3
        rect(d, 7, y, 7 + w, y + 1.8, white, r=0.9)
    finish(img, "depot-size-map")


def revert_exclusive():
    # An open padlock: freeing an exclusive checkout.
    img, d = base()
    plate(d)
    white = "#ffffff"
    cx, cy = 18, 19
    d.arc([px(cx - 6), px(cy - 14), px(cx + 6), px(cy - 2)], start=180, end=360, fill=white, width=px(2.4))
    d.line([px(cx - 6) + px(1.2), px(cy - 8), px(cx - 6) + px(1.2), px(cy - 5)], fill=white, width=px(2.4))
    rect(d, cx - 8, cy - 2, cx + 8, cy + 11, "#f59e0b", r=2)
    rect(d, cx - 1.2, cy + 1.8, cx + 1.2, cy + 6.8, "#1f3a5c", r=1)
    finish(img, "revert-exclusive-checkouts")


def virtual_stream():
    # A dashed stream box (how P4V draws a virtual stream) holding a
    # checklist: two folders ticked, one left out.
    img, d = base()
    plate(d)
    dash = "#7dd3fc"
    x0, y0, x1, y1 = 4.5, 4.5, 31.5, 31.5
    step, run = 4.0, 2.4
    t = 1.3
    x = x0
    while x < x1:
        e = min(x + run, x1)
        rect(d, x, y0, e, y0 + t, dash, r=0.4)
        rect(d, x, y1 - t, e, y1, dash, r=0.4)
        x += step
    y = y0
    while y < y1:
        e = min(y + run, y1)
        rect(d, x0, y, x0 + t, e, dash, r=0.4)
        rect(d, x1 - t, y, x1, e, dash, r=0.4)
        y += step
    white = "#ffffff"
    for i, on in enumerate((True, False, True)):
        top = 9 + i * 6.5
        box = "#22c55e" if on else "#2b4a6e"
        rect(d, 8.5, top, 13.5, top + 5, box, r=1)
        if on:
            d.line(
                [(px(9.6), px(top + 2.6)), (px(10.8), px(top + 3.8)), (px(12.6), px(top + 1.3))],
                fill=white, width=px(1.1), joint="curve",
            )
        rect(d, 15.5, top + 1.4, 27 if on else 24, top + 3.6, white if on else "#5b7aa0", r=1)
    finish(img, "virtual-stream-utility")


if __name__ == "__main__":
    project_activity()
    server_activity()
    depot_size_map()
    revert_exclusive()
    virtual_stream()
    print("Wrote icons to", OUT)
