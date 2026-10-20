# -*- coding: utf-8 -*-
"""生成商店素材，输出到 store/：

    python tools/make-store-assets.py

    store/screenshot-1-scene.png     1280x800  使用场景
    store/screenshot-2-panel.png     1280x800  面板特写 + 功能标注
    store/promo-large-640x400.png
    store/promo-small-440x280.png
    store/logo-300.png

用 PIL + 微软雅黑，中文标注能真实渲染。整套图按 2 倍超采样绘制再缩回，
边缘和文字都干净。

面板是照着 content.js 的真实布局和配色重画的，不是真实抓屏——商店允许
示意图，但要求与实际功能一致，所以尺寸、文案、控件位置都对齐源码。
"""

import os
from PIL import Image, ImageDraw, ImageFont

SCALE = 2
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "store")

FONT_R = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"

C = {
    "bg":       (11, 14, 18),
    "bg2":      (17, 26, 34),
    "panel":    (15, 18, 22),
    "head":     (20, 23, 28),
    "surface":  (22, 27, 34),
    "line":     (35, 42, 51),
    "text":     (230, 237, 243),
    "dim":      (139, 148, 158),
    "faint":    (107, 114, 128),
    "accent":   (34, 211, 238),
    "ok":       (63, 185, 80),
    "bad":      (248, 81, 73),
    "track":    (60, 66, 75),
    "white":    (255, 255, 255),
}


def S(v):
    return int(round(v * SCALE))


def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT_R, S(size))


def canvas(w, h, top, bottom=None):
    img = Image.new("RGB", (S(w), S(h)), top)
    if bottom is None:
        return img
    d = ImageDraw.Draw(img)
    for y in range(S(h)):
        t = y / max(1, S(h) - 1)
        col = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (S(w), y)], fill=col)
    return img


def glow(img, cx, cy, r, color, peak):
    """柔光：在深色底上叠一层低透明度径向渐变"""
    layer = Image.new("RGB", img.size, color)
    mask = Image.new("L", img.size, 0)
    md = ImageDraw.Draw(mask)
    x0, y0 = S(cx - r), S(cy - r)
    x1, y1 = S(cx + r), S(cy + r)
    steps = 26
    for i in range(steps, 0, -1):
        t = i / steps
        md.ellipse([x0 + (x1 - x0) * (1 - t) / 2, y0 + (y1 - y0) * (1 - t) / 2,
                    x1 - (x1 - x0) * (1 - t) / 2, y1 - (y1 - y0) * (1 - t) / 2],
                   fill=int(255 * peak * (1 - t) ** 2))
    img.paste(layer, (0, 0), mask)


def text(d, xy, s, size, color, bold=False, anchor="la"):
    d.text((S(xy[0]), S(xy[1])), s, font=font(size, bold), fill=color, anchor=anchor)


def text_w(d, s, size, bold=False):
    return d.textlength(s, font=font(size, bold)) / SCALE


# ---------------- 图标 ----------------
# 与 icons/ 同源造型：深色圆角底 + 两条错开的青色胶囊，中间断开

def draw_icon(img, x, y, size):
    d = ImageDraw.Draw(img)
    r = size * 0.22
    d.rounded_rectangle([S(x), S(y), S(x + size), S(y + size)], radius=S(r), fill=(14, 18, 24))

    bar_h = max(2.0, size * 0.16)
    half = bar_h / 2
    y1 = y + size * 0.36
    y2 = y + size * 0.64
    for (ax, bx, cy) in ((x + size * 0.20, x + size * 0.56, y1),
                         (x + size * 0.44, x + size * 0.80, y2)):
        d.rounded_rectangle([S(ax), S(cy - half), S(bx), S(cy + half)],
                            radius=S(half), fill=C["accent"])

    gap_w = max(1.0, size * 0.07)
    gap_x = x + size * 0.50
    for cy in (y1, y2):
        d.rectangle([S(gap_x - gap_w / 2), S(cy - half), S(gap_x + gap_w / 2), S(cy + half)],
                    fill=(14, 18, 24))


# ---------------- 面板 ----------------
# 尺寸取自 content.js：268 宽，头部 34，body 各控件按 CSS 像素

PANEL_W = 268
PANEL_H = 176


def draw_panel(img, x, y, k, ms, active=True, meter=0.62):
    d = ImageDraw.Draw(img)
    W, H = PANEL_W * k, PANEL_H * k
    r = 10 * k

    d.rounded_rectangle([S(x), S(y), S(x + W), S(y + H)], radius=S(r), fill=C["panel"])
    d.rounded_rectangle([S(x), S(y), S(x + W), S(y + H)], radius=S(r), outline=(45, 50, 58), width=max(1, S(0.6)))

    head_h = 34 * k
    d.rounded_rectangle([S(x), S(y), S(x + W), S(y + head_h)], radius=S(r), fill=C["head"])
    d.rectangle([S(x), S(y + head_h - r), S(x + W), S(y + head_h)], fill=C["head"])
    d.line([(S(x), S(y + head_h)), (S(x + W), S(y + head_h))], fill=(40, 46, 54), width=max(1, S(0.6)))

    cy = y + head_h / 2
    d.ellipse([S(x + 13 * k), S(cy - 3 * k), S(x + 19 * k), S(cy + 3 * k)],
              fill=C["ok"] if active else C["faint"])
    text(d, (x + 26 * k, cy), "音画偏移", 11.5 * k, C["text"], anchor="lm")
    text(d, (x + W - 20 * k, cy), "×", 13 * k, C["dim"], anchor="mm")
    text(d, (x + W - 38 * k, cy), "−", 13 * k, C["dim"], anchor="mm")

    body_y = y + head_h
    pad = 12 * k
    inner_w = W - pad * 2

    num = "%.3f" % (ms / 1000.0)
    num_size = 25 * k
    num_w = text_w(d, num, num_size, bold=True)
    unit_w = text_w(d, "s", 11 * k)
    start = x + (W - num_w - unit_w - 3 * k) / 2
    num_y = body_y + 20 * k
    text(d, (start, num_y), num, num_size, C["accent"] if ms > 0 else C["dim"],
         bold=True, anchor="lm")
    text(d, (start + num_w + 3 * k, num_y + 6 * k), "s", 11 * k, C["faint"], anchor="lm")

    tr_y = body_y + 44 * k
    d.rounded_rectangle([S(x + pad), S(tr_y - 1.5 * k), S(x + pad + inner_w), S(tr_y + 1.5 * k)],
                        radius=S(1.5 * k), fill=C["track"])
    ratio = min(1.0, ms / 10000.0)
    if ratio > 0.004:
        d.rounded_rectangle([S(x + pad), S(tr_y - 1.5 * k), S(x + pad + inner_w * ratio), S(tr_y + 1.5 * k)],
                            radius=S(1.5 * k), fill=C["accent"])
    tx = x + pad + inner_w * ratio
    d.ellipse([S(tx - 6 * k), S(tr_y - 6 * k), S(tx + 6 * k), S(tr_y + 6 * k)],
              fill=C["text"], outline=C["accent"], width=max(1, S(1.4 * k)))

    steps = ["−1s", "−100", "归零", "+100", "+1s"]
    btn_y = body_y + 58 * k
    btn_h = 20 * k
    gap = 4 * k
    btn_w = (inner_w - gap * 4) / 5
    for i, label in enumerate(steps):
        bx = x + pad + i * (btn_w + gap)
        d.rounded_rectangle([S(bx), S(btn_y), S(bx + btn_w), S(btn_y + btn_h)],
                            radius=S(4 * k), fill=(34, 39, 46), outline=(48, 54, 62), width=max(1, S(0.5)))
        text(d, (bx + btn_w / 2, btn_y + btn_h / 2), label, 10.5 * k, C["dim"], anchor="mm")

    met_y = body_y + 87 * k
    d.rounded_rectangle([S(x + pad), S(met_y), S(x + pad + inner_w), S(met_y + 2 * k)],
                        radius=S(1 * k), fill=(42, 47, 54))
    if active:
        d.rounded_rectangle([S(x + pad), S(met_y), S(x + pad + inner_w * meter), S(met_y + 2 * k)],
                            radius=S(1 * k), fill=C["ok"])

    foot_y = body_y + 100 * k
    text(d, (x + pad, foot_y + 5 * k), "悬停面板后 ←→ 微调", 10 * k, C["faint"], anchor="lm")

    stop_w, stop_h = 46 * k, 20 * k
    sx = x + W - pad - stop_w
    d.rounded_rectangle([S(sx), S(foot_y), S(sx + stop_w), S(foot_y + stop_h)],
                        radius=S(4 * k), fill=C["panel"], outline=(120, 50, 48), width=max(1, S(0.7)))
    text(d, (sx + stop_w / 2, foot_y + stop_h / 2), "停止", 10.5 * k, C["bad"], anchor="mm")


def draw_player(img, x, y, w, h, t=0.38):
    """视频播放器示意：画面 + 底部控件条"""
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([S(x + 2), S(y + 4), S(x + w + 2), S(y + h + 4)], radius=S(10), fill=(4, 6, 9))
    d.rounded_rectangle([S(x), S(y), S(x + w), S(y + h)], radius=S(10), fill=(10, 14, 19))

    vx, vy, vw, vh = x + 14, y + 14, w - 28, h - 96
    for i in range(S(vh)):
        tt = i / max(1, S(vh) - 1)
        col = (int(22 + 8 * (1 - tt)), int(33 + 10 * (1 - tt)), int(45 + 12 * (1 - tt)))
        d.line([(S(vx), S(vy) + i), (S(vx + vw), S(vy) + i)], fill=col)

    d.rectangle([S(vx), S(vy + vh * 0.64), S(vx + vw), S(vy + vh)], fill=(27, 39, 52))
    glow(img, vx + vw * 0.74, vy + vh * 0.40, 120, (91, 127, 168), 0.30)

    d.ellipse([S(vx + vw * 0.34 - 26), S(vy + vh * 0.46), S(vx + vw * 0.34 + 26), S(vy + vh * 0.46 + 52)],
              fill=(9, 13, 18))
    d.rounded_rectangle([S(vx + vw * 0.34 - 34), S(vy + vh * 0.62), S(vx + vw * 0.34 + 34), S(vy + vh)],
                        radius=S(22), fill=(9, 13, 18))

    by = y + h - 62
    d.rectangle([S(x + 14), S(by), S(x + w - 14), S(by + 48)], fill=(11, 16, 22))

    px, py = x + 34, by + 24
    d.polygon([(S(px), S(py - 8)), (S(px + 14), S(py)), (S(px), S(py + 8))], fill=(200, 208, 218))

    bar_x, bar_w = x + 62, w - 190
    d.rounded_rectangle([S(bar_x), S(by + 21), S(bar_x + bar_w), S(by + 26)], radius=S(2), fill=(42, 50, 61))
    d.rounded_rectangle([S(bar_x), S(by + 21), S(bar_x + bar_w * t), S(by + 26)], radius=S(2), fill=(200, 208, 218))
    d.ellipse([S(bar_x + bar_w * t - 5), S(by + 18.5), S(bar_x + bar_w * t + 5), S(by + 28.5)], fill=C["white"])
    text(d, (bar_x + 8, by + 34), "12:40 / 33:05", 11, (123, 135, 148))


def draw_browser_chrome(img, w):
    """顶部标签栏 + 地址栏"""
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, S(w), S(74)], fill=(13, 17, 23))
    d.line([(0, S(74)), (S(w), S(74))], fill=(28, 34, 42), width=max(1, S(0.6)))

    for i, col in enumerate([(237, 106, 94), (245, 191, 79), (98, 197, 84)]):
        cx = 20 + i * 16
        d.ellipse([S(cx - 5), S(14), S(cx + 5), S(24)], fill=col)

    d.rounded_rectangle([S(80), S(12), S(300), S(46)], radius=S(6), fill=(22, 27, 34))
    text(d, (94, 29), "视频页面", 12, C["dim"], anchor="lm")

    d.rounded_rectangle([S(320), S(46), S(1000), S(70)], radius=S(6), fill=(22, 27, 34))
    text(d, (336, 58), "https://", 10.5, C["faint"], anchor="lm")


def draw_toolbar_icon(img, x, y, size, hot=False):
    if hot:
        d = ImageDraw.Draw(img)
        d.ellipse([S(x - 7), S(y - 7), S(x + size + 7), S(y + size + 7)],
                  fill=(16, 42, 50), outline=C["accent"], width=max(1, S(1.2)))
    draw_icon(img, x, y, size)


# ---------------- 场景 1 ----------------

def screenshot_scene():
    img = canvas(1280, 800, (10, 13, 17), (17, 26, 34))
    glow(img, 1020, 160, 460, (34, 211, 238), 0.10)
    glow(img, 240, 700, 420, (43, 108, 176), 0.10)

    draw_browser_chrome(img, 1280)

    d = ImageDraw.Draw(img)
    for i in range(3):
        draw_icon(img, 1150 + i * 34, 20, 20)
    draw_toolbar_icon(img, 1150 + 2 * 34, 20, 20, hot=True)

    draw_player(img, 70, 110, 1140, 600, t=0.38)

    draw_panel(img, 70 + 1140 - 18 - PANEL_W, 110 + 600 - 18 - PANEL_H, 1.0, 2400)

    text(d, (70, 750), "点工具栏图标即可接管，面板浮在页面右下角，全屏时同样可用", 15, C["dim"])
    return img


# ---------------- 场景 2 ----------------

def screenshot_panel():
    img = canvas(1280, 800, (9, 12, 16), (15, 23, 31))
    glow(img, 380, 380, 420, (34, 211, 238), 0.09)

    d = ImageDraw.Draw(img)
    text(d, (80, 96), "面板就是全部界面", 30, C["text"], bold=True)
    text(d, (80, 146), "没有第二个弹窗，点图标接管，所有调节都在这里", 15, C["dim"])

    k = 1.75
    px, py = 80, 230
    draw_panel(img, px, py, k, 2400)
    pw, ph = PANEL_W * k, PANEL_H * k

    marks = [
        (py + (34 + 20) * k, "延迟读数", "拖动后立刻变化，单位是秒"),
        (py + (34 + 44) * k, "滑块", "0 ~ 10 秒，松手即生效"),
        (py + (34 + 58) * k, "步进按钮", "100 毫秒 / 1 秒 精调，归零一键回原点"),
        (py + (34 + 87) * k, "电平条", "绿色在跳，才说明真的出声了"),
        (py + (34 + 100) * k, "停止", "声音立刻回到页面，不留后台"),
    ]

    lx = px + pw + 74
    for my, title, desc in marks:
        d.ellipse([S(px + pw + 8), S(my - 3), S(px + pw + 14), S(my + 3)], fill=C["accent"])
        d.line([(S(px + pw + 14), S(my)), (S(lx - 16), S(my))], fill=(40, 60, 70), width=max(1, S(0.8)))
        text(d, (lx, my - 9), title, 15, C["text"], bold=True)
        text(d, (lx, my + 11), desc, 12.5, C["dim"])

    return img


# ---------------- 推广图 ----------------

def promo(w, h, k):
    img = canvas(w, h, (10, 16, 22), (16, 26, 35))
    glow(img, w * 0.82, h * 0.26, w * 0.38, (34, 211, 238), 0.12)
    glow(img, w * 0.10, h * 0.88, w * 0.30, (43, 108, 176), 0.10)

    d = ImageDraw.Draw(img)
    isz = h * 0.30
    ix, iy = w * 0.06, h * 0.13
    draw_icon(img, ix, iy, isz)

    title_size = max(15, h * 0.072)
    text(d, (ix, iy + isz + h * 0.10), "音画偏移", title_size, C["text"], bold=True)
    text(d, (ix, iy + isz + h * 0.10 + title_size * 1.45), "标签页音频延迟", max(10, h * 0.040), C["accent"])

    pk = max(0.42, h / 540.0)
    pxw = PANEL_W * pk
    draw_panel(img, w - pxw - w * 0.07, (h - PANEL_H * pk) / 2, pk, 2400)

    return img


def logo(size):
    img = Image.new("RGBA", (S(size), S(size)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    for i in range(3):
        r = size * 0.22
        d.rounded_rectangle([S(0), S(0), S(size), S(size)], radius=S(r), fill=(14, 18, 24, 255))

    bar_h = max(2.0, size * 0.16)
    half = bar_h / 2
    for (ax, bx, cy) in ((size * 0.20, size * 0.56, size * 0.36),
                         (size * 0.44, size * 0.80, size * 0.64)):
        d.rounded_rectangle([S(ax), S(cy - half), S(bx), S(cy + half)],
                            radius=S(half), fill=C["accent"] + (255,))

    gap_w = max(1.0, size * 0.07)
    gx = size * 0.50
    for cy in (size * 0.36, size * 0.64):
        d.rectangle([S(gx - gap_w / 2), S(cy - half), S(gx + gap_w / 2), S(cy + half)],
                    fill=(14, 18, 24, 255))

    mask = Image.new("L", (S(size), S(size)), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S(size) - 1, S(size) - 1],
                                           radius=S(size * 0.22), fill=255)
    base = Image.new("RGBA", (S(size), S(size)), (0, 0, 0, 0))
    base.paste(img, (0, 0), mask)
    return base


# ---------------- 输出 ----------------

os.makedirs(OUT, exist_ok=True)


def save(img, name, target=None):
    if target:
        img = img.resize((S(target[0]), S(target[1])), Image.LANCZOS) if img.size[0] != S(target[0]) else img
        img = img.resize(target, Image.LANCZOS)
    else:
        img = img.resize((img.size[0] // SCALE, img.size[1] // SCALE), Image.LANCZOS)
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print("store/%-28s %5.1f KB" % (name, os.path.getsize(path) / 1024.0))


save(screenshot_scene(), "screenshot-1-scene.png")
save(screenshot_panel(), "screenshot-2-panel.png")
save(promo(640, 400, 3), "promo-large-640x400.png")
save(promo(440, 280, 2), "promo-small-440x280.png")
save(logo(300), "logo-300.png")
