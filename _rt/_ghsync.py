#!/usr/bin/env python3
"""FClassPal -> GitHub 同步器（本机 github.com 被 hosts 屏蔽时的唯一可用通道）。

背景（别删这段，下次换机器还会踩）：
  本机 hosts 把整个 github.com 域名族（github.com / api.github.com / uploads.github.com /
  raw.githubusercontent.com ...）全钉到了 127.0.0.1，本地 DNS 又对这批域名 Query refused，
  出口代理 127.0.0.1:65431 对 GitHub 的 CONNECT 直接返 502 —— 所以 `git push`、`curl`、
  `urllib` 走默认解析一律失败，换 PAT 也没用（不是鉴权问题，是根本连不出去）。

  但**绕过 hosts、直连真实 IP、自己带 SNI** 是通的（实测 2026-10-06）：
      api.github.com      20.205.243.168    200
      github.com          20.205.243.166    200
      uploads.github.com  20.205.243.161    资产上传走这个域
  所以本脚本自己问 8.8.8.8 解析 A 记录、自己连 IP、再把 Host/SNI 写成真域名。
  注意不要去掉代理环境变量就完事 —— urllib 会读 http_proxy，下面 ProxyHandler({}) 已关掉。

用法（cwd 必须是项目根）：
    python _rt/_ghsync.py status                      # 只看本地与远端哪些文件不一致
    python _rt/_ghsync.py push -m "提交说明"           # 用 Git Data API 一次提交所有差异
    python _rt/_ghsync.py push --all -m "..."         # 忽略差异检测，全量重推
    python _rt/_ghsync.py release v2.4.1 --notes-file CHANGELOG_v240.md \
        --asset dist/FClassPal-2.4.1.exe              # 建 release + 传资产（可只给 --notes-file）

token：优先读环境变量 GH_TOKEN / GITHUB_TOKEN，否则读 .git/_tok（.git/ 下的文件不会被提交）。
      脚本从不打印 token。
"""
import argparse
import base64
import hashlib
import http.client
import json
import os
import random
import re
import socket
import ssl
import struct
import subprocess
import sys
import time

OWNER = 'fangyugit'
REPO = 'FclassPal'
BRANCH = 'main'
DNS_SERVER = '8.8.8.8'

# 兜底 IP：DNS 查不到时用。GitHub 这几个是 Anycast，比较稳。
FALLBACK_IP = {
    'api.github.com': '20.205.243.168',
    'github.com': '20.205.243.166',
    'uploads.github.com': '20.205.243.161',
}

_IP_CACHE = {}


# ---------------------------------------------------------------- DNS（绕开 hosts）

def dns_a(host, server=DNS_SERVER, timeout=6):
    """只问 DNS 服务器要 A 记录，不看 hosts 文件。支持同一响应里的 CNAME 链。"""
    qid = random.randint(0, 0xFFFF)
    query = struct.pack('>HHHHHH', qid, 0x0100, 1, 0, 0, 0)
    for label in host.split('.'):
        query += bytes([len(label)]) + label.encode('ascii')
    query += b'\x00' + struct.pack('>HH', 1, 1)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(query, (server, 53))
        data, _ = sock.recvfrom(4096)
    finally:
        sock.close()

    if len(data) < 12:
        return None
    ancount = struct.unpack('>H', data[6:8])[0]

    def read_name(buf, off):
        """跳过名字（可能带压缩指针），返回下一个字节偏移。"""
        while True:
            if off >= len(buf):
                return off
            ln = buf[off]
            if ln == 0:
                return off + 1
            if ln & 0xC0 == 0xC0:
                return off + 2
            off += 1 + ln

    off = 12 + len(host) + 2  # 跳过问题区的 QNAME + QTYPE + QCLASS
    for _ in range(ancount):
        off = read_name(data, off)
        if off + 10 > len(data):
            break
        rtype, _rclass, _ttl, rdlen = struct.unpack('>HHIH', data[off:off + 10])
        off += 10
        if rtype == 1 and rdlen == 4:
            return '.'.join(str(b) for b in data[off:off + 4])
        off += rdlen
    return None


def ip_of(host):
    if host not in _IP_CACHE:
        ip = None
        try:
            ip = dns_a(host)
        except Exception:
            ip = None
        if not ip:
            ip = FALLBACK_IP.get(host)
        if not ip:
            raise SystemExit('解析不了 ' + host + '（DNS 与兜底表都没命中）')
        _IP_CACHE[host] = ip
    return _IP_CACHE[host]


# ---------------------------------------------------------------- 带 SNI 的直连 HTTP

class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """连到指定 IP，但 TLS SNI 与 Host 头用真实域名（否则证书校验过不去）。"""

    def __init__(self, host, ip, timeout=60):
        super().__init__(host, 443, timeout=timeout)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _token():
    tok = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if tok:
        return tok.strip()
    root = git_root()
    path = os.path.join(root, '.git', '_tok')
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as fh:
            return fh.read().strip()
    raise SystemExit('找不到 token：设 GH_TOKEN，或把 PAT 写进 .git/_tok')


def api(method, path, body=None, host='api.github.com', token=None, ok=(200, 201)):
    """发一个 REST 请求。path 形如 /repos/o/r/git/blobs。"""
    conn = PinnedHTTPSConnection(host, ip_of(host))
    try:
        payload = json.dumps(body).encode('utf-8') if body is not None else None
        headers = {
            'Host': host,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'FClassPal-ghsync',
            'X-GitHub-Api-Version': '2022-11-28',
        }
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status not in ok:
            raise SystemExit('%s %s -> %s\n%s' % (method, path, resp.status,
                                                  raw[:800].decode('utf-8', 'replace')))
        return json.loads(raw.decode('utf-8')) if raw else {}
    finally:
        conn.close()


# ---------------------------------------------------------------- 本地 / 远端比对

def git_root():
    out = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit('当前目录不在 git 工作树里')
    return out.stdout.strip().replace('/', os.sep)


def blob_sha(data):
    """git blob 的 SHA-1，和 GitHub 树的 sha 是同一个东西。"""
    h = hashlib.sha1()
    h.update(b'blob %d\0' % len(data))
    h.update(data)
    return h.hexdigest()


def local_files():
    """该进仓库的文件 = 已跟踪 + 未跟踪且没被 .gitignore 忽略（交给 git 判断）。"""
    out = subprocess.run(['git', 'ls-files', '-co', '--exclude-standard'],
                         capture_output=True, text=True, cwd=git_root())
    if out.returncode != 0:
        raise SystemExit('git ls-files 失败：' + out.stderr)
    files = {}
    root = git_root()
    for rel in out.stdout.splitlines():
        rel = rel.strip()
        if not rel:
            continue
        full = os.path.join(root, rel.replace('/', os.sep))
        if not os.path.isfile(full):
            continue
        with open(full, 'rb') as fh:
            files[rel] = fh.read()
    return files


def remote_tree(token):
    """远端整个树：path -> (sha, size)。"""
    out = {}
    data = api('GET', '/repos/%s/%s/git/trees/heads/%s?recursive=1' % (OWNER, REPO, BRANCH),
               token=token)
    for ent in data.get('tree', []):
        if ent.get('type') == 'blob':
            out[ent['path']] = (ent['sha'], ent.get('size', 0))
    return out


def diff(token, verbose=True):
    local = local_files()
    remote = remote_tree(token)
    changed, added, same = [], [], []
    for path, data in sorted(local.items()):
        sha = blob_sha(data)
        if path not in remote:
            added.append(path)
        elif remote[path][0] != sha:
            changed.append(path)
        else:
            same.append(path)
    removed = sorted(set(remote) - set(local))
    if verbose:
        print('远端 %d 个文件 / 本地 %d 个文件' % (len(remote), len(local)))
        print('  未变 %d' % len(same))
        print('  改动 %d  %s' % (len(changed), ' '.join(changed) if changed else '-'))
        print('  新增 %d  %s' % (len(added), ' '.join(added) if added else '-'))
        print('  仅远端有 %d  %s' % (len(removed), ' '.join(removed) if removed else '-'))
    return changed, added, removed, local


# ---------------------------------------------------------------- 提交

def push(message, only=None, all_files=False):
    token = _token()
    changed, added, removed, local = diff(token)
    if removed:
        print('注意 以下文件只在远端存在，本脚本**不会**删（要删请自己上 GitHub 动手）：'
              + ', '.join(removed))
    targets = sorted(local) if all_files else sorted(set(changed) | set(added))
    if only:
        targets = [t for t in targets if t in set(only)]
    if not targets:
        print('没有需要提交的文件，收工。')
        return

    head = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPO, BRANCH), token=token)
    base_commit = head['object']['sha']
    base_tree = api('GET', '/repos/%s/%s/git/commits/%s' % (OWNER, REPO, base_commit),
                    token=token)['tree']['sha']
    print('基线 commit %s（tree %s）' % (base_commit[:8], base_tree[:8]))

    entries = []
    for i, path in enumerate(targets, 1):
        data = local[path]
        blob = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO),
                   {'content': base64.b64encode(data).decode('ascii'),
                    'encoding': 'base64'}, token=token)
        entries.append({'path': path, 'mode': '100644', 'type': 'blob',
                        'sha': blob['sha']})
        print('  [%2d/%2d] %-42s %8d B  blob %s' % (i, len(targets), path, len(data),
                                                    blob['sha'][:8]))
        if blob['sha'] != blob_sha(data):
            raise SystemExit('blob sha 不一致（%s），中止' % path)

    tree = api('POST', '/repos/%s/%s/git/trees' % (OWNER, REPO),
               {'base_tree': base_tree, 'tree': entries}, token=token)
    commit = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO),
                 {'message': message, 'tree': tree['sha'], 'parents': [base_commit]},
                 token=token)
    api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPO, BRANCH),
        {'sha': commit['sha'], 'force': False}, token=token)
    url = 'https://github.com/%s/%s/commit/%s' % (OWNER, REPO, commit['sha'])
    print('\n提交完成 ' + commit['sha'][:8] + '\n' + url)
    return commit['sha']


# ---------------------------------------------------------------- Release

def release(tag, name=None, notes_file=None, notes=None, asset=None, prerelease=False):
    token = _token()
    if notes_file:
        with open(notes_file, 'r', encoding='utf-8') as fh:
            notes = fh.read()
    if not notes:
        raise SystemExit('release 需要 --notes-file 或 --notes')
    body = {'tag_name': tag, 'name': name or tag, 'body': notes,
            'draft': False, 'prerelease': bool(prerelease), 'target_commitish': BRANCH}
    rel = api('POST', '/repos/%s/%s/releases' % (OWNER, REPO), body, token=token,
              ok=(200, 201))
    print('release %s 已建 %s' % (tag, rel['html_url']))

    if asset:
        upload_asset(rel['upload_url'], asset, token)
    return rel


def upload_asset(upload_url, path, token):
    """资产要发到 uploads.github.com（和 api 是两个域）。大文件流式发，别整个读进内存。"""
    base = upload_url.split('{')[0]
    name = os.path.basename(path)
    url = base + '?name=' + name
    m = re.match(r'https://([^/]+)(/.*)$', url)
    host, rest = m.group(1), m.group(2)
    size = os.path.getsize(path)
    ctype = ('application/octet-stream' if name.endswith('.exe')
             else 'application/zip' if name.endswith('.zip') else 'text/plain')

    conn = PinnedHTTPSConnection(host, ip_of(host), timeout=1800)
    try:
        conn.putrequest('POST', rest, skip_host=True, skip_accept_encoding=True)
        conn.putheader('Host', host)
        conn.putheader('Authorization', 'Bearer ' + token)
        conn.putheader('Content-Type', ctype)
        conn.putheader('Content-Length', str(size))
        conn.putheader('User-Agent', 'FClassPal-ghsync')
        conn.endheaders()
        sent, t0, last = 0, time.time(), 0
        with open(path, 'rb') as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                conn.send(chunk)
                sent += len(chunk)
                if sent - last >= 16 * 1024 * 1024:
                    last = sent
                    print('  上传 %5.1f%%  (%.1f/%.1f MB, %.1f MB/s)'
                          % (100.0 * sent / size, sent / 1048576.0, size / 1048576.0,
                             (sent / 1048576.0) / max(time.time() - t0, 0.001)))
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status not in (200, 201):
            raise SystemExit('上传 %s 失败 %s\n%s'
                             % (name, resp.status, raw[:500].decode('utf-8', 'replace')))
        data = json.loads(raw.decode('utf-8'))
        print('  资产已上传 %s  (%.1f MB)' % (data['browser_download_url'],
                                              data['size'] / 1048576.0))
        return data
    finally:
        conn.close()


# ---------------------------------------------------------------- CLI

def main():
    ap = argparse.ArgumentParser(description='FClassPal -> GitHub 同步器')
    sub = ap.add_subparsers(dest='cmd', required=True)

    sub.add_parser('status', help='列出本地与远端的差异')

    p_push = sub.add_parser('push', help='一次提交所有差异文件')
    p_push.add_argument('-m', '--message', required=True)
    p_push.add_argument('--all', action='store_true', help='忽略差异检测，全量重推')
    p_push.add_argument('--only', nargs='*', help='只推指定路径')

    p_rel = sub.add_parser('release', help='建 release 并可选上传资产')
    p_rel.add_argument('tag')
    p_rel.add_argument('--name')
    p_rel.add_argument('--notes-file')
    p_rel.add_argument('--notes')
    p_rel.add_argument('--asset')
    p_rel.add_argument('--prerelease', action='store_true')

    args = ap.parse_args()
    if args.cmd == 'status':
        diff(_token())
    elif args.cmd == 'push':
        push(args.message, only=args.only, all_files=args.all)
    elif args.cmd == 'release':
        release(args.tag, name=args.name, notes_file=args.notes_file,
                notes=args.notes, asset=args.asset, prerelease=args.prerelease)


if __name__ == '__main__':
    main()
