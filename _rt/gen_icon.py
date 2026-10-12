# -*- coding: utf-8 -*-
"""FClassPal 应用图标（v2.4.6 重绘）。

用户点名：应用图标就用界面右下角那个"加号"卡片。设计取 add-card 的样子 ——
蓝紫渐变底 + 居中一块半透明白色圆角卡片 + 白色加号，一眼"添加快捷方式"。

输出（build/ 下）：
  icon.png            256px，Windows 风格圆角方底（exe 用）
  icon.ico            多尺寸条目
  icon-512.png        512px（electron-builder mac/linux 用）
  icon_fullsquare.png 不带圆角遮罩的满幅版本 —— 安卓自适应图标的前景层/圆形
                      图标用它：启动器自己拿蒙版裁形状，不会再出现"方里套方"
                      的圆角死角（用户报的"安卓图标圆角不对劲"就是那个）。

所有形状画在 2048px 大画布上再 LANCZOS 缩小，抗锯齿。
"""
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIG = 2048          # 绘制尺寸（最后缩小到目标）
C1, C2 = (0x2E, 0x6B, 0xF2), (0x6A, 0x3D, 0xF5)   # 管家蓝 -> 点缀紫（沿用旧版）
sys.stdout.reconfigure(encoding='utf-8')


def gradient(size):
    """对角线性渐变（左上蓝 -> 右下紫）"""
    grad = Image.new('RGBA', (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(C1, C2)) + (255,)
    return grad


def draw_addcard(img, s):
    """居中的 add-card：白色描边卡片 + 实心白加号（界面右下角同款）。
    卡片只描边不填充 —— 半透明填充会把加号淹没（白上白），描边既保留"卡片"
    的意象又给加号留足对比度。"""
    d = ImageDraw.Draw(img)
    tile = round(s * 0.44)
    tx = (s - tile) // 2
    ring = round(s * 0.022)
    d.rounded_rectangle([tx, tx, tx + tile, tx + tile],
                        radius=round(tile * 0.24),
                        outline=(255, 255, 255, 150), width=ring)
    # 加号：横竖两根圆角矩形，实心白（bar/half 比例小才像加号，粗了变方块）
    bar = round(tile * 0.065)
    half = round(tile * 0.24)
    cx = cy = s // 2
    d.rounded_rectangle([cx - half, cy - bar, cx + half, cy + bar],
                        radius=bar // 2, fill=(255, 255, 255, 240))
    d.rounded_rectangle([cx - bar, cy - half, cx + bar, cy + half],
                        radius=bar // 2, fill=(255, 255, 255, 240))


def build(square_rounded):
    """在 BIG 画布上画一版：square_rounded=True 加圆角遮罩（Windows 版）"""
    img = gradient(BIG)
    if square_rounded:
        mask = Image.new('L', (BIG, BIG), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, BIG - 1, BIG - 1], radius=round(BIG * 0.24), fill=255)
        out = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
    else:
        out = img
    draw_addcard(out, BIG)
    return out


def down(img, size):
    return img.resize((size, size), Image.LANCZOS)


def main():
    rounded = build(True)
    full = build(False)

    outdir = os.path.join(ROOT, 'build')
    os.makedirs(outdir, exist_ok=True)
    rounded.save(os.path.join(outdir, 'icon.png'))             # 256
    down(rounded, 512).save(os.path.join(outdir, 'icon-512.png'))
    full.save(os.path.join(outdir, 'icon_fullsquare.png'))     # 2048，安卓用
    rounded.save(os.path.join(outdir, 'icon.ico'),
                 sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                        (64, 64), (128, 128), (256, 256)])
    for f in ('icon.png', 'icon-512.png', 'icon_fullsquare.png', 'icon.ico'):
        p = os.path.join(outdir, f)
        print(f, os.path.getsize(p) // 1024, 'KB')


if __name__ == '__main__':
    main()
