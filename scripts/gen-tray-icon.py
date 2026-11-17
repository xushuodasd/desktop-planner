# -*- coding: utf-8 -*-
"""扁平苹果风托盘图标：蓝圆 + 细白对勾（SF Symbol 气质）。"""
from PIL import Image, ImageDraw
import os

assets = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'app', 'assets'))
os.makedirs(assets, exist_ok=True)


def flat_ball(size: int) -> Image.Image:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 纵向浅蓝→系统蓝
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(90 + (0 - 90) * t)      # #5ac8fa -> #007aff
        g = int(200 + (122 - 200) * t)
        b = int(250 + (255 - 250) * t)
        # 实际：#5ac8fa = 90,200,250 ; #007aff = 0,122,255
        r = int(90 + (0 - 90) * t)
        g = int(200 + (122 - 200) * t)
        b = int(250 + (255 - 250) * t)
        d.line([(0, y), (size - 1, y)], fill=(r, g, b, 255))
    # 圆形遮罩
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse([1, 1, size - 2, size - 2], fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    # 细白描边
    edge = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(edge).ellipse(
        [1, 1, size - 2, size - 2],
        outline=(255, 255, 255, 90),
        width=max(1, size // 32),
    )
    out = Image.alpha_composite(out, edge)
    # 细线对勾
    s = size / 56.0
    pts = [(17.5 * s, 29.2 * s), (24.8 * s, 36.2 * s), (39.2 * s, 20.8 * s)]
    width = max(2, round(3.2 * s))
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.line(pts, fill=(255, 255, 255, 255), width=width, joint='curve')
    r = width / 2.0
    for px, py in (pts[0], pts[-1]):
        ld.ellipse([px - r, py - r, px + r, py + r], fill=(255, 255, 255, 255))
    return Image.alpha_composite(out, layer)


def save_ico(img32: Image.Image, path: str):
    frames = []
    for s in (16, 24, 32):
        frames.append(img32.resize((s, s), Image.Resampling.LANCZOS) if s != 32 else img32)
    frames[0].save(path, format='ICO', sizes=[(16, 16), (24, 24), (32, 32)], append_images=frames[1:])


img = flat_ball(32)
for name in ('tray.png', 'tray-win.png'):
    p = os.path.join(assets, name)
    img.save(p)
    print('OK', p, os.path.getsize(p))

for name in ('tray.ico', 'tray-win.ico'):
    p = os.path.join(assets, name)
    save_ico(img, p)
    print('OK', p, os.path.getsize(p))
