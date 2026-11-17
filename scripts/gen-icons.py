# -*- coding: utf-8 -*-
"""
程序化生成应用图标：扁平苹果风蓝圆 + 细白对勾（与悬浮球 SVG 同款）。
产出：app/assets/icon.png（256px）与 app/assets/icon.ico（多尺寸）。
用法：python scripts/gen-icons.py（仅使用 Pillow）
"""
import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, '..', 'app', 'assets'))
os.makedirs(ASSETS, exist_ok=True)

SIZE = 256


def build_flat_icon() -> Image.Image:
    """圆角方标：系统蓝纵向渐变 + 细线对勾。"""
    ys = np.linspace(0, 1, SIZE).reshape(SIZE, 1, 1)
    top = np.array([90, 200, 250], np.float64)   # #5ac8fa
    bot = np.array([0, 122, 255], np.float64)    # #007aff
    rgb = np.broadcast_to(top * (1 - ys) + bot * ys, (SIZE, SIZE, 3))
    grad = np.zeros((SIZE, SIZE, 4), np.uint8)
    grad[:, :, :3] = rgb.astype(np.uint8)
    grad[:, :, 3] = 255
    base = Image.fromarray(grad, 'RGBA')

    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([8, 8, 247, 247], radius=56, fill=255)
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    img.paste(base, (0, 0), mask)

    # 极淡内描边
    edge = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [10, 10, 245, 245], radius=54, outline=(255, 255, 255, 70), width=3
    )
    edge_m = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    edge_m.paste(edge, (0, 0), mask)
    img = Image.alpha_composite(img, edge_m)

    scale = SIZE / 56.0
    pts = [(17.5 * scale, 29.2 * scale), (24.8 * scale, 36.2 * scale), (39.2 * scale, 20.8 * scale)]
    width = max(10, round(3.2 * scale * 1.15))
    layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.line(pts, fill=(255, 255, 255, 255), width=width, joint='curve')
    r = width / 2.0
    for px, py in (pts[0], pts[-1]):
        d.ellipse([px - r, py - r, px + r, py + r], fill=(255, 255, 255, 255))
    return Image.alpha_composite(img, layer)


def main():
    icon = build_flat_icon()
    png_path = os.path.join(ASSETS, 'icon.png')
    ico_path = os.path.join(ASSETS, 'icon.ico')
    icon.save(png_path)
    # Pillow：用 256 主图 + sizes= 一次写入多尺寸 ICO（含 256，electron-builder 要求）
    icon.save(
        ico_path,
        format='ICO',
        sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)],
    )
    print('OK ->', png_path)
    print('OK ->', ico_path)


if __name__ == '__main__':
    main()
