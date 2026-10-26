"""Render the DSH Recovery console icon: dark rounded tile + amber restart loop.

The loop is built from explicit polygons (an annulus segment plus a triangular
arrowhead whose base is a radial line), so the two pieces join exactly and the
arrow keeps clean, predictable proportions at every size.
"""
import math
import os
from PIL import Image, ImageDraw

SS = 4  # supersample factor
SIZE = 1024
W = SIZE * SS

OUT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET_DIR = os.path.join(OUT_DIR, "app", "assets")
os.makedirs(ASSET_DIR, exist_ok=True)

AMBER = (0xF2, 0xA4, 0x1F, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        color = lerp(top, bottom, y / (size - 1))
        for x in range(size):
            px[x, y] = color
    return img


def rounded_mask(size, inset, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [inset, inset, size - 1 - inset, size - 1 - inset], radius=radius, fill=255
    )
    return mask


def ring_segment(cx, cy, r_out, r_in, a_from, a_to, steps=720):
    """Polygon of an annulus segment, angles in degrees (PIL convention)."""
    outer, inner = [], []
    for i in range(steps + 1):
        a = math.radians(a_from + (a_to - a_from) * i / steps)
        ca, sa = math.cos(a), math.sin(a)
        outer.append((cx + r_out * ca, cy + r_out * sa))
        inner.append((cx + r_in * ca, cy + r_in * sa))
    return outer + inner[::-1]


def main():
    tile = vertical_gradient(W, (0x2A, 0x2F, 0x39), (0x11, 0x14, 0x19))
    inset, radius = int(28 * SS), int(224 * SS)

    icon = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    icon.paste(tile, (0, 0), rounded_mask(W, inset, radius))

    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle(
        [inset, inset, W - 1 - inset, W - 1 - inset],
        radius=radius,
        outline=(255, 255, 255, 24),
        width=int(3 * SS),
    )

    cx = cy = W / 2
    r = 244 * SS          # loop centre-line radius
    w = 84 * SS           # stroke width
    r_out, r_in = r + w / 2, r - w / 2

    # Clockwise sweep (increasing angle in PIL's y-down space) from the upper
    # right, all the way round, ending at the upper left. The +360 keeps the
    # sweep going the long way instead of collapsing to the short gap.
    start, end = 300.0, 228.0 + 360.0

    draw.polygon(ring_segment(cx, cy, r_out, r_in, start, end), fill=AMBER)

    # Arrowhead sits at the terminal angle (end mod 360) with a radial base.
    a = math.radians(end)
    ca, sa = math.cos(a), math.sin(a)
    tx, ty = -sa, ca                      # clockwise tangent
    head_len = 1.15 * w
    head_half = 0.95 * w
    tip = (cx + r * ca + tx * head_len, cy + r * sa + ty * head_len)
    b1 = (cx + (r + head_half) * ca, cy + (r + head_half) * sa)
    b2 = (cx + (r - head_half) * ca, cy + (r - head_half) * sa)
    draw.polygon([tip, b1, b2], fill=AMBER)

    # Centre dot: the "core" the loop restarts.
    dot_r = 50 * SS
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=(255, 255, 255, 255))

    icon = icon.resize((SIZE, SIZE), Image.LANCZOS)

    png_path = os.path.join(ASSET_DIR, "icon.png")
    icon.save(png_path, "PNG")

    ico_path = os.path.join(ASSET_DIR, "icon.ico")
    icon.save(ico_path, "ICO", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])

    # A 32px preview, to judge legibility at taskbar/shortcut size.
    icon.resize((32, 32), Image.LANCZOS).resize((256, 256), Image.NEAREST).save(
        os.path.join(OUT_DIR, ".runtime", "icon-32-preview.png"), "PNG"
    )

    print("wrote", png_path, os.path.getsize(png_path), "bytes")
    print("wrote", ico_path, os.path.getsize(ico_path), "bytes")


if __name__ == "__main__":
    main()
