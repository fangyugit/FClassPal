# -*- coding: utf-8 -*-
"""生成管家助手应用图标：蓝紫渐变圆角方底 + 2×2 白色圆角磁贴（快捷方式启动器隐喻）。
输出 build/icon.png（256px）与 build/icon.ico（16-256 多尺寸，PNG 条目）。"""
import os, sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 256
sys.stdout.reconfigure(encoding='utf-8')

# 1) 对角渐变底：左上 #2E6BF2（管家蓝）→ 右下 #6A3DF5（点缀紫）
grad = Image.new('RGBA', (S, S))
px = grad.load()
c1, c2 = (0x2E, 0x6B, 0xF2), (0x6A, 0x3D, 0xF5)
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S - 2)
        px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(c1, c2)) + (255,)

# 2) Windows 风格圆角方底（半径 ~22%）
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=56, fill=255)
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
img.paste(grad, (0, 0), mask)

# 3) 2×2 白色圆角磁贴（右下角那块用淡蓝，暗示"添加快捷方式"）
d = ImageDraw.Draw(img)
tile = 88; gap = 20
x0 = (S - 2 * tile - gap) // 2
y0 = (S - 2 * tile - gap) // 2
for r in range(2):
    for c in range(2):
        tx, ty = x0 + c * (tile + gap), y0 + r * (tile + gap)
        if r == 1 and c == 1:  # 右下：虚线感"添加"格（半透明白）
            d.rounded_rectangle([tx, ty, tx + tile, ty + tile], radius=22,
                                fill=(255, 255, 255, 92))
            # 中央十字（加号）
            d.rounded_rectangle([tx + tile//2 - 6, ty + 26, tx + tile//2 + 6, ty + tile - 26],
                                radius=6, fill=(255, 255, 255, 220))
            d.rounded_rectangle([tx + 26, ty + tile//2 - 6, tx + tile - 26, ty + tile//2 + 6],
                                radius=6, fill=(255, 255, 255, 220))
        else:
            d.rounded_rectangle([tx, ty, tx + tile, ty + tile], radius=22,
                                fill=(255, 255, 255, 255))

outdir = os.path.join(ROOT, 'build')
os.makedirs(outdir, exist_ok=True)
img.save(os.path.join(outdir, 'icon.png'))
# ICO：PIL 按sizes表自动从 256 图缩出各尺寸条目
img.save(os.path.join(outdir, 'icon.ico'),
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon.png', os.path.getsize(os.path.join(outdir, 'icon.png')) // 1024, 'KB')
print('icon.ico', os.path.getsize(os.path.join(outdir, 'icon.ico')) // 1024, 'KB')
