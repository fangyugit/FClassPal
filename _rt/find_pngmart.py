# -*- coding: utf-8 -*-
"""从 pngmart 搜索结果挖图片页链接。"""
import io
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
for name in ['kuromi', 'melody', 'cinnamo']:
    s = io.open(f'_m_{name}.html', encoding='utf-8', errors='ignore').read()
    pages = re.findall(r'https://www\.pngmart\.com/(?:image|files)/\d+/[^"\s<>]+?\.png', s)
    pages = sorted(set(pages))
    # 搜索页通常给的是图片页链接和缩略图直链
    item_pages = sorted(set(re.findall(r'https://www\.pngmart\.com/image/[^"\s<>]+/', s)))
    print(f'=== {name}: 直链 {len(pages)}，图片页 {len(item_pages)} ===')
    print('\n'.join((pages[:8] or item_pages[:8])))
