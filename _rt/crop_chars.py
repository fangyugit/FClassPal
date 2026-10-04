# -*- coding: utf-8 -*-
"""裁剪三丽鸥角色贴图到 renderer/theme/<name>/。
步骤：加载 RGBA -> alpha-bbox 去透明边 -> (可选)按比例截取区域 -> LANCZOS 缩放 -> 保存。
最后拼一张预览图供人工确认。"""
import os
import sys

from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '_char_src')
ROOT = os.path.dirname(HERE)  # desktop-widget/

# (源文件, 主题子目录, 输出名, 目标最长边, 裁剪分数(x0,y0,x1,y1) 或 None)
JOBS = [
    # ---- kitty 增补（原有 head/full/sit 不动）----
    ('kitty2__Hello-Kitty-PNG-Clipart.png', 'kitty', 'kitty-wave.png', 110, None),
    ('kitty2__Pink-Kitty-PNG-Clipart.png', 'kitty', 'kitty-ballet.png', 100, None),
    # ---- 库洛米 ----
    ('kuromi__Kuromi-PNG-Clipart.png', 'kuromi', 'kuromi-stand.png', 115, None),
    ('kuromi__Kuromi-PNG-File.png', 'kuromi', 'kuromi-love.png', 95, None),
    ('kuromi__Kuromi-PNG-HD.png', 'kuromi', 'kuromi-face.png', 80, None),
    ('kuromi__Kuromi-PNG-Clipart.png', 'kuromi', 'kuromi-head.png', 64, (0.10, 0.28, 0.90, 0.62)),
    # ---- 美乐蒂 ----
    ('melody__My-Melody-PNG-Clipart.png', 'melody', 'melody-full.png', 115, None),
    ('melody__My-Melody-PNG-HD.png', 'melody', 'melody-cheer.png', 95, None),
    ('melody__My-Melody-PNG-HD.png', 'melody', 'melody-head.png', 64, (0.18, 0.30, 0.92, 0.72)),
    # ---- 玉桂狗（dog 主题真实贴图）----
    ('cinnamo__Cinnamoroll-PNG-Clipart.png', 'dog', 'cinna-plane.png', 115, None),
    ('cinnamo__Cinnamoroll-PNG-File.png', 'dog', 'cinna-wink.png', 95, None),
    ('cinnamo__Cinnamoroll-PNG-File.png', 'dog', 'cinna-head.png', 64, (0.02, 0.02, 0.62, 0.62)),
    # ---- v2.2.2 补充贴图（每主题加料 + sanrio 混合主题用）----
    ('kuromi__Kuromi-PNG-Free-Download.png', 'kuromi', 'kuromi-lie.png', 95, None),
    ('kuromi__Kuromi-PNG-Isolated-HD.png', 'kuromi', 'kuromi-cry.png', 80, None),
    ('cinnamo__Cinnamoroll-PNG-Isolated-HD.png', 'dog', 'cinna-bike.png', 95, None),
    ('cinnamo__Cinnamoroll-PNG-HD-Isolated.png', 'dog', 'cinna-berry.png', 85, None),
    ('melody__My-Melody-Download-PNG-Image.png', 'melody', 'melody-emb.png', 95, None),
    ('kitty2__Kitty-Cat-PNG-Clipart.png', 'kitty', 'kitty-kimono.png', 95, None),
]


def trim(im):
    bbox = im.getchannel('A').getbbox()
    return im.crop(bbox) if bbox else im


def main():
    thumbs = []
    for src, sub, name, size, frac in JOBS:
        im = Image.open(os.path.join(SRC, src)).convert('RGBA')
        im = trim(im)
        if frac:
            w, h = im.size
            im = im.crop((int(w * frac[0]), int(h * frac[1]), int(w * frac[2]), int(h * frac[3])))
            im = trim(im)
        s = size / max(im.size)
        if s < 1:
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
        out_dir = os.path.join(ROOT, 'renderer', 'theme', sub)
        os.makedirs(out_dir, exist_ok=True)
        out = os.path.join(out_dir, name)
        im.save(out, 'PNG', optimize=True)
        print(f'{src} -> theme/{sub}/{name}: {im.width}x{im.height}, {os.path.getsize(out)//1024}KB')
        prev = im.copy()
        prev.thumbnail((130, 130), Image.LANCZOS)
        thumbs.append((sub + '/' + name, prev))

    # 预览拼图（4 列）
    cols, cw, ch = 4, 150, 165
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new('RGBA', (cols * cw, rows * ch), (245, 245, 245, 255))
    d = ImageDraw.Draw(sheet)
    for i, (name, t) in enumerate(thumbs):
        x, y = (i % cols) * cw, (i // cols) * ch
        sheet.alpha_composite(t, (x + (cw - t.width) // 2, y + 5 + (140 - t.height) // 2))
        d.text((x + 4, y + 148), name, fill=(60, 60, 60, 255))
    sheet.convert('RGB').save(os.path.join(HERE, '_crop_sheet.jpg'), quality=88)
    print('sheet -> _rt/_crop_sheet.jpg')


if __name__ == '__main__':
    main()
