/* 真实对话框层探针 —— v2.4.7 复盘新增的第三层验证。
 *
 * 为什么需要它（血泪）：
 *   `_rt/_packcheck.js` 直接调 API → 绕过了按钮，按钮是死的也全绿。
 *   `_rt/_packui.js` 用真实鼠标事件点按钮，但**把 dialog 打了桩** → 只能证明
 *   "处理函数被调用"，证明不了"用户真的看得见对话框"。用户第二次报
 *   「还是无法导入导出」就卡在这一层。
 *
 * 本探针不打任何桩：
 *   ① 真实鼠标事件点按钮（打在标签文字的几何中心）
 *   ② 等一会儿，然后**问操作系统**：有没有出现原生对话框（窗口类 #32770）
 *   ③ 截屏存证（人眼可复核）
 *
 * 跑法：
 *   node _rt/_packdlg.js              测全部四个按钮
 *   node _rt/_packdlg.js btnCfgExport 只测一个
 */
const { app, BrowserWindow } = require('electron');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const SB = require('./_sandbox');   // 配置走沙箱，绝不碰用户真实目录

const ROOT = path.join(__dirname, '..');
const CONF = SB.CONF;
const BACKUP = path.join(__dirname, '_pack_cfg.bak.json');
const PY = 'C:/Users/Seewo/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
/* 进程名过滤：开发态跑出来是 electron.exe，打包态才是 FClassPal.exe。
 * 写死任何一个都会把被测对象自己过滤掉，然后误报"对话框没弹出"——这个坑我踩过。 */
const PROCFILTER = process.env.FCP_PROC || 'electron';
const WINDUMP = path.join(__dirname, '_windump.py');
const SHOT = path.join(__dirname, '_packdlg_shot.png');

let pass = 0, fail = 0;
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (extra ? '  [' + extra + ']' : '')); }
};

if (!fs.existsSync(CONF)) { console.error('找不到 ' + CONF); app.exit(2); }
fs.copyFileSync(CONF, BACKUP);
const restore = () => { try { fs.copyFileSync(BACKUP, CONF); } catch (e) { /* 忽略 */ } };
app.on('will-quit', restore);
process.on('exit', restore);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function py(args) {
  return new Promise((resolve) => {
    execFile(PY, [WINDUMP].concat(args), { encoding: 'utf8' }, (err, stdout) => resolve(stdout || ''));
  });
}

async function dialogCount() {
  const out = await py(['--filter', PROCFILTER]);
  const m = out.match(/#32770）可见数 = (\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

async function closeDialogs() {
  await py(['--close-dialogs']);
}

/* 按下按钮（真实输入事件） */
async function pressButton(wc, id) {
  const info = await wc.executeJavaScript(`(() => {
    if (typeof openSettings === 'function') openSettings();
    const panel = document.getElementById('settingsPanel');
    panel.classList.remove('hidden');
    const body = panel.querySelector('.panel-body') || panel;
    body.scrollTop = body.scrollHeight;
    const b = document.getElementById('${id}');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const rg = document.createRange(); rg.selectNodeContents(b);
    const tr = rg.getBoundingClientRect();
    const tx = (tr.width ? tr.left + tr.width / 2 : r.left + r.width / 2);
    const ty = (tr.width ? tr.top + tr.height / 2 : r.top + r.height / 2);
    const hit = document.elementFromPoint(tx, ty);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      textW: Math.round(tr.width),
      x: Math.round(tx), y: Math.round(ty),
      inView: tx > 0 && ty > 0 && tx < window.innerWidth && ty < window.innerHeight,
      vw: window.innerWidth, vh: window.innerHeight,
      hitIsBtn: !!hit && (hit === b || b.contains(hit)),
      hitDesc: hit ? (hit.id || hit.tagName + '.' + (hit.className || '')) : 'null'
    };
  })()`);
  if (!info) return null;
  wc.sendInputEvent({ type: 'mouseDown', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  return info;
}

const BTNS = process.argv[2] ? [process.argv[2]] : [
  'btnCfgExport', 'btnCfgImport', 'btnThemeExport', 'btnThemeImport'
];

/* 拉起真实主进程（不打任何 dialog 桩）。
 * 但给 dialog 包一层只读追踪：记录"有没有被调用"以及"返回值/异常"——
 * 这是为了把两种可能彻底分开：
 *   ① 处理函数压根没被调用（按钮/IPC 层的问题）
 *   ② 处理函数调用了，但对话框没显示（对话框层的问题）
 * 包装**不改变行为**，原函数照常执行。 */
require(path.join(ROOT, 'main.js'));

const { dialog } = require('electron');
const trace = { calls: [], results: [] };
const wrap = (name) => {
  const orig = dialog[name].bind(dialog);
  dialog[name] = function (a, b) {
    trace.calls.push(name);
    return orig(a, b).then(
      (r) => { trace.results.push(name + ' -> ' + JSON.stringify(r)); return r; },
      (e) => { trace.results.push(name + ' !! ' + (e && e.message)); throw e; }
    );
  };
};
wrap('showSaveDialog');
wrap('showOpenDialog');

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    await wait(500);
    win = BrowserWindow.getAllWindows()[0] || null;
  }
  if (!win) { console.error('等不到主窗口'); app.exit(3); return; }
  const wc = win.webContents;
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  await wait(1200);
  win.setPosition(60, 60);
  win.showInactive();
  await wait(600);

  for (const id of BTNS) {
    await closeDialogs();
    await wait(400);
    const before = await dialogCount();
    const info = await pressButton(wc, id);
    if (!info) { check('找到按钮 ' + id, false); continue; }

    check(id + ' 按钮可见且尺寸正常', info.w > 60 && info.h > 20 && info.inView,
      info.w + '×' + info.h + '  文字宽 ' + info.textW + '  视口 ' + info.vw + '×' + info.vh);
    check(id + ' 文字中心命中的是按钮本身', info.hitIsBtn, '命中 ' + info.hitDesc);

    await wait(3000);
    const after = await dialogCount();
    check('★ ' + id + ' 点击后操作系统层面出现原生对话框（#32770）',
      after > before, '点击前=' + before + ' 点击后=' + after);
    console.log('        dialog 调用记录：calls=' + JSON.stringify(trace.calls) +
      ' results=' + JSON.stringify(trace.results));
    if (after > before) {
      await py(['--filter', PROCFILTER, '--shot', SHOT.replace('.png', '_' + id + '.png')]);
    }
    await closeDialogs();
    await wait(600);
  }

  /* 关掉可能残留的对话框后截一张全景图 */
  await closeDialogs();
  await wait(500);
  await py(['--filter', PROCFILTER, '--shot', SHOT]);

  const errs = await wc.executeJavaScript('(window.__probeErrs || []).length');
  console.log('  渲染层 JS 错误数=' + errs);
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(3); });
