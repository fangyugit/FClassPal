/* 生成安卓启动图标（全套 mipmap + 自适应前景层）。
 * 跑法：./node_modules/electron/dist/electron.exe _rt/_mkandroidicons.js
 * 产物写进 mobile/android-overlay/app/src/main/res/（装配脚本再复制进 android 工程）。
 *
 * v2.4.6：图标重绘为"加号卡片"（build/icon.png，_rt/gen_icon.py 生成），并且
 * 修掉用户报的"安卓图标圆角不对劲"——旧版把带圆角的方块图标缩到 72% 贴在纯色
 * 背景层上，启动器的圆形蒙版一裁，四角露出背景色，看着像方块上贴方块。现在：
 *   普通图标 ic_launcher.png      圆角版图标原样（API<26 的启动器不裁剪）
 *   圆形图标 ic_launcher_round.png 满幅版裁圆（蒙版由我们出，没有色差角）
 *   前景层 ic_launcher_foreground  满幅版铺满 108dp —— 自适应图标由启动器蒙版
 *                                  裁形状，渐变铺到边，什么形状都严丝合缝
 * 满幅版 = build/icon_fullsquare.png（无圆角遮罩，同 _rt/gen_icon.py）。 */
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

app.whenReady().then(() => {
  const rounded = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'));
  const full = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon_fullsquare.png'));
  if (rounded.isEmpty() || full.isEmpty()) {
    console.error('读不到 build/icon.png / build/icon_fullsquare.png（先跑 _rt/gen_icon.py）');
    app.exit(1);
    return;
  }

  /** 满幅缩放到 size×size（铺满，不留透明边） */
  function fill(size, src) {
    return src.resize({ width: size, height: size, quality: 'best' });
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

    const s1 = Math.round(LAUNCHER_BASE * scale);
    // 1) 普通启动图标（API < 26 用）：带圆角的成品
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), fill(s1, rounded).toPNG());

    // 2) 圆形启动图标（API < 26 的 roundIcon）：满幅裁圆，角上没有第二层颜色
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'),
      circleMask(fill(s1, full)).toPNG());

    // 3) 自适应图标前景层：满幅铺满 108dp，形状交给启动器蒙版
    const s2 = Math.round(FOREGROUND_BASE * scale);
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'),
      fill(s2, full).toPNG());

    n += 3;
    console.log('mipmap-' + name, 'launcher=' + s1 + ' foreground=' + s2);
  });

  console.log('共写出 ' + n + ' 个 PNG -> ' + OUT);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
