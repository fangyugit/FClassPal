/* 安卓壳 · 桥接层回归探针（v2.4.5 新增）。
 * 跑法：env -u ELECTRON_RUN_AS_NODE -u HTTP_PROXY -u HTTPS_PROXY \
 *        ./node_modules/electron/dist/electron.exe _rt/_mobilecheck.js
 *
 * 在真 Chromium 里加载 mobile/www/index.html（Capacitor 原生插件不存在，
 * 走的全是桥接层的纯 Web 兜底），验证四件事：
 *   1) 无未捕获异常 / 无 console error
 *   2) window.widgetAPI 是桥接层注入的（app.js 没有落到预览模式）
 *   3) 手机适配生效：html.mobile 挂上、桌面专有行被打上 data-mobile-hide、文案改写命中
 *   4) 配置读写走 localStorage，且 body 没有 preview 标记类
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');

const WWW = path.join(__dirname, '..', 'mobile', 'www', 'index.html');
let win = null;
const errors = [];

app.whenReady().then(async () => {
  if (!fs.existsSync(WWW)) { console.error('FAIL 找不到 ' + WWW); app.exit(1); return; }
  win = new BrowserWindow({
    width: 412, height: 892, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    // Electron 对 file:// 页面必刷的 CSP 开发警告不是页面的问题，别当失败算
    if (message.indexOf('Electron Security Warning') >= 0) return;
    if (level >= 2) errors.push('console: ' + message);
  });
  process.on('uncaughtException', (e) => { errors.push('main: ' + e.message); });
  await win.loadURL('file:///' + WWW.replace(/\\/g, '/'));
  await new Promise((r) => setTimeout(r, 3000));

  const checks = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    out.bridgeInjected = !!window.widgetAPI && typeof window.widgetAPI.getConfig === 'function'
      && typeof window.widgetAPI.launchMarker === 'undefined';
    out.mobileClass = document.documentElement.classList.contains('mobile');
    out.previewBody = document.body.classList.contains('preview');
    out.hideMarks = document.querySelectorAll('[data-mobile-hide]').length;
    out.usbHidden = (document.getElementById('usbSection') || {}).getAttribute
      ? document.getElementById('usbSection').getAttribute('data-mobile-hide') === '1' : false;
    out.hintText = (document.querySelector('.hint') || {textContent: ''}).textContent;
    const cfg = await window.widgetAPI.getConfig();
    out.cfgTitle = cfg && cfg.title;
    out.cfgAppearance = cfg && cfg.appearance;
    out.cfgGroups = cfg && Array.isArray(cfg.groups) && cfg.groups.length;
    const saved = await window.widgetAPI.saveConfig(Object.assign({}, cfg, { opacity: 0.7 }));
    out.saveOk = !!(saved && saved.success);
    const env = await window.widgetAPI.getEnv();
    out.envPlatform = env && env.platform;
    out.wallpaper = await window.widgetAPI.getWallpaper();
    const pal = await window.widgetAPI.getPalette({ colorMode: 'manual', accentColor: '#3366CC' });
    out.paletteSource = pal && pal.source;
    out.palettePrimary = pal && pal.primary;
    out.usb = await window.widgetAPI.getUsbDrives();
    out.appearance = await window.widgetAPI.getSystemAppearance();
    out.fullScreen = (() => {
      const r = document.getElementById('widget').getBoundingClientRect();
      return Math.abs(r.width - window.innerWidth) < 2 && Math.abs(r.height - window.innerHeight) < 2;
    })();
    return out;
  })()`);

  const C = [
    ['桥接层注入 window.widgetAPI', checks.bridgeInjected],
    ['html.mobile 标记挂上', checks.mobileClass],
    ['body 没有被加 preview 标记类', !checks.previewBody],
    ['桌面专有元素已打 data-mobile-hide（>=9 个）', checks.hideMarks >= 9],
    ['U 盘区被隐藏', checks.usbHidden],
    ['提示条改写成"长按打开菜单"', checks.hintText.indexOf('长按打开菜单') >= 0],
    ['配置默认值（title=FClassPal）', checks.cfgTitle === 'FClassPal'],
    ['明暗默认跟随系统', checks.cfgAppearance === 'auto'],
    ['首启种子分组 1 个', checks.cfgGroups === 1],
    ['saveConfig 走 localStorage', checks.saveOk],
    ['getEnv.platform = android（绝不能是 browser）', checks.envPlatform === 'android'],
    ['壁纸兜底返回 null（渐变基底）', checks.wallpaper === null],
    ['手动主色派生调色板', checks.paletteSource === '#3366cc' && /^#[0-9a-f]{6}$/.test(checks.palettePrimary || '')],
    ['U 盘列表空数组', Array.isArray(checks.usb) && checks.usb.length === 0],
    ['系统明暗可读', typeof (checks.appearance || {}).isDark === 'boolean'],
    ['#widget 铺满视口（全屏面板）', checks.fullScreen]
  ];

  let bad = 0;
  C.forEach(([name, ok]) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); if (!ok) bad++; });
  console.log('hideMarks 实测=' + checks.hideMarks +
    ' palette=' + checks.palettePrimary +
    ' appearance=' + JSON.stringify(checks.appearance));
  if (errors.length) {
    bad++;
    console.log('FAIL  页面无报错（' + errors.length + ' 条）');
    errors.slice(0, 6).forEach((e) => console.log('      ' + e.slice(0, 300)));
  } else {
    console.log('PASS  页面无报错（console error / 未捕获异常均为 0）');
  }
  console.log('结果: ' + (C.length + 1 - bad) + ' 通过, ' + bad + ' 失败');
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
