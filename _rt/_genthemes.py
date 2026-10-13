# -*- coding: utf-8 -*-
"""v2.5.0 新增 8 套角色主题的 CSS 生成器。

骨架来自 theme-kitty 块（_rt/_kitty_tpl.css，298 行，68 个选择器）。
每套主题注入：
  ① 完整独立的 --md3-* 角色配色（十套不共底 → 现在十八套不共底）
  ② 原创矢量贴纸（SVG data-URL，不引版权图）：
     标题栏头像 / 主区贴纸 / USB 区 / 面板水印 / 弹窗 / 右键菜单六个槽位
  ③ 分组标题的项目符号（爪印/布丁/奶瓶/音符/麦克风/葱/法棍/鲸尾）

跑法：python _rt/_genthemes.py   （直接改写 renderer/style.css，幂等）
"""
import io
import re
import os
from urllib.parse import quote

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
TPL = io.open(os.path.join(ROOT, '_rt', '_kitty_tpl.css'), encoding='utf-8').read()
CSS_PATH = os.path.join(ROOT, 'renderer', 'style.css')


def rgb(h):
    h = h.lstrip('#')
    return ' '.join(str(int(h[i:i + 2], 16)) for i in (0, 2, 4))


def svgurl(svg):
    """SVG → data URL。全部转义，保证能安全塞进 url("...")。"""
    return 'url("data:image/svg+xml,' + quote(svg, safe='') + '")'


# ---------------------------------------------------------------- 贴纸模板
def head_svg(c):
    """标题栏头像（viewBox 0 0 80 90）。c: body/hair/acc/blush 颜色。
    kind: ears=兽耳垂耳 / twintails=双马尾 / whale=鲸鱼耳鳍。"""
    kind = c['kind']
    extra = ''
    if kind == 'ears':
        # 两只垂耳（一深一浅更有精神）
        extra = ('<path d="M16 34 Q8 10 26 16 Q34 20 32 34 Z" fill="%s"/>'
                 '<path d="M64 34 Q72 10 54 16 Q46 20 48 34 Z" fill="%s"/>'
                 % (c['hair'], c['body']))
    elif kind == 'twintails':
        extra = ('<path d="M12 38 Q2 22 14 14 Q22 22 20 40 Z" fill="%s"/>'
                 '<path d="M68 38 Q78 22 66 14 Q58 22 60 40 Z" fill="%s"/>'
                 % (c['hair'], c['hair']))
    elif kind == 'whale':
        extra = ('<path d="M14 30 Q6 20 12 12 Q22 16 24 28 Z" fill="%s"/>'
                 '<path d="M66 30 Q74 20 68 12 Q58 16 56 28 Z" fill="%s"/>'
                 % (c['acc'], c['acc']))
    # 呆毛/顶饰
    top = '<circle cx="40" cy="12" r="7" fill="%s"/>' % c['acc']
    return ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 90'>"
            + extra
            + '<ellipse cx="40" cy="52" rx="30" ry="28" fill="%s"/>'
            % c['body']
            + top
            + '<circle cx="30" cy="50" r="3.6" fill="#3A3A3A"/>'
            + '<circle cx="50" cy="50" r="3.6" fill="#3A3A3A"/>'
            + '<ellipse cx="22" cy="58" rx="5" ry="3" fill="%s"/>'
            % c['blush']
            + '<ellipse cx="58" cy="58" rx="5" ry="3" fill="%s"/>' % c['blush']
            + '<path d="M36 60 Q40 64 44 60" stroke="#3A3A3A" stroke-width="2" fill="none" stroke-linecap="round"/>'
            + '</svg>')


def full_svg(c):
    """完整立绘（viewBox 0 0 100 120）：头 + 小身子 + 脚。"""
    kind = c['kind']
    extra = ''
    if kind == 'ears':
        extra = ('<path d="M20 40 Q12 16 30 22 Q38 26 36 40 Z" fill="%s"/>'
                 '<path d="M80 40 Q88 16 70 22 Q62 26 64 40 Z" fill="%s"/>'
                 % (c['hair'], c['body']))
    elif kind == 'twintails':
        # 长双马尾垂到身侧（teto 用卷螺感=两段圆弧）
        d = 'Q2 30 16 20 Q26 30 22 56 Q20 70 12 76' if c['kind'] == 'twintails' else ''
        extra = ('<path d="M22 44 %s" stroke="%s" stroke-width="9" fill="none" stroke-linecap="round"/>'
                 '<path d="M78 44 Q98 30 84 20 Q74 30 78 56 Q80 70 88 76" stroke="%s" stroke-width="9" fill="none" stroke-linecap="round"/>'
                 % (d, c['hair'], c['hair']))
    elif kind == 'whale':
        extra = ('<path d="M18 42 Q6 30 14 20 Q28 26 30 42 Z" fill="%s"/>'
                 '<path d="M82 42 Q94 30 86 20 Q72 26 70 42 Z" fill="%s"/>' % (c['acc'], c['acc']))
    return ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 120'>"
            + extra
            # 身体
            + '<rect x="34" y="76" width="32" height="30" rx="14" fill="%s"/>' % c['cloth']
            # 头
            + '<ellipse cx="50" cy="52" rx="30" ry="28" fill="%s"/>' % c['body']
            # 头顶饰
            + '<circle cx="50" cy="16" r="7" fill="%s"/>' % c['acc']
            + '<circle cx="40" cy="50" r="3.4" fill="#3A3A3A"/>'
            + '<circle cx="60" cy="50" r="3.4" fill="#3A3A3A"/>'
            + '<ellipse cx="32" cy="58" rx="4.6" ry="2.8" fill="%s"/>' % c['blush']
            + '<ellipse cx="68" cy="58" rx="4.6" ry="2.8" fill="%s"/>' % c['blush']
            + '<path d="M46 60 Q50 64 54 60" stroke="#3A3A3A" stroke-width="2" fill="none" stroke-linecap="round"/>'
            # 手 + 脚
            + '<circle cx="30" cy="88" r="6" fill="%s"/>' % c['body']
            + '<circle cx="70" cy="88" r="6" fill="%s"/>' % c['body']
            + '<ellipse cx="42" cy="106" rx="7" ry="4.4" fill="%s"/>' % c['acc']
            + '<ellipse cx="58" cy="106" rx="7" ry="4.4" fill="%s"/>' % c['acc']
            + '</svg>')


def bullet_svg(path):
    return ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>"
            + path + '</svg>')


BULLETS = {
    'paw': "<circle cx='8' cy='10' r='3.4' fill='ACC'/>"
           "<circle cx='3.6' cy='6.2' r='1.7' fill='ACC'/><circle cx='6.8' cy='4' r='1.7' fill='ACC'/>"
           "<circle cx='10' cy='3.4' r='1.6' fill='ACC'/><circle cx='12.8' cy='6' r='1.7' fill='ACC'/>",
    'pudding': "<path d='M3 7 Q3 2.4 8 2.4 Q13 2.4 13 7 Z' fill='ACC'/>"
               "<rect x='2.6' y='7' width='10.8' height='4.4' rx='1.6' fill='ACC'/>"
               "<circle cx='8' cy='2' r='1.3' fill='ACC'/>",
    'bottle': "<rect x='6' y='1.6' width='4' height='2.4' rx='0.8' fill='ACC'/>"
              "<path d='M5.6 4 Q5.6 5.6 4.6 7 Q4 8 4 10 L4 12.4 Q4 14.4 6 14.4 L10 14.4 Q12 14.4 12 12.4 L12 10 Q12 8 11.4 7 Q10.4 5.6 10.4 4 Z' fill='ACC'/>",
    'note': "<rect x='10.6' y='2' width='1.8' height='8.6' fill='ACC'/>"
            "<path d='M12.4 2 L12.4 4 Q14.8 4.4 14.8 6.4 Q13.4 5.4 12.4 5.6 Z' fill='ACC'/>"
            "<ellipse cx='8.4' cy='11.4' rx='3' ry='2.3' fill='ACC'/>",
    'mic': "<rect x='6.2' y='1.6' width='3.6' height='7' rx='1.8' fill='ACC'/>"
           "<path d='M4.4 7.6 Q4.4 11 8 11 Q11.6 11 11.6 7.6' stroke='ACC' stroke-width='1.6' fill='none' stroke-linecap='round'/>"
           "<rect x='7.2' y='11' width='1.6' height='3.4' fill='ACC'/>",
    'leek': "<path d='M8 15 Q6.4 9 6.8 3.4 L8 1.6 L9.2 3.4 Q9.6 9 8 15 Z' fill='ACC'/>"
            "<path d='M6.8 3.4 Q4.4 2 3 4.6 Q5.2 5.6 6.9 4.6 Z' fill='ACC'/>"
            "<path d='M9.2 3.4 Q11.6 2 13 4.6 Q10.8 5.6 9.1 4.6 Z' fill='ACC'/>",
    'bread': "<path d='M2.6 10.4 Q2.6 6.4 5.4 6.4 Q5.6 4.4 8 4.4 Q10.4 4.4 10.6 6.4 Q13.4 6.4 13.4 10.4 Q13.4 12 12 12 L4 12 Q2.6 12 2.6 10.4 Z' fill='ACC'/>"
             "<path d='M5.2 8 L5.2 10.2 M8 7.6 L8 10.6 M10.8 8 L10.8 10.2' stroke='#FFFFFF' stroke-width='1.2' stroke-linecap='round'/>",
    'tail': "<path d='M8 14 L8 9 Q8 6.4 5 6 Q2.6 5.6 3 3 Q6 2.6 7.4 4.4 Q8 5.2 8 6 Q8 5.2 8.6 4.4 Q10 2.6 13 3 Q13.4 5.6 11 6 Q8 6.4 8 9 Z' fill='ACC'/>",
}

# ---------------------------------------------------------------- 8 套配色
THEMES = [
    dict(key='pochacco', label='帕恰狗', kind='ears', bullet='paw',
         ACC='#4D8FE0', PC='#DCE9FB', PC_ON='#2E5580', SEC='#3A72C4', SC='#D6E4FA',
         SC_ON='#2A4C74', TER='#6BA3E8', TC='#E3EEFC', TC_ON='#35609A',
         SURF='#FBFDFF', SDIM='#E2EBF6', SFC='#EEF5FD', SFCH='#DCE9FB',
         ONS='#3A4A5E', OSV='#7C8FA6', OL='#A9C4E8', OLV='#D8E6F8', VB='#BBD5F3',
         ASOFT='#E3EEFC', ADEEP='#8FB6E8', VMID='240 247 255', VEND='224 237 252',
         body='#FFFFFF', hair='#4A4A4A', cloth='#EAF2FD', blush='#F5B9C8'),
    dict(key='purin', label='布丁狗', kind='ears', bullet='pudding',
         ACC='#D9962E', PC='#FBEDCB', PC_ON='#7A5616', SEC='#C08420', SC='#F8E3B8',
         SC_ON='#6E4E12', TER='#E8B45C', TC='#FCF1D9', TC_ON='#7A5A1E',
         SURF='#FFFCF4', SDIM='#F0E6CC', SFC='#FBF3DD', SFCH='#F7EAC8',
         ONS='#5E4A26', OSV='#A08A5E', OL='#DCC894', OLV='#F1E5C4', VB='#E8D5A4',
         ASOFT='#FBF0D4', ADEEP='#E3C078', VMID='253 248 235', VEND='250 240 218',
         body='#F7CE46', hair='#C8963C', cloth='#FBEBC4', blush='#F0A884'),
    dict(key='milk', label='奶娃', kind='ears', bullet='bottle',
         ACC='#C08552', PC='#F4E4D2', PC_ON='#6E4A2E', SEC='#A96F42', SC='#F0DCC4',
         SC_ON='#62422A', TER='#D8A878', TC='#F9EEDF', TC_ON='#6E5032',
         SURF='#FFFCF8', SDIM='#EFE2D2', SFC='#F8EEE0', SFCH='#F2E3D0',
         ONS='#55442F', OSV='#9A8468', OL='#D6BEA2', OLV='#EDDFCC', VB='#E0CCB2',
         ASOFT='#F7EBDC', ADEEP='#D8B28C', VMID='254 250 244', VEND='250 242 230',
         body='#FFFFFF', hair='#E8DCC8', cloth='#F6EBDC', blush='#F0B8A8'),
    dict(key='tianyi', label='洛天依', kind='twintails', bullet='note',
         ACC='#2FA98C', PC='#D6F0E8', PC_ON='#1E6B58', SEC='#237E68', SC='#D2EBE3',
         SC_ON='#1C5C4C', TER='#46BDA0', TC='#E1F4EE', TC_ON='#226A58',
         SURF='#F9FCFB', SDIM='#DFEBE8', SFC='#ECF5F2', SFCH='#DFF0EA',
         ONS='#33473F', OSV='#74968B', OL='#A3C9BC', OLV='#D5E9E2', VB='#B4D8CC',
         ASOFT='#E1F4EE', ADEEP='#7CC4B0', VMID='242 250 247', VEND='228 243 237',
         body='#E8E4DE', hair='#B8B2AA', cloth='#DCEFE8', blush='#F0A8A0'),
    dict(key='ling', label='乐正绫', kind='twintails', bullet='mic',
         ACC='#D8433F', PC='#FBDCDA', PC_ON='#7E2422', SEC='#BC3A36', SC='#F8D4D2',
         SC_ON='#6E201E', TER='#E06A64', TC='#FBEBE9', TC_ON='#7E302C',
         SURF='#FFFBFA', SDIM='#F1DEDC', SFC='#FAECEA', SFCH='#F5DCDA',
         ONS='#55302E', OSV='#A47572', OL='#DFA9A5', OLV='#F2D8D5', VB='#E8BCB8',
         ASOFT='#FAE7E5', ADEEP='#E48B86', VMID='254 245 243', VEND='251 233 230',
         body='#F6E0DA', hair='#C8403C', cloth='#F8DAD6', blush='#F0A098'),
    dict(key='miku', label='初音未来', kind='twintails', bullet='leek',
         ACC='#1FB5AA', PC='#D2F2EE', PC_ON='#14655E', SEC='#23A69B', SC='#CCEFE9',
         SC_ON='#135650', TER='#52C7BC', TC='#E0F6F2', TC_ON='#18685F',
         SURF='#F8FCFB', SDIM='#DCEBE9', SFC='#EAF4F2', SFCH='#DEF0ED',
         ONS='#2E4643', OSV='#6F938D', OL='#9FCBC4', OLV='#D3E9E5', VB='#AEDCD5',
         ASOFT='#DFF4F0', ADEEP='#74CCC2', VMID='240 250 248', VEND='225 243 240',
         body='#EDEDE6', hair='#39C5BB', cloth='#DFF2EF', blush='#F0A8B8'),
    dict(key='teto', label='重音Teto', kind='twintails', bullet='bread',
         ACC='#E0557F', PC='#FBDCE6', PC_ON='#7E2A46', SEC='#C24868', SC='#F7D2DE',
         SC_ON='#6E243E', TER='#E87A9C', TC='#FBE7EE', TC_ON='#7E304C',
         SURF='#FFFBFB', SDIM='#F2DEE4', SFC='#FBECEF', SFCH='#F6DCE3',
         ONS='#55303C', OSV='#A47282', OL='#E0A6B8', OLV='#F2D6DF', VB='#E8B4C4',
         ASOFT='#FAE5EC', ADEEP='#E88AA6', VMID='254 243 246', VEND='251 231 238',
         body='#F6E2E0', hair='#DC5270', cloth='#FADCE2', blush='#F0A0A8'),
    dict(key='whale', label='DS鲸鱼娘', kind='whale', bullet='tail',
         ACC='#3E6FD8', PC='#DBE4FA', PC_ON='#263E78', SEC='#3358B4', SC='#D4E0F8',
         SC_ON='#213668', TER='#5E88E2', TC='#E4EBFB', TC_ON='#2C4888',
         SURF='#FAFCFF', SDIM='#E0E8F4', SFC='#EDF2FB', SFCH='#DFE8F8',
         ONS='#2E3E5A', OSV='#7285A6', OL='#A5BCE4', OLV='#D6E2F6', VB='#BCCDF0',
         ASOFT='#E2EBFB', ADEEP='#88A4E8', VMID='242 247 254', VEND='227 237 251',
         body='#EAF0FA', hair='#3E6FD8', cloth='#DCE6F8', blush='#F0AEC0'),
]

# 模板里的颜色 token → 角色名（替换顺序无关，字符串互不包含）
HEX_TOKENS = [
    ('#E8548A', 'ACC'), ('#FFD9E6', 'PC'), ('#8B3A57', 'PC_ON'),
    ('#C2185B', 'SEC'), ('#FFC2D8', 'SC'), ('#7A2745', 'SC_ON'),
    ('#F26D9B', 'TER'), ('#FFD3E1', 'TC'), ('#8E3A57', 'TC_ON'),
    ('#FFF7FA', 'SURF'), ('#F2DEE6', 'SDIM'), ('#FFEAF2', 'SFC'),
    ('#FFDCE9', 'SFCH'), ('#5A3A46', 'ONS'), ('#A9738A', 'OSV'),
    ('#E7A8C0', 'OL'), ('#F9CFE0', 'OLV'), ('#FBC7DC', 'VB'),
    ('#FFE3EE', 'ASOFT'), ('#F7AECB', 'ADEEP'),
]
RGB_TOKENS = [
    ('232 84 138', 'ACC'), ('255 247 250', 'SURF'), ('255 234 242', 'SFC'),
    ('255 220 233', 'SFCH'), ('90 58 70', 'ONS'), ('169 115 138', 'OSV'),
    ('249 207 224', 'OLV'), ('255 240 246', 'VMID'), ('255 226 238', 'VEND'),
]

# 模板贴图 → 槽位（head 还是 full）
STICKER_SLOTS = [
    ("kitty-head.png", 'head'),
    ("kitty-full.png", 'full'),
    ("kitty-sit.png", 'full'),
    ("kitty-wave.png", 'head'),
    ("kitty-ballet.png", 'head'),
    ("kitty-kimono.png", 'full'),
]


def build(t):
    s = TPL
    # ① 颜色（先换 rgb 三元组再换 hex，互不重叠）
    for tok, role in RGB_TOKENS:
        s = s.replace(tok, rgb(t[role]) if len(tok.split()) == 3 and role in ('VMID', 'VEND') else t[role])
    for tok, role in HEX_TOKENS:
        s = s.replace(tok, t[role])
    # ② 主题名
    s = s.replace('theme-kitty', 'theme-' + t['key'])
    s = s.replace('Hello Kitty', t['label']).replace('Kitty', t['label'])
    # ③ 贴纸（原创矢量，data-URL，不引版权图）
    cc = dict(t, acc=t['ACC'])
    head = svgurl(head_svg(cc))
    full = svgurl(full_svg(cc))
    for fname, which in STICKER_SLOTS:
        for q in ("'", '"'):
            s = s.replace("url(%stheme/kitty/%s%s)" % (q, fname, q),
                          head if which == 'head' else full)
    # ④ 分组标题项目符号
    bullet = svgurl(bullet_svg(BULLETS[t['bullet']].replace('ACC', t['ACC'])))
    s = re.sub(r"url\((['\"])data:image/svg\+xml,[^'\")]+\1", bullet.replace('\\', '\\\\'), s, count=1)
    # ⑤ 块头注释
    s = s.replace('主题五：Hello Kitty', '角色主题：' + t['label'], 1)
    return s


def main():
    css = io.open(CSS_PATH, encoding='utf-8').read()
    if 'body.theme-pochacco {' in css:
        print('已生成过，跳过（幂等）')
        return
    blocks = '\n'.join(build(t) for t in THEMES)
    header = ('/* ============================================================\n'
              ' * v2.5.0 新增八套角色主题（帕恰狗/布丁狗/奶娃/洛天依/乐正绫/初音未来/重音Teto/DS鲸鱼娘）\n'
              ' * ------------------------------------------------------------\n'
              ' * 由 _rt/_genthemes.py 以 theme-kitty 块为骨架生成，每套都是完整的\n'
              ' * 自足设计系统（--md3-* 角色整套覆盖，十八套不共底）。角色贴纸全部\n'
              ' * 是原创矢量 SVG（data-URL 内联，不引任何版权图），想换官方图直接\n'
              ' * 替换对应 url(...) 即可。\n'
              ' * ============================================================ */\n\n')
    css = css.rstrip('\n') + '\n\n' + header + blocks + '\n'
    io.open(CSS_PATH, 'w', encoding='utf-8').write(css)
    print('已追加 8 套主题，style.css 现有 %d 行' % css.count('\n'))


if __name__ == '__main__':
    main()
