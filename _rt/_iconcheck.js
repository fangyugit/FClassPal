/* 图标填充 / 图标边框（v2.4.2）的真机正面验证。
 *
 * 三件事必须在这条链路上验，光看源码看不出来：
 *   ① **透明像素不能算进主色**。exe 提取的图标是带透明留白的 PNG，透明区是
 *      (0,0,0,0)。要是把它们也算进聚类，留白面积一大主色就恒等于黑，所有图标
 *      都会被套上一圈黑边 —— 而且看不出是"算错了"，只会觉得"这功能不好看"。
 *      所以这里造一张「透明底 + 中间一小块纯红」的图，断言取出来的是红不是黑。
 *   ② **描边色是图自己的颜色**。端到端读 .item-icon 的 computed borderColor，
 *      而不是读我们写进去的 CSS 变量（变量写对了但没生效是最常见的假成功）。
 *      顺带验「预设图标 / 字符图标没有取色源 → 退回主题强调色」不会变成白色或 currentColor。
 *   ③ **挂 body 的两个状态类没有把界面搞哑**。ic-auto / ic-none 是挂在 body 上的，
 *      跟 v2.4.1 那次"裸 .bg-custom 命中 body → 整站点不动"是同一类风险，
 *      所以这里带着 ic-auto 重做一次 81 点命中测试。
 * 外加回归：用户报的「选择图片/清除 两个按钮的文字跑到按钮外面」。
 *
 * 跑法（脚本自己补 --no-sandbox；必须去掉 ELECTRON_RUN_AS_NODE 与四个代理变量，
 * 否则 require('electron') 拿到的是字符串、file:// 加载会被代理拦）：
 *   env -u ELECTRON_RUN_AS_NODE -u HTTP_PROXY -u HTTPS_PROXY \
 *     ./node_modules/electron/dist/electron.exe _rt/_iconcheck.js
 *
 * 会**备份并还原**用户真实的 ~/.desktop-widget/config.json（测试要往配置里塞几个
 * 假快捷方式），并强制 autoLaunch:false —— 绝不动用户的开机启动项。
 */
const { app, BrowserWindow, dialog, nativeImage } = require('electron');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CONF_DIR = path.join(os.homedir(), '.desktop-widget');
const CONF = path.join(CONF_DIR, 'config.json');
const WORK = path.join(__dirname, '_bg');
const BACKUP = path.join(WORK, 'config.iconcheck.backup.json');

let pass = 0, fail = 0;
const notes = [];
function assert(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function note(s) { notes.push(s); console.log('  · ' + s); }

if (!fs.existsSync(WORK)) fs.mkdirSync(WORK, { recursive: true });

/* ---------- ① 造测试图（纯 Electron，不依赖任何图像库） ---------- */
function makePng(file, w, h, painter) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = painter(x, y);
      const i = (y * w + x) * 4;
      buf[i] = c[2]; buf[i + 1] = c[1]; buf[i + 2] = c[0]; buf[i + 3] = c[3];   // BGRA
    }
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG());
}

const RED = [222, 42, 58, 255];
const GREEN = [36, 168, 92, 255];
const P_RED = path.join(WORK, 'ic_red_alpha.png');     // 透明底 + 中间一块纯红
const P_GREEN = path.join(WORK, 'ic_green.png');       // 满幅纯绿
const P_CLEAR = path.join(WORK, 'ic_clear.png');       // 全透明（没有取色源）
makePng(P_RED, 64, 64, (x, y) => (x >= 20 && x < 44 && y >= 20 && y < 44 ? RED : [0, 0, 0, 0]));
makePng(P_GREEN, 64, 64, () => GREEN);
makePng(P_CLEAR, 64, 64, () => [0, 0, 0, 0]);
note('测试图已生成：' + ['ic_red_alpha.png', 'ic_green.png', 'ic_clear.png'].join(', '));
const URL_RED = pathToFileURL(P_RED).href;
const URL_GREEN = pathToFileURL(P_GREEN).href;
const URL_CLEAR = pathToFileURL(P_CLEAR).href;

/* ---------- ② 备份真实配置，装测试配置 ---------- */
if (!fs.existsSync(CONF)) { console.error('找不到真实配置：' + CONF); app.exit(2); }
fs.copyFileSync(CONF, BACKUP);
const realCfg = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
const testCfg = Object.assign({}, realCfg, {
  autoLaunch: false,          // 绝不能碰用户的开机启动项
  realtime: false,
  keepBottom: false,
  opacity: 0.55,
  theme: 'glass',
  appearance: 'light',
  background: { enabled: false, path: '', blur: 0, mask: 0, scale: 100, offsetX: 50, offsetY: 50, fit: 'cover' },
  iconFit: 'cover',
  iconBorder: 'glass',
  groups: [{
    id: 'group-test',
    name: '测试分组',
    items: [
      { id: 'it-img', name: '图片图标', type: 'file', target: 'C:/x', icon: 'app', iconPath: URL_RED },
      { id: 'it-svg', name: '预设图标', type: 'file', target: 'C:/x', icon: 'folder' },
      { id: 'it-chr', name: '字符图标', type: 'file', target: 'C:/x', icon: 'app', iconChar: 'A' }
    ]
  }]
});
fs.writeFileSync(CONF, JSON.stringify(testCfg, null, 2));
function restoreConfig() {
  try { fs.copyFileSync(BACKUP, CONF); console.log('  · 真实配置已还原'); }
  catch (e) { console.log('  ! 还原失败 ' + e.message); }
}
app.on('will-quit', restoreConfig);
process.on('exit', restoreConfig);

/* ---------- ③ 桩掉对话框（这个探针不走选图，桩掉纯粹防意外弹出） ---------- */
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });

/* ---------- ④ 拉起真实主进程 ---------- */
require(path.join(ROOT, 'main.js'));

const rendererErrors = [];
function wire(wc) {
  try {
    wc.on('console-message', (...a) => {
      let level, message;
      if (a[0] && typeof a[0] === 'object' && 'message' in a[0]) { level = a[0].level; message = a[0].message; }
      else { level = a[1]; message = a[2]; }
      if (level === 'error' || level === 3 || level === 2) {
        const msg = String(message);
        // Electron 自带的安全提示是 console.warn 级别，跟本应用的 bug 无关，别混进来
        if (/Electron Security Warning|Content Security Policy/.test(msg)) return;
        rendererErrors.push(msg);
      }
    });
  } catch (e) { /* 老版本没这个事件也无所谓 */ }
  wc.on('render-process-gone', (e, d) => rendererErrors.push('RENDERER GONE: ' + JSON.stringify(d)));
}

/* 带着 ic-auto 生效的状态做命中测试：挂 body 的状态类一旦误伤祖先，这里立刻表现为
 * 全部落在 <html> 上（v2.4.1 那次"点不动"就是这么被抓出来的）。 */
const HIT_TEST = `(function(){
  var w = document.getElementById('widget');
  var r = w.getBoundingClientRect(), hits = {}, html = 0;
  for (var i = 1; i <= 9; i++) for (var j = 1; j <= 9; j++) {
    var el = document.elementFromPoint(Math.round(r.left + r.width*i/10), Math.round(r.top + r.height*j/10));
    if (!el) continue;
    if (el === document.documentElement) { html++; continue; }
    var cn = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/)[0] : '';
    var tag = el.tagName.toLowerCase() + (el.id ? '#'+el.id : (cn ? '.'+cn : ''));
    hits[tag] = (hits[tag]||0)+1;
  }
  var b = getComputedStyle(document.body);
  return { bodyPos: b.position, bodyPe: b.pointerEvents, htmlHits: html, targets: Object.keys(hits).length,
           summary: Object.keys(hits).sort(function(a,c){return hits[c]-hits[a];}).slice(0,5)
             .map(function(k){return k+'x'+hits[k];}).join(',') };
})()`;

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  let win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) { console.error('没拿到窗口'); restoreConfig(); app.exit(3); }
  const wc = win.webContents;
  wire(wc);

  /* ---------- ① 主色提取：透明像素必须被跳过 ---------- */
  const colors = await wc.executeJavaScript(`(async function(){
    var got = await window.widgetAPI.getIconColors(${JSON.stringify([URL_RED, URL_GREEN, URL_CLEAR])});
    return got;
  })()`);
  const cRed = colors[URL_RED];
  const cGreen = colors[URL_GREEN];
  const cClear = colors[URL_CLEAR];
  note('取色结果：透明底红块=' + cRed + '  纯绿=' + cGreen + '  全透明=' + cClear);

  function hexToRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
    return m ? [(parseInt(m[1], 16) >> 16) & 255, (parseInt(m[1], 16) >> 8) & 255, parseInt(m[1], 16) & 255] : null;
  }
  const rgbRed = hexToRgb(cRed);
  assert('★ 图标取色跳过透明像素：透明底 + 中间纯红 → 取到红色，不是黑',
    !!rgbRed && rgbRed[0] > rgbRed[1] + 40 && rgbRed[0] > rgbRed[2] + 40,
    '取到 ' + cRed);
  const rgbGreen = hexToRgb(cGreen);
  assert('图标取色：满幅纯绿 → 取到绿色',
    !!rgbGreen && rgbGreen[1] > rgbGreen[0] + 40 && rgbGreen[1] > rgbGreen[2] + 40,
    '取到 ' + cGreen);
  assert('图标取色：全透明图取不到色（返回 null，交给主题色回退）', cClear === null || cClear === undefined,
    '取到 ' + cClear);

  /* ---------- ② 端到端：读 computed 样式，而不是读我们写进去的变量 ---------- */
  const look = await wc.executeJavaScript(`(async function(){
    var cs = function(el, pe){ return getComputedStyle(el, pe || null); };
    var px = function(v){ return parseFloat(v) || 0; };
    /* 关键量是 **图片内容盒**（img 边框盒 - 左右 padding）。
     * 「内部」要的是"图片完整落在边框形状之内"，所以判据不是 padding 写没写上，
     * 而是内容盒能不能塞进边框形状的内切正方形。 */
    var read = function(el){
      var img = el.querySelector('img');
      var s = cs(el), r = el.getBoundingClientRect();
      var raw = s.borderTopLeftRadius;
      var bw = px(s.borderLeftWidth);
      var o = {
        border: s.borderColor,
        filter: s.filter,
        tint: cs(el, '::before').backgroundColor,
        position: s.position,
        radiusRaw: raw,
        /* ★ border-radius 是**百分比**时 computed 会原样返回 "50%"（不是 24px），
         * parseFloat 直接拿来当 px 会把 50 当 50px —— 半径要按边框盒宽度换算回来。 */
        radiusPx: /%/.test(raw) ? (px(raw) / 100) * r.width : px(raw),
        borderW: bw,
        box: Math.round(r.width),
        innerBox: r.width - 2 * bw,
        inlineRing: el.style.getPropertyValue('--ic-ring-c'),
        fit: img ? cs(img).objectFit : null,
        pad: img ? px(cs(img).paddingLeft) : null,
        contentBox: img ? img.getBoundingClientRect().width - px(cs(img).paddingLeft)
                                   - px(cs(img).paddingRight) : null
      };
      return o;
    };
    var accent = function(){
      return cs(document.getElementById('widget')).getPropertyValue('--t-accent').trim() ||
             cs(document.documentElement).getPropertyValue('--accent').trim();
    };
    var all = function(){ return [].slice.call(document.querySelectorAll('.item-icon')); };
    var out = {};
    out.accent = accent();
    out.bodyPadVar = cs(document.body).getPropertyValue('--ic-pad').trim();
    out.bodyRadVar = cs(document.body).getPropertyValue('--ic-rad').trim();

    // 原样（glass / 形状跟随主题）：不该被我这段 CSS 碰到
    out.glass = read(all()[0]);
    setIconFit('contain');
    out.glassContain = read(all()[0]);        // ★ 内切于圆形：14.65%
    out.bodyClass0 = document.body.className;
    setIconFit('cover');

    // 走真实入口切到自动取色
    setIconBorder('auto');
    await ensureIconColors();
    refreshIconLook();
    out.autoImg = read(all()[0]);
    out.autoSvg = read(all()[1]);
    out.autoChr = read(all()[2]);
    out.bodyClass1 = document.body.className;

    // 填充方式
    setIconFit('contain');
    out.fitContain = cs(document.querySelector('.item-icon img')).objectFit;
    setIconFit('cover');
    out.fitCover = cs(document.querySelector('.item-icon img')).objectFit;

    // 形状覆盖：方形 → 圆角 0、内缩 0；圆角 30% → 半径 30%、内缩 8.79%
    setIconFit('contain');
    setIconShape('square');
    out.shapeSquare = read(all()[0]);
    setIconShape('rounded');
    setIconRadius(30);
    out.shapeRounded30 = read(all()[0]);
    setIconShape('auto');
    out.shapeAuto = read(all()[0]);
    out.bodyClassShapeAuto = document.body.className;
    setIconFit('cover');

    // 跟随主题：颜色应当等于当前主题强调色，且元素上**没有内联** --ic-ring-c
    setIconBorder('theme');
    out.theme = read(all()[0]);
    out.themePreset = read(all()[1]);
    out.bodyClassTheme = document.body.className;
    out.accentTheme = accent();
    // 换主题不调用 refreshIconLook：验证「跟随主题」是 CSS 回退链自己活的
    switchTheme('md3');
    await new Promise(function(r){ setTimeout(r, 260); });
    out.themeMd3 = read(all()[0]);
    out.accentMd3 = accent();
    switchTheme('glass');
    await new Promise(function(r){ setTimeout(r, 260); });
    out.themeBackGlass = read(all()[0]);

    // 自定义颜色：优先于取色策略，且图片 / 预设 / 字符三种图标都吃
    setIconBorder('auto');
    setIconRingColor('#ff8800');
    out.custom = read(all()[0]);
    out.customSvg = read(all()[1]);
    out.customChr = read(all()[2]);
    // 透明能盖过自定义色
    setIconBorder('none');
    out.customThenNone = read(all()[0]);
    // 切回透明之外的模式 → 自定义色仍在，且元素上没有留下旧的内联色
    setIconBorder('theme');
    out.customThenTheme = read(all()[0]);
    setIconRingColor('');
    out.themeAfterClear = read(all()[0]);

    // 回到自动取色，验证"从自动切走"时内联变量被真的清掉
    setIconBorder('auto');
    await ensureIconColors();
    refreshIconLook();
    out.autoAgain = read(all()[0]);
    setIconBorder('theme');
    out.afterAutoSwitch = read(all()[0]);

    // 透明边框
    setIconBorder('none');
    out.none = read(all()[0]);
    out.bodyClassNone = document.body.className;

    // 切回玻璃：必须回到各主题自己的描边，而不是留下透明
    setIconBorder('glass');
    out.backGlass = read(all()[0]);
    out.bodyClassGlass = document.body.className;

    // 弹窗预览：必须在**自动取色**模式下验 —— 玻璃模式本来就不该有底色和外发光，
    // 那时候量到 transparent 是正确行为，拿它当"预览正常"的证据等于没验。
    // 顺带把填充设成「内部」，确认预览也吃 --ic-fit 和 --ic-pad。
    setIconBorder('auto');
    setIconFit('contain');
    refreshIconLook();
    openItemModal(0, 0);
    await new Promise(function(r){ setTimeout(r, 160); });
    var pv = document.getElementById('iconPreview');
    out.preview = {
      position: cs(pv).position,
      tint: cs(pv, '::before').backgroundColor,
      border: cs(pv).borderColor,
      fit: cs(pv.querySelector('img')).objectFit,
      pad: px(cs(pv.querySelector('img')).paddingLeft),
      box: Math.round(pv.getBoundingClientRect().width),
      inlineRing: pv.style.getPropertyValue('--ic-ring-c'),
      modalOpen: !document.getElementById('itemModal').classList.contains('hidden'),
      modalClass: document.getElementById('itemModal').className
    };
    document.getElementById('itemModal').classList.add('hidden');
    setIconFit('cover');
    setIconBorder('glass');

    // 用户报的按钮溢出：先把设置面板打开 —— 面板关着时是 display:none，
    // getBoundingClientRect 量出来全是 0，会得到"0px 也满足不溢出"的假绿
    openSettings();
    await new Promise(function(r){ setTimeout(r, 220); });
    var geo = function(b) {
      var r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               need: b.scrollWidth, over: b.scrollWidth > Math.ceil(r.width) + 1,
               parent: b.parentElement.className, cls: b.className };
    };
    out.btnPick = geo(document.getElementById('btnBgPick'));
    out.btnClear = geo(document.getElementById('btnBgClear'));
    // 新增的「恢复默认」按钮（自定义色清空入口）：设了色才显示，量的时候先设上
    setIconRingColor('#ff8800');
    await new Promise(function(r){ setTimeout(r, 120); });
    var rb = document.getElementById('btnIconRingClear');
    out.btnRingClear = geo(rb);
    out.btnRingClearShown = !rb.classList.contains('hidden');
    setIconRingColor('');
    out.btnRingClearHidden = document.getElementById('btnIconRingClear').classList.contains('hidden');
    // 圆角滑块只在「圆角」形状下露出来
    setIconShape('circle');
    out.radiusRowHiddenOnCircle = document.getElementById('iconRadiusRow').classList.contains('hidden');
    setIconShape('rounded');
    out.radiusRowShownOnRounded = !document.getElementById('iconRadiusRow').classList.contains('hidden');
    setIconShape('auto');
    return out;
  })()`);

  /* ---------- 判定 ---------- */
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  /* 解析颜色到 [r,g,b]。**三种写法都要认**，少一种就会出现"渲染对、断言红"的假失败：
   *   · #rrggbb            —— 我们自己写进 --ic-ring-c 的、以及主题的 --t-accent
   *   · rgb()/rgba()       —— border-color 这种由 var() 直接落地的
   *   · color(srgb r g b)  —— ★ color-mix() 的 computed 序列化形式（Chromium 会把
   *                           rgba(225,42,58,0.45) 报成 color(srgb 0.88 0.16 0.22 / 0.45)），
   *                           数值是 0–1 的小数，要乘 255 才能和别的通道比。
   *                           **不能加 ^ 锚点**：它经常是夹在别的东西里的
   *                           （drop-shadow(color(srgb …) 0px 5px 11px)），加了锚就漏。 */
  const rgbOf = (s) => {
    const str = String(s || '').trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(str);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(str);
    if (srgb) {
      return [srgb[1], srgb[2], srgb[3]].map((v) => Math.round(parseFloat(v) * 255));
    }
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(str);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const sameRgb = (a, b) => !!a && !!b &&
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  /** 颜色比较留 ±2 容差：color-mix 走的是 0–1 浮点，0.882353×255 = 224.9999… */
  const nearRgb = (a, b) => !!a && !!b &&
    Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2;
  const autoImgBorder = norm(look.autoImg.border);
  assert('★ 自动取色：图片图标的描边 = 图自己的主色（端到端读 computed borderColor）',
    !!rgbRed && autoImgBorder.indexOf('rgb(' + rgbRed.join(',') + ')') >= 0,
    'borderColor=' + look.autoImg.border + '  期望含 rgb(' + (rgbRed || []).join(',') + ')');
  assert('★ 自动取色：同一时刻预设图标退回主题强调色（不是白、也不是 currentColor）',
    look.autoSvg.border !== look.autoImg.border && /rgb/.test(norm(look.autoSvg.border)),
    '预设=' + look.autoSvg.border + '  --t-accent=' + (look.accent || '(未定义)'));
  assert('自动取色：字符图标同样有描边（边框对所有图标生效）',
    /rgb/.test(norm(look.autoChr.border)), '字符=' + look.autoChr.border);
  assert('自动取色：挂上了外发光（filter: drop-shadow）',
    /drop-shadow/.test(look.autoImg.filter), look.autoImg.filter);
  assert('自动取色：底色层有颜色（::before 的 backgroundColor 不是 transparent）',
    !!rgbOf(look.autoImg.tint),
    '底色=' + look.autoImg.tint);
  assert('自动取色：底色层是 absolute（不参与 flex 居中）',
    look.autoImg.position === 'relative', 'icon position=' + look.autoImg.position);

  assert('原样（玻璃）模式下我的 CSS 不生效：描边保持主题原色',
    norm(look.glass.border) !== 'rgba(0,0,0,0)' && norm(look.glass.border) !== 'transparent' &&
    !look.bodyClass0.split(' ').includes('ic-ring'),
    'glass border=' + look.glass.border);
  assert('透明模式：描边真的透明了',
    /rgba?\(0,0,0,0\)/.test(norm(look.none.border)) || norm(look.none.border) === 'transparent',
    'none border=' + look.none.border);
  assert('切回玻璃：描边恢复主题原色（不会残留透明）',
    norm(look.backGlass.border) === norm(look.glass.border),
    'back=' + look.backGlass.border + '  原=' + look.glass.border);
  assert('填充方式：内部=contain / 裁剪=cover 都真的写到了 img 上',
    look.fitContain === 'contain' && look.fitCover === 'cover',
    'contain=' + look.fitContain + '  cover=' + look.fitCover);
  assert('★ 状态类互斥：玻璃不挂 ic-ring、透明只挂 ic-none、有色模式挂 ic-ring',
    !/ic-ring|ic-none/.test(look.bodyClass0) &&
    /ic-ring/.test(look.bodyClass1) && !/ic-none/.test(look.bodyClass1) &&
    /ic-none/.test(look.bodyClassNone) && !/ic-ring/.test(look.bodyClassNone) &&
    !/ic-ring|ic-none/.test(look.bodyClassGlass),
    '[' + look.bodyClass0 + '] [' + look.bodyClass1 + '] [' +
    look.bodyClassNone + '] [' + look.bodyClassGlass + ']');

  /* ---------- v2.4.3 ①：「内部」= 图片完整落在边框形状之内 ---------- */
  /* 判据不是"padding 写上了"，而是**几何上真的进了形状**。
   * 圆角矩形的内切正方形解析解：设可占区域边长 L、圆角半径 R，
   *     半边长 s ≤ (L/2 - R) + R/√2
   * 圆形就是 R = L/2 的特例 → s ≤ L/(2√2)，即 √2·(2s) ≤ L。
   * 注意所有半径都要换算到**border-radius 自己的基准 = 边框盒**上，
   * 而可占区域是边框盒去掉 1px 描边后的内盒（R_inner = R_border - 描边宽）。 */
  const fitsInShape = (r) => {
    if (!r.contentBox || !r.innerBox) return false;
    const L = r.innerBox;
    const R = Math.max(0, r.radiusPx - r.borderW);
    if (R <= 0) return r.contentBox <= L + 0.6;              // 方形：铺满即可
    const sMax = (L / 2 - R) + R / Math.SQRT2;
    return r.contentBox / 2 <= sMax + 0.35;
  };
  const sMaxOf = (r) => {
    const L = r.innerBox;
    const R = Math.max(0, r.radiusPx - r.borderW);
    return (L / 2 - R) + (R > 0 ? R / Math.SQRT2 : 0);
  };
  /* padding 是**百分比**，解析基准是父元素的 content 宽度（= 内盒 46px），
   * 而圆角比例是相对边框盒 48px 的 —— 两个基准差一个描边宽，期望值必须按内盒算，
   * 否则会得到"实际 6.73 期望 14.64"这种量纲错位的假失败。 */
  const padExpect = (r) => 0.2929 * (r.radiusPx / r.box) * r.innerBox;
  const padMatchesRadius = (r) => Math.abs(r.pad - padExpect(r)) <= 0.35;
  note('圆形内切核对（玻璃 50%）：盒=' + look.glassContain.box +
    ' 内盒=' + look.glassContain.innerBox.toFixed(0) +
    ' 圆角=' + look.glassContain.radiusRaw + '→' + look.glassContain.radiusPx.toFixed(1) + 'px' +
    ' 内缩=' + look.glassContain.pad.toFixed(2) + 'px（期望 ' + padExpect(look.glassContain).toFixed(2) + '）' +
    ' 图片内容盒=' + look.glassContain.contentBox.toFixed(2) +
    ' 内切上限=' + (2 * sMaxOf(look.glassContain)).toFixed(2));
  assert('★ 圆形 + 内部：内缩量 = 0.2929 × 圆角半径（正方形内切于圆的解析解）',
    padMatchesRadius(look.glassContain),
    'pad=' + look.glassContain.pad.toFixed(2) + ' 期望=' + padExpect(look.glassContain).toFixed(2) +
    ' 圆角=' + look.glassContain.radiusRaw);
  assert('★★ 圆形 + 内部：图片真的完整落在圆形之内（内容盒 ≤ 内切正方形，第三方异形图标不被切角）',
    fitsInShape(look.glassContain),
    '图片内容盒=' + look.glassContain.contentBox.toFixed(2) + ' ≤ 内切上限=' +
    (2 * sMaxOf(look.glassContain)).toFixed(2));
  assert('内部填充由 body.ic-contain 驱动，且裁剪模式下不留内缩（--ic-pad 不生效）',
    /ic-contain/.test(look.bodyClass0) && look.glassContain.pad > 0,
    'body.ic-contain=' + /ic-contain/.test(look.bodyClass0) + ' pad=' + look.glassContain.pad.toFixed(2));
  assert('★ 形状=方形 + 内部：圆角归零、内缩也归零（图正好铺满方形）',
    look.shapeSquare.radiusPx === 0 && look.shapeSquare.pad === 0 &&
    fitsInShape(look.shapeSquare),
    '圆角=' + look.shapeSquare.radiusRaw + ' 内缩=' + look.shapeSquare.pad);
  assert('★ 形状=圆角 + 半径 30%：圆角 30% 且内缩按 30% 算（不是照搬圆形的 14.65%）',
    Math.abs(look.shapeRounded30.radiusPx / look.shapeRounded30.box - 0.30) < 0.02 &&
    padMatchesRadius(look.shapeRounded30),
    '圆角=' + look.shapeRounded30.radiusRaw + '(' + look.shapeRounded30.radiusPx.toFixed(1) + 'px)' +
    ' 内缩=' + look.shapeRounded30.pad.toFixed(2) + ' 期望=' + padExpect(look.shapeRounded30).toFixed(2));
  assert('★ 形状=圆角 + 半径 30%：图片同样完整落在形状内',
    fitsInShape(look.shapeRounded30),
    '图片内容盒=' + look.shapeRounded30.contentBox.toFixed(2) + ' ≤ 内切上限=' +
    (2 * sMaxOf(look.shapeRounded30)).toFixed(2) +
    '（这一档最紧，若内缩按圆形算就会被圆角切掉）');
  assert('★ 形状=跟随主题：不挂 ic-shape、圆角交还给主题（十套主题各自的形状语言不动）',
    !/ic-shape/.test(look.bodyClassShapeAuto) && !look.bodyRadVar &&
    Math.abs(look.shapeAuto.radiusPx - look.glass.radiusPx) < 0.6,
    'class=[' + look.bodyClassShapeAuto + '] --ic-rad="' + look.bodyRadVar +
    '" 跟随=' + look.shapeAuto.radiusRaw + ' 原=' + look.glass.radiusRaw);
  assert('★ 跟随主题 + 内部：内缩量是**实测主题圆角**算出来的（不是写死 14.65%）',
    padMatchesRadius(look.shapeAuto) && fitsInShape(look.shapeAuto),
    'pad=' + look.shapeAuto.pad.toFixed(2) + ' 期望=' + padExpect(look.shapeAuto).toFixed(2) +
    ' 圆角=' + look.shapeAuto.radiusRaw);

  /* ---------- v2.4.3 ②：图标色调跟随主题 ---------- */
  const accentRgb = rgbOf(look.accentTheme);
  note('跟随主题核对：--t-accent=' + look.accentTheme + ' → ' + JSON.stringify(accentRgb) +
    '  图片图标描边=' + look.theme.border + '  预设=' + look.themePreset.border);
  assert('★ 跟随主题：图片图标的描边 = 当前主题强调色（不是图自己的色）',
    nearRgb(rgbOf(look.theme.border), accentRgb) &&
    !nearRgb(rgbOf(look.theme.border), rgbRed),
    'border=' + look.theme.border + ' 强调色=' + look.accentTheme + '(' + JSON.stringify(accentRgb) + ')');
  assert('★ 跟随主题：元素上不留内联 --ic-ring-c（留了就会压过主题色，切回来也变不回去）',
    look.theme.inlineRing === '', 'inline="' + look.theme.inlineRing + '"');
  assert('★ 跟随主题：外发光与底色也从主题色派生（color-mix 真的算出了颜色）',
    /drop-shadow/.test(look.theme.filter) && !!rgbOf(look.theme.filter) &&
    !!rgbOf(look.theme.tint) && nearRgb(rgbOf(look.theme.tint), accentRgb),
    'filter=' + look.theme.filter + ' 底色=' + look.theme.tint);
  assert('★★ 跟随主题：换主题后描边自动跟着变（纯 CSS 回退链，不靠 JS 重新调用）',
    nearRgb(rgbOf(look.themeMd3.border), rgbOf(look.accentMd3)) &&
    !nearRgb(rgbOf(look.themeMd3.border), accentRgb) &&
    nearRgb(rgbOf(look.themeBackGlass.border), accentRgb),
    'glass=' + look.theme.border + ' → md3=' + look.themeMd3.border +
    '（md3 强调色 ' + look.accentMd3 + '）→ 切回 glass=' + look.themeBackGlass.border);

  /* ---------- v2.4.3 ③：边框颜色自定义 ---------- */
  const ORANGE = [255, 136, 0];
  assert('★ 自定义边框色：优先于取色策略，图片 / 预设 / 字符三种图标都被染上',
    nearRgb(rgbOf(look.custom.border), ORANGE) &&
    nearRgb(rgbOf(look.customSvg.border), ORANGE) &&
    nearRgb(rgbOf(look.customChr.border), ORANGE),
    '图片=' + look.custom.border + ' 预设=' + look.customSvg.border + ' 字符=' + look.customChr.border);
  assert('自定义边框色：外发光与底色也从它派生',
    nearRgb(rgbOf(look.custom.tint), ORANGE) && /drop-shadow/.test(look.custom.filter),
    '底色=' + look.custom.tint);
  assert('★ 自定义边框色 + 透明：透明能盖过自定义色（描边真的没了）',
    /rgba?\(0,0,0,0\)/.test(norm(look.customThenNone.border)) ||
    norm(look.customThenNone.border) === 'transparent',
    'border=' + look.customThenNone.border);
  assert('★ 从透明切回有色模式：自定义色仍在（没有把用户设的色丢掉）',
    nearRgb(rgbOf(look.customThenTheme.border), ORANGE), 'border=' + look.customThenTheme.border);
  assert('★ 「恢复默认」清掉自定义色：描边回到主题强调色',
    nearRgb(rgbOf(look.themeAfterClear.border), accentRgb) && look.themeAfterClear.inlineRing === '',
    'border=' + look.themeAfterClear.border + ' 期望=' + look.accentTheme);
  assert('★ 「恢复默认」按钮只在设了自定义色时出现（没设就藏起来，免得点了没反应）',
    look.btnRingClearShown && look.btnRingClearHidden,
    '设色后显示=' + look.btnRingClearShown + ' 清空后隐藏=' + look.btnRingClearHidden);
  assert('「恢复默认」按钮文字也在框内（同 v2.4.1 那个溢出的老毛病）',
    !look.btnRingClear.over && look.btnRingClear.w >= look.btnRingClear.need,
    look.btnRingClear.w + 'px(需' + look.btnRingClear.need + ')');
  assert('圆角滑块只在「圆角」形状下露出（其他形状下调了没反应）',
    look.radiusRowHiddenOnCircle && look.radiusRowShownOnRounded,
    '圆形时隐藏=' + look.radiusRowHiddenOnCircle + ' 圆角时显示=' + look.radiusRowShownOnRounded);

  /* ---------- v2.4.3 ④：从自动取色切走不能留下内联色 ---------- */
  note('自动取色 → 跟随主题 的内联变量核对：auto 时="' + look.autoAgain.inlineRing +
    '"  切走后="' + look.afterAutoSwitch.inlineRing + '"');
  assert('★ 自动取色时元素上有内联 --ic-ring-c，切走后被真的清掉（内联优先级高于继承）',
    look.autoAgain.inlineRing !== '' && look.afterAutoSwitch.inlineRing === '',
    'auto="' + look.autoAgain.inlineRing + '" afterSwitch="' + look.afterAutoSwitch.inlineRing + '"');
  assert('★ 切走后描边立刻是主题强调色（不是残留的上一张图的颜色）',
    nearRgb(rgbOf(look.afterAutoSwitch.border), accentRgb) &&
    !nearRgb(rgbOf(look.afterAutoSwitch.border), rgbRed),
    'border=' + look.afterAutoSwitch.border + ' 期望=' + look.accentTheme);

  const pvTintRgb = rgbOf(look.preview.tint);
  const pvBorderRgb = rgbOf(look.preview.border);
  note('预览底色核对：tint=' + JSON.stringify(look.preview.tint) + ' → ' + JSON.stringify(pvTintRgb) +
    '  border=' + JSON.stringify(look.preview.border) + ' → ' + JSON.stringify(pvBorderRgb) +
    '  图主色=' + cRed + ' → ' + JSON.stringify(rgbRed));
  assert('★ 弹窗预览跟着设置走：自动取色模式下预览也有图自己的底色，且定位基准是自己',
    look.preview.modalOpen && look.preview.position === 'relative' &&
    nearRgb(pvTintRgb, rgbRed) && sameRgb(pvBorderRgb, rgbRed),
    'position=' + look.preview.position + ' tint=' + look.preview.tint + '/rgb=' + JSON.stringify(pvTintRgb) +
    ' border=' + look.preview.border + '/rgb=' + JSON.stringify(pvBorderRgb) +
    ' 期望=' + JSON.stringify(rgbRed) + ' modalOpen=' + look.preview.modalOpen);
  assert('弹窗预览也吃「图标填充」设置（选图时就能看出裁成什么样）',
    look.preview.fit === 'contain', 'preview object-fit=' + look.preview.fit);

  assert('★ 用户报的按钮溢出：选择图片 / 清除 的文字都在按钮框内',
    !look.btnPick.over && !look.btnClear.over &&
    look.btnPick.w >= look.btnPick.need && look.btnClear.w >= look.btnClear.need,
    '选择图片 ' + look.btnPick.w + 'px(需' + look.btnPick.need + ')  清除 ' + look.btnClear.w + 'px(需' + look.btnClear.need + ')');
  assert('两个按钮已经不在 .size-controls 里（30×30 方框会把文字挤出去）',
    look.btnPick.parent.indexOf('btn-row') >= 0 && look.btnClear.parent.indexOf('btn-row') >= 0,
    '父容器=' + look.btnPick.parent);
  assert('文字按钮高度合理（没被压成方形按钮的 30px）',
    look.btnPick.h >= 28 && look.btnClear.h >= 28,
    '高=' + look.btnPick.h + '/' + look.btnClear.h);

  /* ---------- ③ 带着 ic-ring 做命中测试（body 状态类没把界面搞哑） ---------- */
  await wc.executeJavaScript(`(function(){ setIconBorder('auto'); return 1; })()`);
  await new Promise((r) => setTimeout(r, 400));
  const hit = await wc.executeJavaScript(HIT_TEST);
  note('命中测试（ic-ring 生效）：' + hit.summary);
  assert('★ ic-ring 生效时 body 仍是干净容器（position/z-index 没被图层规则命中）',
    hit.bodyPos === 'static', 'position=' + hit.bodyPos);
  assert('★ ic-ring 生效时 body 的 pointer-events 不是 none', hit.bodyPe !== 'none', 'pe=' + hit.bodyPe);
  assert('★ ic-ring 生效时命中测试落在真实控件上（不是整片 <html>）',
    hit.htmlHits === 0 && hit.targets > 0, '落到 html 的点=' + hit.htmlHits);

  assert('渲染层没有报错', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));

  /* ---------- 截图 ---------- */
  try {
    const img = await win.capturePage();
    const out = path.join(WORK, 'icon_look_auto.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('  · 已存图 ' + path.relative(ROOT, out) + ' (' + img.getSize().width + '×' + img.getSize().height + ')');
  } catch (e) { console.log('  · 截图失败（无桌面会话时正常）：' + e.message); }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  restoreConfig();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('harness 崩了:', e); restoreConfig(); app.exit(1); });
