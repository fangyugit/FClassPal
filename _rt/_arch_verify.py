# -*- coding: utf-8 -*-
"""归档收尾验收：① 九个历史版本现状 ② 最新 release 是否仍是 v2.5.0
③ 新建 tag 触发的 CI 是否被「版本闸门」挡下（macos/android 应被跳过）。

只读。跑法：python _rt/_arch_verify.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ghsync as G

VERS = ['1.5.0', '1.6.0', '1.8.0', '2.0.0', '2.2.2', '2.2.3', '2.2.4', '2.3.3', '2.4.5']
# ③ 里额外展开 job 明细的 tag（新归档的 tag 都列上，方便一眼看出闸门挡没挡住）
TAG_OF = {'v' + v for v in VERS}

# 只读请求也要带令牌：匿名额度只有 60 次/小时，跑两遍就 403
TOKEN = G._token()


def get(path, ok=(200, 404), auth=True):
    d = G.api('GET', path, ok=ok, token=TOKEN if auth else None)
    return None if isinstance(d, dict) and d.get('message') in ('Not Found', 'Bad credentials') else d


print('=== ① 历史版本 ===')
for v in VERS:
    r = get('/repos/%s/%s/releases/tags/v%s' % (G.OWNER, G.REPO, v))
    if r is None:
        print('  %-6s  无 release' % v)
        continue
    names = ', '.join('%s(%.1fMB)' % (a['name'], a['size'] / 1048576.0) for a in (r.get('assets') or []))
    print('  %-6s  %-28s pre=%-5s %s' % (v, r.get('name'), r.get('prerelease'), names or '(无资产)'))

print('')
print('=== ② 仓库 Latest ===')
lr = get('/repos/%s/%s/releases/latest' % (G.OWNER, G.REPO))
print('  %s  (%s)' % (lr['tag_name'], lr['name']))

print('')
print('=== ③ tag 触发的 CI（闸门生效则 macos / android 应为 skipped）===')
d = get('/repos/%s/%s/actions/runs?event=push&per_page=8' % (G.OWNER, G.REPO))
for run in (d.get('workflow_runs') or [])[:8]:
    print('  %-10s %-20s event=%-5s %s' % (run.get('head_branch'), run.get('name'),
                                           run.get('event'), run.get('conclusion')))
    if run.get('head_branch') in TAG_OF:
        j = get('/repos/%s/%s/actions/runs/%d/jobs' % (G.OWNER, G.REPO, run['id']))
        for job in (j or {}).get('jobs') or []:
            print('      %-24s %s' % (job['name'], job['conclusion']))
