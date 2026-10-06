#!/usr/bin/env python3
"""Regenerates the PWA icons and shortcut icons in public/icons (iOS launch screens: scripts/gen-ios-splash.mjs). Run: python3 scripts/gen-pwa-assets.py (needs Pillow and
rsvg-convert, `brew install librsvg`). The mark is the two pills from src/app/icon.svg (24-unit box: 6.9..17.1 x 4.5..19.5)."""
from PIL import Image, ImageDraw
import io, os, subprocess

OUT = os.path.join(os.path.dirname(__file__), "..", "public")
DARK = (16, 21, 24)  # manifest background_color
GREEN, BLUE = (0, 241, 159), (31, 160, 240)
SS = 4  # supersample

def mark(img, cx, cy, height):
    """Draws the two pills so the whole mark is `height` px tall, centred on (cx, cy)."""
    u = height / 15  # px per unit
    d = ImageDraw.Draw(img)
    for x, y, color in ((6.9, 4.5, GREEN), (12.9, 8.5, BLUE)):
        x0, y0 = cx + (x - 12) * u, cy + (y - 12) * u
        d.rounded_rectangle([x0, y0, x0 + 4.2 * u, y0 + 11 * u], radius=2.1 * u, fill=color)

def render(w, h, bg, mark_h, path):
    img = Image.new("RGB", (w * SS, h * SS), bg)
    mark(img, w * SS / 2, h * SS / 2, mark_h * SS)
    img.resize((w, h), Image.LANCZOS).save(os.path.join(OUT, path), optimize=True)

# Icons carry the mark only, no name: Android 12+ builds its launch screen from the home-screen (adaptive) icon, so a name
# in the icon would sit on the home screen too. The name lives on the iOS launch screens (scripts/gen-ios-splash.mjs).
for s in (192, 512):
    render(s, s, DARK, s * 0.34, f"icons/icon-{s}.png")
    # maskable: the launcher crops to a circle or squircle, so the mark stays inside the 80% safe zone (a circle of radius 40%).
    render(s, s, DARK, s * 0.5, f"icons/icon-maskable-{s}.png")

# App shortcut icons (long-press menu): a glyph on a transparent background. Android draws these on the launcher's own grey
# disc (#999), like the "Site settings" gear beside them, so a square of our own colour would show as a box inside it.
# Deep tones of the brand colours: the bright green and blue all but vanish on that grey (blue's contrast is 1.0).
SHORTCUTS = {"checkin": DARK, "recovery": (0, 100, 62), "sleep": (13, 71, 161)}
for name, color in SHORTCUTS.items():
    svg = open(os.path.join(os.path.dirname(__file__), "shortcuts", f"{name}.svg")).read().replace("currentColor", f"rgb{color}")
    glyph = Image.open(io.BytesIO(subprocess.run(["rsvg-convert", "-w", str(192 * SS * 3 // 4), "-f", "png"], input=svg.encode(), capture_output=True, check=True).stdout)).convert("RGBA")
    img = Image.new("RGBA", (192 * SS, 192 * SS), (0, 0, 0, 0))
    img.paste(glyph, ((192 * SS - glyph.width) // 2, (192 * SS - glyph.height) // 2), glyph)
    img.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, f"icons/shortcut-{name}.png"), optimize=True)
