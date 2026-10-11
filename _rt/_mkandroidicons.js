/* 生成安卓启动图标（全套 mipmap + 自适应前景层）。
 * 跑法：./node_modules/electron/dist/electron.exe _rt/_mkandroidicons.js
 * 产物写进 mobile/android-overlay/app/src/main/res/（装配脚本再复制进 android 工程）。
 * 源图用 build/icon.png（256 的蓝紫渐变方块）。 */
const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'mobile', 'android-overlay', 'app', 'src', 'main', 'res');

const DENSITIES = [
  ['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]
];
const LAUNCHER_BASE = 48;        // mipmap/ic_launcher.png 的 mdpi 基准
const FOREGROUND_BASE = 108;     // 自适应图标前景层的 mdpi 基准
const FG_CONTENT_RATIO = 0.72;   // 前景层内容占比（自适应图标安全区是 66/108，留点余量）

app.whenReady().then(() => {
  const src = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'));
  if (src.isEmpty()) { console.error('读不到 build/icon.png'); app.exit(1); return; }
  const sw = src.getSize().width;

  /** 把 src 缩放后贴进 size×size 的透明画布，返回 nativeImage */
  function compose(size, contentSize) {
    const inner = src.resize({ width: contentSize, height: contentSize, quality: 'best' });
    const ib = inner.toBitmap();           // BGRA
    const buf = Buffer.alloc(size * size * 4, 0);
    const off = Math.round((size - contentSize) / 2);
    for (let y = 0; y < contentSize; y++) {
      const sRow = y * contentSize * 4;
      const dRow = ((y + off) * size + off) * 4;
      ib.copy(buf, dRow, sRow, sRow + contentSize * 4);
    }
    return nativeImage.createFromBuffer(buf, { width: size, height: size });
  }

  /** 圆形蒙版（ic_launcher_round 用） */
  function circleMask(img) {
    const { width: w, height: h } = img.getSize();
    const buf = Buffer.from(img.toBitmap());
    const r = w / 2, cx = r, cy = r;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r * r) buf[(y * w + x) * 4 + 3] = 0;
      }
    }
    return nativeImage.createFromBuffer(buf, { width: w, height: h });
  }

  let n = 0;
  DENSITIES.forEach(([name, scale]) => {
    const dir = path.join(OUT, 'mipmap-' + name);
    fs.mkdirSync(dir, { recursive: true });

    // 1) 普通启动图标（API < 26 用）
    const s1 = Math.round(LAUNCHER_BASE * scale);
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), compose(s1, s1).toPNG());

    // 2) 圆形启动图标（API < 26 的 roundIcon）
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), circleMask(compose(s1, s1)).toPNG());

    // 3) 自适应图标前景层：内容缩到 72%，四周留安全区透明边
    const s2 = Math.round(FOREGROUND_BASE * scale);
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'),
      compose(s2, Math.round(s2 * FG_CONTENT_RATIO)).toPNG());

    n += 3;
    console.log('mipmap-' + name, 'launcher=' + s1 + ' foreground=' + s2);
  });

  console.log('共写出 ' + n + ' 个 PNG -> ' + OUT);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
