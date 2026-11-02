/* ============================================================================
 * FClassPal · 局域网服务（v2.6.4）
 *
 * 目的：让同一局域网里的 WearOS 手表能「看到桌面端的快捷方式 → 点一下在电脑上
 * 打开 → 顺手改个名字/调个顺序」，不需要账号、不需要外网、不需要装任何东西。
 *
 * 设计取舍：
 *   ① **只监听局域网，不做穿透**：HTTP 服务绑 0.0.0.0:<port>，UDP 广播用于发现。
 *      想跨网用请自己组 VPN —— 本项目不做 NAT 穿透，也就不必引入任何云。
 *   ② **手表端不用 WebSocket**：WearOS 上 WebView 都没有，原生写 WS 客户端要
 *      自己实现握手/掩码/分片。改成「HTTP 轮询 + 动作即请求」，手表每几秒
 *      GET 一次 /fcp/state，代码量与出错面都小一个数量级，教室场景完全够用。
 *   ③ **状态由渲染层做主**：主进程不解析 config 里的分组语义，只当搬运工——
 *      渲染层 pushState 上来什么，这里就原样发给手表；手表发来的动作转给
 *      渲染层执行（渲染层是唯一能改 config 并重绘的地方），执行完把新状态
 *      作为 HTTP 响应体回去，手表一次往返就拿到结果。
 *   ④ **配对走 6 位数字码 + 随机 token**：码只在设置里显示，用户念给手表听/
 *      手输；配对成功发一个 32 位 hex token，之后所有请求都验它。
 *      错码限速（1 分钟内 8 次）防止有限局域网里被暴力试。
 *
 * 这个文件不 require electron，纯 node，可以被探针直接跑起来做自测。
 * ==========================================================================*/
'use strict';

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PORT = 47820;
const DISCOVERY_PORT = 47822;
const APP_TAG = 'FClassPal';
const API_PREFIX = '/fcp';

/* 请求体上限：一次动作最多几十字节，64KB 已经非常宽松，防止被灌爆内存 */
const MAX_BODY = 64 * 1024;

/* 错码限速：同一个 IP 1 分钟内最多 8 次，超了先锁 60s */
const PAIR_WINDOW = 60 * 1000;
const PAIR_MAX_FAIL = 8;

let server = null;
let udpSocket = null;
let boundPort = 0;
let hooks = null;
let pairFails = new Map();   // ip -> { n, until }

function log(msg) { process.stdout.write('[lan] ' + msg + '\n'); }

function localAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((k) => {
    (ifs[k] || []).forEach((a) => {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    });
  });
  return out;
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/* 错码限速 */
function pairBlocked(ip) {
  const rec = pairFails.get(ip);
  if (!rec) return false;
  if (rec.until && Date.now() < rec.until) return true;
  return false;
}
function notePairFail(ip) {
  const now = Date.now();
  const rec = pairFails.get(ip) || { n: 0, until: 0, t0: now };
  if (now - rec.t0 > PAIR_WINDOW) { rec.n = 0; rec.t0 = now; rec.until = 0; }
  rec.n++;
  if (rec.n >= PAIR_MAX_FAIL) rec.until = now + PAIR_WINDOW;
  pairFails.set(ip, rec);
}

function bearer(req, body) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+([0-9a-f]{16,})$/i.exec(h.trim());
  if (m) return m[1];
  if (body && typeof body.token === 'string') return body.token;
  const u = new URL(req.url, 'http://x');
  return u.searchParams.get('token') || '';
}

/* ---------- 起服务 ---------- */
function start(opts) {
  hooks = opts || {};
  if (typeof hooks.port !== 'number') hooks.port = DEFAULT_PORT;
  if (server) return Promise.resolve(describe());
  pairFails.clear();   // 重启服务 = 用户重新开了一次开关，限速状态不该跨实例

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryListen = (port) => {
      const s = http.createServer(onRequest);
      s.on('error', (err) => {
        /* 端口被占：往上试 4 个（教室里可能同时装了别的东西占着） */
        if (err && err.code === 'EADDRINUSE' && attempts < 4) {
          attempts++;
          tryListen(port + 1);
          return;
        }
        server = null;
        reject(err);
      });
      s.listen(port, '0.0.0.0', () => {
        server = s;
        boundPort = port;
        startDiscovery();
        log('服务已启动 ' + localAddresses().join(',') + ':' + boundPort);
        resolve(describe());
      });
    };
    tryListen(hooks.port);
  });
}

function stop() {
  stopDiscovery();
  if (server) {
    try { server.close(); } catch (e) { /* 已关 */ }
    server = null;
  }
  boundPort = 0;
  pairFails.clear();
}

function describe() {
  return {
    running: !!server,
    port: boundPort,
    addresses: localAddresses(),
    name: hooks && hooks.name ? hooks.name : os.hostname(),
    version: hooks && hooks.version ? hooks.version : ''
  };
}

/* ---------- UDP 发现 ----------
 * 手表不知道电脑 IP 时发一条广播，我们回一条含端口/电脑名的 JSON。
 * 只回 "FClassPal" 的询问（省得被别的扫描器当成开放端口去嗅）。 */
function startDiscovery() {
  if (udpSocket) return;
  udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpSocket.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (text.indexOf(APP_TAG) < 0 && text.indexOf('FCP_DISCOVER') < 0) return;
    const info = {
      app: APP_TAG,
      type: 'fcp-here',
      name: describe().name,
      port: boundPort,
      version: describe().version,
      needCode: true
    };
    const buf = Buffer.from(JSON.stringify(info), 'utf8');
    try { udpSocket.send(buf, 0, buf.length, rinfo.port, rinfo.address); } catch (e) { /* 网络抖动忽略 */ }
  });
  udpSocket.on('error', () => { try { udpSocket.close(); } catch (e) {} udpSocket = null; });
  try {
    udpSocket.bind(DISCOVERY_PORT, () => {
      try { udpSocket.setBroadcast(true); } catch (e) { /* 某些系统要，失败也无妨 */ }
    });
  } catch (e) { /* 端口被占：发现功能失效，手动输 IP 也能用 */ }
}

function stopDiscovery() {
  if (udpSocket) {
    try { udpSocket.close(); } catch (e) { /* 已关 */ }
    udpSocket = null;
  }
}

/* ---------- 路由 ---------- */
async function onRequest(req, res) {
  const u = new URL(req.url || '/', 'http://x');
  const p = u.pathname.replace(/\/+$/, '');
  const ip = (req.socket && req.socket.remoteAddress) || '';

  if (req.method === 'OPTIONS') { sendJson(res, 200, { ok: true }); return; }

  /* 免鉴权：发现 + 配对 + 版本（手表第一次连上来只能拿到这些） */
  if (p === API_PREFIX + '/ping') {
    sendJson(res, 200, {
      app: APP_TAG, ok: true, needCode: true,
      name: describe().name, version: describe().version, port: boundPort
    });
    return;
  }

  if (p === API_PREFIX + '/pair' && req.method === 'POST') {
    if (pairBlocked(ip)) { sendJson(res, 429, { ok: false, error: 'too-many-tries' }); return; }
    const body = await readBody(req);
    if (!body || typeof body.code !== 'string') { sendJson(res, 400, { ok: false, error: 'bad-request' }); return; }
    const expect = String((hooks && hooks.pairCode ? hooks.pairCode() : '') || '');
    const got = body.code.replace(/\D/g, '');
    if (!expect || got !== expect) {
      notePairFail(ip);
      sendJson(res, 403, { ok: false, error: 'bad-code' });
      return;
    }
    pairFails.delete(ip);
    const dev = hooks.registerDevice(String(body.device || 'WearOS').slice(0, 40), ip);
    sendJson(res, 200, {
      ok: true, token: dev.token, deviceId: dev.id,
      name: describe().name, version: describe().version
    });
    return;
  }

  /* 以下都要 token */
  const body = req.method === 'POST' ? await readBody(req) : null;
  const token = bearer(req, body);
  const dev = token && hooks.verifyToken ? hooks.verifyToken(token) : null;
  if (!dev) { sendJson(res, 401, { ok: false, error: 'unauthorized' }); return; }
  if (hooks.touchDevice) hooks.touchDevice(dev.id);

  if (p === API_PREFIX + '/state') {
    sendJson(res, 200, { ok: true, state: hooks.state ? hooks.state() : null, version: describe().version });
    return;
  }

  if (p === API_PREFIX + '/action' && req.method === 'POST') {
    if (!body || typeof body.action !== 'string') { sendJson(res, 400, { ok: false, error: 'bad-request' }); return; }
    let result;
    try {
      result = await hooks.action(body, dev);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'action-failed', detail: String(e && e.message || e) });
      return;
    }
    /* 动作返回里若自带 state 就用它：渲染层刚刚改完 config，那份快照比
     * 主进程缓存的新一步（缓存要等 IPC 的 pushState 到达才更新）。 */
    const st = (result && result.state) || (hooks.state ? hooks.state() : null);
    sendJson(res, 200, Object.assign({ ok: true }, result || {}, {
      state: st, version: describe().version
    }));
    return;
  }

  if (p === API_PREFIX + '/unpair' && req.method === 'POST') {
    if (hooks.removeDevice) hooks.removeDevice(dev.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not-found' });
}

module.exports = {
  start, stop, describe,
  localAddresses,
  DEFAULT_PORT, DISCOVERY_PORT, APP_TAG,
  /* 供探针/测试用：暴露内部端口绑定结果 */
  get port() { return boundPort; },
  get running() { return !!server; }
};
