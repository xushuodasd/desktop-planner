# -*- coding: utf-8 -*-
"""生成应用图标与托盘图标（方案 A：玻璃卡片）。

用法：python scripts/make-icons.py
输出：app/assets/icon.png（1024）、icon.ico（多尺寸）、tray-win.ico / tray-win.png 等
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "app", "assets")

S = 1024
SS = 4
W = S * SS
ACCENT = (94, 92, 230)


def rounded_mask(w, h, radius):
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, fill=255)
    return mask


def base_tile():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    g = Image.linear_gradient("L").resize((W, W))
    grad = ImageOps.colorize(g, black=(48, 53, 64), white=(13, 15, 19)).convert("RGBA")
    img.paste(grad, (0, 0), rounded_mask(W, W, int(W * 0.22)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((3 * SS, 3 * SS, W - 3 * SS, W - 3 * SS), radius=int(W * 0.22),
                        outline=(255, 255, 255, 30), width=int(2.2 * SS))
    return img


def glass_card(x, y, w, h, r, alpha_top=56, alpha_bottom=24, stroke=64):
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    body = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    alpha = Image.linear_gradient("L").resize((w, h)).point(
        lambda v: alpha_top - int((alpha_top - alpha_bottom) * v / 255))
    body.putalpha(alpha)
    card.paste(body, (0, 0), rounded_mask(w, h, r))
    ImageDraw.Draw(card).rounded_rectangle((0, 0, w - 1, h - 1), radius=r,
                                           outline=(255, 255, 255, stroke), width=int(2.4 * SS))
    return card


def icon_full():
    """完整图标：卡片 + 蓝点 + 三行条目"""
    img = base_tile()
    sh = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((216 * SS, 214 * SS, 792 * SS, 812 * SS),
                                         radius=104 * SS, fill=(0, 0, 0, 150))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(26 * SS)))
    img.alpha_composite(glass_card(228 * SS, 196 * SS, 568 * SS, 616 * SS, 96 * SS),
                        (228 * SS, 196 * SS))
    d = ImageDraw.Draw(img)
    d.ellipse((322 * SS, 332 * SS, 386 * SS, 396 * SS), fill=ACCENT + (255,))
    d.ellipse((338 * SS, 348 * SS, 370 * SS, 380 * SS), fill=(255, 255, 255, 235))
    d.rounded_rectangle((416 * SS, 338 * SS, 716 * SS, 374 * SS), radius=18 * SS, fill=(255, 255, 255, 238))
    d.rounded_rectangle((416 * SS, 436 * SS, 654 * SS, 468 * SS), radius=16 * SS, fill=(255, 255, 255, 120))
    d.rounded_rectangle((416 * SS, 514 * SS, 690 * SS, 546 * SS), radius=16 * SS, fill=(255, 255, 255, 66))
    return img


def icon_tray():
    """托盘图标：去掉卡片描边与第三行，元素更粗，16px 下仍可辨认"""
    img = base_tile()
    d = ImageDraw.Draw(img)
    d.ellipse((286 * SS, 300 * SS, 398 * SS, 412 * SS), fill=ACCENT + (255,))
    d.rounded_rectangle((452 * SS, 314 * SS, 792 * SS, 396 * SS), radius=41 * SS, fill=(255, 255, 255, 240))
    d.rounded_rectangle((452 * SS, 474 * SS, 700 * SS, 546 * SS), radius=36 * SS, fill=(255, 255, 255, 120))
    d.rounded_rectangle((452 * SS, 624 * SS, 748 * SS, 696 * SS), radius=36 * SS, fill=(255, 255, 255, 70))
    return img


def save_png(img, size, path):
    img.resize((size, size), Image.LANCZOS).save(path)


def save_ico(img, path, sizes):
    img.save(path, format="ICO", sizes=[(s, s) for s in sizes])


full = icon_full()
tray = icon_tray()

save_png(full, 1024, os.path.join(ASSETS, "icon.png"))
save_ico(full, os.path.join(ASSETS, "icon.ico"), [16, 20, 24, 32, 40, 48, 64, 128, 256])

for name in ("tray-win.png", "tray.png"):
    save_png(tray, 32, os.path.join(ASSETS, name))
for name in ("tray-win.ico", "tray.ico"):
    save_ico(tray, os.path.join(ASSETS, name), [16, 20, 24, 32, 40, 48])

print("icons written to", ASSETS)

