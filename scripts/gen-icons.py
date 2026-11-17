# -*- coding: utf-8 -*-
"""
程序化生成应用图标：渐变圆球 + 对勾母题（与悬浮球 SVG 同款母题）。
产出：app/assets/icon.png（256px）与 app/assets/icon.ico（多尺寸）。
用法：python scripts/gen-icons.py（仅使用 Pillow，无网络）
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, '..', 'app', 'assets'))
os.makedirs(ASSETS, exist_ok=True)

SIZE = 256
CENTER = (128.0, 118.0)   # 球心（略上移，给底部阴影留空间）
RADIUS = 114.0
FOCAL = (89.6, 71.7)      # 高光焦点（约 35%, 28%）

C_LIGHT = (127, 179, 255)  # #7fb3ff
C_MID = (47, 124, 246)     # #2f7cf6
C_DARK = (17, 74, 204)     # #114acc


def build_sphere() -> Image.Image:
    """逐像素径向渐变球体（RGBA，背景透明）。"""
    ys, xs = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    dx = xs - FOCAL[0]
    dy = ys - FOCAL[1]
    dist = np.sqrt(dx * dx + dy * dy)
    t = np.clip(dist / (RADIUS * 1.15), 0.0, 1.0)  # 归一化渐变进度
    t = t ** 1.35  # 让边缘更快压暗，接近 SVG 观感

    inside = (xs - CENTER[0]) ** 2 + (ys - CENTER[1]) ** 2 <= RADIUS * RADIUS
    alpha = np.where(inside, 255, 0).astype(np.uint8)

    # 双段插值：light -> mid（0~0.45），mid -> dark（0.45~1）
    rgb = np.zeros((SIZE, SIZE, 3), np.float64)
    seg1 = np.clip(t / 0.45, 0.0, 1.0)[..., None]
    seg2 = np.clip((t - 0.45) / 0.55, 0.0, 1.0)[..., None]
    light = np.array(C_LIGHT, np.float64)
    mid = np.array(C_MID, np.float64)
    dark = np.array(C_DARK, np.float64)
    rgb = light * (1 - seg1) + mid * seg1
    rgb = rgb * (1 - seg2) + dark * seg2

    arr = np.dstack([rgb.astype(np.uint8), alpha])
    img = Image.fromarray(arr, 'RGBA')

    # 顶部高光椭圆（白色渐隐），模拟玻璃球质感
    gloss = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(gloss)
    gdraw.ellipse([48, 28, 148, 92], fill=(255, 255, 255, 120))
    gloss = gloss.filter(ImageFilter.GaussianBlur(14))
    img = Image.alpha_composite(img, gloss)

    # 内描边收边，避免边缘发虚
    edge = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    edraw = ImageDraw.Draw(edge)
    edraw.ellipse(
        [CENTER[0] - RADIUS + 1, CENTER[1] - RADIUS + 1,
         CENTER[0] + RADIUS - 1, CENTER[1] + RADIUS - 1],
        outline=(255, 255, 255, 40), width=3,
    )
    img = Image.alpha_composite(img, edge)
    return img


def draw_check(img: Image.Image) -> Image.Image:
    """白色对勾：圆头线段 + 曲线连接。"""
    scale = SIZE / 56.0
    pts = [(17 * scale, 29.5 * scale), (24.5 * scale, 37 * scale), (39.5 * scale, 21.5 * scale)]
    width = max(8, round(4.5 * scale))  # ≈20px
    layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.line(pts, fill=(255, 255, 255, 245), width=width, joint='curve')
    r = width / 2.0
    for px, py in (pts[0], pts[-1]):
        d.ellipse([px - r, py - r, px + r, py + r], fill=(255, 255, 255, 245))
    return Image.alpha_composite(img, layer)


def add_shadow(img: Image.Image) -> Image.Image:
    """柔和底部投影。"""
    shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse(
        [CENTER[0] - RADIUS, CENTER[1] - RADIUS + 10,
         CENTER[0] + RADIUS, CENTER[1] + RADIUS + 10],
        fill=(10, 28, 63, 110),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    return Image.alpha_composite(shadow, img)


def main():
    icon = draw_check(build_sphere())
    icon = add_shadow(icon)
    png_path = os.path.join(ASSETS, 'icon.png')
    ico_path = os.path.join(ASSETS, 'icon.ico')
    icon.save(png_path)
    icon.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                               (64, 64), (128, 128), (256, 256)])
    print('OK ->', png_path)
    print('OK ->', ico_path)


if __name__ == '__main__':
    main()
