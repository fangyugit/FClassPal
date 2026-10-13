/* v2.5.0 端到端验证：打包版 → 真按钮 → 真系统对话框。
 * CDP 在渲染层点击 btnCfgExport（走真实 IPC → 主进程 dialog.showOpenDialog），
 * 由外部 _windump.py 数 #32770 原生对话框；随后发 ESC 关掉它。
 * 用法：先由 PowerShell（干净环境变量）启动打包版并带 --remote-debugging-port=9335。 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9335, path }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await get('/json/list');
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO-PAGE'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => { ws.addEventListener('open', r); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.result && r.result.result.value;
  };
  const out = {};
  out.ua = await evalJs('navigator.userAgent.includes("Electron")');
  out.btn = await evalJs('!!document.getElementById("btnCfgExport")');
  out.panelOpen = await evalJs('(function(){const p=document.getElementById("settingsPanel");if(!p)return false;p.classList.remove("hidden");return true;})()');
  /* 真点击：走 app.js 绑定的 handler → IPC export-config → 主进程真对话框 */
  out.clicked = await evalJs('document.getElementById("btnCfgExport").click(); true');
  console.log('CLICKED ' + JSON.stringify(out));
  /* 等对话框起来，再发 ESC 关闭（对话框会阻塞那个 IPC promise，无所谓） */
  await new Promise((r) => setTimeout(r, 6000));
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape'
    });
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log('ESC-SENT');
  process.exit(0);
}
main().catch((e) => { console.log('ERR', e.message); process.exit(1); });
