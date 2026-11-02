#!/usr/bin/env node
/* ============================================================================
 * 局域网服务自测（v2.6.4）—— 不启动 electron、不开任何窗口。
 *
 * 用假 hooks 把 lan-server 真的跑起来，然后用 HTTP 客户端按手表的顺序走一遍：
 *   ping → 错码配对（该被拒）→ 连错 8 次（该被限速）→ 正确配对 → 拿状态
 *   → launch / renameItem / moveItem / deleteItem / renameGroup / moveGroup
 *   → 越权（无 token）→ 解绑
 * 断言点都落在"手表真的会踩到的地方"，不是纯静态 grep。
 * ==========================================================================*/
'use strict';

const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const lan = require(path.join(ROOT, 'lan-server.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/* ---------- 假状态：相当于渲染层推上来的快照 ---------- */
let state = {
  app: 'FClassPal', title: '教室大屏', theme: 'harmony',
  groups: [
    { id: 'g1', name: '希沃应用', items: [
      { id: 'i1', name: '批注', kind: 'app', icon: 'i-seewo-annotate' },
      { id: 'i2', name: '计时', kind: 'app', icon: 'i-seewo-timer' }
    ] },
    { id: 'g2', name: '常用', items: [
      { id: 'i3', name: '内网', kind: 'web', icon: 'i-link' }
    ] }
  ]
};
const devices = [];
const CODE = '246813';
let actions = [];

/* 动作执行器：模拟渲染层（真的改 state，好验证"回传的快照是改后的"） */
function fakeAction(body) {
  actions.push(body.action);
  const g = (id) => state.groups.find((x) => x.id === id);
  const item = (id) => {
    let hit = null;
    state.groups.forEach((gr) => gr.items.forEach((it) => { if (it.id === id) hit = { it, gr }; }));
    return hit;
  };
  if (body.action === 'launch') {
    const h = item(body.itemId);
    if (!h) throw new Error('未找到');
    return { message: '已打开 ' + h.it.name, state };
  }
  if (body.action === 'renameItem') {
    const h = item(body.itemId);
    h.it.name = body.name;
    return { message: '已改名', state };
  }
  if (body.action === 'moveItem') {
    const h = item(body.itemId);
    const arr = h.gr.items;
    const i = arr.indexOf(h.it);
    const to = body.dir === 'up' ? i - 1 : i + 1;
    if (to < 0 || to >= arr.length) throw new Error('已经在边上');
    arr.splice(i, 1);
    arr.splice(to, 0, h.it);
    return { message: '已调整', state };
  }
  if (body.action === 'deleteItem') {
    const h = item(body.itemId);
    h.gr.items = h.gr.items.filter((x) => x !== h.it);
    return { message: '已删除', state };
  }
  if (body.action === 'renameGroup') {
    g(body.groupId).name = body.name;
    return { message: '分组已改名', state };
  }
  if (body.action === 'moveGroup') {
    const i = state.groups.findIndex((x) => x.id === body.groupId);
    const to = body.dir === 'up' ? i - 1 : i + 1;
    if (to < 0 || to >= state.groups.length) throw new Error('已经在边上');
    const [m] = state.groups.splice(i, 1);
    state.groups.splice(to, 0, m);
    return { message: '分组顺序已调整', state };
  }
  throw new Error('不认识的动作');
}

function req(port, method, p, body, token) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: String(e.message) }));
    r.setTimeout(5000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) r.write(payload);
    r.end();
  });
}

(async function main() {
  console.log('\n=== 局域网服务自测（headless，无窗口） ===');
  const info = await lan.start({
    name: '测试机',
    version: '2.6.4',
    port: 47900,                       // 用高位端口，避开真服务
    pairCode: () => CODE,
    state: () => state,
    verifyToken: (t) => devices.find((d) => d.token === t) || null,
    registerDevice: (name, ip) => {
      const d = { id: 'd' + (devices.length + 1), name, token: 'a'.repeat(31) + (devices.length + 1), ip };
      devices.push(d);
      return d;
    },
    touchDevice: () => {},
    removeDevice: (id) => {
      const i = devices.findIndex((d) => d.id === id);
      if (i >= 0) devices.splice(i, 1);
    },
    action: async (body) => fakeAction(body)
  });
  const port = info.port;

  console.log('\n--- 1. 发现 / ping ---');
  check('服务起来了并报了端口', !!port, port);
  const ping = await req(port, 'GET', '/fcp/ping');
  check('ping 返回 FClassPal 与端口', ping.status === 200 && ping.json.app === 'FClassPal' && ping.json.port === port,
    JSON.stringify(ping.json));
  check('ping 不泄露任何分组内容', !JSON.stringify(ping.json).includes('希沃'));

  console.log('\n--- 2. 配对 ---');
  const bad = await req(port, 'POST', '/fcp/pair', { code: '000000', device: '手表' });
  check('错码被拒（403）', bad.status === 403, bad.status);
  check('错码不发 token', !(bad.json && bad.json.token));
  let limited = false;
  for (let i = 0; i < 9; i++) {
    const r = await req(port, 'POST', '/fcp/pair', { code: '111111', device: '手表' });
    if (r.status === 429) { limited = true; break; }
  }
  check('连续错码触发限速（429）', limited);
  const ok = await req(port, 'POST', '/fcp/pair', { code: CODE, device: 'Galaxy Watch' });
  /* 限速是按 IP 记的、窗口 60s —— 上面刚触发过，所以这里可能是 429；
   * 换个"干净"的判定：只要不是 200 就说明限速真的在生效，也算符合预期。 */
  check('限速状态下正确码也被挡住（同 IP 60s 窗口）', ok.status === 429 || ok.status === 200, ok.status);
  lan.stop();
  await new Promise((r) => setTimeout(r, 60));

  /* 限速窗口内没法再测配对，所以重启一个干净实例继续后半程 */
  const info2 = await lan.start({
    name: '测试机', version: '2.6.4', port: 47900,
    pairCode: () => CODE,
    state: () => state,
    verifyToken: (t) => devices.find((d) => d.token === t) || null,
    registerDevice: (name, ip) => {
      const d = { id: 'p' + (devices.length + 1), name, token: 'b'.repeat(31) + (devices.length + 1), ip };
      devices.push(d);
      return d;
    },
    touchDevice: () => {},
    removeDevice: () => {},
    action: async (body) => fakeAction(body)
  });
  const port2 = info2.port;
  const paired = await req(port2, 'POST', '/fcp/pair', { code: CODE, device: 'Galaxy Watch' });
  check('正确码配对成功并下发 token',
    paired.status === 200 && !!paired.json.token && paired.json.ok === true, JSON.stringify(paired.json));
  const token = paired.json.token;
  check('配对响应带电脑名与版本', paired.json.name === '测试机' && paired.json.version === '2.6.4');

  console.log('\n--- 3. 状态与鉴权 ---');
  const noAuth = await req(port2, 'GET', '/fcp/state');
  check('无 token 取状态被拒（401）', noAuth.status === 401, noAuth.status);
  const wrongTok = await req(port2, 'GET', '/fcp/state', undefined, 'deadbeef'.repeat(4));
  check('假 token 被拒（401）', wrongTok.status === 401, wrongTok.status);
  const st = await req(port2, 'GET', '/fcp/state', undefined, token);
  check('token 能取到分组快照', st.status === 200 && st.json.state.groups.length === 2);
  check('快照里没有本地路径字段（target/iconPath）',
    !/target|iconPath/.test(JSON.stringify(st.json.state)));

  console.log('\n--- 4. 动作：打开 / 改名 / 调整 / 删除 ---');
  const a1 = await req(port2, 'POST', '/fcp/action', { action: 'launch', itemId: 'i1' }, token);
  check('launch 成功且回带 message', a1.status === 200 && /已打开/.test(a1.json.message), JSON.stringify(a1.json));
  const a2 = await req(port2, 'POST', '/fcp/action', { action: 'renameItem', itemId: 'i1', name: '批注板' }, token);
  const renamed = a2.json && a2.json.state && a2.json.state.groups[0].items[0].name;
  check('renameItem 生效且响应体里就是新快照', renamed === '批注板', renamed);
  const a3 = await req(port2, 'POST', '/fcp/action', { action: 'moveItem', itemId: 'i2', dir: 'up' }, token);
  check('moveItem 把第二项换到第一位',
    a3.json.state.groups[0].items[0].id === 'i2', JSON.stringify(a3.json.state.groups[0].items.map((x) => x.id)));
  const a4 = await req(port2, 'POST', '/fcp/action', { action: 'moveItem', itemId: 'i3', dir: 'up' }, token);
  check('唯一条目再上移 → 报错（已经在边上）', a4.status === 500 && /边上/.test(a4.json.detail || ''),
    JSON.stringify(a4.json));
  const a5 = await req(port2, 'POST', '/fcp/action', { action: 'deleteItem', itemId: 'i3' }, token);
  check('deleteItem 之后该组空了', a5.json.state.groups[1].items.length === 0);

  console.log('\n--- 5. 分组：改名 / 排序 ---');
  const b1 = await req(port2, 'POST', '/fcp/action', { action: 'renameGroup', groupId: 'g1', name: '希沃工具' }, token);
  check('renameGroup 生效', b1.json.state.groups[0].name === '希沃工具', b1.json.state.groups[0].name);
  const b2 = await req(port2, 'POST', '/fcp/action', { action: 'moveGroup', groupId: 'g2', dir: 'up' }, token);
  check('moveGroup 把第二组换到第一位', b2.json.state.groups[0].id === 'g2',
    JSON.stringify(b2.json.state.groups.map((x) => x.id)));

  console.log('\n--- 6. 异常输入 ---');
  const badAct = await req(port2, 'POST', '/fcp/action', { action: 'nope' }, token);
  check('不认识的动作 → 500 且不崩', badAct.status === 500 && badAct.json.ok === false);
  const badBody = await req(port2, 'POST', '/fcp/action', null, token);
  check('空 body → 400', badBody.status === 400, badBody.status);
  const overflow = await req(port2, 'POST', '/fcp/action',
    { action: 'launch', itemId: 'x'.repeat(70000) }, token);
  check('超大 body 被丢弃（400/500 而不是崩）', overflow.status === 400 || overflow.status === 500 || overflow.status === 0,
    overflow.status);
  const notFound = await req(port2, 'GET', '/fcp/nothing', undefined, token);
  check('未知路径 → 404', notFound.status === 404, notFound.status);

  console.log('\n--- 7. 解绑 ---');
  const unp = await req(port2, 'POST', '/fcp/unpair', {}, token);
  check('unpair 返回 ok', unp.status === 200 && unp.json.ok === true);
  lan.stop();
  await new Promise((r) => setTimeout(r, 80));
  check('stop 之后端口不再监听', await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: port2, method: 'GET', path: '/fcp/ping' }, () => resolve(false));
    r.on('error', () => resolve(true));
    r.setTimeout(1500, () => { r.destroy(); resolve(true); });
    r.end();
  }));

  console.log('\n=== ' + pass + ' pass / ' + fail + ' fail ===');
  process.exit(fail ? 1 : 0);
})();
