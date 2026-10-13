# -*- coding: utf-8 -*-
"""清掉历史存档页里混进来的「当前版本」产物。

背景：`.github/workflows/build-multiplatform.yml` 由 `push: tags: v*` 触发，
checkout 到的却是当前 main。于是每建一个历史存档 tag（v1.5.0 …），CI 都会把
**当前版本（2.5.0）** 的 macOS 包和 debug APK 挂到那个存档页上。
工作流已加「版本闸门」防复发，但闸门只能约束之后新建的 tag —— 老 tag 指向的还是
旧提交，得等它们自己跑完。

本脚本：
  ① 取消仍在排队/运行中的「存档 tag」CI，别再往上传；
  ② 等它们落定；
  ③ 删掉存档页里所有 `FClassPal-<当前版本>-*` 资产；
  ④ 打印最终资产清单。

只动我们自己建的存档页，绝不碰用户原有的正式 release。
跑法：python _rt/_arch_clean.py
"""
import os
import re
import sys
import json
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ghsync as G

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 我们建立的存档 tag（用户原有的正式 release 不在其列，一律不碰）
ARCH_TAGS = ['v1.5.0', 'v1.6.0', 'v1.8.0', 'v2.0.0', 'v2.2.2', 'v2.3.3']

TOKEN = G._token()


def get(path, ok=(200, 404)):
    d = G.api('GET', path, ok=ok, token=TOKEN)
    return None if isinstance(d, dict) and d.get('message') in ('Not Found', 'Bad credentials') else d


def cur_version():
    with open(os.path.join(ROOT, 'package.json'), 'r', encoding='utf-8') as fh:
        return json.load(fh)['version']


def runs():
    d = get('/repos/%s/%s/actions/runs?event=push&per_page=30' % (G.OWNER, G.REPO))
    return d.get('workflow_runs') or []


def main():
    cur = cur_version()
    stray = re.compile(r'^FClassPal-%s-' % re.escape(cur))

    # ---- ① 取消在途的存档 tag CI ----
    for r in runs():
        if r.get('head_branch') not in ARCH_TAGS:
            continue
        if r.get('status') == 'completed':
            continue
        try:
            G.api('POST', '/repos/%s/%s/actions/runs/%d/cancel' % (G.OWNER, G.REPO, r['id']),
                  token=TOKEN, ok=(200, 202, 204, 409))
            print('取消中  %s  run#%s  status=%s' % (r['head_branch'], r['run_number'], r['status']))
        except Exception as e:
            print('取消失败 %s: %s' % (r['head_branch'], e))

    # ---- ② 等落定（最多 ~4 分钟）----
    for _ in range(24):
        pending = [r['head_branch'] for r in runs()
                   if r.get('head_branch') in ARCH_TAGS and r.get('status') != 'completed']
        if not pending:
            break
        print('  等待落定：%s' % ', '.join(pending))
        time.sleep(10)

    # ---- ③ 清杂 ----
    print('')
    total = 0
    for tag in ARCH_TAGS:
        rel = get('/repos/%s/%s/releases/tags/%s' % (G.OWNER, G.REPO, tag))
        if rel is None:
            print('%s  无 release' % tag)
            continue
        for a in (rel.get('assets') or []):
            if not stray.match(a['name']):
                continue
            G.api('DELETE', '/repos/%s/%s/releases/assets/%d' % (G.OWNER, G.REPO, a['id']),
                  token=TOKEN, ok=(204,))
            print('%s  ✂ 已删 %s（%.1fMB）' % (tag, a['name'], a['size'] / 1048576.0))
            total += 1
    print('\n共删除 %d 个杂物' % total)

    # ---- ④ 最终清单 ----
    print('')
    for tag in ARCH_TAGS:
        rel = get('/repos/%s/%s/releases/tags/%s' % (G.OWNER, G.REPO, tag))
        if rel is None:
            continue
        names = ', '.join('%s(%.1fMB)' % (a['name'], a['size'] / 1048576.0) for a in (rel.get('assets') or []))
        print('%-8s %s' % (tag, names or '(无资产)'))


if __name__ == '__main__':
    main()
