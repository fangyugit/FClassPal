# -*- coding: utf-8 -*-
"""批量下载 pngmart 候选图 → trim 透明边分析 → 白底预览拼图。"""
import io
import os
import sys
import urllib.request

from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '_char_src')
os.makedirs(SRC, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

NAMES = {
    'kuromi': ["Kuromi-PNG-HD.png", "Kuromi-PNG-Clipart.png", "Kuromi-PNG-Free-Download.png",
               "Kuromi-PNG-Isolated-HD.png", "Kuromi-PNG-File.png"],
    'melody': ["My-Melody-PNG-HD.png", "My-Melody-PNG-Clipart.png", "My-Melody-Download-PNG-Image.png",
               "My-Melody-PNG-Isolated-HD.png", "My-Melody-PNG-File.png"],
    'cinnamo': ["Cinnamoroll-PNG-HD-Isolated.png", "Cinnamoroll-PNG-Clipart.png",
                "Cinnamoroll-PNG-Isolated-HD.png", "Cinnamoroll-PNG-File.png", "Cinnamoroll-PNG-Image.png"],
}
for tag, lst in NAMES.items():
    for n in lst:
        dst = os.path.join(SRC, f"{tag}__{n}")
        if os.path.exists(dst):
            continue
        url = f"https://www.pngmart.com/files/23/{n}"
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=20) as r, open(dst, "wb") as f:
                f.write(r.read())
            print("DL", tag, n, os.path.getsize(dst) // 1024, "KB")
        except Exception as e:
            print("FAIL", tag, n, str(e)[:60])

# 白底预览拼图
rows = []
for fn in sorted(os.listdir(SRC)):
    if not fn.endswith('.png'):
        continue
    try:
        im = Image.open(os.path.join(SRC, fn)).convert('RGBA')
    except Exception:
        continue
    bbox = im.getchannel('A').getbbox()
    opaque = sum(im.getchannel('A').histogram()[250:]) / (im.width * im.height)
    rows.append((fn, im.size, bbox, opaque))
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    p = bg.convert('RGB')
    p.thumbnail((200, 200))
    p.save(os.path.join(SRC, '_p_' + fn.replace('.png', '.jpg')), 'JPEG', quality=85)

for fn, size, bbox, op in rows:
    print(f"{fn}: {size[0]}x{size[1]} bbox={bbox} 不透明={op:.0%}")

# 拼成 contact sheet
COLS, TW, TH = 5, 200, 220
files = [r[0] for r in rows]
sheet = Image.new('RGB', (COLS * TW, ((len(files) + COLS - 1) // COLS) * TH), (245, 245, 245))
d = ImageDraw.Draw(sheet)
for i, fn in enumerate(files):
    im = Image.open(os.path.join(SRC, '_p_' + fn.replace('.png', '.jpg')))
    x, y = (i % COLS) * TW, (i // COLS) * TH
    sheet.paste(im, (x + (TW - im.width) // 2, y + 4))
    d.text((x + 6, y + TH - 18), fn.replace('__', '/')[:38], fill=(0, 0, 0))
sheet.save(os.path.join(SRC, '_contact.jpg'), 'JPEG', quality=88)
print('contact ->', os.path.join(SRC, '_contact.jpg'))
