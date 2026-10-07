const {
  app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage,
  desktopCapturer, session
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

// 配置存储路径
const CONFIG_DIR = path.join(os.homedir(), '.desktop-widget');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const ICONS_DIR = path.join(CONFIG_DIR, 'icons');

/* 主进程兜底：没有它，任何一处 IPC 回调里的未捕获异常都会弹 Electron 的
 * "A JavaScript error occurred in the main process" 报错框（v2.0 拖动松手时
 * 用户看到的就是这个——saveBounds 作用域写错）。这里改成记日志不弹窗：
 * 桌面小部件不该因为一个非致命异常打断用户。 */
process.on('uncaughtException', (e) => {
  console.error('[main] uncaughtException:', e && (e.stack || e.message || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[main] unhandledRejection:', e && (e.stack || e.message || e));
});

// 托盘图标（32x32 PNG，内嵌避免依赖外部文件）
const TRAY_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAaElEQVR42mNgwAP0s///pwZmIAVQy1KyHENry/E6gl6WY3UEvS3HcMSgdAA6oLY83AG4XEcPB4AdMeqAgUqAow4Y/A4YzQWjDhjNBaMOGM0FdHPAgDfJRlvFg6JjMii6ZoOiczoQ3XMAbgljtx0qGzEAAAAASUVORK5CYII=';

// 默认配置
const DEFAULT_CONFIG = {
  width: 480,
  height: 420,
  x: 100,
  y: 100,
  opacity: 0.55,   // 玻璃背景 alpha：1=实色磨砂，0=完全透明；前景内容始终不透明
  alwaysOnTop: false,   // 已弃用置顶：小部件默认沉底
  keepBottom: true,     // 置底：始终位于其他窗口之下（桌面小部件形态）
  autoLaunch: false,   // 开机自启动
  locked: false,       // 锁定位置：禁止拖动 / 缩放
  // 实时玻璃底材（屏幕采集）默认关闭：默认"只模糊壁纸"——玻璃里显示的是真实
  // 壁纸本身，不随桌面内容变化。开启后才会逐帧采集窗口背后的桌面，但代价是
  // 系统截图/录屏看不到本窗口（setContentProtection 的副作用）。
  realtime: false,
  theme: 'glass',      // 界面风格：'glass'=液态玻璃，'md3'=Material Design 3（壁纸取色）
  // 明暗模式（v2.4.0）：'light' | 'dark'。dark 时：动态配色走 Monet 的暗色方案
  // （SchemeTonalSpot isDark=true，主色自动换成暗底可读的高亮度色调），
  // 静态主题再由 style.css 末尾的 body.dark 层把表面压暗（强调色仍归各主题）。
  appearance: 'light',
  // 自定义背景图（v2.4.0）：替代壁纸当玻璃的底材。
  //   enabled  开关
  //   path     原图绝对路径（不复制，省磁盘；文件被移走就自动回退壁纸）
  //   blur     图片模糊 px（0-40）
  //   mask     白色蒙版不透明度 %（0-100，压亮图片当磨砂底）
  //   scale    缩放 %（100-300，配合 offsetX/Y 就是"裁剪"）
  //   offsetX/Y 图片位置 %（0-100，background-position）
  //   fit      cover=裁剪铺满 / contain=完整显示 / tile=平铺
  background: {
    enabled: false, path: '', blur: 0, mask: 0,
    scale: 100, offsetX: 50, offsetY: 50, fit: 'cover'
  },
  // MD3 主色来源：'auto'=从壁纸提取（Monet/Material You 官方算法），
  //              'manual'=用 accentColor 指定的颜色，走同一条 tonal 派生链路
  colorMode: 'auto',
  accentColor: '#6750A4',   // 手动模式下的主色（默认取 MD3 baseline 紫）
  accentPicked: false,      // 用户是否亲手挑过主色（false 时切风格会用该风格的推荐色）
  cornerRadius: null,       // 主界面圆角弧度 px（null = 跟随当前主题的默认值）
  // 图标外观（v2.4.2 起，全局设置；十套主题共用）
  //   iconFit    'cover'=裁剪（填满整块，超出边框形状的部分裁掉，默认）
  //              'contain'=内部（**完整落在边框形状之内**，四周按内切解留白，
  //                        第三方异形图标不会被圆边切掉一角）
  //              —— 只对「自定义图片」和「exe 提取的图标」有意义；预设 SVG 与
  //              自定义字符本来就是矢量/文字，没有"裁不裁"的问题，不受影响。
  //   iconBorder 'glass'=玻璃白描边（默认，原来的样子）
  //              'auto'=自动取色（从图标图里挑主色，同时染描边 + 外发光 + 底色）
  //              'theme'=跟随主题（用当前主题的强调色，换风格/换壁纸会跟着变）
  //              'none'=透明（描边与外发光都去掉，只留主题自己的底材质感）
  //              auto 取不到色的图标（预设 SVG / 字符 / 图片读不出来 / 全透明图）
  //              退回当前主题的强调色，不会变成看不见的白边。
  //   iconShape  'auto'=跟随主题（默认，十套主题各自的形状语言不动）
  //              'circle' / 'rounded' / 'square' = 强制成圆形 / 圆角 / 方形
  //   iconRadius 形状选「圆角」时的圆角大小（占图标边长的百分比，4–50）
  //   iconRingColor '' = 按 iconBorder 的策略取色；'#rrggbb' = 自定义描边色
  //              （自定义色一旦设置就优先，只有「透明」能盖过它）
  //   iconMono   true = 统一图标风格（v2.4.4）：所有图标（图片 / 预设 / 字符）
  //              都收敛到**同一个颜色**上，像 Pixel 的主题图标那样"取一个色、
  //              统一整套图标"。图片是按自己的 alpha 裁剪出形状，再用这个色
  //              保明暗地染上去（细节留着，认得出是什么应用）；
  //              预设线条图标与字符图标本来就是单色，直接换色。
  //              统一色 = iconRingColor（设了就用它）> 当前主题的强调色。
  //              它是「内部」填充的附加项：填充切到「裁剪」时自动让位（设置留着，
  //              切回「内部」就恢复），因为裁剪模式下图标已经被切成满幅，
  //              再上单色会失去意义。
  iconFit: 'cover',
  iconBorder: 'glass',
  iconShape: 'auto',
  iconRadius: 22,
  iconRingColor: '',
  iconMono: false,
  // 首次启动种子：只给一个空的「希沃应用」分组，快捷方式完全由用户自己添加
  groups: [
    {
      id: 'group-1',
      name: '希沃应用',
      items: []
    }
  ]
};

let mainWindow = null;
let tray = null;
/* 锁定状态缓存：move-window 每帧都会来一次，不能每次都读磁盘配置 */
let windowLocked = false;
/* 置底状态缓存：focus 事件高频触发，同样不能读磁盘 */
let keepBottom = true;
/* 渲染层正在拖拽的标志（v1.8）。
 * 拖拽期间必须暂停两件事，否则每挪一帧都可能被系统的 'move' 事件反打回来，
 * 产生"来回跳 / 画面闪"：
 *   ① 不再把主进程读到的 bounds 回推给渲染层（渲染层自己算的位置才是对的）
 *   ② 不再因为抢到焦点就 moveBottom（拖拽拿到焦点是常态，压回去等于改 Z 序） */
let renderDragging = false;

function applyKeepBottom() {
  if (keepBottom && mainWindow && !mainWindow.isDestroyed() && !renderDragging) {
    try { mainWindow.moveBottom(); } catch (e) { /* 忽略 */ }
  }
}

function applyLocked(locked) {
  windowLocked = !!locked;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setMovable(!windowLocked);
      mainWindow.setResizable(!windowLocked);
    } catch (e) { /* 平台不支持时忽略 */ }
  }
}

/* ---------- 为什么不用 Mica（v1.7 移除） ----------
 * 之前在 Win11 22H2+ 上用 setBackgroundMaterial('mica')，并且为了满足它
 * "与 transparent 互斥"的限制把窗口设成了 transparent:false。结果很糟：
 *   1. 窗口变成不透明矩形 —— CSS 的 border-radius 只裁掉了玻璃层，四角外面
 *      仍然露出一圈方形底色，这正是用户报的"主界面圆角有问题"。
 *   2. mica 是 DWM 在窗口**外面**画的位图，Chromium 的 backdrop-filter 根本
 *      采不到它，对"模糊"没有任何贡献，白交出一个不透明窗口。
 * 现在统一走 transparent:true + 自己在渲染层画真实壁纸当底材（见下）。
 * 圆角由窗口的 per-pixel alpha 天然支持，四角是真的透明。 */

/* ---------- 桌面壁纸（渲染层折射基底） ----------
 * 为什么需要：mica 是 DWM 在窗口外画的位图层，Chromium 完全看不到它，
 * 所以 .widget::before 的 backdrop-filter 对着"空 backdrop"，折射永远不出现。
 * 解决办法：把用户真实的桌面壁纸按屏幕坐标再画一遍到窗口里当基底——
 * 位置对齐后，玻璃里折射的内容与真·桌面完全一致，观感就是真折射。
 *
 * 兼容性：读取失败 / 壁纸是纯色时返回 null，渲染层自动退回内置渐变基底。
 * 单显示器与多显示器都覆盖：style=span 用整个虚拟桌面，其余用窗口所在那块的
 * 显示器矩形。读到非 Windows 平台直接返回 null。 */
function readRegValue(key, name) {
  return new Promise((resolve) => {
    try {
      execFile('reg', ['query', key, '/v', name], { windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve('');
          // 形如：    WallPaper    REG_SZ    C:\Users\x\wall.jpg
          const m = stdout.match(new RegExp(name + '\\s+REG_\\w+\\s+(.*)'));
          resolve(m ? m[1].trim() : '');
        });
    } catch (e) { resolve(''); }
  });
}

/* 壁纸在屏幕坐标系里的矩形。
 * style: 0=居中 2=拉伸 6=适应 10=填充 22=跨屏；tile=1 时平铺（按居中处理即可） */
function wallpaperRect(imgW, imgH, style, tile, area) {
  if (!imgW || !imgH) return null;
  const A = area;   // { x, y, width, height }
  if (tile && style !== 22) {
    return { x: A.x, y: A.y, w: A.width, h: A.height, tile: true };
  }
  let w = imgW, h = imgH;
  if (style === 2) {                       // 拉伸：直接铺满
    w = A.width; h = A.height;
  } else if (style === 6 || style === 10) { // 适应 / 填充：等比缩放
    const k = style === 10
      ? Math.max(A.width / imgW, A.height / imgH)
      : Math.min(A.width / imgW, A.height / imgH);
    w = Math.round(imgW * k); h = Math.round(imgH * k);
  }
  // 其余（居中 / 跨屏 / 平铺）按原始尺寸，居中放置
  return {
    x: Math.round(A.x + (A.width - w) / 2),
    y: Math.round(A.y + (A.height - h) / 2),
    w: Math.round(w), h: Math.round(h), tile: false
  };
}

/* 壁纸"指纹"：文件路径 + 修改时间 + 填充方式。
 * 换壁纸时 Windows 既可能改注册表的 WallPaper 字符串（手动换图），也可能
 * 只重写同一个 TranscodedWallpaper 文件（幻灯片轮播），所以两者都要看。 */
function wallpaperSignature(meta) {
  if (!meta) return '';
  return meta.file + '|' + meta.mtime + '|' + meta.style + '|' + (meta.tile ? 1 : 0);
}

/* ---------- Monet 壁纸取色（Google material-color-utilities） ----------
 * v1.8 起不再拿 HSL 去近似 MD3 的 tonal palette。原因：HSL 的 L 不是感知明度，
 * 同一色相下 40% 与 90% 的实际观感深浅差距和 HCT 差得远，配出来的"容器色/正文色"
 * 层级不稳。现在直接用 Android 12 Material You（内部代号 Monet）的同一套算法：
 *
 *   1. 取色  QuantizerCelebi.quantize(pixels, 48)  —— 在 Lab 空间做 WSMeans 聚类
 *   2. 排序  Score.score(…, {desired, fallback, filter:true})
 *            —— 按"色相占比 × 接近目标彩度 48"打分，剔除低彩度的灰、剔除占比过低的
 *               噪声色；候选全不合格时返回 fallback（我们用基线紫，此时 dynamic=false）
 *   3. 配色  new SchemeTonalSpot(Hct, isDark=false, contrastLevel=0)
 *   4. 取值  new MaterialDynamicColors().primary().getArgb(scheme) …
 *            —— 每个角色的 tone 由官方 spec 给足（primary=40、container=90…），
 *               是真正感知均匀的层级。
 *
 * ★ 通道顺序：nativeImage.toBitmap() 在 Windows 上是 **BGRA** 不是 RGBA（踩过）。
 * ★ 库本体是 ESM，而 Electron 的 asar 不支持 ESM 解析（包里的 `import()` 必失败），
 *   所以先用 esbuild 预打成单个 CommonJS 文件 vendor/monet.js 再 require。
 *   重新生成：
 *   node node_modules/esbuild/bin/esbuild vendor/monet-entry.js --bundle --format=cjs
 *        --platform=node --target=node18 --legal-comments=inline --outfile=vendor/monet.js
 */
const monet = (() => {
  try { return require('./vendor/monet.js'); } catch (e) { return null; }
})();

const MD3_BASELINE = '#6750a4';          // 官方 MD3 baseline 紫（灰白壁纸兜底）
const MONET_MAX_DIM = 72;                // 采样长边：再大几乎不影响结果，只烧 CPU
const MONET_CLUSTERS = 48;
const ICON_SAMPLE_DIM = 32;              // 图标取色采样长边（图标只显示 48px，72 采样没额外信息）

/* 主进程里的驼峰键 ↔ MaterialDynamicColors 的方法名一一对应。
 * 渲染层会把驼峰转成 CSS 的短横变量（primaryContainer → --md3-primary-container）。 */
const MD3_ROLE_MAP = [
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

/** 由 DynamicScheme 产出全部 tonal 角色（hex），缺字 **`dynamic`/`source`** 由调用方补 */
function monetRoles(scheme) {
  const mdc = new monet.MaterialDynamicColors();
  const out = {};
  MD3_ROLE_MAP.forEach(([key, method]) => {
    try {
      const argb = mdc[method]().getArgb(scheme);
      out[key] = monet.hexFromArgb(argb);
    } catch (e) { /* 某角色取不到就跳过，CSS 有基线值兜底 */ }
  });
  return out;
}

/** source → 整套 tonal palette。dynamic=false 表示"没取到色、用的是兜底"。
 *  isDark=true 走 Monet 的暗色方案（SchemeTonalSpot 的第二个参数），
 *  主色/容器色会自动换成暗底可读的色调 —— 这就是"黑暗模式"在动态主题下的实现。 */
function monetSchemePalette(hct, dynamic, isDark) {
  const scheme = new monet.SchemeTonalSpot(hct, !!isDark, 0);
  const p = monetRoles(scheme);
  p.dynamic = !!dynamic;
  // 标记这份配色是明还是暗：渲染层切主题时要判断"手上这份方案还能不能用"
  p.dark = !!isDark;
  try { p.source = monet.hexFromArgb(hct.toInt()); } catch (e) { p.source = MD3_BASELINE; }
  return p;
}

/** 自定义背景图文件（启用且存在时）——它优先当底材、也优先当取色源 */
function customBackgroundFile(cfg) {
  const bg = cfg && cfg.background;
  if (!bg || !bg.enabled || !bg.path) return null;
  try { return fs.existsSync(bg.path) ? bg.path : null; } catch (e) { return null; }
}

/** 从壁纸文件里按 Monet 流程挑 source color；拿不到返回 null */
function monetSourceFromFile(file) {
  if (!monet || !file) return null;
  try {
    const img = nativeImage.createFromPath(file);
    const size = img.getSize();
    if (!size.width || !size.height) return null;
    const k = Math.max(size.width, size.height) / MONET_MAX_DIM;
    const w = Math.max(1, Math.round(size.width / k));
    const h = Math.max(1, Math.round(size.height / k));
    const buf = img.resize({ width: w, height: h }).toBitmap();
    if (!buf || buf.length < 4) return null;
    const pixels = [];
    for (let i = 0; i < buf.length; i += 4) {
      pixels.push(monet.argbFromRgb(buf[i + 2], buf[i + 1], buf[i]));   // BGRA
    }
    if (pixels.length < 16) return null;
    const clusters = monet.QuantizerCelebi.quantize(pixels, MONET_CLUSTERS);
    const fallback = monet.argbFromHex(MD3_BASELINE);
    const ranked = monet.Score.score(clusters, {
      desired: 4, fallbackColorARGB: fallback, filter: true
    });
    const best = ranked && ranked[0];
    if (typeof best !== 'number') return null;
    if (best === fallback) return null;   // 候选全不合格（灰白/纯黑壁纸）
    return monet.Hct.fromInt(best);
  } catch (e) {
    return null;
  }
}

/** 手动色：直接由用户指定的 hex 派生（永远 dynamic=false） */
function monetSourceFromHex(hex) {
  if (!monet || !/^#?[0-9a-f]{6}$/i.test(String(hex || ''))) return null;
  try { return monet.Hct.fromInt(monet.argbFromHex(hex)); } catch (e) { return null; }
}

/**
 * 壁纸平均亮度（0..1），给渲染层的 overLight 分档用（亮底要减弱折射、加重模糊）。
 *
 * 采样口径刻意与 Monet 取色完全一致（长边 72px、BGRA、同一份 nativeImage），
 * 这样"配色"和"明暗"来自同一批像素，不会出现"色偏暗但亮度说很亮"的错位。
 *
 * 用的是 sRGB 加权平均（0.2126/0.7152/0.0722），**不做 gamma 线性化**：
 * 这里只需要一个能分档的"感知亮度"，不是 WCAG 对比度计算。线性化会把暗部压得
 * 很低（#808080 只有 0.216），阈值反而难定；加权平均下 0.62 正好对应
 * "明显偏亮的壁纸 / 白底大窗口"。
 *
 * 失败（读不到文件、图损坏、无 monet 依赖）返回 null —— 渲染层会保持原分档。 */
function wallpaperLuminance(file) {
  if (!file) return null;
  try {
    const img = nativeImage.createFromPath(file);
    const size = img.getSize();
    if (!size.width || !size.height) return null;
    const k = Math.max(size.width, size.height) / MONET_MAX_DIM;
    const w = Math.max(1, Math.round(size.width / k));
    const h = Math.max(1, Math.round(size.height / k));
    const buf = img.resize({ width: w, height: h }).toBitmap();
    if (!buf || buf.length < 4) return null;
    let sum = 0;
    let n = 0;
    for (let i = 0; i + 3 < buf.length; i += 4) {
      sum += 0.2126 * buf[i + 2] + 0.7152 * buf[i + 1] + 0.0722 * buf[i];   // BGRA
      n++;
    }
    if (!n) return null;
    return Math.round((sum / n / 255) * 1000) / 1000;
  } catch (e) {
    return null;
  }
}

/* ---------- 图标主色（v2.4.2，图标边框「自动取色」用） ----------
 * 与壁纸取色同一套流程（nativeImage → BGRA → QuantizerCelebi 聚类 → Score 打分），
 * 但**不派生 MD3 调色板**：这里要的是"这张图看着是什么颜色"，不是"能当主题色"的颜色，
 * 所以直接返回聚类冠军的 hex。
 *
 * 与壁纸取色刻意不同的两点：
 *   1. **跳过透明像素** —— 最要命的一条。exe 提取的图标是带透明留白的 PNG，
 *      透明区是 (0,0,0,0)。全算进去的话留白面积一大，主色就恒等于黑，
 *      所有图标都会套上黑边。只统计 alpha>=8 的像素才拿得到真正的图形颜色。
 *   2. `filter: false` —— Score 默认会滤掉低饱和/偏暗的候选（壁纸那样做对，
 *      它要挑一个够"正"的主题色）。可图标的主色本来就可能是不饱和的灰蓝，
 *      滤掉之后只剩兜底紫，反而跟图不像。这里不挑。
 *
 * 返回 '#rrggbb'；读不到 / 图坏了 / 没有不透明像素 / 没有 monet 依赖一律 null。 */
const ICON_COLOR_CACHE = new Map();
const ICON_COLOR_CACHE_MAX = 64;

function iconColorKey(file) {
  // 路径 + mtime：同路径换了图（重新选一张同名图覆盖）时不会拿到旧色
  try { return file + '|' + fs.statSync(file).mtimeMs; } catch (e) { return file; }
}

function iconColorFromFile(file) {
  if (!monet || !file) return null;
  const key = iconColorKey(file);
  if (ICON_COLOR_CACHE.has(key)) return ICON_COLOR_CACHE.get(key);

  let out = null;
  try {
    const img = nativeImage.createFromPath(file);
    const size = img.getSize();
    if (size.width && size.height) {
      const k = Math.max(size.width, size.height) / ICON_SAMPLE_DIM;
      const w = Math.max(1, Math.round(size.width / k));
      const h = Math.max(1, Math.round(size.height / k));
      const buf = img.resize({ width: w, height: h }).toBitmap();
      const pixels = [];
      for (let i = 0; i + 3 < buf.length; i += 4) {
        if (buf[i + 3] < 8) continue;                     // 透明像素不算（见注意 1）
        pixels.push(monet.argbFromRgb(buf[i + 2], buf[i + 1], buf[i]));   // BGRA
      }
      if (pixels.length >= 16) {
        const fallback = monet.argbFromHex(MD3_BASELINE);
        const ranked = monet.Score.score(
          monet.QuantizerCelebi.quantize(pixels, MONET_CLUSTERS),
          { desired: 1, fallbackColorARGB: fallback, filter: false }
        );
        const best = ranked && ranked[0];
        if (typeof best === 'number' && best !== fallback) out = monet.hexFromArgb(best);
      }
    }
  } catch (e) { out = null; }

  ICON_COLOR_CACHE.set(key, out);
  while (ICON_COLOR_CACHE.size > ICON_COLOR_CACHE_MAX) {
    ICON_COLOR_CACHE.delete(ICON_COLOR_CACHE.keys().next().value);
  }
  return out;
}

/** 渲染层存的是 file:// URL（选图与提取图标都这么存），这里转回本地路径；
 *  已经是普通路径的就原样返回。 */
function iconFileArg(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^file:\/\//i.test(value)) {
    try { return fileURLToPath(value); } catch (e) { return null; }
  }
  return value;
}

const PALETTE_CACHE = new Map();   // key = 取色参数指纹 → 调色板，避免重复聚类
const PALETTE_CACHE_MAX = 8;

function paletteCacheGet(key) {
  if (PALETTE_CACHE.has(key)) {
    const v = PALETTE_CACHE.get(key);
    PALETTE_CACHE.delete(key); PALETTE_CACHE.set(key, v);   // LRU：挪到最新
    return v;
  }
  return null;
}
function paletteCacheSet(key, value) {
  PALETTE_CACHE.set(key, value);
  while (PALETTE_CACHE.size > PALETTE_CACHE_MAX) {
    PALETTE_CACHE.delete(PALETTE_CACHE.keys().next().value);
  }
  return value;
}

/**
 * 产出当前配置对应的整套 MD3 配色。
 * @param {object} cfg    配置（colorMode: 'auto'|'manual'，accentColor: '#rrggbb'，
 *                        appearance: 'light'|'dark'，background: {enabled,path}）
 * @param {?string} file  壁纸文件（auto 模式用）；传 null 时内部自行去读
 * @param {?string} sig   壁纸指纹（缓存 key 的一部分）
 */
async function buildPalette(cfg, file, sig) {
  if (!monet) return null;
  const mode = cfg && cfg.colorMode === 'manual' ? 'manual' : 'auto';
  const color = cfg && cfg.accentColor ? String(cfg.accentColor) : '';
  const isDark = !!(cfg && cfg.appearance === 'dark');

  if (mode === 'manual') {
    const key = 'manual|' + color.toLowerCase() + '|' + (isDark ? 'dark' : 'light');
    const hit = paletteCacheGet(key);
    if (hit) return hit;
    const hct = monetSourceFromHex(color);
    if (!hct) return null;
    return paletteCacheSet(key, monetSchemePalette(hct, false, isDark));
  }

  // 自定义背景图优先当取色源：底材换了，配色就该跟着换（否则会跟壁纸串味）
  const bgFile = customBackgroundFile(cfg);
  let meta = null;
  let wantFile = bgFile || file;
  let wantSig = bgFile ? ('bg|' + bgFile) : sig;
  if (!wantFile) {
    meta = await readWallpaperMeta();
    if (!meta) return null;
    wantFile = meta.file;
    wantSig = wallpaperSignature(meta);
  }
  const key = 'auto|' + (wantSig || '') + '|' + (isDark ? 'dark' : 'light');
  const hit = paletteCacheGet(key);
  if (hit) return hit;
  const hct = monetSourceFromFile(wantFile);
  if (!hct) {
    // 灰白壁纸：用基线紫，但照样给出完整套装（dynamic=false 供 UI 提示）
    return paletteCacheSet(key, monetSchemePalette(monetSourceFromHex(MD3_BASELINE), false, isDark));
  }
  return paletteCacheSet(key, monetSchemePalette(hct, true, isDark));
}

/* 取壁纸文件 + 填充方式（注册表 / 系统转码缓存），读不到返回 null */
async function readWallpaperMeta() {
  const DESK = 'HKCU\\Control Panel\\Desktop';
  let file = await readRegValue(DESK, 'WallPaper');
  const style = parseInt(await readRegValue(DESK, 'WallpaperStyle'), 10) || 10;
  const tile = (await readRegValue(DESK, 'TileWallpaper')) === '1';

  // 注册表偶尔指向已删除的文件（换过壁纸 / 同步过配置），换用系统转码缓存
  if (!file || !fs.existsSync(file)) {
    const cached = path.join(app.getPath('appData'),
      'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    if (fs.existsSync(cached)) file = cached;
    else {
      const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes', 'CachedFiles');
      const hit = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => /\.(jpe?g|png|bmp|webp)$/i.test(f));
      if (hit) file = path.join(dir, hit);
    }
  }
  if (!file || !fs.existsSync(file)) return null;
  let mtime = 0;
  try { mtime = Math.round(fs.statSync(file).mtimeMs); } catch (e) { /* 读不到就当 0 */ }
  return { file, style, tile, mtime };
}

/* 取壁纸信息，坐标已换算成"相对窗口左上角"，渲染层直接喂给 background-position */
async function getWallpaperInfo(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return null;
  try {
    const cfg = loadConfig();
    const bgFile = customBackgroundFile(cfg);
    const meta = await readWallpaperMeta();
    if (!meta) return null;
    const file = meta.file;
    const style = meta.style;
    const tile = meta.tile;
    const sig = wallpaperSignature(meta);

    const img = nativeImage.createFromPath(file);
    const size = img.getSize();
    if (!size.width || !size.height) return null;

    const winB = win.getBounds();
    // span（跨屏）用整个虚拟桌面的并集，其余用窗口所在那块显示器
    let area;
    if (style === 22) {
      const all = screen.getAllDisplays().map((d) => d.bounds);
      const x0 = Math.min(...all.map((b) => b.x));
      const y0 = Math.min(...all.map((b) => b.y));
      const x1 = Math.max(...all.map((b) => b.x + b.width));
      const y1 = Math.max(...all.map((b) => b.y + b.height));
      area = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    } else {
      area = screen.getDisplayMatching(winB).bounds;
    }

    const rect = wallpaperRect(size.width, size.height, style, tile, area);
    if (!rect) return null;
    return {
      url: pathToFileURL(file).href,
      w: rect.w, h: rect.h,
      // 绝对屏幕坐标：渲染层窗口移动时用它本地换算偏移，不必每帧来 IPC
      ax: rect.x, ay: rect.y,
      // 相对当前窗口左上角（首次直接可用）
      x: rect.x - winB.x,
      y: rect.y - winB.y,
      tile: !!rect.tile,
      sig,
      // 自定义背景图（v2.4.0）：渲染层拿 url 直接当底材（file:// 同源可加载），
      // luminance 喂 overLight 亮底自适应，palette 也由它派生（见 buildPalette）
      bg: bgFile ? {
        url: pathToFileURL(bgFile).href,
        path: bgFile,
        luminance: wallpaperLuminance(bgFile)
      } : null,
      // 底材平均亮度（0..1）：玻璃主题的 overLight 亮底自适应要用（见渲染层）。
      // 有自定义背景时以它为准 —— 那时候壁纸根本没显示。
      luminance: bgFile ? wallpaperLuminance(bgFile) : wallpaperLuminance(file),
      // MD3 风格的配色：由 Monet 从这张壁纸（或用户手动指定的主色）派生
      // await 放在 return 里是不行的，这里必须先把 await 结果取出来
      palette: await buildPalette(cfg, file, sig)
    };
  } catch (e) {
    return null;   // 任何异常都静默降级到内置基底
  }
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (e) {
    console.error('读取配置失败', e);
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function createWindow() {
  const config = loadConfig();
  // v2.4.0：「透明（黑背景）」主题已下线（v2.3.3 曾把它设成默认并迁移过老配置，
  // 所以这里要把已经迁移成 'transparent' 的配置收回来，否则 applyTheme 会退回基线）。
  // 替代品是任意主题上的「黑暗模式」。
  if (!config.themeMigratedToTransparent) {
    config.themeMigratedToTransparent = true;
    if (config.theme === 'glass') config.theme = 'transparent';
    saveConfig(config);
  }
  if (config.theme === 'transparent') {
    config.theme = 'glass';
    saveConfig(config);
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    x: config.x ?? Math.round((sw - config.width) / 2),
    y: config.y ?? Math.round((sh - config.height) / 2),
    minWidth: 300,
    minHeight: 220,
    frame: false,
    // 必须透明：圆角要靠 per-pixel alpha 才裁得干净（mica 的不透明窗口会在
    // 四角露出一圈方形底色）。玻璃底材由渲染层的 #envLayer 自己画真实壁纸。
    transparent: true,
    // 显式写透明底色：某些 GPU 路径下透明窗口首次合成会用白底，移动时会看到
    // 一帧白闪（老 Electron 的经典坑）。写明 0 alpha 就不会。
    backgroundColor: '#00000000',
    // 窗口图标：开发模式 / alt-tab / 弹窗标题栏用它；打包后 exe 自带同款图标
    // （electron-builder 走 build/icon.ico）。v2.0 及以前没设，任务管理器里是
    // 光秃秃的 Electron 默认图标——用户点名"icon 要有图标"。
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.ico'))
      ? path.join(__dirname, 'build', 'icon.ico')
      : undefined,
    alwaysOnTop: false,       // 置底小部件，永不置顶（旧配置里的 alwaysOnTop 不再生效）
    skipTaskbar: true,        // 桌面小部件不出现在任务栏
    resizable: true,
    show: false,              // 等 ready-to-show 再显示，避免白闪
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  applyLocked(config.locked);   // 锁定位置：窗口不可移动 / 不可缩放
  keepBottom = config.keepBottom !== false;   // 默认置底

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    applyKeepBottom();   // 首次显示就沉到底层
  });

  // 置底核心：窗口一获得焦点就会被系统提到前面，抢到焦点立刻压回去
  mainWindow.on('focus', () => {
    if (keepBottom) {
      try { mainWindow.moveBottom(); } catch (e) { /* 忽略 */ }
    }
  });

  // 窗口变化时保存（saveBounds 已提升到模块级，set-dragging 结束时也要用）
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ---------- 系统托盘 ----------
 * 任务栏隐藏后，托盘是唯一能重新唤出窗口的入口。 */
function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_ICON_B64);
  tray = new Tray(icon);
  tray.setToolTip('FClassPal');

  const buildMenu = () => Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? '隐藏窗口' : '显示窗口',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: '添加快捷方式',
      click: () => sendToRenderer('add')
    },
    {
      label: '设置',
      click: () => { toggleWindow(true); sendToRenderer('settings'); }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { app.isQuitting = true; app.quit(); }
    }
  ]);

  tray.setContextMenu(buildMenu());
  // 单击托盘图标切换显示/隐藏
  tray.on('click', () => toggleWindow());
}

function toggleWindow(forceShow) {
  if (!mainWindow) return;
  if (forceShow || !mainWindow.isVisible()) {
    mainWindow.show();
    // 置底小部件不抢焦点；若允许置顶逻辑存在也不强制 focus
    if (keepBottom) applyKeepBottom();
  } else {
    mainWindow.hide();
  }
}

function sendToRenderer(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tray-action', action);
  }
}

/* 把窗口真实位置/尺寸回推给渲染层，避免两者状态不一致 */
function pushBounds(b) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bounds-changed', b);
  }
}

/* 窗口位置/尺寸落盘（300ms 防抖，拖拽时不会每像素读写磁盘）。
 * ※ 必须是模块级函数，不能放在 createWindow 的闭包里：
 *   ipcMain.on('set-dragging') 在拖动结束时也要调它——v2.0 把它写成了闭包局部量，
 *   结果**每次松手都抛 ReferenceError: saveBounds is not defined**（Electron 没有
 *   uncaughtException 兜底时就是用户看到的一坨报错弹窗），而且抛错发生在落盘之前，
 *   **拖完的位置根本没存下来**，重启又回到老位置。一个作用域错误打穿两个功能。 */
let boundsSaveTimer = null;
function saveBounds() {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = 0;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    const cfg = loadConfig();
    cfg.width = b.width;
    cfg.height = b.height;
    cfg.x = b.x;
    cfg.y = b.y;
    // cfg.opacity 现在表示"玻璃背景 alpha"，仅由渲染层在调透明度滑块时写入，
    // 不再从 mainWindow.getOpacity() 读取（OS 级窗口透明度已停用，避免覆盖渲染层值）。
    saveConfig(cfg);
    // 渲染层拖拽期间绝不回推：它的 bounds 才是准的（见 renderDragging 注释）。
    // 缺这一步时，每拖一帧都会有一次"被拉回旧位置又拖回来"的闪跳。
    if (!renderDragging) pushBounds(b);
  }, 300);
}

/* ============================================================
 * U 盘检测（可移动磁盘 DriveType=2）
 * ------------------------------------------------------------
 * 采用"常驻 PowerShell 进程 + 变化才输出"的方案：
 * 若每 N 秒 spawn 一次 powershell，每次都要付 ~1s 的冷启动开销；
 * 常驻进程把单次成本降到一次 WMI 查询（约 10ms），且只在插拔时推送。
 * 进程意外退出会自动重启。
 * 注意：必须显式设置 OutputEncoding 为 UTF8，否则中文卷标会按 GBK
 * 输出，导致 Node 侧解析出乱码。
 * ============================================================ */
const PS_USB_WATCH = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$prev = ''",
  "while ($true) {",
  "  $drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | ForEach-Object {",
  "    [PSCustomObject]@{",
  "      letter = ($_.DeviceID -replace ':', '')",
  "      name   = $_.VolumeName",
  "      size   = $_.Size",
  "      free   = $_.FreeSpace",
  "    }",
  "  })",
  "  $json = ConvertTo-Json -InputObject $drives -Compress -Depth 3",
  "  if ($json -ne $prev) { $prev = $json; Write-Output $json; [Console]::Out.Flush() }",
  "  Start-Sleep -Milliseconds 1200",
  "}"
].join('\n');

let usbWatcher = null;
let lastDrives = [];

/* 归一化：过滤脏数据、补默认值、按盘符排序，保证渲染层拿到稳定结构 */
function normalizeDrives(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d) => d && d.letter)
    .map((d) => ({
      letter: String(d.letter).replace(':', '').toUpperCase(),
      name: (d.name && String(d.name).trim()) || '可移动磁盘',
      size: typeof d.size === 'number' ? d.size : 0,
      free: typeof d.free === 'number' ? d.free : 0
    }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

function sendUsbDrives(drives) {
  lastDrives = drives;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usb-changed', drives);
  }
}

function startUsbWatcher() {
  if (process.platform !== 'win32') return;

  const spawnWatcher = () => {
    if (app.isQuitting) return;
    try {
      usbWatcher = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', PS_USB_WATCH],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      console.error('U 盘监听启动失败：', e.message);
      return;
    }

    let buf = '';
    usbWatcher.stdout.setEncoding('utf8');
    usbWatcher.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          sendUsbDrives(normalizeDrives(JSON.parse(line)));
        } catch (e) { /* 忽略无法解析的脏行，等待下一行 */ }
      }
    });

    usbWatcher.on('error', () => { usbWatcher = null; });
    usbWatcher.on('exit', () => {
      usbWatcher = null;
      setTimeout(spawnWatcher, 3000);   // 异常退出后自动重启
    });
  };

  spawnWatcher();
}

function stopUsbWatcher() {
  if (usbWatcher) {
    try { usbWatcher.kill(); } catch (e) { /* 已退出 */ }
    usbWatcher = null;
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  startUsbWatcher();
  startWallpaperWatcher();   // 换壁纸时把新壁纸推给渲染层重画

  /* 启动时同步一次自启动注册表状态，保证配置与系统一致 */
  try {
    const cfg = loadConfig();
    if (cfg.autoLaunch) app.setLoginItemSettings({ openAtLogin: true });
  } catch (e) { /* 注册表写入失败不影响启动 */ }
});

app.on('window-all-closed', () => {
  // 保留托盘常驻，不随窗口关闭退出
  if (process.platform !== 'darwin') {
    // 仅在真正退出时清理
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopUsbWatcher();
  stopWallpaperWatcher();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else toggleWindow(true);
});

/* ---------- IPC 通信 ---------- */
ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('get-env', () => ({
  // v1.7 起放弃 mica：它要求 transparent:false，会在四角露出一圈方形底色。
  // 现在一律 transparent 窗口 + 渲染层自己画真实壁纸当玻璃底材。
  transparent: true,
  platform: process.platform,
  release: os.release()
}));

/* 壁纸基底：位置随窗口移动而变，所以每次都要按当前 bounds 重新算 */
ipcMain.handle('get-wallpaper', () => getWallpaperInfo(mainWindow));

/* MD3 单独取配色：手动选主色时不必重走整套壁纸坐标计算，直接给 palette。
 * 传进来的 patch 会先落盘（这样 wallpaper-changed 重取时也记得住），再算色。 */
ipcMain.handle('get-palette', (event, patch) => {
  const cfg = loadConfig();
  if (patch && typeof patch === 'object') {
    if (patch.colorMode === 'auto' || patch.colorMode === 'manual') cfg.colorMode = patch.colorMode;
    if (typeof patch.accentColor === 'string') cfg.accentColor = patch.accentColor;
    // v2.4.0：明暗模式与自定义背景都会改变"该用哪张图、走哪套方案"来派生配色
    if (patch.appearance === 'auto' || patch.appearance === 'light' || patch.appearance === 'dark') {
      cfg.appearance = patch.appearance === 'auto' ? 'light' : patch.appearance;
    }
    if (patch.background && typeof patch.background === 'object') {
      cfg.background = { ...cfg.background, ...patch.background };
    }
    saveConfig(cfg);
  }
  return buildPalette(cfg, null, null);
});

/* ---------- 壁纸变更监听：换壁纸要同步 ----------
 * 静态壁纸基底最大的问题就是"开窗那一刻冻结"，换了壁纸玻璃里还是旧的。
 * Windows 没有给普通应用 WM_WALLPAPERCHANGED，只能轮询：
 *   · 手动换图 → 注册表 WallPaper 字符串变化
 *   · 幻灯片轮播 / 主题切换 → 同一个 TranscodedWallpaper 文件被重写（mtime 变）
 * 两条都装进指纹里，2s 一次，一次 reg query + 一次 stat，开销可以忽略。 */
let wallpaperSig = '';
let wallpaperTimer = null;

async function checkWallpaperChanged() {
  if (process.platform !== 'win32') return;
  try {
    const meta = await readWallpaperMeta();
    const sig = wallpaperSignature(meta);
    if (!sig) return;
    if (wallpaperSig && sig !== wallpaperSig) {
      const info = await getWallpaperInfo(mainWindow);
      if (info && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wallpaper-changed', info);
      }
    }
    wallpaperSig = sig;
  } catch (e) { /* 读不到就维持现状，下次再试 */ }
}

function startWallpaperWatcher() {
  if (process.platform !== 'win32') return;
  checkWallpaperChanged();
  if (wallpaperTimer) clearInterval(wallpaperTimer);
  wallpaperTimer = setInterval(checkWallpaperChanged, 2000);
}

function stopWallpaperWatcher() {
  if (wallpaperTimer) { clearInterval(wallpaperTimer); wallpaperTimer = null; }
}

/* ---------- 实时玻璃底材：把真实桌面采给渲染层 ----------
 * 为什么需要：Mica / Acrylic 都是 DWM 在窗口**外面**画的位图，浏览器进程里的
 * Chromium 拿不到窗口底下的真实像素。于是 backdrop-filter 糊的其实是一片空白
 * （或我们内建的假壁纸）—— 桌面在动，玻璃里纹丝不动，这就是用户说的
 * "模糊不是实时的"。
 *
 * 做法：走 Chromium 自带的屏幕采集链路。
 *   ① 主进程用 setDisplayMediaRequestHandler 直接放行"窗口所在的那块显示器"，
 *      跳过系统选择器（Electron 31 支持）。
 *   ② 渲染进程 getDisplayMedia 拿到视频流，按屏幕坐标裁出窗口矩形画进
 *      #deskCanvas。底材即真桌面，桌面一动画面就跟着动。
 *
 * 自拍问题：窗口若出现在自己的采集里就成了无限镜面。用 setContentProtection(true)
 * （Windows = SetWindowDisplayAffinity + WDA_EXCLUDEFROMCAPTURE）把本窗口从所有
 * 屏幕采集中排除，采到的自然是窗口背后的桌面 —— 正是我们要的内容。
 * 副作用必须在设置里如实告知：开启期间系统截图 / 录屏也看不到本窗口。 */
let displayMediaReady = false;
let realtimeActive = false;

/** 窗口所在显示器的几何信息（DIP + 缩放），渲染层按它把 bounds 换算成物理像素 */
function displayInfoForWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const b = mainWindow.getBounds();
  const d = screen.getDisplayMatching(b);
  return {
    x: d.bounds.x, y: d.bounds.y,
    w: d.bounds.width, h: d.bounds.height,
    scaleFactor: d.scaleFactor || 1,
    id: String(d.id)
  };
}

function ensureDisplayMediaHandler() {
  if (displayMediaReady) return;
  displayMediaReady = true;
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const info = displayInfoForWindow();
      // thumbnailSize 给最小尺寸：我们只需要 source 句柄，缩略图没用还费内存
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: { width: 1, height: 1 }
      });
      if (!sources.length) { callback({}); return; }
      // 多显示器：优先窗口所在那块（desktopCapturer 的 display_id 与 screen 的 id 都是字符串）
      const match = (info && sources.find((s) => String(s.display_id) === info.id)) || sources[0];
      callback({ video: match });
    } catch (e) {
      callback({});
    }
  });
}

ipcMain.handle('realtime-start', () => {
  try {
    ensureDisplayMediaHandler();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setContentProtection(true); } catch (e) { /* 老版本可能没有 */ }
    }
    realtimeActive = true;
    return displayInfoForWindow();
  } catch (e) {
    return null;
  }
});

ipcMain.handle('realtime-stop', () => {
  realtimeActive = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setContentProtection(false); } catch (e) { /* 忽略 */ }
  }
  return true;
});

/* 窗口挪到另一块显示器 / DPI 变了，渲染层要重新拉一次几何信息 */
ipcMain.handle('get-display-info', () => displayInfoForWindow());

ipcMain.handle('save-config', (event, config) => {
  saveConfig(config);
  /* 这里刻意不再 setBounds：渲染层持有的 bounds 可能已过期（例如窗口被
   * 系统原生拖拽移动过），一旦用它回写就会让窗口瞬间"跳回"旧位置，
   * 这正是拖动时闪烁/抖动的来源之一。位置只由拖拽与 setBounds 接口决定。
   * 也不再 setOpacity：透明度已重定义为"玻璃背景 alpha"，由渲染层用
   * CSS 变量 --glass-alpha 直接驱动 .widget::before，整个窗口 OS 级
   * 透明度固定为不透明，保证前景文字/图标始终可读。 */
  return true;
});

ipcMain.handle('open-target', async (event, item) => {
  try {
    if (item.type === 'web') {
      await shell.openExternal(item.target);
    } else if (item.type === 'app' || item.type === 'file' || item.type === 'folder') {
      if (!fs.existsSync(item.target)) {
        return { success: false, error: '目标不存在：' + item.target };
      }
      await shell.openPath(item.target);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

/* 选择文件夹（目录）。
 * ※ 必须单独开一个通道：Windows 的原生对话框**不支持**同时勾 openFile 和
 *   openDirectory（那个组合只有 macOS 有效）。之前"文件 / 文件夹"共用一个
 *   openFile 对话框，用户永远选不到目录，只能手打或粘贴路径——本次修的就是它。 */
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择文件夹',
    buttonLabel: '选择此文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/* 关于界面：版本号 + GitHub 链接。
 * open-external 做域名白名单：渲染层被攻破时也不能拿它打开任意 URL。 */
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('open-external', (event, url) => {
  if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) {
    return shell.openExternal(url);
  }
  return false;
});

ipcMain.handle('select-app', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: '可执行文件', extensions: ['exe', 'bat', 'cmd', 'lnk'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

/* ---------- 自定义图标：选择图片并复制到图标目录 ---------- */
ipcMain.handle('select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;

  const src = result.filePaths[0];
  try {
    ensureConfigDir();
    if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });
    const ext = path.extname(src).toLowerCase() || '.png';
    const destName = 'icon-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    const dest = path.join(ICONS_DIR, destName);
    fs.copyFileSync(src, dest);
    // 返回 file:// URL，渲染层可直接用作 img src
    return { path: dest, url: pathToFileURL(dest).href };
  } catch (e) {
    return { error: e.message };
  }
});

/* ---------- 自定义背景图（v2.4.0） ----------
 * 只存路径、不复制文件：一张壁纸级的图动辄几 MB，复制一份纯浪费磁盘。
 * 文件被移走 / 删除时 customBackgroundFile 返回 null，渲染层自动回退壁纸。 */
function backgroundPayload(file) {
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return {
      url: pathToFileURL(file).href,
      path: file,
      luminance: wallpaperLuminance(file)
    };
  } catch (e) { return null; }
}

ipcMain.handle('pick-background', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [
      { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const hit = backgroundPayload(result.filePaths[0]);
  return hit || { error: '读不到这张图片' };
});

ipcMain.handle('load-background', () => backgroundPayload(customBackgroundFile(loadConfig())));

/* ---------- 窗口控制 ---------- */
ipcMain.handle('set-bounds', (event, bounds) => {
  if (mainWindow && !windowLocked) {
    mainWindow.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    });
  }
  return true;
});

/* ---------- 触摸拖动：渲染层每帧推一次目标位置 ----------
 * 用 send（fire-and-forget）而非 invoke：拖动不需要主进程回复，
 * 免去往返应答的开销；setPosition 只改坐标不改尺寸，开销极小。 */
ipcMain.on('move-window', (event, pos) => {
  if (!mainWindow || mainWindow.isDestroyed() || windowLocked) return;
  if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
  const x = Math.round(pos.x), y = Math.round(pos.y);
  /* 拖动诊断（v2.2.3）：只统计"每帧位移"，够不够异常由 set-dragging 那边判定。
   * 主进程是唯一能看到"真实落位"的地方，用它来量最省事。 */
  if (dragStat.t0) {
    dragStat.moves++;
    if (dragStat.lastX !== null) {
      const step = Math.max(Math.abs(x - dragStat.lastX), Math.abs(y - dragStat.lastY));
      if (step > dragStat.maxStep) dragStat.maxStep = step;
    }
    dragStat.lastX = x;
    dragStat.lastY = y;
    dragStat.lastAt = Date.now();
  }
  mainWindow.setPosition(x, y);
});

/* 拖动会话统计（v2.2.3）：触摸拖动闪屏的两类主因，主进程能直接观测到——
 *   ① set-dragging 被**反复**开关 → 渲染层在反复"结束并重启"拖拽，
 *      折射滤镜跟着摘戴，肉眼就是闪；
 *   ② 单帧位移异常大 → 坐标源不可信（采样离群 / 坐标系反馈）。
 * 正常一次拖拽只有 1 次 true + 1 次 false、单帧几十像素，所以只在异常时
 * 落一行日志到 ~/.desktop-widget/drag-diag.log（不产生常驻 IO），
 * 用户遇到问题可以直接把这个文件发回来定位。 */
let dragStat = { t0: 0, lastAt: 0, toggles: 0, moves: 0, maxStep: 0, lastX: null, lastY: null, logged: false };
function dragDiagWrite(extra) {
  try {
    ensureConfigDir();
    fs.appendFileSync(path.join(CONFIG_DIR, 'drag-diag.log'),
      new Date().toISOString() + ' ' + extra + '\n');
  } catch (e) { /* 诊断失败绝不影响主流程 */ }
}

/* 渲染层拖拽开关（v1.8）：告诉主进程"这几帧的位置由我说了算"。
 * 结束时由主进程读一次真实 bounds 落盘并回推，把两边对齐。 */
ipcMain.on('set-dragging', (event, value) => {
  const now = Date.now();
  // 距上次活动超过 3s 视为新的一段拖拽，重新计数
  if (!dragStat.t0 || now - dragStat.lastAt > 3000) {
    dragStat = { t0: now, lastAt: now, toggles: 0, moves: 0, maxStep: 0, lastX: null, lastY: null, logged: false };
  }
  dragStat.lastAt = now;
  dragStat.toggles++;
  if (!value && !dragStat.logged &&
      (dragStat.toggles > 2 || dragStat.maxStep > 400)) {
    dragStat.logged = true;
    dragDiagWrite('toggles=' + dragStat.toggles + ' moves=' + dragStat.moves +
      ' maxStep=' + dragStat.maxStep + ' span=' + (now - dragStat.t0) + 'ms');
  }
  renderDragging = !!value;
  if (!renderDragging) {
    applyKeepBottom();   // 拖拽期间被搁置的置底，松手后补一次
    saveBounds();        // 立即排一次落盘+回推（内部已有 300ms 防抖）
  }
});

/* ---------- 开机自启动 ----------
 * 写入当前用户的注册表 Run 键（HKCU\...\Run），便携版 exe 同样适用。 */
ipcMain.handle('set-auto-launch', (event, value) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!value });
    const enabled = app.getLoginItemSettings().openAtLogin;
    const cfg = loadConfig();
    cfg.autoLaunch = !!value;
    saveConfig(cfg);
    return { success: enabled === !!value, enabled };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/* ---------- 锁定位置 ----------
 * 双保险：主进程 setMovable/setResizable 挡住系统级移动，
 * 同时 move-window / set-bounds 也会被 windowLocked 拦截。 */
ipcMain.handle('set-locked', (event, value) => {
  applyLocked(value);
  const cfg = loadConfig();
  cfg.locked = !!value;
  saveConfig(cfg);
  return { success: true };
});

ipcMain.on('window-hide', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

/* 置底开关：渲染层设置面板的"窗口置底" */
ipcMain.on('set-keep-bottom', (event, value) => {
  keepBottom = !!value;
  if (keepBottom) {
    applyKeepBottom();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setAlwaysOnTop(false); } catch (e) { /* 忽略 */ }
  }
  const cfg = loadConfig();
  cfg.keepBottom = keepBottom;
  cfg.alwaysOnTop = false;   // 顺手清理旧字段
  saveConfig(cfg);
});

/* ---------- 从文件（exe 等）提取系统图标 ----------
 * 用 Electron 自带的 app.getFileIcon 取大图标，转成 PNG 存到图标目录，
 * 再以 file:// URL 交给渲染层，和"自定义图片"走同一套存储/展示逻辑。 */
ipcMain.handle('get-file-icon', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') return { error: '路径无效' };
    if (!fs.existsSync(filePath)) return { error: '文件不存在' };

    const icon = await app.getFileIcon(filePath, { size: 'large' });
    if (!icon || icon.isEmpty()) return { error: '该文件没有可用图标' };

    ensureConfigDir();
    if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

    const safe = path.basename(filePath).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_').slice(0, 40);
    const destName = 'exe-' + safe + '-' + Date.now() + '.png';
    const dest = path.join(ICONS_DIR, destName);
    fs.writeFileSync(dest, icon.toPNG());

    return { path: dest, url: pathToFileURL(dest).href };
  } catch (e) {
    return { error: e.message };
  }
});

/* ---------- 图标主色批量查询（v2.4.2） ----------
 * 渲染层一次把所有图片图标的路径发过来，主进程回 path → '#rrggbb' 的表。
 * 做成"一次拿全"而不是每个图标一次往返：首帧就能带上颜色，
 * 否则会先画一圈白边再变色（用户明确不喜欢这种"掉画质"式的闪）。
 * 取不到色的返回 null（或键根本不存在），渲染层退回主题强调色。 */
ipcMain.handle('get-icon-colors', (event, list) => {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw) continue;
    const key = String(raw);
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = iconColorFromFile(iconFileArg(key));
  }
  return out;
});

/* ---------- U 盘 ---------- */
ipcMain.handle('get-usb-drives', () => lastDrives);

ipcMain.handle('open-drive', async (event, letter) => {
  try {
    const l = String(letter).replace(':', '').toUpperCase();
    const target = l + ':\\';
    const err = await shell.openPath(target);
    if (err) return { success: false, error: err };
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/* ---------- 安全弹出 U 盘：五层策略 + 真实结果验证 ----------
 *
 * 历代踩过的坑，都在这里留档：
 * ① Shell 右键动词 DoIt() 是异步的，失败也不报错——经常"假成功"（提示已弹出，
 *    实际盘还在）。所以每层都必须轮询盘符是否真的消失，消失才算成功。
 * ② mountvol 兜底传的是 "E:" 而非 "E:\"，路径不合法，兜底永远失败。
 * ③ ★ CM_Request_Device_EjectW 弹的是**磁盘节点**（PNPDeviceID 形如
 *    USBSTOR\Disk&Ven_...）。弹它可以返回 CR_SUCCESS，但盘符根本不会消失——
 *    Windows 的"安全删除硬件"弹的是它上层的 **USB 设备节点**
 *    （USB\VID_xxxx&PID_xxxx）。修复：CM_Get_Parent 逐级上溯，直到设备 ID 以
 *    "USB\" 开头（注意不能匹配 "USBSTOR\"，所以要带反斜杠）。
 * ④ 取 PNPDeviceID 原来只走 Get-Partition，部分环境取不到。改为优先走 WMI
 *    关联链（LogicalDisk → DiskPartition → DiskDrive），不需要管理员权限。
 * ⑤ ★★ v2.2.3 修正错误码映射（本次修的两个真问题之一）：
 *    旧表把 **51 当成"设备正忙"**、把 **9 当成"权限不足"**，而实际上
 *    CONFIGRET 51 = CR_ACCESS_DENIED（**权限不足**）、PNP_VETO_TYPE 9 =
 *    PNP_VetoInsufficientPower（**供电不足**），权限不足是 12 =
 *    PNP_VetoInsufficientRights。两件事刚好被写反 → 用户看到"设备正忙"，
 *    完全判断不出是权限问题（本次用户就在问"是否需要管理员权限"）。
 * ⑥ ★★ v2.2.3 新增"卷级弹出"层（免管理员，见 buildVolumeEjectScript）：
 *    CM 弹 USB 父节点只对**整台设备**生效，遇到"设备节点受保护 / 上层仍有子设备
 *    在位"时 Windows 会保住盘符。而照着 Explorer"弹出"的实现思路
 *    （CreateFile \\.\X: → FSCTL_LOCK_VOLUME → 允许移除介质 →
 *    FSCTL_DISMOUNT_VOLUME → IOCTL_STORAGE_EJECT_MEDIA →
 *    DeleteVolumeMountPoint）走的是**卷**这条路，对可移动卷不需要管理员
 *    （固定磁盘才需要），且真被占用时会明确报 ERROR_BUSY/ACCESS_DENIED，
 *    比 CM 那层含糊的 veto 更好定位。
 * ⑦ 所有普通层都失败时返回 needAdmin，界面据此给出一次性的"以管理员身份重试"
 *    （UAC 提权跑 CM 弹节点 + mountvol /p —— 这两条在提权后才真正解锁）。
 *
 * 顺序：① CM 弹 USB 父节点 → ② 卷级 IOCTL 弹出（新）→ ③ Shell 弹出动词
 *      → ④ WMI Dismount → ⑤ mountvol /p →（失败则）提权重试。 */

/** PNP_VETO_TYPE（Cfg.h，从 0 起顺序枚举）→ 人话 */
const VETO_HINTS = {
  0: '系统没有给出具体原因',
  1: '该设备不支持安全移除（老式设备）',
  2: '有程序正在关闭中，请等几秒再试',
  3: '有应用程序正在占用该 U 盘（常见的资源管理器窗口 / 编辑器）',
  4: '有系统服务正在占用该 U 盘（搜索索引、杀毒扫描、网盘同步最常见）',
  5: '该 U 盘上还有未关闭的文件句柄，请关掉所有打开该盘的窗口和程序',
  6: '设备自身拒绝了弹出请求',
  7: '设备驱动拒绝了弹出请求',
  8: '该设备不支持此操作',
  9: '设备供电不足，无法安全弹出（可换一个 USB 口试试）',
  10: '该设备不允许被停用',
  11: '驱动不支持此操作（老式驱动）',
  12: '权限不足：该设备的移除需要管理员权限'
};

/** CONFIGRET 关键返回码（cfgmgr32.h）→ 人话。
 *  51 是 CR_ACCESS_DENIED（v2.2.3 修正：旧版写成了"设备正忙"）。 */
const CM_HINTS = {
  5: '设备节点无效（CR_INVALID_DEVNODE）',
  13: '找不到该设备节点（CR_NO_SUCH_DEVNODE）',
  19: '配置管理器返回失败（CR_FAILURE）',
  23: '系统拒绝了移除请求（CR_REMOVE_VETOED），通常是设备仍被占用',
  40: '该设备不允许被停用（CR_NOT_DISABLEABLE）',
  51: '访问被拒绝（CR_ACCESS_DENIED）：需要管理员权限才能移除该设备',
  52: '系统不支持此调用（CR_CALL_NOT_IMPLEMENTED）'
};

/** 生成 PowerShell 函数 InvokeCmEject($letter)：取 PNPDeviceID → 上溯到 USB\
 *  父节点 → CM_Request_Device_EjectW。返回单行结果字符串（OK/VETO/LOCATE/NODEV）。
 *  ※ 用"函数定义"而不是"整段脚本"是为了让提权模式能复用同一份逻辑：
 *    提权脚本里要接着跑 mountvol、还要把结果落盘，不能被 exit 提前结束。 */
function buildCmEjectFn() {
  return [
    'function InvokeCmEject($l) {',
    '  $devId = $null',
    '  try {',
    '    $parts = @(Get-CimInstance -Query ("ASSOCIATORS OF {Win32_LogicalDisk.DeviceID=\'" + $l + "\':\'} WHERE AssocClass=Win32_LogicalDiskToPartition") -ErrorAction Stop)',
    '    foreach ($p in $parts) {',
    '      $dd = @(Get-CimInstance -Query ("ASSOCIATORS OF {Win32_DiskPartition.DeviceID=\'" + $p.DeviceID + "\'} WHERE AssocClass=Win32_DiskDriveToDiskPartition") -ErrorAction Stop)',
    '      if ($dd.Count -gt 0 -and $dd[0].PNPDeviceID) { $devId = $dd[0].PNPDeviceID; break }',
    '    }',
    '  } catch { }',
    '  if (-not $devId) {',
    '    try {',
    '      $num = (Get-Partition -DriveLetter $l -ErrorAction Stop | Select-Object -First 1).DiskNumber',
    '      $devId = (Get-CimInstance Win32_DiskDrive -ErrorAction Stop | Where-Object { $_.Index -eq $num }).PNPDeviceID',
    '    } catch { }',
    '  }',
    "  if (-not $devId) { return 'NODEV' }",
    '  try { Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class UsbEject {',
    '  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    '  public static extern uint CM_Locate_DevNodeW(out uint dev, string id, uint flags);',
    '  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    '  public static extern uint CM_Get_Parent(out uint parent, uint dev, uint flags);',
    '  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    '  public static extern uint CM_Get_Device_IDW(uint dev, StringBuilder id, uint len, uint flags);',
    '  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    '  public static extern uint CM_Request_Device_EjectW(uint dev, out uint vetoType, StringBuilder vetoName, uint len, uint flags);',
    '}',
    '"@ } catch { }',
    '  $dev = 0',
    '  $rc = [UsbEject]::CM_Locate_DevNodeW([ref]$dev, $devId, 0)',
    "  if ($rc -ne 0) { return ('LOCATE ' + $rc) }",
    /* 上溯：磁盘节点 USBSTOR\... → USB\VID_xxx → USB\ROOT_HUB… 只取 USB\VID 那层 */
    '  $target = $dev',
    '  $found = $false',
    '  $sb = New-Object System.Text.StringBuilder 512',
    '  for ($i = 0; $i -lt 12; $i++) {',
    '    [void][UsbEject]::CM_Get_Device_IDW($target, $sb, 512, 0)',
    '    if ($sb.ToString() -match \'^USB\\\\\') { $found = $true; break }',
    '    $parent = 0',
    '    $pr = [UsbEject]::CM_Get_Parent([ref]$parent, $target, 0)',
    '    if ($pr -ne 0 -or $parent -eq 0) { break }',
    '    $target = $parent',
    '    [void]$sb.Clear()',
    '  }',
    '  if (-not $found) { $target = $dev; [void]$sb.Clear(); [void][UsbEject]::CM_Get_Device_IDW($target, $sb, 512, 0) }',
    '  $vt = 0',
    '  $vb = New-Object System.Text.StringBuilder 260',
    '  $rc = [UsbEject]::CM_Request_Device_EjectW($target, [ref]$vt, $vb, 260, 0)',
    "  if ($rc -ne 0) { return ('VETO ' + $vt + '|' + $vb.ToString() + '|' + $rc) }",
    "  return ('OK ' + $sb.ToString())",
    '}'
  ].join('\n');
}

/** 卷级弹出（照 Explorer"弹出"的路子，可移动卷免管理员）。
 *  LOCK → 允许移除介质 → DISMOUNT → STORAGE_EJECT_MEDIA → 删挂载点。
 *  真被占用时 LOCK/DISMOUNT 会失败并带 ERROR_BUSY(170)/ACCESS_DENIED(5)，
 *  正好用来区分"被占用"和"没权限"。 */
function buildVolumeEjectScript(l) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$l = '" + l + "'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class VolEject {',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr templ);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint ret, IntPtr ov);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern bool CloseHandle(IntPtr h);',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern bool DeleteVolumeMountPointW(string mnt);',
    '  public static string Run(string letter) {',
    '    string r = "";',
    '    uint ret = 0;',
    /* 先要读写权限（锁卷需要），被拒再退只读——两者都可能成，看设备策略 */
    '    for (int mode = 0; mode < 2; mode++) {',
    '      uint access = mode == 0 ? 0xC0000000u : 0x80000000u;',
    '      IntPtr h = CreateFileW(@"\\\\.\\" + letter + ":", access, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);',
    '      if (h == new IntPtr(-1)) { r += "OPEN" + mode + "=err" + Marshal.GetLastWin32Error() + " "; continue; }',
    '      r += "OPEN" + mode + "=ok";',
    '      bool lk = DeviceIoControl(h, 0x00090018u, IntPtr.Zero, 0u, IntPtr.Zero, 0u, out ret, IntPtr.Zero);',
    '      r += " LOCK=" + (lk ? "1" : "0/" + Marshal.GetLastWin32Error());',
    '      IntPtr pin = Marshal.AllocHGlobal(4);',
    '      Marshal.WriteInt32(pin, 0);',
    '      DeviceIoControl(h, 0x002D1400u, pin, 4u, IntPtr.Zero, 0u, out ret, IntPtr.Zero);',
    '      Marshal.FreeHGlobal(pin);',
    '      bool dm = DeviceIoControl(h, 0x00090020u, IntPtr.Zero, 0u, IntPtr.Zero, 0u, out ret, IntPtr.Zero);',
    '      r += " DISMOUNT=" + (dm ? "1" : "0/" + Marshal.GetLastWin32Error());',
    '      bool ej = DeviceIoControl(h, 0x002D4808u, IntPtr.Zero, 0u, IntPtr.Zero, 0u, out ret, IntPtr.Zero);',
    '      r += " EJECT=" + (ej ? "1" : "0/" + Marshal.GetLastWin32Error());',
    '      CloseHandle(h);',
    '      bool del = DeleteVolumeMountPointW(letter + ":\\\\");',
    '      r += " DELMOUNT=" + (del ? "1" : "0/" + Marshal.GetLastWin32Error());',
    '      return r;',
    '    }',
    '    return r;',
    '  }',
    '}',
    '"@',
    "Write-Output ('VOL ' + [VolEject]::Run($l))"
  ].join('\n');
}

ipcMain.handle('eject-drive', async (event, letter) => {
  const l = String(letter || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!/^[A-Z]$/.test(l)) return { success: false, error: '盘符无效' };
  const driveRoot = l + ':\\';

  const run = (cmd, args, timeout) => new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout },
      (err, stdout, stderr) => resolve({
        err, stdout: String(stdout || ''), stderr: String(stderr || '')
      }));
  });

  const driveExists = () => { try { return fs.existsSync(driveRoot); } catch (e) { return false; } };
  if (!driveExists()) return { success: true };   // 已经不在了，直接算成功

  const waitGone = async (ms) => {
    for (let t = 0; t < ms; t += 250) {
      if (!driveExists()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return !driveExists();
  };

  let lastError = '';
  let needAdmin = false;      // 明确的"权限不足"信号
  const detail = [];          // 每层真实输出，失败时一并返回，便于定位

  /* 认定"这是权限问题"：输出里出现 Access is denied / 拒绝访问 / 0x80070005 */
  const flagAdmin = (text) => {
    if (text && /Access is denied|拒绝访问|Access Denied|0x80070005|UnauthorizedAccess/i.test(text)) {
      needAdmin = true;
    }
  };
  const PS_HEAD = ['-NoProfile', '-NonInteractive', '-Command'];

  const done = () => {
    sendUsbDrives(normalizeDrives(lastDrives.filter((d) => d.letter !== l)));
    return { success: true };
  };

  /* --- 1) CM_Request_Device_EjectW：弹 USB **父节点**（首选，免管理员） --- */
  const cmPs = ["$ErrorActionPreference = 'Stop'", buildCmEjectFn(),
    "Write-Output (InvokeCmEject '" + l + "')"].join('\n');
  const r1 = await run('powershell.exe', PS_HEAD.concat(cmPs), 30000);
  const out1 = (r1.stdout || '').trim();
  detail.push('CM=' + (out1 || (r1.stderr || '').trim().slice(0, 160) || '(无输出)'));
  if (out1.indexOf('OK') === 0) {
    if (await waitGone(6000)) return done();
    lastError = '系统已接受弹出请求，但盘符在 6 秒内没有消失';
  } else if (out1.indexOf('VETO') === 0) {
    const p = out1.slice(5).split('|');
    const vt = parseInt(p[0], 10) || 0;
    const rc = parseInt(p[2], 10) || 0;
    lastError = VETO_HINTS[vt] || ('设备被占用，无法弹出（原因码 ' + vt + '）');
    if (vt === 12) needAdmin = true;
    if (rc === 51) { needAdmin = true; lastError = CM_HINTS[51]; }
    const vetoName = (p[1] || '').trim();
    if (vetoName && (vt === 3 || vt === 4 || vt === 11)) lastError += '（占用方：' + vetoName + '）';
  } else if (out1.indexOf('LOCATE') === 0) {
    const rc = parseInt(out1.slice(6).trim(), 10) || 0;
    lastError = '定位设备节点失败：' + (CM_HINTS[rc] || ('配置管理器返回码 ' + rc));
    if (rc === 51) needAdmin = true;
  } else if (out1 === 'NODEV') {
    lastError = '没有找到该盘符对应的物理设备';
  } else if (r1.err) {
    lastError = '调用配置管理器失败：' + String(r1.err.message || '').slice(0, 120);
  }
  flagAdmin(out1 + ' ' + (r1.stderr || ''));

  /* --- 2) 卷级弹出（v2.2.3 新增，免管理员；占用/权限会给出明确错误码） --- */
  if (!driveExists()) return done();
  const r15 = await run('powershell.exe', PS_HEAD.concat(buildVolumeEjectScript(l)), 30000);
  const out15 = (r15.stdout || '').trim();
  detail.push('VOL=' + (out15 || (r15.stderr || '').trim().slice(0, 160) || '(无输出)'));
  if (out15.indexOf('VOL ') === 0 && await waitGone(5000)) return done();
  const volBody = out15.replace(/^VOL\s*/, '');
  // 170 = ERROR_BUSY（卷被占用）、5 = ERROR_ACCESS_DENIED
  if (/OPEN0=err5/.test(volBody)) needAdmin = true;
  if (!lastError && /0\/170/.test(volBody)) {
    lastError = '该 U 盘上还有正在使用的文件（卷被占用），请先关掉打开该盘的窗口或程序';
  }
  flagAdmin(out15 + ' ' + (r15.stderr || ''));

  /* --- 3) 资源管理器右键"弹出"动词 --- */
  if (!driveExists()) return done();
  const shellPs = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    "$sa = New-Object -ComObject Shell.Application",
    "$item = $sa.Namespace(17).ParseName('" + l + ":\\')",
    "if (-not $item) { Write-Output 'NOTFOUND'; exit 2 }",
    "foreach ($v in $item.Verbs()) {",
    "  if ($v.Name -match 'Eject|弹出|卸除|取出|取り出す') { $v.DoIt(); Write-Output 'OK'; exit 0 }",
    "}",
    "Write-Output 'NOVERB'; exit 3"
  ].join('\n');

  const r2 = await run('powershell.exe', PS_HEAD.concat(shellPs), 15000);
  const out2 = (r2.stdout || '').trim();
  detail.push('SHELL=' + (out2 || '(无输出)'));
  if (out2.indexOf('OK') >= 0 && await waitGone(6000)) return done();

  /* --- 4) WMI 卸载卷（Dismount，Permanent=true 会摘掉盘符） --- */
  if (!driveExists()) return done();
  const wmiPs = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    "$v = Get-CimInstance Win32_Volume -Filter \"DriveLetter='" + l + ":'\"",
    "if (-not $v) { Write-Output 'NOVOL'; exit 2 }",
    "$r = Invoke-CimMethod -InputObject $v -MethodName Dismount -Arguments @{ Force = $false; Permanent = $true }",
    "Write-Output ('DISMOUNT ' + $r.ReturnValue)",
    'exit 0'
  ].join('\n');
  const r3 = await run('powershell.exe', PS_HEAD.concat(wmiPs), 20000);
  const out3 = (r3.stdout || '').trim();
  detail.push('WMI=' + (out3 || '(无输出)'));
  if (out3.indexOf('DISMOUNT 0') === 0 && await waitGone(4000)) return done();

  /* --- 5) mountvol 卸载卷（必须是 E:\ 形式；需要管理员） --- */
  if (!driveExists()) return done();
  const r4 = await run('mountvol', [l + ':\\', '/p'], 15000);
  const mv = ((r4.stderr || '').trim() || (r4.stdout || '').trim()).slice(0, 120);
  detail.push('MOUNTVOL=' + (mv || 'ok'));
  if (!r4.err && await waitGone(4000)) return done();
  if (r4.err && mv) {
    lastError = lastError ? lastError + '；' + mv : mv;
    flagAdmin(mv);
  }

  return {
    success: false,
    error: lastError || '弹出失败，请确认没有程序正在使用该 U 盘',
    /* 普通层全失败：界面据此给出"以管理员身份重试"。
     * 明确的权限信号一定置位；盘符仍在也置位——提权是最后一张牌，
     * 让用户能一键试，比让他自己猜要强。 */
    needAdmin: needAdmin || driveExists(),
    detail: detail.join(' | ').slice(0, 400)
  };
});

/* --- 提权重试：走一次 UAC，把 CM 弹节点 + mountvol /p 交给管理员进程 ---
 * 为什么要单独一条通道：普通用户态下 ① devnode 可能被系统保护
 * （CM 返回 CR_ACCESS_DENIED=51）② mountvol /p 明确要求管理员。
 * 实现要点：脚本写临时文件 → 提权 powershell -File 执行 → 结果写回文件
 * （提权子进程的 stdout 拿不到，只能落盘再读）→ 主进程校验盘符是否真消失。 */
ipcMain.handle('eject-drive-elevated', async (event, letter) => {
  const l = String(letter || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!/^[A-Z]$/.test(l)) return { success: false, error: '盘符无效' };
  const driveRoot = l + ':\\';
  const driveExists = () => { try { return fs.existsSync(driveRoot); } catch (e) { return false; } };
  if (!driveExists()) return { success: true };

  const run = (cmd, args, timeout) => new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout },
      (err, stdout, stderr) => resolve({
        err, stdout: String(stdout || ''), stderr: String(stderr || '')
      }));
  });

  const stamp = Date.now();
  const tmpDir = app.getPath('temp');
  const psFile = path.join(tmpDir, 'fclasspal-eject-' + l + '-' + stamp + '.ps1');
  const outFile = path.join(tmpDir, 'fclasspal-eject-' + l + '-' + stamp + '.out');
  const script = [
    "$ErrorActionPreference = 'Continue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$l = '" + l + "'",
    buildCmEjectFn(),
    '$log = @()',
    /* 提权子进程的 stdout 拿不到，所以每步结果拼进 $log，最后落盘 */
    "try { $log += ('CM=' + (InvokeCmEject $l)) } catch { $log += ('CM=EX ' + $_.Exception.Message) }",
    'try {',
    "  $mv = (& mountvol ($l + ':\\') /p) 2>&1",
    "  $log += ('MOUNTVOL(exit=' + $LASTEXITCODE + ')=' + (($mv | Out-String).Trim()))",
    '} catch { $log += ("MOUNTVOL=EX " + $_.Exception.Message) }',
    'try {',
    "  $v = Get-CimInstance Win32_Volume -Filter \"DriveLetter='$l:'\"",
    '  if ($v) {',
    '    $r2 = Invoke-CimMethod -InputObject $v -MethodName Dismount -Arguments @{ Force = $false; Permanent = $true }',
    "    $log += ('WMI=' + $r2.ReturnValue)",
    '  }',
    '} catch { $log += ("WMI=EX " + $_.Exception.Message) }',
    "Set-Content -LiteralPath '" + outFile + "' -Value ($log -join ' | ') -Encoding UTF8"
  ].join('\n');

  try {
    fs.writeFileSync(psFile, '\ufeff' + script, 'utf8');
  } catch (e) {
    return { success: false, error: '无法写入提权脚本：' + e.message };
  }

  const launch = "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"" +
    psFile + "\"' -Verb RunAs -WindowStyle Hidden -Wait";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], 120000);

  let outText = '';
  try { if (fs.existsSync(outFile)) outText = fs.readFileSync(outFile, 'utf8').replace(/^\ufeff/, ''); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(psFile); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(outFile); } catch (e) { /* 忽略 */ }

  const errText = ((r.stderr || '') + ' ' + (r.stdout || '')).trim();
  if (/canceled by the user|用户已取消|操作已被用户取消|The operation was canceled/i.test(errText)) {
    return { success: false, error: '已取消管理员授权', detail: errText.slice(0, 200) };
  }

  for (let t = 0; t < 12000; t += 250) {
    if (!driveExists()) {
      sendUsbDrives(normalizeDrives(lastDrives.filter((d) => d.letter !== l)));
      return { success: true };
    }
    await new Promise((res) => setTimeout(res, 250));
  }

  return {
    success: false,
    error: '管理员模式仍然没能弹出：通常是有程序还占着该 U 盘（可关掉资源管理器窗口 / 暂停杀毒扫描后重试）',
    detail: (outText || errText).slice(0, 400)
  };
});

// （旧置顶配置通道已移除，由 set-keep-bottom 统一负责）
