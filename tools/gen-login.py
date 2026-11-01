#!/usr/bin/env python3
"""Images of SynoFile's page in DSM's Login Portal (ui/images/login):
the wallpaper behind the login, its thumbnail, the title on the login
card, and the mask the Login Portal lays over the thumbnail.

    python3 tools/gen-login.py
"""

import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui/images/login"
ICON = ROOT / "ui/images/icon_256.png"
BOLD = "/usr/share/fonts/noto/NotoSans-Bold.ttf"
REGULAR = "/usr/share/fonts/noto/NotoSans-Regular.ttf"

TOP = (36, 48, 78)
BOTTOM = (12, 15, 22)
GLOWS = [((0.18, 0.30), 0.42, (122, 140, 255)), ((0.78, 0.72), 0.50, (165, 125, 255)), ((0.62, 0.18), 0.30, (96, 165, 250))]


def wallpaper(w, h, seed=7):
    """Night blue, two soft lights, and folders adrift."""
    img = Image.new("RGB", (w, h))
    px = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        px.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    for (cx, cy), r, c in GLOWS:
        R = r * w
        g.ellipse([cx * w - R, cy * h - R, cx * w + R, cy * h + R], fill=tuple(round(v * 0.32) for v in c))
    glow = glow.filter(ImageFilter.GaussianBlur(w / 9))
    img = ImageChops.add(img, glow)

    rnd = random.Random(seed)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    u = w / 1920
    for _ in range(26):
        s = rnd.uniform(70, 230) * u
        x, y = rnd.uniform(-0.05, 1.0) * w, rnd.uniform(-0.05, 1.0) * h
        a = rnd.randint(10, 30)
        col = rnd.choice([(150, 165, 255), (180, 150, 255), (120, 180, 255)])
        _folder(d, x, y, s, col + (a,), max(1, round(2 * u)))
    layer = layer.filter(ImageFilter.GaussianBlur(1.2 * u))
    img = Image.alpha_composite(img.convert("RGBA"), layer)
    return img.convert("RGB")


def _folder(d, x, y, s, col, line):
    """A folder outline: tab and body, rounded."""
    w, h = s, s * 0.74
    r = s * 0.09
    tab = [x, y, x + w * 0.42, y + h * 0.28]
    d.rounded_rectangle(tab, r, outline=col, width=line)
    d.rounded_rectangle([x, y + h * 0.14, x + w, y + h], r, outline=col, width=line, fill=col[:3] + (col[3] // 4,))


def title(scale):
    """Icon and name, as the login card shows them (340×62 at 1x)."""
    W, H = 340 * scale, 62 * scale
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    icon = Image.open(ICON).convert("RGBA").resize((46 * scale, 46 * scale), Image.LANCZOS)
    img.alpha_composite(icon, (2 * scale, 8 * scale))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(BOLD, 26 * scale)
    d.text((58 * scale, H / 2), "SynoFile", font=f, fill=(31, 35, 40, 255), anchor="lm")
    return img


def mask(scale):
    """The Login Portal's preview: a welcome on the left, the login card
    on the right, over a transparent ground (154×96 at 1x)."""
    k = 4  # drawn large, then shrunk: smooth edges
    W, H = 154 * scale, 96 * scale
    img = Image.new("RGBA", (W * k, H * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = scale * k
    white = (255, 255, 255, 255)
    d.text((7 * u, 7 * u), "SynoFile", font=ImageFont.truetype(BOLD, round(3.6 * u)), fill=white)
    d.text((15 * u, 46 * u), "Hello there, welcome", font=ImageFont.truetype(BOLD, round(4.6 * u)), fill=white)
    d.text((15 * u, 51.5 * u), "The files of your NAS, in two panes", font=ImageFont.truetype(REGULAR, round(2.4 * u)), fill=(255, 255, 255, 200))
    card = [92.5 * u, 20 * u, 137.5 * u, 76.5 * u]
    d.rectangle(card, fill=white)
    d.line([(97 * u, 26.5 * u), (101 * u, 26.5 * u)], fill=(0, 117, 255, 255), width=round(0.5 * u))
    d.text((97 * u, 22.5 * u), "Log in", font=ImageFont.truetype(REGULAR, round(1.8 * u)), fill=(0, 117, 255, 255))
    icon = Image.open(ICON).convert("RGBA").resize((round(4.4 * u), round(4.4 * u)), Image.LANCZOS)
    img.alpha_composite(icon, (round(97 * u), round(28 * u)))
    d.text((102.5 * u, 30.2 * u), "SynoFile", font=ImageFont.truetype(BOLD, round(2.6 * u)), fill=(31, 35, 40, 255), anchor="lm")
    d.text((97 * u, 35.5 * u), "Sign in", font=ImageFont.truetype(BOLD, round(2.4 * u)), fill=(31, 35, 40, 255))
    d.text((97 * u, 42.5 * u), "Username", font=ImageFont.truetype(REGULAR, round(1.7 * u)), fill=(150, 155, 165, 255))
    d.line([(97 * u, 46 * u), (133 * u, 46 * u)], fill=(215, 218, 224, 255), width=max(1, round(0.25 * u)))
    c = (137.5 * u, 60 * u)
    r = 4 * u
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=(0, 117, 255, 255))
    d.line([(c[0] - 1.6 * u, c[1]), (c[0] + 1.6 * u, c[1])], fill=white, width=round(0.5 * u))
    d.line([(c[0] + 0.4 * u, c[1] - 1.2 * u), (c[0] + 1.6 * u, c[1]), (c[0] + 0.4 * u, c[1] + 1.2 * u)], fill=white, width=round(0.5 * u))
    return img.resize((W, H), Image.LANCZOS)


def main():
    for s in (1, 2):
        d = OUT / f"{s}x"
        d.mkdir(parents=True, exist_ok=True)
        title(s).save(d / "title.png", optimize=True)
        mask(s).save(d / "loginui.png", optimize=True)
    big = wallpaper(2560, 1440)
    big.save(OUT / "2x/wallpaper.jpg", quality=84, optimize=True, progressive=True)
    big.resize((1920, 1080), Image.LANCZOS).save(OUT / "1x/wallpaper.jpg", quality=84, optimize=True, progressive=True)
    for s in (1, 2):
        # the thumbnail is 16:10: the middle of the 16:9 wallpaper
        big.resize((320 * s, 200 * s), Image.LANCZOS, box=(128, 0, 2432, 1440)).save(OUT / f"{s}x/thumbnail.png", optimize=True)


if __name__ == "__main__":
    main()
