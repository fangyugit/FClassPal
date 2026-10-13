# -*- coding: utf-8 -*-
"""把 D:\\deskop w 里的经典历史版本归档到 GitHub Releases（v2.5.0 任务 #106）。

要点：
  · 每个版本建 tag + release，标题明确写「历史存档」；
  · make_latest=false —— 否则刚发布的 v2.5.0 会被老版本抢走 Latest 标记；
  · 原始文件名里有中文和空格（管家助手 X.Y.Z.exe），资产名统一改成
    GuanJia-<v>.exe / 原名写进说明，避免 URL 里出现奇怪编码；
  · 幂等：远端已有 release 的版本直接跳过，重复跑只补缺口；
  · 清杂：CI 曾把当前版本（2.5.0）的产物挂到存档页上，这里按「当前版本号前缀」
    识别并删除，只删我们自己建的存档页，不动用户原有的正式 release。

跑法：python _rt/_archive_old.py
"""
import os
import re
import sys
import json
import shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ghsync as G

SRC = r'D:\deskop w'
STAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_arch')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (版本, 源文件, 资产名, 时期说明, 是否归我们管)
#   归我们管 → 缺 release 就建，且允许清理混进来的杂物；
#   不归我们管 → 用户当年就发布过，原样放着，只做存在性检查。
ITEMS = [
    ('1.5.0', '管家助手 1.5.0.exe', 'GuanJia-1.5.0.exe', '管家助手时期（FClassPal 前身），最早的公开版本', True),
    ('1.6.0', '管家助手 1.6.0.exe', 'GuanJia-1.6.0.exe', '管家助手时期', True),
    ('1.8.0', '管家助手 1.8.0.exe', 'GuanJia-1.8.0.exe', '管家助手时期', True),
    ('2.0.0', '管家助手 2.0.0.exe', 'GuanJia-2.0.0.exe', '管家助手时期里程碑', True),
    ('2.2.2', '管家助手-2.2.2.exe', 'GuanJia-2.2.2.exe', '管家助手时期', True),
    ('2.2.3', '管家助手-2.2.3.exe', 'GuanJia-2.2.3.exe', '管家助手时期收尾版本', False),
    ('2.2.4', 'FClassPal-2.2.4.exe', 'FClassPal-2.2.4.exe', '改名为 FClassPal 后的第一个版本', False),
    ('2.3.3', 'FClassPal-2.3.3.exe', 'FClassPal-2.3.3.exe', 'FClassPal 时期', True),
    ('2.4.5', 'FClassPal-2.4.5.exe', 'FClassPal-2.4.5.exe', '最后一个未做体积优化的版本（约 94MB）', False),
]

NOTES = """FClassPal v{v}（历史存档）

## 关于这一版

- {era}
- {size} MB
- 原始文件名：`{orig}`

这是**历史版本存档**，仅供回滚与怀旧，不建议日常使用。
最新版本请到 [Releases 首页](https://github.com/fangyugit/FclassPal/releases/latest) 下载。

## 下载

| 平台 | 产物 | 架构 |
|---|---|---|
| Windows | {asset} | x64 |
"""


def get(path):
    d = G.api('GET', path, ok=(200, 404))
    return None if isinstance(d, dict) and d.get('message') in ('Not Found', 'Bad credentials') else d


def cur_version():
    with open(os.path.join(ROOT, 'package.json'), 'r', encoding='utf-8') as fh:
        return json.load(fh)['version']


def main():
    token = G._token()
    cur = cur_version()
    # 所有归档 tag 都打在同一个提交上（这些版本的源码提交不在当前仓库历史里）
    sha = G.api('GET', '/repos/%s/%s/git/ref/heads/%s' % (G.OWNER, G.REPO, G.BRANCH),
                token=token)['object']['sha']
    print('归档 tag 基准提交：%s' % sha)
    print('当前发布版本：%s（存档页里出现它的产物 = 杂物，要删）' % cur)
    print('')

    for ver, src, asset, era, ours in ITEMS:
        tag = 'v' + ver
        rel = get('/repos/%s/%s/releases/tags/%s' % (G.OWNER, G.REPO, tag))
        if rel:
            note = '已有 release，跳过建档' + ('（非本次归档，不动它）' if not ours else '')
            print('· %-6s %s  name=%r' % (ver, note, rel.get('name')))
        elif not ours:
            print('· %-6s 远端无 release（原本就没有，跳过）' % ver)
            continue
        else:
            path = os.path.join(SRC, src)
            if not os.path.exists(path):
                print('!! %-6s 缺少源文件，跳过：%s' % (ver, path))
                continue
            size = round(os.path.getsize(path) / 1048576, 1)
            # tag（已存在则忽略）
            try:
                G.api('POST', '/repos/%s/%s/git/refs' % (G.OWNER, G.REPO),
                      {'ref': 'refs/tags/' + tag, 'sha': sha}, token=token, ok=(200, 201, 422))
                print('  tag %s 已建' % tag)
            except Exception as e:
                print('  tag %s 已存在或失败：%s' % (tag, e))
            notes = NOTES.format(v=ver, era=era, size=size, orig=src, asset=asset)
            # 资产名要干净（原名带中文与空格）→ 先落到中转目录再传
            if not os.path.isdir(STAGE):
                os.makedirs(STAGE)
            staged = os.path.join(STAGE, asset)
            if not os.path.exists(staged):
                shutil.copy2(path, staged)
            try:
                rel = G.release(tag, name='【历史存档】FClassPal v%s' % ver, notes=notes,
                                asset=staged, make_latest=False)
            except Exception as e:
                print('!! release %s 失败：%s' % (tag, e))
                continue
            try:
                if os.path.exists(staged):
                    os.remove(staged)     # 传完就删中转副本，别白占 850MB
            except Exception:
                pass

        # ---- 清杂：删掉 CI 误挂上来的当前版本产物 ----
        if not ours:
            continue
        rel = get('/repos/%s/%s/releases/tags/%s' % (G.OWNER, G.REPO, tag)) or rel
        stray = re.compile(r'^FClassPal-%s-' % re.escape(cur))
        for a in (rel.get('assets') or []):
            if not stray.match(a['name']):
                continue
            st = G.api('DELETE', '/repos/%s/%s/releases/assets/%d' % (G.OWNER, G.REPO, a['id']),
                       token=token, ok=(204,))
            print('  ✂ 已删杂物 %s（%.1fMB）' % (a['name'], a['size'] / 1048576.0))


if __name__ == '__main__':
    main()
