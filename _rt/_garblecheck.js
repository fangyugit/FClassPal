/* 花屏事故的正面验证（v2.4.0）。
 *
 * 事故成因：批量改 CSS 时把 `body.theme-glass,` 留成了独立的裸选择器，
 * 于是整条 `.sl-bead` 规则（position/width/height/backdrop-filter/filter）
 * 全落在了 <body> 身上 —— 整个窗口变成 34×22 的折射元素，一切到玻璃主题就花屏卡死。
 *
 * 这个脚本走**真实产品页 + 真实切换路径**（#themeSelect 的 change 事件 → switchTheme），
 * 逐个主题检查 <body> 自己的计算样式是否干净。CSS 写法正确时 body 永远是
 * static / 满窗 / filter:none —— 一旦再有人把选择器写断，这里第一秒就红。
 *
 * 跑法（必须去掉 ELECTRON_RUN_AS_NODE，否则 require('electron') 不是 API）：
 *   env -u ELECTRON_RUN_AS_NODE -u HTTP_PROXY -u HTTPS_PROXY \
 *     ./node_modules/electron/dist/electron.exe _rt/_garblecheck.js
 *
 * 注意 本机某些会话里渲染进程会因为沙箱起不来而 `file://` 直接 ERR_FAILED（不是代理问题，
 *   去掉代理变量也一样），表现为 loadFile 立刻报 ERR_FAILED、断言一条都不跑。下面在
 *   app ready 之前自己补上 --no-sandbox 开关，调用方就不用再记这串参数了。
 *   只补 no-sandbox、**不关 GPU** —— 本探针要读 backdrop-filter / filter 的计算样式并截图，
 *   关掉硬件加速会让滤镜渲染失真，读数就不再可信。
 */
const { app, BrowserWindow } = require('electron');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const fs = require('fs');

const OUT = __dirname;
let pass = 0, fail = 0;
function assert(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

/* 在页面里跑的采集脚本：读 <body> 和 #widget 的计算样式 + 关键 DOM 事实。
 * 注意它必须自己是个 IIFE/async 函数体，不能污染页面顶层作用域。 */
function collect() {
  return `(async () => {
    const cs = getComputedStyle(document.body);
    const w = document.getElementById('widget');
    const wcs = w ? getComputedStyle(w) : null;
    const bg = document.getElementById('bgCustom');
    const env = document.getElementById('envLayer');
    const warp = document.querySelector('.glass-warp');
    const veil = document.querySelector('.glass-veil');
    const zOf = (el) => el ? getComputedStyle(el).zIndex : null;
    return {
      classes: document.body.className,
      body: {
        position: cs.position,
        width: cs.width, height: cs.height,
        display: cs.display,
        filter: cs.filter,
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
        borderRadius: cs.borderRadius,
        overflow: cs.overflow,
        margin: cs.margin,
      },
      win: { w: innerWidth, h: innerHeight },
      beadCount: document.querySelectorAll('.sl-bead').length,
      wrapCount: document.querySelectorAll('.sl-wrap').length,
      beadVisible: Array.from(document.querySelectorAll('.sl-bead'))
        .filter((b) => getComputedStyle(b).display !== 'none').length,
      widget: wcs ? { position: wcs.position, filterCss: wcs.filter } : null,
      layers: {
        hasBgCustom: !!bg,
        hasEnv: !!env,
        bgZ: zOf(bg), envZ: zOf(env), warpZ: zOf(warp),
        bgAfterEnv: !!(bg && env) && !!(env.compareDocumentPosition(bg) & Node.DOCUMENT_POSITION_FOLLOWING),
        veilBg: veil ? getComputedStyle(veil).backgroundImage : null,
        bgStyle: bg ? { fi: bg.style.backgroundImage.slice(0, 42), filter: bg.style.filter, transform: bg.style.transform } : null,
        bgBox: bg ? { w: getComputedStyle(bg).width, h: getComputedStyle(bg).height, origin: getComputedStyle(bg).transformOrigin } : null,
      },
      vars: {
        surface: getComputedStyle(document.body).getPropertyValue('--md3-surface').trim(),
        onSurface: getComputedStyle(document.body).getPropertyValue('--md3-on-surface').trim(),
        accent: getComputedStyle(document.body).getPropertyValue('--t-accent').trim(),
      },
    };
  })()`;
}

/** <body> 必须永远是一个干净的满窗容器 */
function bodyIsSane(b, win) {
  const problems = [];
  if (b.position !== 'static') problems.push('position=' + b.position);
  if (b.display !== 'block') problems.push('display=' + b.display);
  if (b.filter !== 'none') problems.push('filter=' + b.filter);
  if (b.backdropFilter && b.backdropFilter !== 'none') problems.push('backdropFilter=' + b.backdropFilter);
  if (b.borderRadius !== '0px') problems.push('borderRadius=' + b.borderRadius);
  if (Math.abs(parseFloat(b.width) - win.w) > 1) problems.push('width=' + b.width + '≠' + win.w);
  if (Math.abs(parseFloat(b.height) - win.h) > 1) problems.push('height=' + b.height + '≠' + win.h);
  return problems;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 680, height: 560, show: true, frame: false,
    x: 4000, y: 0,                       // 屏幕外可见窗口：需要真实渲染，但不打扰用户
    webPreferences: { backgroundThrottling: false },
  });
  const page = 'file:///' + path.join(__dirname, '..', 'renderer', 'index.html').replace(/\\/g, '/');
  await win.loadURL(page);
  // 清掉预览模式存下的旧配置，让 v2.4.0 新默认（glass + light）生效
  await win.webContents.executeJavaScript(`localStorage.clear(); 'cleared'`);
  await win.loadURL(page);
  await new Promise((r) => setTimeout(r, 2200));

  /* 打开设置面板（主题下拉、明暗分段、背景控件都在里面） */
  await win.webContents.executeJavaScript(`(async () => {
    const gear = document.querySelector('[data-act="settings"], #btnSettings, .gear');
    if (gear) gear.click();
    await new Promise(r => setTimeout(r, 350));
    return true;
  })()`);

  /* ---------- 1. 逐个主题真实切换，检查 body 没被污染 ---------- */
  console.log('[逐主题真实切换（走 #themeSelect → switchTheme）]');
  const themes = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('#themeSelect option')).map(o => o.value)`
  );
  console.log('  可选主题: ' + themes.join(', '));
  assert('主题下拉里有 10 套主题（透明主题已下线）', themes.length === 10, '实际 ' + themes.length);
  assert('透明主题已从列表移除', themes.indexOf('transparent') < 0);

  const shots = [];
  for (const t of themes) {
    await win.webContents.executeJavaScript(`(async () => {
      const sel = document.getElementById('themeSelect');
      sel.value = ${JSON.stringify(t)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 260));
      return sel.value;
    })()`);
    const s = await win.webContents.executeJavaScript(collect());
    const problems = bodyIsSane(s.body, s.win);
    assert(`theme-${t}: <body> 计算样式干净（无花屏风险）`,
      problems.length === 0, problems.join(' ') || `w=${s.body.width} pos=${s.body.position}`);
    assert(`theme-${t}: 挂上了 theme-${t} 标记类`, s.classes.indexOf('theme-' + t) >= 0, s.classes);
    // 珠子只在玻璃主题里显示：玻璃主题每根滑块一颗，别的主题必须 0 颗。
    // （滑块是 JS 动态生成的，所以期望值按 .sl-wrap 实际数量算，不写死。）
    if (t === 'glass') {
      assert(`theme-glass: 面板里 ${s.wrapCount} 根滑块各配一颗玻璃珠子`,
        s.wrapCount >= 1 && s.beadVisible === s.wrapCount,
        `beadVisible=${s.beadVisible} wrap=${s.wrapCount}`);
    } else {
      assert(`theme-${t}: 别的主题不显示玻璃珠子（0 颗）`, s.beadVisible === 0,
        'beadVisible=' + s.beadVisible);
    }
  }

  /* ---------- 2. 玻璃主题 + 明暗两档 ---------- */
  console.log('[玻璃主题：明亮 / 黑暗]');
  await win.webContents.executeJavaScript(`(async () => {
    const sel = document.getElementById('themeSelect');
    sel.value = 'glass'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 260));
    return true;
  })()`);
  const lightS = await win.webContents.executeJavaScript(collect());
  assert('明亮模式: body 无 dark 类', lightS.classes.indexOf('dark') < 0, lightS.classes);
  assert('明亮模式: body 有 dyn 类（动态取色主题）', /\bdyn\b/.test(lightS.classes), lightS.classes);
  assert('明亮模式: <body> 干净', bodyIsSane(lightS.body, lightS.win).length === 0, bodyIsSane(lightS.body, lightS.win).join(' '));
  const lightVeil = lightS.layers.veilBg;
  shots.push(['garble_glass_light.png', lightS]);

  // 点黑暗模式（真实入口 #appearanceSeg）
  const darkClick = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('#appearanceSeg [data-appearance="dark"]');
    if (!btn) return { ok: false, why: 'no #appearanceSeg dark button' };
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    return { ok: true, classes: document.body.className };
  })()`);
  assert('面板里有黑暗模式按钮且点击生效', darkClick.ok && /\bdark\b/.test(darkClick.classes || ''),
    JSON.stringify(darkClick));
  const darkS = await win.webContents.executeJavaScript(collect());
  assert('黑暗模式: body 挂上 dark 类', darkS.classes.indexOf('dark') >= 0, darkS.classes);
  assert('黑暗模式: <body> 仍然干净（暗色层没误伤根容器）',
    bodyIsSane(darkS.body, darkS.win).length === 0, bodyIsSane(darkS.body, darkS.win).join(' '));
  assert('黑暗模式: veil 背景与明亮模式不同（黑纱生效）', darkS.layers.veilBg !== lightVeil,
    'light=' + String(lightVeil).slice(0, 46) + ' | dark=' + String(darkS.layers.veilBg).slice(0, 46));
  assert('黑暗模式: veil 的底渐变换成了深色（rgba(6, 8, 14,…)）',
    /rgba\(6, 8, 14/.test(darkS.layers.veilBg || ''), String(darkS.layers.veilBg).slice(-52));
  assert('明亮模式: veil 的底渐变是白纱（rgba(255, 255, 255,…)）',
    /rgba\(255, 255, 255/.test(lightVeil || ''), String(lightVeil).slice(-52));
  assert('黑暗模式: surface 变量被压暗（不等于明亮模式的值）',
    !darkS.vars.surface || darkS.vars.surface !== lightS.vars.surface,
    'light surface=' + lightS.vars.surface + ' dark surface=' + darkS.vars.surface);
  shots.push(['garble_glass_dark.png', darkS]);

  // 切回明亮
  const backLight = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('#appearanceSeg [data-appearance="light"]');
    btn && btn.click();
    await new Promise(r => setTimeout(r, 600));
    return document.body.className;
  })()`);
  assert('能切回明亮模式（dark 类被摘掉）', backLight.indexOf('dark') < 0, backLight);

  /* ---------- 3. 固定配色主题也要有暗色 ---------- */
  console.log('[固定配色主题的暗色]');
  for (const t of ['miuix', 'kitty']) {
    await win.webContents.executeJavaScript(`(async () => {
      const sel = document.getElementById('themeSelect');
      sel.value = ${JSON.stringify(t)}; sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const d = document.querySelector('#appearanceSeg [data-appearance="dark"]');
      d && d.click();
      await new Promise(r => setTimeout(r, 400));
      return true;
    })()`);
    const s = await win.webContents.executeJavaScript(collect());
    assert(`theme-${t}: 有 dyn 以外的暗色层（body.dark:not(.dyn) 生效）`,
      s.classes.indexOf('dark') >= 0 && s.classes.indexOf('dyn') < 0, s.classes);
    assert(`theme-${t}: <body> 在暗色下依然干净`,
      bodyIsSane(s.body, s.win).length === 0, bodyIsSane(s.body, s.win).join(' '));
    assert(`theme-${t}: 暗色下表面变量已被压暗`, !!s.vars.surface, 'surface=' + s.vars.surface);
    shots.push([`garble_${t}_dark.png`, s]);
    await win.webContents.executeJavaScript(`(async () => {
      const l = document.querySelector('#appearanceSeg [data-appearance="light"]');
      l && l.click(); await new Promise(r => setTimeout(r, 300)); return true;
    })()`);
  }

  /* ---------- 4. 自定义背景图的分层契约 ---------- */
  console.log('[自定义背景图分层]');
  const bgS = shots[0][1];
  assert('#bgCustom 元素存在', bgS.layers.hasBgCustom);
  assert('#bgCustom 的 z-index 是 -1（在壁纸层同档）', bgS.layers.bgZ === '-1', 'z=' + bgS.layers.bgZ);
  assert('#envLayer 的 z-index 也是 -1（同档）', bgS.layers.envZ === '-1', 'z=' + bgS.layers.envZ);
  assert('★ #bgCustom 在 DOM 里排在 #envLayer 之后（同档时后者画在上面）', bgS.layers.bgAfterEnv);
  assert('.glass-warp 的 z-index 是 0，高于底材（backdrop-filter 才采得到）',
    bgS.layers.warpZ === '0', 'z=' + bgS.layers.warpZ);
  assert('#bgCustom 铺满窗口（inset:0，跟着窗口尺寸走）',
    /^\d+px$/.test(bgS.layers.bgBox.w) && parseFloat(bgS.layers.bgBox.w) > 100,
    'w=' + bgS.layers.bgBox.w + ' h=' + bgS.layers.bgBox.h);

  // 手动挂一张背景图（预览模式下没有真文件，直接写内联样式验证 CSS 契约）
  const bgApplied = await win.webContents.executeJavaScript(`(async () => {
    const bg = document.getElementById('bgCustom');
    document.body.classList.add('bg-custom');
    bg.style.backgroundImage = 'linear-gradient(rgba(255,255,255,0.35),rgba(255,255,255,0.35)), url("data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'64\\' height=\\'64\\'%3E%3Crect width=\\'64\\' height=\\'64\\' fill=\\'%234fa8e8\\'/%3E%3C/svg%3E")';
    bg.style.filter = 'blur(9px)';
    bg.style.transform = 'scale(1.3)';
    await new Promise(r => setTimeout(r, 260));
    const cs = getComputedStyle(bg);
    const env = getComputedStyle(document.getElementById('envLayer'));
    const ox = parseFloat(cs.transformOrigin.split(' ')[0]);
    const oy = parseFloat(cs.transformOrigin.split(' ')[1]);
    return {
      layers: cs.backgroundImage.split('), ').length,
      hasMaskLayer: /linear-gradient\\(rgba\\(255, 255, 255/.test(cs.backgroundImage),
      filter: cs.filter, transform: cs.transform,
      origin: cs.transformOrigin,
      centerOk: Math.abs(ox - parseFloat(cs.width) / 2) < 1.5 &&
                Math.abs(oy - parseFloat(cs.height) / 2) < 1.5,
      box: cs.width + 'x' + cs.height,
      envDisplay: env.display,
      inspected: cs.filter !== 'none' && cs.transform !== 'none',
    };
  })()`);
  assert('蒙版是叠在同一元素上的第二层渐变（不额外加 DOM）', bgApplied.hasMaskLayer, JSON.stringify(bgApplied.layers));
  assert('模糊走 filter: blur（背景自身模糊，不靠 backdrop）', /blur\(9px\)/.test(bgApplied.filter), bgApplied.filter);
  assert('裁剪走 transform: scale（窗口尺寸不动）', /matrix\(1\.3/.test(bgApplied.transform), bgApplied.transform);
  assert('★ 缩放原点是元素中心（50% 50% → 四边均匀裁切，不是左上角）',
    bgApplied.centerOk, 'origin=' + bgApplied.origin + ' box=' + bgApplied.box);
  assert('自定义背景启用时隐藏实时底材层（不打架）', bgApplied.envDisplay === 'none', 'env display=' + bgApplied.envDisplay);

  /* ★★ v2.4.1 回归：body 带 bg-custom 时，整站必须还能点
   * 事故成因：图层规则写成裸 `.bg-custom`，而 body 也挂同名类 →
   * position:absolute + pointer-events:none 落到 body 上并继承到整棵子树，
   * 界面看着完好却一个都点不动（用户报"选完背景图软件无法操作"）。
   * 这里在 bg-custom 生效状态下量三件事：body 是否干净、widget 是否收得到点击、
   * 以及 81 点命中测试还落不落在真实控件上。 */
  const bgAlive = await win.webContents.executeJavaScript(`(function(){
    var b = getComputedStyle(document.body);
    var w = document.getElementById('widget');
    var wcs = getComputedStyle(w);
    var r = w.getBoundingClientRect();
    var hits = {}, html = 0;
    for (var i = 1; i <= 9; i++) for (var j = 1; j <= 9; j++) {
      var el = document.elementFromPoint(Math.round(r.left + r.width*i/10), Math.round(r.top + r.height*j/10));
      if (!el) continue;
      if (el === document.documentElement) { html++; continue; }
      var cn = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/)[0] : '';
      var tag = el.tagName.toLowerCase() + (el.id ? '#'+el.id : (cn ? '.'+cn : ''));
      hits[tag] = (hits[tag]||0)+1;
    }
    return { bodyPos: b.position, bodyPe: b.pointerEvents, bodyZ: b.zIndex,
             wPe: wcs.pointerEvents, htmlHits: html, hitCount: Object.keys(hits).length,
             top: Object.keys(hits).sort(function(x,y){return hits[y]-hits[x];}).slice(0,4)
                    .map(function(k){return k+'x'+hits[k];}).join(','),
             cls: document.body.className };
  })()`);
  console.log('  · bg-custom 生效时: ' + JSON.stringify(bgAlive));
  assert('★ bg-custom 生效时 <body> 仍是干净容器（position/z-index 没被图层规则命中）',
    bgAlive.bodyPos === 'static' && bgAlive.bodyZ === 'auto',
    `position=${bgAlive.bodyPos} z=${bgAlive.bodyZ}`);
  assert('★ bg-custom 生效时 <body> 的 pointer-events 不是 none',
    bgAlive.bodyPe !== 'none', 'pe=' + bgAlive.bodyPe);
  assert('★ bg-custom 生效时 widget 依然收得到点击（pe=auto）',
    bgAlive.wPe === 'auto', 'pe=' + bgAlive.wPe);
  assert('★ bg-custom 生效时命中测试落在真实控件上（不是整片 <html>）',
    bgAlive.htmlHits === 0 && bgAlive.hitCount > 0,
    `落到 html 的点=${bgAlive.htmlHits} 命中目标=${bgAlive.top}`);

  // 这次截图就是"自定义背景 + 玻璃"的真实渲染
  await win.webContents.executeJavaScript(`(async () => {
    const sel = document.getElementById('themeSelect');
    sel.value = 'glass'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300)); return true;
  })()`);
  const bgShot = await win.webContents.executeJavaScript(collect());
  shots.push(['garble_bgcustom.png', bgShot]);
  await win.webContents.executeJavaScript(`document.body.classList.remove('bg-custom'); true`);

  /* ---------- 截图落盘 ---------- */
  // 顺序重放一遍，保证每张图对应它的状态
  const plan = [
    ['garble_glass_light.png', { theme: 'glass', dark: false }],
    ['garble_glass_dark.png', { theme: 'glass', dark: true }],
    ['garble_miuix_dark.png', { theme: 'miuix', dark: true }],
    ['garble_kitty_dark.png', { theme: 'kitty', dark: true }],
  ];
  for (const [file, cfgState] of plan) {
    await win.webContents.executeJavaScript(`(async () => {
      const sel = document.getElementById('themeSelect');
      sel.value = ${JSON.stringify(cfgState.theme)}; sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const b = document.querySelector('#appearanceSeg [data-appearance="${cfgState.dark ? 'dark' : 'light'}"]');
      b && b.click();
      await new Promise(r => setTimeout(r, 600));
      return true;
    })()`);
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, file), img.toPNG());
    console.log('  saved ' + file);
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
