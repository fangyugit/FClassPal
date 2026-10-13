/* v2.4.6 · 「导入导出按钮点不动 / 文字超出按钮」真机复现探针。
 *
 * 为什么需要它：`_rt/_packcheck.js` 是直接 `executeJavaScript('API.exportConfig()')` ——
 * 它验的是 IPC 链路，**完全绕过了按钮本身**，所以按钮尺寸/可点区域坏掉时它照样全绿
 * （教训：验证必须打在用户真正碰的那一层）。
 *
 * 本探针只做一件事：用**真实鼠标事件**（webContents.sendInputEvent）点在按钮上，
 * 并且先做命中测试（elementFromPoint 落在按钮上吗）。
 *
 * 三项断言/按钮：
 *   ① 按钮盒宽高 > 60px（不是被 .size-controls 的 30×30 压扁）
 *   ② 标签文字几何中心 elementFromPoint 命中按钮自身（点得到）
 *   ③ 真实 mouseDown/mouseUp 之后，文件对话框桩被调用（= 真的走通了）
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE -u HTTP_PROXY -u HTTPS_PROXY \
 *     ./node_modules/electron/dist/electron.exe _rt/_packui.js
 */
const { app, BrowserWindow, dialog } = require('electron');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const fs = require('fs');
const os = require('os');
const SB = require('./_sandbox');   // 配置走沙箱，绝不碰用户真实目录

const ROOT = path.join(__dirname, '..');
const CONF = SB.CONF;
const BACKUP = path.join(__dirname, '_pack_cfg.bak.json');
const OUTDIR = path.join(__dirname, '_pack_out');

let pass = 0, fail = 0;
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (extra ? '  [' + extra + ']' : '')); }
};

if (!fs.existsSync(CONF)) { console.error('找不到 ' + CONF); app.exit(2); }
fs.copyFileSync(CONF, BACKUP);
const restore = () => { try { fs.copyFileSync(BACKUP, CONF); } catch (e) { } };
app.on('will-quit', restore);
process.on('exit', restore);
const realCfg = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
fs.writeFileSync(CONF, JSON.stringify(Object.assign({}, realCfg, {
  autoLaunch: false, realtime: false, keepBottom: false, locked: false
}), null, 2));

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

/* 对话框桩：记录被调用次数，返回固定路径 */
const calls = { save: 0, open: 0 };
dialog.showSaveDialog = async (win, opts) => {
  calls.save++;
  const p = /fcpt/.test((opts && opts.defaultPath) || '') ? path.join(OUTDIR, 'ui.fcpt') : path.join(OUTDIR, 'ui.fcpc');
  return { canceled: false, filePath: p };
};
dialog.showOpenDialog = async () => {
  calls.open++;
  return { canceled: true, filePaths: [] };
};

require(path.join(ROOT, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickButton(wc, id) {
  const info = await wc.executeJavaScript(`(() => {
    const b = document.getElementById('${id}');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const txt = (b.textContent || '').trim();
    // 文字几何中心（不是按钮盒中心）：用户点的是看得见的字
    let tx = r.left + r.width / 2, ty = r.top + r.height / 2;
    if (txt) {
      const range = document.createRange();
      range.selectNodeContents(b);
      const tr = range.getBoundingClientRect();
      if (tr.width) { tx = tr.left + tr.width / 2; ty = tr.top + tr.height / 2; }
    }
    const hit = document.elementFromPoint(tx, ty);
    return {
      id: '${id}', text: txt,
      w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100,
      boxX: r.left + r.width / 2, boxY: r.top + r.height / 2,
      txtX: tx, txtY: ty,
      textW: Math.round((rangeWidth(b)) * 100) / 100,
      hitIsBtn: !!hit && (hit === b || b.contains(hit)),
      hitDesc: hit ? (hit.id || hit.tagName + '.' + (hit.className || '')) : 'null'
    };
    function rangeWidth(el) {
      const rg = document.createRange(); rg.selectNodeContents(el);
      const rr = rg.getBoundingClientRect(); return rr.width || 0;
    }
  })()`);
  if (!info) return null;
  // 真实鼠标事件：点在**文字中心**（用户实际点的位置）
  const x = Math.round(info.txtX), y = Math.round(info.txtY);
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  return info;
}

app.whenReady().then(async () => {
  await wait(2600);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  win.setPosition(80, 80);
  win.showInactive();

  // 打开设置面板 + 滚到底（用户就是在这里点的）
  await wc.executeJavaScript(`document.getElementById('settingsPanel').classList.remove('hidden');
    const b = document.getElementById('settingsPanel').querySelector('.panel-body');
    if (b) b.scrollTop = b.scrollHeight;
    true;`);
  await wait(500);

  const BUTTONS = [
    /* v2.5.0：导出从「另存为」改成「选文件夹」（用户反馈另存为不直观），
     * 所以导出按钮触发的也是 showOpenDialog(openDirectory) —— kind 全是 open。 */
    ['btnCfgExport', 'open', 'fcpc'],
    ['btnCfgImport', 'open', 'fcpc'],
    ['btnThemeExport', 'open', 'fcpt'],
    ['btnThemeImport', 'open', 'fcpt']
  ];

  for (const [id, kind, ext] of BUTTONS) {
    const before = calls[kind];   // 计数基准
    const info = await clickButton(wc, id);
    if (!info) { check(id + ' 存在', false); continue; }
    // ① 尺寸没被压扁（30×30 的方形图标按钮容器症状）
    check(id + ' 按钮盒尺寸正常（未被压成 30px 方形）', info.w > 60 && info.h > 20,
      info.w + '×' + info.h + '  文字宽 ' + info.textW);
    // ② 点得到的区域：文字中心必须命中按钮
    check(id + ' 文字中心命中的是按钮本身', info.hitIsBtn, '命中 ' + info.hitDesc);
    // ③ 真实点击后对话框被调用（比点击前多一次）
    await wait(700);
    const now = calls[kind];
    check(id + ' 真实点击触发了文件对话框', now > before,
      'save=' + calls.save + ' open=' + calls.open);
  }

  // 导出产物真的落盘
  await wait(400);
  check('导出产物已落盘（ui.fcpc）', fs.existsSync(path.join(OUTDIR, 'ui.fcpc')),
    fs.existsSync(path.join(OUTDIR, 'ui.fcpc')) ? fs.statSync(path.join(OUTDIR, 'ui.fcpc')).size + 'B' : '缺');
  check('导出产物已落盘（ui.fcpt）', fs.existsSync(path.join(OUTDIR, 'ui.fcpt')),
    fs.existsSync(path.join(OUTDIR, 'ui.fcpt')) ? fs.statSync(path.join(OUTDIR, 'ui.fcpt')).size + 'B' : '缺');

  const errs = await wc.executeJavaScript('(window.__probeErrs || []).length');
  console.log('  渲染层 JS 错误数=' + errs);
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(3); });
