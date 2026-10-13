# -*- coding: utf-8 -*-
"""归档前探测：看每个历史版本在 GitHub 上到底有没有 release / tag / 资产。

只读，不改任何东西。跑法：python _rt/_arch_probe.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ghsync as G

VERS = ['1.5.0', '1.6.0', '1.8.0', '2.0.0', '2.2.2', '2.2.3', '2.2.4', '2.3.3', '2.4.5']


def get(path):
    """返回解析后的 JSON，404 时返回 None（api() 会把 404 体的 message 也解析出来）。"""
    d = G.api('GET', path, ok=(200, 404))
    if isinstance(d, dict) and d.get('message') in ('Not Found', 'Bad credentials'):
        return None
    return d


for v in VERS:
    tag = 'v' + v
    r = get('/repos/%s/%s/releases/tags/%s' % (G.OWNER, G.REPO, tag))
    has_tag = get('/repos/%s/%s/git/ref/tags/%s' % (G.OWNER, G.REPO, tag)) is not None
    if r is None:
        print('%-8s  release: 无        tag: %s' % (v, '有' if has_tag else '无'))
        continue
    assets = r.get('assets') or []
    names = ', '.join('%s(%.1fMB)' % (a['name'], a['size'] / 1048576.0) for a in assets) or '(无资产)'
    print('%-8s  release: 有  name=%r  pre=%s  assets: %s'
          % (v, r.get('name'), r.get('prerelease'), names))
