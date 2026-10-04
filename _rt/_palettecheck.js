/* 手动选色链路验证（jsdom 跑真 app.js + 真 index.html）
 * 关键：mock 的 getPalette 返回**真算法算出的调色板**（vendor/monet.js），
 * 而不是 app.js 内置 mock 的 null —— 后者会让「选色无效」看起来像正常。
 * 用法：node _rt/_palettecheck.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf-8');
const js = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf-8');

const monet = require(path.join(ROOT, 'vendor', 'monet.js'));
const ROLES = [
  ['primary', 'primary'], ['onPrimary', 'onPrimary'],
  ['primaryContainer', 'primaryContainer'], ['onPrimaryContainer', 'onPrimaryContainer'],
  ['secondary', 'secondary'], ['onSecondary', 'onSecondary'],
  ['secondaryContainer', 'secondaryContainer'], ['onSecondaryContainer', 'onSecondaryContainer'],
  ['tertiary', 'tertiary'], ['onTertiary', 'onTertiary'],
  ['tertiaryContainer', 'tertiaryContainer'], ['onTertiaryContainer', 'onTertiaryContainer'],
  ['surface', 'surface'], ['surfaceDim', 'surfaceDim'],
  ['surfaceContainer', 'surfaceContainer'], ['surfaceContainerHigh', 'surfaceContainerHigh'],
  ['onSurface', 'onSurface'], ['onSurfaceVariant', 'onSurfaceVariant'],
  ['outline', 'outline'], ['outlineVariant', 'outlineVariant'],
  ['error', 'error'], ['onError', 'onError']
];
function paletteOf(hex) {
  const hct = monet.Hct.fromInt(monet.argbFromHex(hex));
  const scheme = new monet.SchemeTonalSpot(hct, false, 0);
  const mdc = new monet.MaterialDynamicColors();
  const out = {};
  ROLES.forEach(([k, m]) => { out[k] = monet.hexFromArgb(mdc[m]().getArgb(scheme)); });
  out.dynamic = false;
  out.source = monet.hexFromArgb(hct.toInt());
  return out;
}

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function info(s) { console.log('        ' + s); }

const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
window.alert = () => {};
window.confirm = () => true;

const CFG = {
  title: '管家助手', width: 480, height: 420, x: 100, y: 100, opacity: 0.55,
  keepBottom: true, autoLaunch: false, locked: false, realtime: false,
  theme: 'glass', colorMode: 'auto', accentColor: '#6750A4',
  groups: [{ id: 'g1', name: '教学资源', items: [
    { id: 'i1', name: '希沃学苑', type: 'web', target: 'https://study.seewo.com/', icon: 'book' },
    { id: 'i2', name: '易+官网', type: 'web', target: 'https://e.seewo.com/', icon: 'plus' }
  ]}]
};
const saved = [];
let calls = [];
window.widgetAPI = {
  getConfig: () => Promise.resolve(JSON.parse(JSON.stringify(CFG))),
  saveConfig: (c) => { saved.push(JSON.parse(JSON.stringify(c))); return Promise.resolve(true); },
  getEnv: () => Promise.resolve({ transparent: true, platform: 'browser', release: '0' }),
  getWallpaper: () => Promise.resolve(null),
  onWallpaperChanged: () => () => {},
  getPalette: (patch) => {
    calls.push(patch ? JSON.parse(JSON.stringify(patch)) : null);
    const c = String((patch && patch.accentColor) || CFG.accentColor || '#6750A4');
    return Promise.resolve(paletteOf(c));
  },
  getUsbDrives: () => Promise.resolve([]),
  onUsbChange: () => () => {},
  onBoundsChanged: () => () => {},
  onTrayAction: () => () => {},
  startRealtime: () => Promise.resolve(null),
  stopRealtime: () => Promise.resolve(true),
  getDisplayInfo: () => Promise.resolve(null),
  selectFile: () => Promise.resolve('C:/Demo/a.txt'),
  selectApp: () => Promise.resolve('C:/Demo/App.exe'),
  selectImage: () => Promise.resolve({ path: 'd', url: '' }),
  getFileIcon: () => Promise.resolve({ path: 'd', url: '' }),
  openDrive: () => Promise.resolve({ success: true }),
  ejectDrive: () => Promise.resolve({ success: true }),
  hideWindow: () => {}, close: () => {},
  setKeepBottom: () => {}, setDragging: () => {},
  setAutoLaunch: () => Promise.resolve({ success: true }),
  setLocked: () => Promise.resolve({ success: true }),
  setBounds: () => Promise.resolve(true),
  moveWindow: () => {}, openTarget: () => Promise.resolve({ success: true })
};

const $ = (id) => document.getElementById(id);
const rootVar = (n) => document.documentElement.style.getPropertyValue(n).trim();
const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isHidden = (el) => !el || el.classList.contains('hidden');

(async () => {
  window.eval(js);
  await wait(80);

  console.log('[初始化]');
  check('脚本跑完（分组已渲染）', $('groups').children.length > 0);
  check('glass 主题下不加任何 theme-* 类（玻璃是基线皮肤）', !/theme-/.test(document.body.className),
    'class="' + document.body.className + '"');

  console.log('[设置面板 / 取色入口]');
  const settingsBtn = document.querySelector('.ctx-item[data-act="settings"]');
  check('存在"设置"菜单项', !!settingsBtn);
  click(settingsBtn);
  await wait(120);
  check('设置面板打开', !$('settingsPanel').classList.contains('hidden'));

  const box = $('md3ColorBox');
  check('存在取色面板 #md3ColorBox', !!box);
  check('【glass 主题下取色面板也可见（旧版隐藏→用户找不到选色）】', !isHidden(box),
    'class="' + (box ? box.className : '') + '"');
  const themeSel = $('themeSelect');
  check('主题下拉栏存在且选项 = 10（含三丽鸥混合）', !!themeSel && themeSel.options.length === 10,
    'options=' + (themeSel ? themeSel.options.length : 'null'));
  /* 下拉切换助手：设值 + 派发 change（v2.2.2 起主题切换走 select） */
  const pickTheme = async (t) => {
    themeSel.value = t;
    themeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(140);
  };
  await pickTheme('md3');
  await wait(150);
  info('body.className = ' + document.body.className);
  check('MD3 主题类已生效', document.body.classList.contains('theme-md3'));
  check('auto 模式下 #manualRow 隐藏', isHidden($('manualRow')));
  check('auto 模式下 #swatches 隐藏', isHidden($('swatches')));

  console.log('[点"手动指定"]');
  const manBtn = document.querySelector('#colorModeSeg .seg-btn[data-mode="manual"]');
  check('取色分段控件有 manual 按钮', !!manBtn);
  click(manBtn);
  await wait(200);
  info('paletteInfo = ' + $('paletteInfo').textContent);
  info('getPalette 调用 = ' + JSON.stringify(calls));
  check('manualRow 显示', !isHidden($('manualRow')));
  check('swatches 显示', !isHidden($('swatches')));
  check('切手动时向主进程要过 palette', calls.length > 0);

  console.log('[点色板真的换色]');
  const before = rootVar('--md3-primary');
  const sw = document.querySelector('#swatches .swatch[data-color="#F26100"]');
  check('存在落日橙色板', !!sw);
  click(sw);
  await wait(260);
  const after = rootVar('--md3-primary');
  info('--md3-primary: ' + (before || '<空>') + '  →  ' + (after || '<空>'));
  check('点色板后 --md3-primary 被写入且变了', !!after && after !== before);
  check('--md3-primary-rgb 同步写入', !!rootVar('--md3-primary-rgb'), rootVar('--md3-primary-rgb'));
  check('点色板带上了 accentColor 请求', calls.some((c) => c && String(c.accentColor).toUpperCase() === '#F26100'),
    JSON.stringify(calls.slice(-2)));
  info('accentHex = ' + $('accentHex').textContent + ' / paletteInfo = ' + $('paletteInfo').textContent);
  check('paletteInfo 显示为手动色', $('paletteInfo').textContent.includes('手动'), $('paletteInfo').textContent);
  check('config 里 colorMode 已落为 manual 并写盘', saved.some((c) => c.colorMode === 'manual'),
    JSON.stringify(saved.map((c) => c.colorMode + ':' + c.accentColor)));

  console.log('[原生取色器]');
  const ci = $('accentColor');
  check('存在 input[type=color]', !!ci && ci.type === 'color', ci ? ('value=' + ci.value) : '');
  check('取色器 value 未被吞成 #000000', ci.value !== '#000000', 'value=' + ci.value);
  const b2 = rootVar('--md3-primary');
  ci.value = '#00696e';
  ci.dispatchEvent(new window.Event('input', { bubbles: true }));
  ci.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(260);
  check('改原生取色器后主色变化', rootVar('--md3-primary') !== b2,
    b2 + ' → ' + rootVar('--md3-primary'));
  check('accentHex 跟随更新', $('accentHex').textContent === '#00696E', $('accentHex').textContent);

  console.log('[九套风格都能选色]');
  // 每轮换一个色板，否则第一轮已经把 --md3-primary 写成目标值，后面比不出"变化"
  const cycle = ['#3F7D4E', '#00696E', '#F26100', '#C2185B', '#0B57D0', '#6750A4'];
  const seenPrimary = {};
  for (let ti = 0; ti < 10; ti++) {
    /* 固定配色主题（miuix/harmony 用各自官方配色，kitty/dog/kuromi/melody/sanrio 是
     * 角色扮演配色，CSS 里写死 --md3-*）取色面板隐藏；
     * 动态配色主题（glass/md3/fluent）面板可见且点色板有效 */
    const t = ['glass', 'md3', 'fluent', 'miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'][ti];
    const fixed = ['miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'].indexOf(t) >= 0;
    await pickTheme(t);
    const cls = document.body.className;
    check('【' + t + '】主题类生效', t === 'glass' ? !/theme-/.test(cls) : cls.includes('theme-' + t), 'class="' + cls + '"');
    check('【' + t + '】取色面板' + (fixed ? '隐藏（固定配色）' : '可见'), fixed ? isHidden(box) : !isHidden(box));
    if (!fixed) {
      const b3 = rootVar('--md3-primary');
      const want = cycle[ti];
      click(document.querySelector('#swatches .swatch[data-color="' + want + '"]'));
      await wait(240);
      const now = rootVar('--md3-primary');
      check('【' + t + '】点色板后主色变化', now !== b3, b3 + ' → ' + now + '（选 ' + want + '）');
      seenPrimary[t] = now;
    }
  }
  info('各风格下 --md3-primary：' + JSON.stringify(seenPrimary));

  console.log('[切回壁纸取色]');
  click(document.querySelector('#colorModeSeg .seg-btn[data-mode="auto"]'));
  await wait(200);
  check('auto 下 manualRow 重新隐藏', isHidden($('manualRow')));
  check('auto 模式也向主进程要过 palette', calls.some((c) => c && c.colorMode === 'auto'), JSON.stringify(calls.slice(-2)));
  check('accentPicked 已随手动挑色落盘', saved.some((c) => c.accentPicked === true));

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  if (failed) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exitCode = 1; }
})();
