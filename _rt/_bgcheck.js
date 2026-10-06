/* 「选择背景图片后软件无法操作」复现与定位（v2.4.1）
 *
 * 做法：不猜，直接把**真实的 main.js** 拉起来，只把原生文件对话框换成桩
 * （对话框需要真人点，自动化点不了，其余链路全是真的：IPC、读写文件、
 *  Monet 取色、palette 下发、渲染层 applyCustomBackground）。
 *
 * 量三件事：
 *   ① 主进程事件循环延迟（50ms 心跳的实际间隔）—— 卡住 = 整个 app 无响应
 *   ② 渲染层 executeJavaScript 往返时延 —— 卡住 = 界面点不动
 *   ③ 图片到底有没有在渲染层加载出来（file:// 子资源 + 中文路径）
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
 *     ./node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu _rt/_bgcheck.js
 *     （--no-sandbox 现在由脚本自己补上，直接跑 .exe 加脚本路径即可）
 */
const { app, BrowserWindow, dialog } = require('electron');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const CONF_DIR = path.join(os.homedir(), '.desktop-widget');
const CONF = path.join(CONF_DIR, 'config.json');
const BACKUP = path.join(__dirname, '_bg', 'config.backup.json');
const IMG = (n) => path.join(__dirname, '_bg', n);

let pass = 0, fail = 0;
const notes = [];
function assert(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function note(s) { notes.push(s); console.log('  · ' + s); }

/* ---------- ① 备份真实配置，装一份可控的测试配置 ---------- */
if (!fs.existsSync(CONF)) { console.error('找不到真实配置：' + CONF); app.exit(2); }
fs.copyFileSync(CONF, BACKUP);
const realCfg = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
const testCfg = Object.assign({}, realCfg, {
  autoLaunch: false,        // ★ 绝不能碰用户的开机启动项
  realtime: false,
  keepBottom: false,
  opacity: 0,               // ★ 与用户现场一致：透明度滑到最左（--glass-alpha: 0）
  theme: 'kitty',           // 用户报障时就在这套主题上
  appearance: 'light',
  background: { enabled: false, path: '', blur: 0, mask: 0, scale: 100, offsetX: 50, offsetY: 50, fit: 'cover' }
});
fs.writeFileSync(CONF, JSON.stringify(testCfg, null, 2));
function restoreConfig() {
  try { fs.copyFileSync(BACKUP, CONF); console.log('  · 真实配置已还原'); } catch (e) { console.log('  ! 还原失败 ' + e.message); }
}
app.on('will-quit', restoreConfig);
process.on('exit', restoreConfig);

/* ---------- ② 桩掉对话框 ---------- */
let nextPick = null;
let dialogCalls = 0;
dialog.showOpenDialog = async (win, opts) => {
  dialogCalls++;
  const isBg = opts && opts.title === '选择背景图片';
  console.log(`  · 对话框被调用 #${dialogCalls}${isBg ? '（背景图）' : '（' + (opts && opts.title || '其他') + '）'} → ` +
    (isBg && nextPick ? path.basename(nextPick) : 'cancel'));
  if (isBg && nextPick) { const p = nextPick; return { canceled: false, filePaths: [p] }; }
  return { canceled: true, filePaths: [] };
};

/* ---------- ③ 主进程事件循环延迟探针 ---------- */
let maxLag = 0;
let lastTick = Date.now();
let lagWindow = 0;
const lagTimer = setInterval(() => {
  const n = Date.now();
  const lag = n - lastTick - 50;
  if (lag > maxLag) maxLag = lag;
  if (lag > lagWindow) lagWindow = lag;
  lastTick = n;
}, 50);
function resetLag() { maxLag = 0; lagWindow = 0; lastTick = Date.now(); }

/* ---------- ④ 拉起真实主进程 ---------- */
require(path.join(ROOT, 'main.js'));

const rendererErrors = [];
function wire(wc) {
  try {
    wc.on('console-message', (...a) => {
      // Electron 版本之间签名不同：新版是 (event{level,message,...})，旧版是 (e, level, message, line, src)
      let level, message;
      if (a[0] && typeof a[0] === 'object' && 'message' in a[0]) { level = a[0].level; message = a[0].message; }
      else { level = a[1]; message = a[2]; }
      if (level === 'error' || level === 3 || level === 2) rendererErrors.push(String(message));
    });
  } catch (e) { /* 老版本没有这个事件也无所谓 */ }
  wc.on('render-process-gone', (e, d) => rendererErrors.push('RENDERER GONE: ' + JSON.stringify(d)));
}

/** 往返时延：渲染层主线程被卡住时这里会超时 */
async function ping(wc, label, timeoutMs) {
  const t0 = Date.now();
  const res = await Promise.race([
    wc.executeJavaScript('(function(){return 1})()'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), timeoutMs || 4000)),
  ]).catch((e) => 'THROW:' + e.message);
  const dt = Date.now() - t0;
  const ok = res !== 'TIMEOUT' && String(res).indexOf('THROW') !== 0;
  console.log(`  · ping ${label}: ${ok ? dt + 'ms' : res}`);
  return { ok, dt };
}

/** 点一个元素（真实事件派发） */
const clickSel = (sel) => `(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'NO_EL';el.click();return 'OK';})()`;

/* 「界面还能不能操作」的硬指标：在窗口里撒 81 个点做命中测试。
 * 元素被某个隐形层盖住时 click 全被它吃掉 —— 这就是用户说的"无法操作"。
 * 与"选图前"的命中直方图对比：如果选图后多出一个满窗的命中目标，
 * 说明有层顶到最上面把界面接管了。 */
const HIT_TEST = `(function(){
  var w = document.getElementById('widget');
  var r = w.getBoundingClientRect();
  var names = {};
  for (var i = 1; i <= 9; i++) for (var j = 1; j <= 9; j++) {
    var x = Math.round(r.left + r.width * i / 10);
    var y = Math.round(r.top + r.height * j / 10);
    var el = document.elementFromPoint(x, y);
    if (!el) { names['(null)'] = (names['(null)']||0)+1; continue; }
    var cn = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/)[0] : '';
    var tag = el.tagName.toLowerCase() + (el.id ? '#'+el.id : (cn ? '.'+cn : ''));
    names[tag] = (names[tag]||0)+1;
  }
  var wcs = getComputedStyle(w);
  return { hits: names, a: wcs.pointerEvents, b: wcs.display, c: wcs.visibility,
           w: Math.round(r.width), h: Math.round(r.height) };
})()`;
function hitSummary(h) {
  return Object.keys(h.hits).sort((x, y) => h.hits[y] - h.hits[x])
    .map((k) => k + '×' + h.hits[k]).join(', ');
}
/** 等到命中直方图**连着两次一样**再当基线。
 *
 * 为什么要这样：格子有入场动画（t-enter），init 里还有 render / 量圆角等一串活儿，
 * 固定 2.5s 之后直接采样时快时慢 —— 曾经抓到过 before=「item-grid×41 + svg×1」、
 * after=「item-grid×31 + use×1」的假失败（前后其实完全一致，是**基线**采早了，
 * 那一刻格子还没铺满、预设图标的内层 <use> 也还没画出来）。
 * 与"选了背景图之后界面有没有被接管"无关，纯粹是采样时机问题，所以这里等它稳定。 */
async function stableHit(wc, tries = 10, gap = 250) {
  let prev = null, cur = null;
  for (let i = 0; i < tries; i++) {
    cur = await wc.executeJavaScript(HIT_TEST);
    const s = hitSummary(cur);
    if (prev === s) return cur;
    prev = s;
    await new Promise((r) => setTimeout(r, gap));
  }
  return cur;
}

app.whenReady().then(async () => {
  // 等主进程把窗口建出来
  let win = null;
  for (let i = 0; i < 60 && !win; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) await new Promise((r) => setTimeout(r, 250));
  }
  if (!win) { console.error('没拿到窗口'); restoreConfig(); app.exit(3); }
  wire(win.webContents);
  await new Promise((r) => setTimeout(r, 2500));   // 等渲染层 init 跑完（feImage 解码等）
  const wc = win.webContents;

  console.log('[0] 基线]');
  const b1 = await ping(wc, '基线');
  assert('基线：渲染层能响应', b1.ok && b1.dt < 800, b1.dt + 'ms');
  const baseState = await wc.executeJavaScript(`(function(){
    var bg=document.getElementById('bgCustom');
    return { cls: document.body.className,
             alpha: getComputedStyle(document.getElementById('widget')).getPropertyValue('--glass-alpha').trim(),
             hasEl: !!bg, bgImg: bg ? getComputedStyle(bg).backgroundImage.slice(0,60) : null,
             envDisplay: getComputedStyle(document.getElementById('envLayer')).display };
  })()`);
  console.log('  · 基线状态 ' + JSON.stringify(baseState));
  const hitBefore = await stableHit(wc);
  console.log('  · 选图前命中分布: ' + hitSummary(hitBefore));
  resetLag();

  /* ---------- 主流程：点「选择图片…」 ---------- */
  console.log('[1] 选一张普通背景图（模拟用户操作）]');
  nextPick = IMG('normal.jpg');
  const before = dialogCalls;
  const clicked = await wc.executeJavaScript(clickSel('#btnBgPick'));
  assert('#btnBgPick 存在且可点击', clicked === 'OK', clicked);
  // 等对话框桩 + IPC + 取色 + 重绘全部走完
  await new Promise((r) => setTimeout(r, 2500));
  const p1 = await ping(wc, '选图之后');
  assert('★ 选图之后渲染层仍能响应（不卡界面）', p1.ok && p1.dt < 1200, p1.dt + 'ms');
  note(`选图期间主进程事件循环最大延迟 = ${lagWindow}ms`);
  assert('★ 选图期间主进程没有被长阻塞（<800ms）', lagWindow < 800, lagWindow + 'ms');
  assert('对话框确实被调用了一次', dialogCalls === before + 1, `calls=${dialogCalls}`);

  const s1 = await wc.executeJavaScript(`(function(){
    var bg=document.getElementById('bgCustom');
    var cs=bg?getComputedStyle(bg):null;
    return { cls: document.body.className,
             bgImg: cs?cs.backgroundImage.slice(0,110):null,
             bgSize: cs?cs.backgroundSize:null, bgPos: cs?cs.backgroundPosition:null,
             filter: cs?cs.filter:null, transform: cs?cs.transform:null,
             envDisplay: getComputedStyle(document.getElementById('envLayer')).display,
             envImg: getComputedStyle(document.getElementById('envLayer')).backgroundImage.slice(0,20),
             alpha: getComputedStyle(document.getElementById('widget')).getPropertyValue('--glass-alpha').trim(),
             fileInfo: (document.getElementById('bgFileInfo')||{}).textContent,
             toast: (document.querySelector('.toast')||{}).textContent };
  })()`);
  console.log('  · 选图后状态 ' + JSON.stringify(s1, null, 0));
  assert('body 挂上了 bg-custom 类', s1.cls.indexOf('bg-custom') >= 0, s1.cls);
  assert('#bgCustom 拿到了背景图 URL', /url\(/.test(s1.bgImg || ''));
  assert('底材层已让位（env-layer display:none）', s1.envDisplay === 'none', s1.envDisplay);

  /* ★★ 决定性的那条：选图之后界面有没有被隐形层接管 */
  const hitAfter = await stableHit(wc);
  console.log('  · 选图后命中分布: ' + hitSummary(hitAfter));
  assert('★ 选图后没有多出接管界面的满窗层（命中分布与选图前一致）',
    hitSummary(hitAfter) === hitSummary(hitBefore),
    'before=[' + hitSummary(hitBefore) + '] after=[' + hitSummary(hitAfter) + ']');
  assert('★ #widget 自身仍可接收指针事件（不被 pointer-events:none 关掉）',
    hitAfter.a === 'auto' && hitAfter.b !== 'none' && hitAfter.c === 'visible',
    `pe=${hitAfter.a} display=${hitAfter.b} vis=${hitAfter.c}`);

  /* ★ 关键：这张图在渲染层到底加载出来没有 */
  const loadTest = await wc.executeJavaScript(`(function(){
    var raw = document.getElementById('bgCustom').style.backgroundImage;
    var m = /url\\("?([^")]+)"?\\)/.exec(raw);
    if (!m) return Promise.resolve({ ok:false, why:'style 里没有 url', raw: raw.slice(0,120) });
    var url = m[1];
    return new Promise(function(res){
      var t0 = Date.now(); var im = new Image();
      im.onload = function(){ res({ ok:true, url:url.slice(0,90), w:im.naturalWidth, h:im.naturalHeight, ms:Date.now()-t0 }); };
      im.onerror = function(){ res({ ok:false, why:'onerror', url:url.slice(0,90), ms:Date.now()-t0 }); };
      im.src = url;
      setTimeout(function(){ res({ ok:false, why:'超时未加载', url:url.slice(0,90) }); }, 4000);
    });
  })()`);
  console.log('  · 图片加载 ' + JSON.stringify(loadTest));
  assert('★ 背景图真的在渲染层加载成功（file:// 子资源可达）', loadTest.ok === true,
    loadTest.ok ? `${loadTest.w}×${loadTest.h} in ${loadTest.ms}ms` : JSON.stringify(loadTest));

  /* ---------- 再点一次：能不能连续操作 ---------- */
  console.log('[2] 连续第二次操作（界面还能不能用）]');
  await wc.executeJavaScript(clickSel('#setBgOn'));
  await new Promise((r) => setTimeout(r, 800));
  const p2 = await ping(wc, '二次操作后');
  assert('★ 还能继续点界面控件', p2.ok && p2.dt < 1200, p2.dt + 'ms');

  /* ---------- 超大图 ---------- */
  console.log('[3] 换一张超大图（5200×3900, 5.6MB）]');
  resetLag();
  nextPick = IMG('huge.jpg');
  await wc.executeJavaScript(clickSel('#btnBgPick'));
  await new Promise((r) => setTimeout(r, 3500));
  const p3 = await ping(wc, '大图之后');
  assert('★ 超大图也不会卡界面', p3.ok && p3.dt < 1500, p3.dt + 'ms');
  note(`大图期间主进程最大延迟 = ${lagWindow}ms`);
  assert('超大图主进程阻塞 <1200ms', lagWindow < 1200, lagWindow + 'ms');

  /* ---------- 中文路径 ---------- */
  console.log('[4] 含中文与空格的路径]');
  const cnDir = path.join(__dirname, '_bg', '我的 图片');
  fs.mkdirSync(cnDir, { recursive: true });
  const cnFile = path.join(cnDir, '背景 图.jpg');
  fs.copyFileSync(IMG('normal.jpg'), cnFile);
  resetLag();
  nextPick = cnFile;
  await wc.executeJavaScript(clickSel('#btnBgPick'));
  await new Promise((r) => setTimeout(r, 2000));
  const cnLoad = await wc.executeJavaScript(`(function(){
    var raw = document.getElementById('bgCustom').style.backgroundImage;
    var m = /url\\("?([^")]+)"?\\)/.exec(raw);
    if (!m) return Promise.resolve({ ok:false, why:'无 url' });
    return new Promise(function(res){ var im=new Image();
      im.onload=function(){res({ok:true,w:im.naturalWidth,url:m[1].slice(0,110)});};
      im.onerror=function(){res({ok:false,why:'onerror',url:m[1].slice(0,110)});};
      im.src=m[1]; setTimeout(function(){res({ok:false,why:'超时',url:m[1].slice(0,110)});},4000); });
  })()`);
  console.log('  · 中文路径加载 ' + JSON.stringify(cnLoad));
  assert('★ 中文/空格路径的图片也能加载', cnLoad.ok === true, JSON.stringify(cnLoad));
  const p4 = await ping(wc, '中文路径之后');
  assert('中文路径后仍可操作', p4.ok && p4.dt < 1500, p4.dt + 'ms');

  /* ---------- 用户现场参数：opacity=0 + 走「启用」开关触发选图 ---------- */
  console.log('[4b] 用户现场：opacity=0（玻璃全透）+ 从「启用自定义背景」开关选图]');
  await wc.executeJavaScript(`(function(){
    // 用户 config.json 里 opacity=0，透明度滑块拉到最左 = 玻璃面完全透明
    var w=document.getElementById('widget');
    w.style.setProperty('--glass-alpha','0');
    return true;
  })()`);
  // 清掉已有背景，让开关走到"没图 → 先选图"那条分支
  await wc.executeJavaScript(`(function(){
    var c=document.getElementById('btnBgClear'); if(c) c.click(); return true;
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  resetLag();
  nextPick = IMG('normal.jpg');
  // 真实用户操作：勾选「启用自定义背景」→ 触发自动弹选图框
  const toggled = await wc.executeJavaScript(`(function(){
    var el=document.getElementById('setBgOn');
    if(!el) return 'NO_EL';
    el.checked = true;
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return 'OK';
  })()`);
  assert('「启用自定义背景」开关存在', toggled === 'OK', toggled);
  await new Promise((r) => setTimeout(r, 2500));
  const p5 = await ping(wc, '开关路径选图后');
  assert('★ 开关路径选图后界面仍响应', p5.ok && p5.dt < 1500, p5.dt + 'ms');
  note(`开关路径主进程最大延迟 = ${lagWindow}ms`);
  const hit5 = await stableHit(wc);
  console.log('  · 命中分布: ' + hitSummary(hit5));
  assert('★ opacity=0 + 自定义背景：命中分布仍与最初一致（界面没被接管）',
    hitSummary(hit5) === hitSummary(hitBefore),
    'now=[' + hitSummary(hit5) + ']');
  assert('★ opacity=0 下 #widget 依然可交互', hit5.a === 'auto' && hit5.b !== 'none', `pe=${hit5.a} display=${hit5.b}`);

  /* ---------- 渲染层异常 ---------- */
  console.log('[5] 渲染层报错]');
  const uniq = Array.from(new Set(rendererErrors)).filter((m) => !/DevTools|Autofill|GPU|gpu_|Security Warning/i.test(m));
  assert('渲染层没有未捕获异常', uniq.length === 0, uniq.slice(0, 3).join(' | '));
  if (uniq.length) uniq.slice(0, 6).forEach((m) => console.log('    ! ' + m));

  /* ---------- 落盘结果 ---------- */
  const onDisk = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
  console.log('[6] 落盘配置]');
  console.log('  · background=' + JSON.stringify(onDisk.background));
  console.log('  · opacity=' + onDisk.opacity + ' theme=' + onDisk.theme + ' appearance=' + onDisk.appearance);
  assert('背景配置写进了盘', !!(onDisk.background && onDisk.background.enabled && onDisk.background.path));

  clearInterval(lagTimer);

  /* ---------- 截图：真实主进程窗口 + 真实背景图 ---------- */
  try {
    const img = await win.capturePage();
    const out = path.join(__dirname, '_bg', 'bg_applied.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('  · 已存图 ' + path.relative(ROOT, out) + ' (' + img.getSize().width + '×' + img.getSize().height + ')');
  } catch (e) { console.log('  · 截图失败（无桌面会话时正常）：' + e.message); }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  restoreConfig();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('harness 崩了:', e); restoreConfig(); app.exit(1); });
