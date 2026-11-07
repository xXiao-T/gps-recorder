#!/usr/bin/env python3
"""生成 PWA 图标（开发期运行，产物提交到 icons/）。

设计：深海军蓝底 + 青色轨迹线 + 珊瑚色终点，对应「点迹」的定位+线路记录。
运行：python3 scripts/generate_icons.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
S = 1024  # 先在 4 倍尺寸绘制，再缩放到目标尺寸得到平滑边缘

BG_TOP = (11, 22, 40)
BG_BOTTOM = (18, 44, 78)
ROUTE = (79, 195, 255)
ROUTE_LIGHT = (160, 220, 255)
END_RING = (255, 255, 255)
END_DOT = (255, 93, 115)


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient_background() -> Image.Image:
    """竖直渐变背景。"""
    img = Image.new("RGB", (S, S))
    px = img.load()
    for y in range(S):
        t = y / (S - 1)
        color = tuple(lerp(BG_TOP[i], BG_BOTTOM[i], t) for i in range(3))
        for x in range(S):
            px[x, y] = color
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_route(draw: ImageDraw.ImageDraw, scale: float = 1.0) -> None:
    """按比例绘制轨迹折线与终点标记。scale 控制内容占画布比例。"""
    cx = cy = S / 2

    def pt(x: float, y: float) -> tuple[float, float]:
        return (cx + (x - 0.5) * S * scale, cy + (y - 0.5) * S * scale)

    points = [pt(0.24, 0.74), pt(0.45, 0.58), pt(0.38, 0.39), pt(0.68, 0.27)]
    width = round(S * 0.058 * scale)
    draw.line(points, fill=ROUTE, width=width, joint="curve")
    for p in points[:-1]:
        r = width * 0.46
        draw.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=ROUTE_LIGHT)

    end = points[-1]
    ring_r = S * 0.105 * scale
    draw.ellipse(
        (end[0] - ring_r, end[1] - ring_r, end[0] + ring_r, end[1] + ring_r),
        fill=END_RING,
    )
    dot_r = S * 0.068 * scale
    draw.ellipse(
        (end[0] - dot_r, end[1] - dot_r, end[0] + dot_r, end[1] + dot_r),
        fill=END_DOT,
    )


def render_icon(rounded: bool, content_scale: float) -> Image.Image:
    base = gradient_background().convert("RGBA")
    draw = ImageDraw.Draw(base)
    draw_route(draw, scale=content_scale)
    if rounded:
        mask = rounded_mask(S, radius=round(S * 0.22))
        base.putalpha(mask)
    return base


def save_icon(img: Image.Image, size: int, name: str) -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    out = img.resize((size, size), Image.LANCZOS)
    out.save(ICONS / name, format="PNG", optimize=True)
    print(f"wrote icons/{name} ({size}x{size})")


def main() -> None:
    normal = render_icon(rounded=True, content_scale=0.92)
    maskable = render_icon(rounded=False, content_scale=0.70)

    save_icon(normal, 512, "icon-512.png")
    save_icon(normal, 192, "icon-192.png")
    save_icon(maskable, 512, "icon-maskable-512.png")
    save_icon(normal, 180, "apple-touch-icon-180.png")


if __name__ == "__main__":
    main()
