/* 图标外观（v2.4.2 / v2.4.3）的真机截图，用来肉眼确认三个需求：
 *   1. 「内部」= 第三方异形图标完整落在圆形边框内（四个角不再被切）
 *   2. 边框「跟随主题」—— 换主题色调跟着变
 *   3. 形状（圆形 / 圆角 / 方形）与边框颜色自定义
 * 断言在 _rt/_iconcheck.js 里；这个脚本只出图。
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE -u HTTP_PROXY -u HTTPS_PROXY \
 *     ./node_modules/electron/dist/electron.exe _rt/_iconshot.js
 * 会备份并还原真实 ~/.desktop-widget/config.json，autoLaunch 强制 false。
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
const BACKUP = path.join(WORK, 'config.iconshot.backup.json');

function makePng(file, w, h, painter) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = painter(x, y), i = (y * w + x) * 4;
    buf[i] = c[2]; buf[i + 1] = c[1]; buf[i + 2] = c[0]; buf[i + 3] = c[3];   // BGRA
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG());
}
/* 三张"异形图标"：真正铺满方框的图最能暴露"内部"到底有没有进圆
 * （铺满方框 + contain 而不做内缩的话，四个角一定顶在圆外被切掉）。 */
const RED = [222, 42, 58, 255], GREEN = [36, 168, 92, 255], INK = [40, 52, 90, 255];
const P_FULL = path.join(WORK, 'ic_full_square.png');     // 满幅红块（最极端）
const P_BORDER = path.join(WORK, 'ic_frame.png');         // 只有四边有色的"框"图
const P_DIAG = path.join(WORK, 'ic_diag.png');            // 对角线图形，角上必然触边
makePng(P_FULL, 120, 120, () => RED);
makePng(P_BORDER, 120, 120, (x, y) =>
  (x < 10 || y < 10 || x >= 110 || y >= 110) ? GREEN : [0, 0, 0, 0]);
makePng(P_DIAG, 120, 120, (x, y) =>
  (Math.abs(x - y) < 16 || Math.abs(x + y - 119) < 16) ? INK : [0, 0, 0, 0]);

if (!fs.existsSync(CONF)) { console.error('找不到真实配置：' + CONF); app.exit(2); }
fs.copyFileSync(CONF, BACKUP);
const realCfg = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
fs.writeFileSync(CONF, JSON.stringify(Object.assign({}, realCfg, {
  autoLaunch: false, realtime: false, keepBottom: false, opacity: 0.55,
  theme: 'glass', appearance: 'light',
  background: { enabled: false, path: '', blur: 0, mask: 0, scale: 100, offsetX: 50, offsetY: 50, fit: 'cover' },
  iconFit: 'contain', iconBorder: 'auto', iconShape: 'auto', iconRadius: 22, iconRingColor: '',
  groups: [{
    id: 'group-test', name: '图标外观实测',
    items: [
      { id: 'a', name: '满幅方图', type: 'file', target: 'C:/x', icon: 'app', iconPath: pathToFileURL(P_FULL).href },
      { id: 'b', name: '边框图', type: 'file', target: 'C:/x', icon: 'app', iconPath: pathToFileURL(P_BORDER).href },
      { id: 'c', name: '对角图', type: 'file', target: 'C:/x', icon: 'app', iconPath: pathToFileURL(P_DIAG).href },
      { id: 'd', name: '预设图标', type: 'file', target: 'C:/x', icon: 'folder' },
      { id: 'e', name: '字符图标', type: 'file', target: 'C:/x', icon: 'app', iconChar: 'A' }
    ]
  }]
}), null, 2));
function restore() { try { fs.copyFileSync(BACKUP, CONF); console.log('  · 真实配置已还原'); } catch (e) { } }
app.on('will-quit', restore);
process.on('exit', restore);
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });

require(path.join(ROOT, 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const wc = win.webContents;
  const shot = async (name) => {
    fs.writeFileSync(path.join(WORK, name), (await win.capturePage()).toPNG());
    console.log('  · 已存 _rt/_bg/' + name);
  };
  const hide = () => wc.executeJavaScript(`(function(){
    document.querySelectorAll('.panel').forEach(function(p){ p.classList.add('hidden'); });
    document.querySelectorAll('.modal').forEach(function(m){ m.classList.add('hidden'); });
    return 1; })()`);

  await hide();
  // ① 内部 + 圆形（跟随主题形状）+ 自动取色：三张图都应完整落在圆内
  await wc.executeJavaScript(`(async function(){
    setIconFit('contain'); setIconBorder('auto'); setIconShape('auto');
    await ensureIconColors(); refreshIconLook();
    return 1; })()`);
  await sleep(700);
  await shot('icon_v243_contain_circle_auto.png');

  // ② 同样内部，但形状=圆角 30% + 边框跟随主题（颜色应等于主题强调色，不是图自己的色）
  await wc.executeJavaScript(`(function(){
    setIconShape('rounded'); setIconRadius(30); setIconBorder('theme'); return 1; })()`);
  await sleep(600);
  await shot('icon_v243_rounded_theme.png');

  // ③ 方形 + 自定义边框色
  await wc.executeJavaScript(`(function(){
    setIconShape('square'); setIconRingColor('#ff8800'); return 1; })()`);
  await sleep(600);
  await shot('icon_v243_square_custom.png');

  // ④ 对照：裁剪模式下同一个图形会被切掉四角
  await wc.executeJavaScript(`(function(){
    setIconFit('cover'); setIconShape('circle'); setIconBorder('auto'); return 1; })()`);
  await sleep(600);
  await shot('icon_v243_cover_circle_cut.png');

  // ⑤ 弹窗预览：内部 + 圆角（选图时就能看出会不会被切）
  await wc.executeJavaScript(`(async function(){
    setIconFit('contain'); setIconShape('rounded'); setIconRadius(30);
    setIconBorder('auto'); setIconRingColor('');
    await ensureIconColors(); refreshIconLook();
    openItemModal(0, 0);
    await new Promise(function(r){ setTimeout(r, 320); });
    return 1; })()`);
  await sleep(400);
  await shot('icon_v243_modal_preview.png');

  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
