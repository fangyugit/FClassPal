/* ============================================================
 * 桌面小部件 - 渲染进程逻辑
 * 功能：快捷方式管理、自定义图标、拖拽移动、缩放、透明度、触摸/高清适配
 * 操作入口：右键 / 长按 弹出菜单（主界面不显示任何按钮）
 * ============================================================ */

/* 预设图标 → 内联 SVG symbol id（线条图标，见 index.html #svgDefs）
 * 不用 emoji：emoji 在 Windows/触摸屏上的渲染风格不可控。 */
const ICONS = {
  book: 'i-book', plus: 'i-plus', mail: 'i-mail', shield: 'i-shield',
  board: 'i-board', camera: 'i-camera', folder: 'i-folder', link: 'i-link',
  app: 'i-gear', star: 'i-star'
};

// 预览模式下的示例图片图标（用于验证自定义图片渲染）
const DEMO_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAaElEQVR42mNgwAP0s///pwZmIAVQy1KyHENry/E6gl6WY3UEvS3HcMSgdAA6oLY83AG4XEcPB4AdMeqAgUqAow4Y/A4YzQWjDhjNBaMOGM0FdHPAgDfJRlvFg6JjMii6ZoOiczoQ3XMAbgljtx0qGzEAAAAASUVORK5CYII=';

const MIN_W = 300, MIN_H = 220;

let config = null;
let bounds = { x: 0, y: 0, width: 480, height: 420 };
let editMode = false;
let currentEdit = null; // { groupIndex, itemIndex } or { groupIndex } for new

/* 图标编辑状态：三种来源互斥，优先级 图片 > 自定义字符 > 预设 */
let iconState = { preset: 'app', char: '', path: '' };

/* 用户是否手动挑过图标。为 true 时，"选择 exe 后自动提取图标"不再覆盖，
 * 否则用户精心选的图会被一次路径选择冲掉。 */
let iconUserPicked = false;

/* ---------- 预览模式的调色板近似算法 ----------
 * 真机一律由主进程用 Monet（QuantizerCelebi + Score + SchemeTonalSpot）派生 tonal
 * 角色；浏览器预览模式没有主进程，也不值得为了"看一眼界面"去加载 232KB 的 Monet
 * 包。这里用 HSL 近似：源色取色相，按 MD3 的 tone 阶梯给每个角色指定饱和/明度。
 *
 * 目的很明确——手动选色之后界面必须真的跟着变色；观感与真机不会完全一致，
 * 所以返回的结果带 `preview: true`，界面上会写明是预览近似色，不冒充真机取色。 */
const PREVIEW_ROLE_TONE = {
  /*           色相偏移  饱和   明度 */
  primary:      [0, 0.52, 0.40], onPrimary: [0, 0.60, 1.00],
  primaryContainer: [0, 0.60, 0.90], onPrimaryContainer: [0, 0.66, 0.15],
  secondary:    [-8, 0.22, 0.40], onSecondary: [0, 0.30, 1.00],
  secondaryContainer: [-8, 0.26, 0.86], onSecondaryContainer: [-8, 0.32, 0.16],
  tertiary:     [60, 0.34, 0.40], onTertiary: [0, 0.30, 1.00],
  tertiaryContainer: [60, 0.46, 0.90], onTertiaryContainer: [60, 0.46, 0.16],
  surface:      [0, 0.32, 0.99], surfaceDim: [0, 0.10, 0.87],
  surfaceContainer: [0, 0.24, 0.95], surfaceContainerHigh: [0, 0.16, 0.90],
  onSurface:    [0, 0.12, 0.11], onSurfaceVariant: [0, 0.08, 0.30],
  outline:      [0, 0.05, 0.47], outlineVariant: [0, 0.07, 0.79],
  /* error 不跟源色走（null = 用固定红相 25） */
  error:        [null, 0.66, 0.40], onError: [0, 0.60, 1.00]
};
const PREVIEW_SOURCE = '#6750A4';

function hexToHsl(hex) {
  const t = hexToRgbTriplet(hex);
  if (!t) return null;
  const [r0, g0, b0] = t.split(' ').map((n) => Number(n) / 255);
  const mx = Math.max(r0, g0, b0), mn = Math.min(r0, g0, b0), d = mx - mn;
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r0) h = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) / 6;
    else if (mx === g0) h = ((b0 - r0) / d + 2) / 6;
    else h = ((r0 - g0) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hslToHex(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0) => {
    const t = (t0 + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return '#' + to(f(hh + 1 / 3)) + to(f(hh)) + to(f(hh - 1 / 3));
}

function previewPalette(hex) {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  const h = hsl[0];
  const out = { dynamic: true, source: String(hex).toLowerCase(), preview: true };
  Object.keys(PREVIEW_ROLE_TONE).forEach((role) => {
    const [shift, s, l] = PREVIEW_ROLE_TONE[role];
    out[role] = hslToHex(shift === null ? 25 : h + shift, s, l);
  });
  return out;
}

/* ---------- 运行环境兼容层 ----------
 * 在 Electron 中走真实 IPC；在普通浏览器中走本地 mock，
 * 这样双击 index.html 也能预览界面与交互。 */
const PREVIEW_MODE = !window.widgetAPI;   // 双击 index.html 预览 / smoke-test 的 jsdom 环境
const API = window.widgetAPI || (function () {
  const KEY = 'desktop-widget-config';
  const def = {
    title: 'FClassPal', width: 480, height: 420, x: 100, y: 100, opacity: 0.92,
    alwaysOnTop: false, keepBottom: true, autoLaunch: false, locked: false,
    /* 与 main.js 的 DEFAULT_CONFIG 对齐；缺了这几项预览模式开场就是 undefined，
     * 设置面板会读出一堆空值（风格按钮、取色器） */
    theme: 'glass', colorMode: 'auto', accentColor: PREVIEW_SOURCE, accentPicked: false,
    cornerRadius: null,
    /* 与 main.js 的首次启动种子一致：只有一个空的「希沃应用」分组 */
    groups: [
      { id: 'g1', name: '希沃应用', items: [] }
    ]
  };
  let cfg = null;
  return {
    async getConfig() { try { cfg = JSON.parse(localStorage.getItem(KEY)) || def; } catch { cfg = def; } return cfg; },
    async saveConfig(c) {
      cfg = c; localStorage.setItem(KEY, JSON.stringify(c));
      // 透明度只驱动"玻璃表面层"（.glass-veil 的 --glass-alpha），
      // 前景文字/图标始终不透明、可读。
      widget.style.setProperty('--glass-alpha', c.opacity ?? 0.55);
      return true;
    },
    async openTarget(it) {
      if (it.type === 'web') window.open(it.target, '_blank');
      else alert('预览模式：将打开 ' + it.target);
      return { success: true };
    },
    selectFile: () => Promise.resolve('C:\\Demo\\示例文件.txt'),
    selectApp: () => Promise.resolve('C:\\Program Files\\Demo\\App.exe'),
    // 文件夹走独立通道（Windows 的 openFile 对话框选不到目录）
    selectFolder: () => Promise.resolve('C:\\Demo\\示例文件夹'),
    // 预览模式：返回示例图片，便于验证自定义图片图标的渲染
    selectImage: () => Promise.resolve({ path: 'demo', url: DEMO_ICON }),
    getEnv: () => Promise.resolve({ transparent: true, platform: 'browser', release: '0' }),
    // 预览模式取不到真实壁纸：返回 null，让 #envLayer 用内置渐变基底，
    // MD3 则退回 CSS 里的 baseline 配色
    getWallpaper: () => Promise.resolve(null),
    onWallpaperChanged: () => () => {},
    // 预览取色：本地 HSL 近似派生（真机走主进程 Monet）。
    // 之前这里恒返回 null，导致"预览模式下手动选色完全没反应"——手动选色的
    // 反馈是这套控件存在的唯一理由，预览模式也必须能看见颜色变化。
    getPalette: (patch) => {
      const manual = patch && patch.colorMode === 'manual';
      const src = manual && patch.accentColor ? patch.accentColor : PREVIEW_SOURCE;
      return Promise.resolve(previewPalette(src));
    },
    // 预览模式（file:// 双击打开）没有 Electron 主进程，无法采集桌面。
    // startRealtime 返回 null → 渲染层静默退回静态基底，不会报错也不会白屏。
    startRealtime: () => Promise.resolve(null),
    stopRealtime: () => Promise.resolve(true),
    getDisplayInfo: () => Promise.resolve(null),
    // 预览模式无法调用系统 API 提取 exe 图标，返回示例图便于验证渲染链路
    getFileIcon: () => Promise.resolve({ path: 'demo', url: DEMO_ICON }),
    // 预览模式造一个示例 U 盘，便于查看 U 盘区域的排版
    getUsbDrives: () => Promise.resolve([
      { letter: 'G', name: '教学资料', size: 32000000000, free: 12800000000 }
    ]),
    openDrive: (l) => { alert('预览模式：将打开 ' + l + ':\\'); return Promise.resolve({ success: true }); },
    ejectDrive: (l) => { alert('预览模式：将安全弹出 ' + l + ':'); return Promise.resolve({ success: true }); },
    ejectDriveElevated: (l) => { alert('预览模式：将以管理员身份弹出 ' + l + ':'); return Promise.resolve({ success: true }); },
    onUsbChange: () => () => {},
    onBoundsChanged: () => () => {},
    hideWindow: () => alert('预览模式：已隐藏到托盘'),
    close: () => { if (confirm('预览模式：关闭窗口？')) window.close(); },
    setKeepBottom: () => {},
    setAutoLaunch: () => Promise.resolve({ success: true }),
    setLocked: () => Promise.resolve({ success: true }),
    moveWindow: (x, y) => {
      widget.style.position = 'absolute';
      widget.style.left = x + 'px';
      widget.style.top = y + 'px';
    },
    setDragging: () => {},
    setBounds: (b) => {
      widget.style.position = 'absolute';
      widget.style.left = b.x + 'px';
      widget.style.top = b.y + 'px';
      widget.style.width = b.width + 'px';
      widget.style.height = b.height + 'px';
      widget.style.setProperty('--glass-alpha', cfg ? cfg.opacity : 0.55);
      return Promise.resolve(true);
    }
  };
})();

// DOM
const $ = (id) => document.getElementById(id);
const widget = $('widget');
const groupsEl = $('groups');
const titleInput = $('titleInput');
const opacityBar = $('opacityBar');
const opacityRange = $('opacityRange');
const ctxMenu = $('ctxMenu');

/* ---------- 界面风格（v2.0 起共 6 套，彼此完全独立） ----------
 * 'glass'   = 液态玻璃（折射 + 边光 + 高光渐变），唯一非平面系
 * 'md3'     = Material Design 3 / Material You（tonal 平面 + state layer + ripple）
 * 'fluent'  = Microsoft Fluent / Win11（亚克力 + 噪点 + Reveal 高光 + 底部强调条）
 * 'miuix'   = 小米 MIUIX / HyperOS（超大圆角 + 彩色渐变表面 + 回弹动效）
 * 'harmony' = 华为 HarmonyOS（中性表面 + 胶囊按钮 + 主色焦点环）
 * 'kitty'   = Hello Kitty（粉白奶油 + 蝴蝶结/爱心 + 圆润弹跳）
 * 每套风格在 style.css 里是**完整的自足设计系统**（自己一套 token 与全部表面规则），
 * 不存在"共底"：改一套不会牵动另一套。共同点只有配色来源 —— 都由主进程把
 * 壁纸（Monet）或用户手选色派生成一套 tonal 角色变量（--md3-*），
 * 各主题从中挑不同角色当强调色（MD3/Fluent/Harmony 用 primary、
 * MIUI 用 primary→tertiary 渐变、Kitty 用 tertiary 的粉调），
 * 所以同一个源色在不同主题下观感并不相同。 */
const THEMES = ['glass', 'md3', 'fluent', 'miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'];
const FLAT_THEMES = THEMES.filter((t) => t !== 'glass');
const THEME_LABEL = {
  glass: '液态玻璃', md3: 'MD3', fluent: 'Fluent',
  miuix: 'MIUI', harmony: '鸿蒙', kitty: 'Hello Kitty', dog: '玉桂狗',
  kuromi: '库洛米', melody: '美乐蒂', sanrio: '三丽鸥混合'
};
/* 每套主题的推荐主色：从「莫奈取色」切到「手动指定」时用它当起点，
 * 这样每套风格一上手就是自己的味道（而不是一律基线紫）。 */
const THEME_ACCENT = {
  glass: '#6750A4', md3: '#6750A4', fluent: '#0B57D0',
  miuix: '#3482FF', harmony: '#0A59F7', kitty: '#C2185B', dog: '#4FA8E8',
  kuromi: '#8E5BC8', melody: '#EC6FA8', sanrio: '#E8548A'
};
/* 固定配色主题：Hello Kitty / 玉桂狗 / 库洛米 / 美乐蒂 / 三丽鸥混合（角色扮演配色）、
 * MIUIX（compose-miuix-ui 规范浅色方案 #3482FF）、鸿蒙（HarmonyOS 品牌蓝 #0A59F7）。
 * 对它们做壁纸取色是无效操作，设置面板里换成提示文案。 */
const FIXED_PALETTE_THEMES = ['kitty', 'dog', 'miuix', 'harmony', 'kuromi', 'melody', 'sanrio'];
const THEME_ACCENT_LIST = Object.keys(THEME_ACCENT).map((k) => THEME_ACCENT[k].toUpperCase());
let currentTheme = 'glass';
/* 用户是否亲手挑过主色。为 false 时，切风格/切手动模式会用该风格的推荐色；
 * 为 true 就一律尊重用户的选择，不再被主题默认值覆盖。 */
let accentPicked = false;

function applyTheme(theme) {
  const t = THEMES.indexOf(theme) >= 0 ? theme : 'glass';
  currentTheme = t;
  FLAT_THEMES.forEach((n) => document.body.classList.toggle('theme-' + n, n === t));
  const sel = $('themeSelect');
  if (sel && sel.value !== t) sel.value = t;
}

/* ---------- MD3 动态配色：把主进程从壁纸提取的 tonal palette 写进 CSS ----------
 * 同时写两份：--md3-primary（直接用）和 --md3-primary-rgb（供 rgb(R G B / A) 用）。
 * 只写 -rgb 会导致纯色场景（background: var(--md3-primary)）拿不到值，
 * 两份都写才不会出现"某些地方变黑/透明"的怪现象。 */
const MD3_ROLES = [
  'primary', 'on-primary', 'primary-container', 'on-primary-container',
  'secondary', 'on-secondary', 'secondary-container', 'on-secondary-container',
  'tertiary', 'on-tertiary', 'tertiary-container', 'on-tertiary-container',
  'surface', 'surface-dim', 'surface-container', 'surface-container-high',
  'on-surface', 'on-surface-variant', 'outline', 'outline-variant',
  'error', 'on-error'
];

function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(' ');
}

function applyPalette(palette) {
  if (!palette || !currentTheme) return;
  const root = document.documentElement;
  MD3_ROLES.forEach((role) => {
    // 调色板里的键是驼峰（primaryContainer），CSS 变量是短横（primary-container）
    const key = role.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const hex = palette[key];
    if (!hex) return;
    root.style.setProperty('--md3-' + role, hex);
    const triplet = hexToRgbTriplet(hex);
    if (triplet) root.style.setProperty('--md3-' + role + '-rgb', triplet);
  });
}

/* ---------- MD3 动效（motion） ----------
 * MD3 的 motion 是"缓动曲线 + 时长档位"两套 token：
 *   easing  standard    = cubic-bezier(.2, 0, 0, 1)        元素进出、形变
 *           emphasize   = cubic-bezier(.2, 0, 0, 1) 的减速/加速变体
 *   duration short1~4 = 50/100/150/200ms、medium1~4 = 250/300/350/400ms、
 *            long1~4  = 450/500/550/600ms
 * CSS 里已把它们写成变量（--md3-dur-* / --md3-ease-*），这里只补 JS 驱动的三种：
 *   ① 列表入场：错峰 stagger（每个元素 18ms 递进，最多 10 个，再多就同步进）
 *   ② 面板/菜单：交给 CSS 动画，但要在 DOM 复用时手动重播（见 motionReplay）
 *   ③ 换风格 / 换主色时的 cross-fade，避免颜色硬跳
 * 另外全部动效都对 `prefers-reduced-motion: reduce` 让路（系统设置里关动画的人不晕）。 */
const MD3_EASE_STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';
const REDUCE_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function motionCrossFade() {
  if (!FLAT_THEMES.includes(currentTheme) || REDUCE_MOTION) return;
  if (!widget.animate) return;
  try {
    widget.animate(
      [{ opacity: 0.6 }, { opacity: 1 }],
      { duration: 260, easing: MD3_EASE_STANDARD }
    );
  } catch (e) { /* 没有 WAAPI 就只是硬切，不影响功能 */ }
}

/** 给一组元素重播入场动画（换风格时才需要：元素本身没被重建） */
function motionReplay(selector) {
  if (!FLAT_THEMES.includes(currentTheme) || REDUCE_MOTION) return;
  const els = document.querySelectorAll(selector);
  if (!els.length) return;
  els.forEach((el) => el.classList.remove('t-enter'));
  void widget.offsetWidth;      // 强制回流，否则连续两次加同名 class 不会重播
  els.forEach((el) => el.classList.add('t-enter'));
}

function motionReflowItems() {
  motionReplay('.item, .usb-item');
}

/** 新建元素时打上错峰序号（stagger 入场靠 CSS 变量 --i 算 delay，
 *  每套主题的步长不同，由 CSS 里的 --t-stagger 决定） */
function staggerIndex(el, i) {
  if (el) el.style.setProperty('--i', String(Math.min(i, 10)));
}

/* ---------- MD3 ripple ----------
 * Material 的标志性交互：按下处扩散的墨点，用 currentColor 上色，
 * 所以 filled 按钮（白字）和 outlined 按钮（主色字）都对。
 * **只有 MD3 用 ripple**：其余风格各有自己的按压语言（MIUI/Kitty 是缩放回弹、
 * Fluent 是 Reveal 高光 + 背景变深、鸿蒙是主色淡底），不该都一样。 */
function spawnRipple(host, e) {
  /* ripple 是 MD3 的按压语言，只在 md3 风格下生成。
   * 其余各套平面风格各有自己的按压表达：MIUI/Kitty/美乐蒂是缩放回弹（:active 带
   * rotate/scale），Fluent 是 Reveal 光斑（--rv-x/--rv-y 跟随指针），
   * 鸿蒙是主色淡底 + 缩放，库洛米是邪气侧倾；玻璃风沿用液态高光。混用会互相打架。 */
  if (currentTheme !== 'md3') return;
  if (!host.classList.contains('ripple-host')) host.classList.add('ripple-host');
  const r = host.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const el = document.createElement('span');
  el.className = 'ripple';
  el.style.width = el.style.height = size + 'px';
  el.style.left = (e.clientX - r.left - size / 2) + 'px';
  el.style.top = (e.clientY - r.top - size / 2) + 'px';
  host.appendChild(el);
  setTimeout(() => el.remove(), 480);
}

/* 只给"看起来像按钮"的元素挂 ripple，用事件委托一次搞定。
 * 注意 .item 不参与：它的删除按钮是绝对定位在卡片外的（top:-7px），
 * 一旦给 .item 加 overflow:hidden 就会把删除按钮裁掉。卡片本身已经有
 * state layer（::before）表达按压，不需要 ripple。 */
document.addEventListener('pointerdown', (e) => {
  if (currentTheme !== 'md3') return;
  const host = e.target.closest &&
    e.target.closest('.usb-btn, .primary-btn, .ghost-btn, .danger-btn, .pick-btn, .text-btn, .ctx-item, .seg-btn, .size-controls button, .panel-close');
  if (host) spawnRipple(host, e);
}, true);

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* 生成内联 SVG 线条图标：<svg class="ic"><use href="#i-xxx"/></svg>
 * 颜色跟随 currentColor，尺寸由外层 CSS 的 .ic 控制。 */
function svgIcon(id, cls) {
  return '<svg class="' + (cls || 'ic') + '" aria-hidden="true"><use href="#' + id + '"/></svg>';
}

let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    widget.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 持久化 ---------- */
let persistTimer;
function persist() {
  config.x = Math.round(bounds.x);
  config.y = Math.round(bounds.y);
  config.width = Math.round(bounds.width);
  config.height = Math.round(bounds.height);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    API.saveConfig(config);
  }, 150);
}

/* ---------- 图标解析：图片 > 自定义字符 > 预设(内联SVG) ---------- */
function resolveIcon(it) {
  if (it.iconPath) return { type: 'img', value: it.iconPath };
  if (it.iconChar) return { type: 'text', value: it.iconChar };
  return { type: 'svg', value: ICONS[it.icon] || 'i-star' };
}

/* ---------- 渲染 ---------- */
function render() {
  titleInput.value = config.title || 'FClassPal';
  groupsEl.innerHTML = '';
  config.groups.forEach((g, gi) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'group';
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = g.name;
    groupEl.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'item-grid';

    g.items.forEach((it, ii) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'item';
      const del = document.createElement('button');
      del.className = 'del-btn';
      del.title = '删除';
      del.innerHTML = svgIcon('i-x');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        g.items.splice(ii, 1);
        persist();
        render();
      });
      const icon = document.createElement('div');
      icon.className = 'item-icon';
      const ic = resolveIcon(it);
      if (ic.type === 'img') {
        const img = document.createElement('img');
        img.src = ic.value;
        img.alt = it.name || '';
        icon.appendChild(img);
      } else if (ic.type === 'svg') {
        icon.innerHTML = svgIcon(ic.value);
      } else {
        icon.textContent = ic.value;
      }
      const name = document.createElement('div');
      name.className = 'item-name';
      name.textContent = it.name;
      itemEl.append(del, icon, name);
      staggerIndex(itemEl, ii);   // 错峰入场（glass 风格下 CSS 不认这个 class）
      itemEl.classList.add('t-enter');
      itemEl.addEventListener('click', () => {
        if (editMode) { openItemModal(gi, ii); return; }  // 编辑模式：点按即编辑
        openItem(it);
      });
      grid.appendChild(itemEl);
    });

    if (editMode) {
      const add = document.createElement('div');
      add.className = 'item add-card';
      add.innerHTML = '<div class="item-icon">' + svgIcon('i-plus') + '</div><div class="item-name">添加</div>';
      add.addEventListener('click', () => openItemModal(gi, null));
      grid.appendChild(add);
    }

    groupEl.appendChild(grid);
    groupsEl.appendChild(groupEl);
  });
}

/* ---------- 打开目标 ---------- */
async function openItem(it) {
  toast('正在打开：' + it.name);
  const res = await API.openTarget(it);
  if (!res.success) toast('打开失败：' + res.error);
}

/* ---------- 窗口移动（鼠标 / 触摸 / 手写笔 统一支持） ----------
 * 触摸屏上不工作的根因：旧方案用 CSS -webkit-app-region: drag 把拖拽
 * 交给系统窗口管理器，但 Windows 触摸输入经常不被 app-region 命中测试
 * 捕获，手指按下后窗口纹丝不动（鼠标正常）。
 * 现在改用 Pointer Events 手动拖拽，三种输入走同一条路：
 *   1. pointerdown 记录起点并 setPointerCapture（手指滑出标题栏也不丢事件）
 *   2. pointermove 只更新坐标，rAF 合并成一帧一次 move-window
 *   3. move-window 是 fire-and-forget（send 而非 invoke），主进程直接
 *      setPosition，不等回复——避免旧版"每次 invoke 排队应答"造成的闪烁
 *   4. 拖动期间 is-moving 关掉折射滤镜（保留模糊）， resize 才全关
 *
 * ※ v1.8 修"拖动会闪"的三个真凶：
 *   ① **用 clientX 算位移会自激振荡** —— clientX 是"相对窗口左上角"的坐标，
 *      窗口一移动它本身就变了。窗口追上指针后 clientX 又回到起点值，算出的
 *      目标位置被拉回原点，下一帧再追…… 表现就是拖动时抖/闪/拖不动。
 *      → 改用 **screenX/screenY**（绝对屏幕坐标，与窗口位置无关）。
 *   ② **主进程 'move' 事件回推 bounds** —— 每次移动都会 debounce 后把
 *      getBounds() 推回来，渲染层再据此刷新壁纸偏移。拖拽中这一记回推会把
 *      正在用的位置改掉。→ 拖拽期间用 setDragging(true) 叫停回推。
 *   ③ **拖拽会拿到焦点 → 置底逻辑立刻 moveBottom()** —— 拖动过程中改 Z 序
 *      会让窗口瞬间沉到其他窗口后面。→ 同样放进 setDragging 期间暂停。
 *
 * ※ v2.2.3 修"触摸拖动会闪、鼠标拖动没事"。鼠标与触摸的差别只有五点，
 *   逐条治掉（下面注释里 ①②③④⑤ 与实现一一对应）：
 *   ① **第二根手指/掌根会把拖拽基准重置**：旧代码 pointerdown 完全不看
 *      pointerId，触屏上多一个接触点就把 dragOrigin/dragStart 重设成当前值，
 *      窗口于是在两个参照系之间来回跳 —— 这是"闪"的第一大来源。
 *      → dragPointerId 锁定主指针：已有手指按着时，新的 pointerdown 直接忽略。
 *   ② **pointercancel 让折射滤镜反复摘戴**：Windows 触摸在"窗口被程序移动"
 *      时会重做命中测试，Chromium 随之可能发 pointercancel。旧代码立刻
 *      endDrag() → is-moving 被摘掉（折射滤镜消失），下一帧又恢复；手指一动
 *      一停就来一轮 = 肉眼看到的闪。→ 改成**软结束**：取消/丢失捕获只排一个
 *      260ms 宽限定时器，期间只要还有位移就无缝续上（重新对齐基准，无跳变），
 *      到点才真正收尾。鼠标路径不变（pointerup 仍然是硬结束，不引入延迟）。
 *   ③ **亚像素抖动**：触摸采样点自带 ±1px 噪声，而主进程 setPosition 会
 *      Math.round；两边差半个像素 → 底材（壁纸快照/实时底图）每帧重采样一次，
 *      表现为细密闪烁。→ 位置按整数落位，同一整数位置不再触发重绘。
 *   ④ **偶发离群采样**：单帧突然给一个很远的坐标会让窗口瞬移再弹回。
 *      → 每帧最多前进 DRAG_MAX_STEP 像素（限制速度而不是丢弃采样，
 *      否则遇到连续大位移会卡死）。
 *   ⑤ **长按菜单插入拖动过程**：触摸"按住 550ms 再拖"很常见，旧代码在拖动
 *      期间照样会把右键/长按菜单弹出来，整屏重绘一次。→ 拖动（含宽限期）内
 *      不武装长按、不响应 contextmenu。 */
let dragging = false, dragRaf = 0;
let dragPointerId = null;      // ① 拖拽主指针（其它 pointerId 一律忽略）
let dragPointerDown = false;   // 主指针是否还按着（软结束判定用）
let dragEndTimer = 0;          // ② 软结束宽限定时器
let dragStartX = 0, dragStartY = 0, dragOriginX = 0, dragOriginY = 0, lastX = 0, lastY = 0;
let dragLastAt = 0;            // 上一次有效位移的时间戳（卡死自救用）
const DRAG_CANCEL_GRACE = 260; // 取消后仍可无缝续拖的时间窗（ms）
const DRAG_MAX_STEP = 240;     // 单帧最大可信位移（px）
const titlebar = $('titlebar');

function applyMove() {
  dragRaf = 0;
  if (!dragging) return;
  // ③ 整数落位：与主进程 setPosition 的 round 对齐，避免底材每帧重采样
  const tx = Math.round(dragOriginX + (lastX - dragStartX));
  const ty = Math.round(dragOriginY + (lastY - dragStartY));
  let nx = tx, ny = ty;
  // ④ 限速：坏采样最多让窗口每帧走 DRAG_MAX_STEP，且不会卡死（下一帧继续逼近）
  const dx = tx - bounds.x, dy = ty - bounds.y;
  if (Math.abs(dx) > DRAG_MAX_STEP) nx = bounds.x + Math.sign(dx) * DRAG_MAX_STEP;
  if (Math.abs(dy) > DRAG_MAX_STEP) ny = bounds.y + Math.sign(dy) * DRAG_MAX_STEP;
  if (nx === bounds.x && ny === bounds.y) return;   // 抖动不到 1px：这一帧不必动
  bounds.x = nx;
  bounds.y = ny;
  if (typeof API.moveWindow === 'function') {
    API.moveWindow(nx, ny);
  } else {
    API.setBounds(bounds);   // 浏览器预览模式
  }
  // 底材跟着窗口走：壁纸快照的位置按屏幕坐标重算，否则拖动期间会"拖着画面跑"，
  // 松手校正的那一刻还会再闪一下。这一步只是改一个 background-position，很便宜。
  repositionWallpaper();
}

titlebar.addEventListener('pointerdown', (e) => {
  if (e.target.closest('input, button, select')) return;
  if (titleInput.classList.contains('editable')) return;
  if (config && config.locked) return;
  // ① 已经有一根手指在拖 → 忽略新的接触点（掌根/第二指不再重置基准）
  if (dragPointerDown) {
    // 卡死自救：万一旧指针的 pointerup 被系统吞掉（触摸序列异常），
    // 静止 1.5s 后又来新的按下 → 认定上一轮已是脏状态，直接重启拖拽。
    if (Date.now() - dragLastAt < 1500) return;
    endDrag();
  }
  if (dragEndTimer) { clearTimeout(dragEndTimer); dragEndTimer = 0; }
  dragging = true;
  dragPointerId = e.pointerId;
  dragPointerDown = true;
  dragLastAt = Date.now();
  // 屏幕坐标：不随窗口自身位移而变，拖拽才能真正"指哪走哪"
  dragStartX = lastX = e.screenX;
  dragStartY = lastY = e.screenY;
  // 基准取"窗口当前实际位置"：无论是新开始还是取消后续上，都不会产生跳变
  dragOriginX = bounds.x;
  dragOriginY = bounds.y;
  cancelLp();                    // ⑤ 拖动期间不弹长按菜单
  document.body.classList.add('is-moving');
  if (typeof API.setDragging === 'function') API.setDragging(true);
  try { titlebar.setPointerCapture(e.pointerId); } catch (_) {}
});
titlebar.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragPointerId) return;
  // 鼠标的悬停移动（未按左键）不算拖拽，别把已结束的拖拽续上
  if (e.pointerType === 'mouse' && e.buttons === 0) return;
  if (dragEndTimer) {            // ② 宽限期内又来了位移 → 无缝续上，不摘滤镜
    clearTimeout(dragEndTimer); dragEndTimer = 0; dragPointerDown = true;
  }
  lastX = e.screenX; lastY = e.screenY;
  dragLastAt = Date.now();
  if (!dragRaf) dragRaf = requestAnimationFrame(applyMove);  // 一帧最多一次
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  dragPointerId = null;
  dragPointerDown = false;
  if (dragEndTimer) { clearTimeout(dragEndTimer); dragEndTimer = 0; }
  if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
  document.body.classList.remove('is-moving');
  if (typeof API.setDragging === 'function') API.setDragging(false);
  persist();
};
/* ② 软结束：cancel / 丢失捕获可能只是系统重做命中测试造成的一过性事件，
 *    先按住不动，宽限期内有新的位移就继续拖，到点才真收尾（避免滤镜反复摘戴）。 */
const softEndDrag = () => {
  if (!dragging) return;
  dragPointerDown = false;
  if (dragEndTimer) clearTimeout(dragEndTimer);
  dragEndTimer = setTimeout(() => { dragEndTimer = 0; endDrag(); }, DRAG_CANCEL_GRACE);
};
// ②-① 事件只认主指针：别的 pointerId 的 up/cancel 不能打断正在进行的拖拽
titlebar.addEventListener('pointerup', (e) => {
  if (e.pointerId !== dragPointerId) return;
  endDrag();
});
titlebar.addEventListener('pointercancel', (e) => {
  if (e.pointerId !== dragPointerId) return;
  softEndDrag();
});
titlebar.addEventListener('lostpointercapture', (e) => {
  if (e.pointerId !== undefined && e.pointerId !== dragPointerId) return;
  softEndDrag();
});

/* ---------- 缩放 ----------
 * 同理用 rAF 合并：pointermove 每秒可达上百次，逐次 IPC 会让尺寸在
 * 排队消息间抖动。合并成每帧一次后拖动边缘就是连续的。 */
let resizing = false, rsRaf = 0;
let rsPointerId = null, rsPointerDown = false, rsEndTimer = 0;
let rsStartX = 0, rsStartY = 0, rsW = 0, rsH = 0, rsLastX = 0, rsLastY = 0;
const resizeHandle = $('resizeHandle');

const applyResize = () => {
  rsRaf = 0;
  if (!resizing) return;
  // 整数落位：尺寸同样不要小数，避免每帧重排 + 重新光栅化
  const w = Math.max(MIN_W, Math.round(rsW + (rsLastX - rsStartX)));
  const h = Math.max(MIN_H, Math.round(rsH + (rsLastY - rsStartY)));
  if (w === bounds.width && h === bounds.height) return;
  bounds.width = w;
  bounds.height = h;
  API.setBounds(bounds);
};

resizeHandle.addEventListener('pointerdown', (e) => {
  if (config && config.locked) return;
  e.stopPropagation();
  if (rsPointerDown) return;          // 同一根手指之外的第二触点忽略（同拖动①）
  if (rsEndTimer) { clearTimeout(rsEndTimer); rsEndTimer = 0; }
  resizing = true;
  rsPointerId = e.pointerId;
  rsPointerDown = true;
  // 同理用屏幕坐标：与主窗口几何无关，不会形成反馈回路
  rsStartX = rsLastX = e.screenX;
  rsStartY = rsLastY = e.screenY;
  rsW = bounds.width;
  rsH = bounds.height;
  cancelLp();                          // 缩放期间不弹长按菜单
  // is-resizing 会把毛玻璃整个摘掉（缩放会重算图层，代价远高于平移），
  // is-moving 只摘折射滤镜。两个 class 分开，观感才不会"一按就掉画质"。
  document.body.classList.add('is-moving', 'is-resizing');
  if (typeof API.setDragging === 'function') API.setDragging(true);
  try { resizeHandle.setPointerCapture(e.pointerId); } catch (_) {}
});
resizeHandle.addEventListener('pointermove', (e) => {
  if (!resizing || e.pointerId !== rsPointerId) return;
  if (e.pointerType === 'mouse' && e.buttons === 0) return;
  if (rsEndTimer) { clearTimeout(rsEndTimer); rsEndTimer = 0; rsPointerDown = true; }
  rsLastX = e.screenX;
  rsLastY = e.screenY;
  if (!rsRaf) rsRaf = requestAnimationFrame(applyResize);
});
const endResize = () => {
  if (!resizing) return;
  resizing = false;
  rsPointerId = null;
  rsPointerDown = false;
  if (rsEndTimer) { clearTimeout(rsEndTimer); rsEndTimer = 0; }
  if (rsRaf) { cancelAnimationFrame(rsRaf); rsRaf = 0; }
  document.body.classList.remove('is-moving', 'is-resizing');
  if (typeof API.setDragging === 'function') API.setDragging(false);
  persist();
  refreshWallpaper();   // 尺寸变了：壁纸相对偏移要重算（函数声明会提升，可安全前置调用）
  refreshRealtimeBounds();   // canvas 后备分辨率跟着窗口尺寸变，必须重画
};
/* 与拖动同样的软结束：缩放中的一过性 cancel 不该让毛玻璃闪一下又回来 */
const softEndResize = () => {
  if (!resizing) return;
  rsPointerDown = false;
  if (rsEndTimer) clearTimeout(rsEndTimer);
  rsEndTimer = setTimeout(() => { rsEndTimer = 0; endResize(); }, DRAG_CANCEL_GRACE);
};
resizeHandle.addEventListener('pointerup', (e) => {
  if (e.pointerId !== rsPointerId) return;
  endResize();
});
resizeHandle.addEventListener('pointercancel', (e) => {
  if (e.pointerId !== rsPointerId) return;
  softEndResize();
});
resizeHandle.addEventListener('lostpointercapture', (e) => {
  if (e.pointerId !== undefined && e.pointerId !== rsPointerId) return;
  softEndResize();
});

/* ---------- 同步主进程回推的真实窗口位置 ----------
 * 原生拖拽由系统完成，渲染层拿不到新坐标。若不同步，下次保存配置时
 * 渲染层会用过期 bounds 把窗口"拽回"旧位置。 */
if (typeof API.onBoundsChanged === 'function') {
  API.onBoundsChanged((b) => {
    if (!b || !config) return;
    bounds.x = b.x; bounds.y = b.y;
    bounds.width = b.width; bounds.height = b.height;
    config.x = b.x; config.y = b.y;
    config.width = b.width; config.height = b.height;
    refreshWallpaper();   // 窗口挪了：壁纸相对偏移要跟着重算，否则会"跟着窗口飘"
    refreshRealtimeBounds();   // 实时底材：立刻补一帧，并按需刷新显示器几何
  });
}

/* ---------- 鼠标光感：sheen 光斑跟随 ----------
 * 光斑只跟"鼠标"（pointerType=mouse），触摸不产生——触摸拖动窗口时
 * 屏幕上不该出现光点，也避免触摸设备资源浪费。
 * 位置写入 transform（合成器移动），rAF 一帧最多更新一次。 */
const sheen = $('sheen');
if (sheen) {
  let sheenRaf = 0;
  const SHEEN_R = 170;   // 与 CSS .sheen 的 340px/2 一致
  widget.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const x = e.clientX, y = e.clientY;
    const hit = e.target && e.target.closest ? e.target.closest('.item') : null;
    if (!sheenRaf) {
      sheenRaf = requestAnimationFrame(() => {
        sheenRaf = 0;
        const r = widget.getBoundingClientRect();
        sheen.style.transform =
          'translate3d(' + Math.round(x - r.left - SHEEN_R) + 'px,' +
          Math.round(y - r.top - SHEEN_R) + 'px,0)';
        // 液态玻璃边光环：角度与亮度跟随鼠标（角度在 JS 算好再写，
        // CSS 的 calc(135deg + -0.5 * 28deg) 符号解析不合法，不能写进样式表）
        const nx = Math.max(-1, Math.min(1, ((x - r.left) / Math.max(1, r.width)) * 2 - 1));
        const ny = Math.max(-1, Math.min(1, ((y - r.top) / Math.max(1, r.height)) * 2 - 1));
        widget.style.setProperty('--lg-angle', (135 + nx * 30).toFixed(1) + 'deg');
        widget.style.setProperty('--lg-glow', Math.min(1, Math.hypot(nx, ny)).toFixed(3));
        // Reveal/光感高光：光点跟着鼠标在卡片里的相对位置走。
        // fluent（Reveal 光斑）、miuix（指针柔光）、harmony（沉浸光感光带）都读它。
        if (hit) {
          const rr = hit.getBoundingClientRect();
          hit.style.setProperty('--rv-x', (((x - rr.left) / Math.max(1, rr.width)) * 100).toFixed(1) + '%');
          hit.style.setProperty('--rv-y', (((y - rr.top) / Math.max(1, rr.height)) * 100).toFixed(1) + '%');
        }
      });
    }
    document.body.classList.add('glow');
  });
  const dimSheen = () => document.body.classList.remove('glow');
  widget.addEventListener('pointerleave', dimSheen);
  window.addEventListener('blur', dimSheen);   // 窗口失焦时熄灭，避免光斑悬停残留
}

/* ---------- 液态玻璃折射（liquid-glass-react standard 模式） ----------
 * 方向场来自预烘焙的置换贴图（renderer/lg-displacement-map.js，256×256 JPEG），
 * 由 SVG 滤镜里的 feImage 载入 —— 与参考实现 src/index.tsx 的 GlassFilter 一致。
 *
 * 之前这里写的注释"Chromium 不渲染 feImage，贴图那条路是死的"是**错的**，
 * 已用 A/B 截图证伪：开/关滤镜两张图在玻璃中心区均值差 0.00 / 0% 像素变化，
 * 上边带 102 / 72%，左边带 168 / 95%，玻璃外 0.03 / 0%。若 feImage 真的是空操作，
 * feDisplacementMap 会退化成整块平移 35px，中心不可能纹丝不动。
 *
 * 真正让折射一直看不见的是另一件事：url() 写进了 backdrop-filter。Chromium 不认
 * backdrop-filter 里的 url()，一个不合法的函数会让**整条声明作废**，于是 blur 和
 * 折射一起没了（剩下的模糊来自别处，看起来像"只有模糊没有折射"）。
 * 正确写法见 style.css：backdrop-filter 只管 blur/saturate，filter 单独写
 * url(#liquidGlass)，两个属性挂同一个空的 .glass-warp 层。
 *
 * 所以这里的探测也必须跟着改成 filter，不能再探 backdrop-filter。 */
function enableLiquidGlass() {
  try {
    if (!document.getElementById('liquidGlass')) return;
    // 把贴图 dataURL 填进 feImage 的 href。HTML 里留空是刻意的：
    // 内联 6KB base64 会让 index.html 难以 diff，且 JS 侧还能顺手判空兜底。
    const map = document.getElementById('lgMap');
    if (!map) return;
    const url = window.LG_DISPLACEMENT_MAP;
    if (!url) return;                       // 贴图没加载 → 保持普通毛玻璃
    map.setAttribute('href', url);
    // 同时写 xlink:href：老一点的 SVG 解析路径只认这个
    map.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return;
    if (!CSS.supports('filter', 'url(#liquidGlass)')) return;
    document.body.classList.add('lg-ready');
  } catch (e) { /* 探测失败就维持普通玻璃观感 */ }
}

/* ---------- 折射基底：把桌面壁纸按屏幕坐标画进 #envLayer ----------
 * 为什么需要：mica 是 DWM 在窗口外画的位图层，Chromium 的 backdrop-filter
 * 看不到它；而 .glass-warp 的 backdrop 又被 isolation 限制在 widget 内部。
 * 结果就是"滤镜挂上了、参数也对，但对着空白合成，什么都看不见"。
 *
 * 所以把壁纸按屏幕坐标在 widget 内再画一遍当基底：位置对齐后，玻璃里折射的
 * 内容与真实桌面完全一致。另外它必须有"结构"（边界/细节）——实测同一套滤镜
 * 作用在缓变渐变上像素差为 0，作用在有结构的图案上是 5.1，因为位移 ±70px
 * 对缓变场的采样值几乎不变。壁纸天生带结构，正是最好的基底。
 *
 * 取不到壁纸（纯色桌面 / 非 Windows / 读注册表失败）时静默保留内置渐变。 */
let wallInfo = null;

function applyWallpaper(info) {
  const env = document.getElementById('envLayer');
  if (!env || !info || !info.url) return false;
  wallInfo = info;
  applyPalette(info.palette);   // MD3：配色跟着这张壁纸走
  describePalette(info.palette);
  env.style.backgroundImage = 'url("' + info.url + '")';
  env.style.backgroundSize = info.w + 'px ' + info.h + 'px';
  env.style.backgroundRepeat = info.tile ? 'repeat' : 'no-repeat';
  env.classList.add('has-wallpaper');
  // 优先用 ax/ay + 当前 widget 坐标换算偏移 —— info.x/y 是 IPC 那一刻的窗口位置算的，
  // 网络/异步回来时窗口可能已经挪了。仅在 mock（预览模式）下没有 ax/ay 时回退到 x/y。
  if (typeof info.ax === 'number') {
    repositionWallpaper();
  } else {
    env.style.backgroundPosition = info.x + 'px ' + info.y + 'px';
  }
  return true;
}

/* 把"壁纸相对窗口的偏移"按当前窗口位置重新写入。仅改一帧 CSS，不走 IPC、
 * 不读注册表，拖动时一帧多次也吃得消。
 *
 * 坐标空间务必用 bounds（屏幕坐标）而不是 getBoundingClientRect()：后者返回的是
 * 页面坐标（原点在窗口左上角），跟 ax/ay 的屏幕坐标差了一个窗口原点。之前用
 * getBoundingClientRect 算，窗口在屏幕 (1469,690) 时算出来是 "0 -100"，而主进程
 * 给的正确值是 "-1469 -790" —— 偏移整整差了一个窗口位置，玻璃里显示的是壁纸的
 * 另一块区域（好在壁纸处处有结构，折射仍然可见，所以肉眼没立刻发现）。 */
function repositionWallpaper() {
  const env = document.getElementById('envLayer');
  if (!env || !wallInfo || typeof wallInfo.ax !== 'number') return;
  env.style.backgroundPosition =
    (wallInfo.ax - bounds.x).toFixed(1) + 'px ' +
    (wallInfo.ay - bounds.y).toFixed(1) + 'px';
}

/* 窗口移动/缩放时把"壁纸偏移"跟着重算。
 *
 * 关键决定：用 setTimeout(0) 而不是 requestAnimationFrame 做合并节流 —— 因为
 * BrowserWindow 在 show:false 或渲染管线尚未合成时 rAF 不触发（_lgwall 这种
 * 自动化探针在主进程里跑时就被坑过一次），而我们要"无论窗口可不可见都得能跑"。
 *
 * 如果 wallInfo 已经加载（ax/ay 已存在），就跳过 IPC 直接走本地换算；只有真正
 * 缺数据时才打到主进程去读注册表 + 截屏。 */
let wallTimer = 0;
/** @param {boolean} force true = 强制回主进程重取（换壁纸时用），
 *                         false = 已有数据就本地换算偏移，不打扰主进程 */
function refreshWallpaper(force) {
  if (typeof API.getWallpaper !== 'function') return;
  if (!force && wallInfo && typeof wallInfo.ax === 'number') { repositionWallpaper(); return; }
  if (wallTimer) return;
  wallTimer = setTimeout(() => {
    wallTimer = 0;
    Promise.resolve(API.getWallpaper())
      .then((info) => { if (info) applyWallpaper(info); })
      .catch(() => { /* 取不到就保持当前基底 */ });
  }, 16);
}

/* 换壁纸同步：主进程轮询注册表 + 文件 mtime，变了就推一份新的壁纸信息过来。
 * 静态基底最怕的就是"开窗那一刻冻结"，这里补上更新通道。 */
if (typeof API.onWallpaperChanged === 'function') {
  API.onWallpaperChanged((info) => {
    if (!info) return;
    applyWallpaper(info);
  });
}

/* ---------- 实时玻璃底材：把真实桌面按屏幕坐标画进 #deskCanvas ----------
 * 静态壁纸基底解决的是"折射有东西可弯"，但解决不了"模糊不是实时的" ——
 * 壁纸快照在窗口打开那一刻就定死了，底下开着视频、拖着窗口，玻璃里都不会变。
 *
 * 真正的实时底材只能来自屏幕采集。链路：
 *   主进程 realtime-start  → 注册 getDisplayMedia 放行 + 把本窗口从采集中排除
 *                            + 回传窗口所在显示器的几何与缩放
 *   渲染进程 getDisplayMedia → <video> → 每帧 drawImage 裁出窗口矩形 → canvas
 * canvas 铺在 .env-layer 里，于是 .glass-warp 的 backdrop-filter 采样的就是
 * 真桌面像素 —— 桌面在动，玻璃里就跟着动。
 *
 * 采集拿不到（权限 / 无 device / 预览模式 / 老 Electron）时静默退回静态壁纸基底，
 * 界面与之前完全一致，不会出现"半截玻璃"。 */
const RT_FPS = 15;
const rt = { on: false, stream: null, video: null, ctx: null, info: null, raf: 0, last: 0, infoAt: 0 };

/* Chromium 的 getDisplayMedia 在部分版本/策略下要求"瞬时用户激活"。
 * 我们在启动时（没有任何手势）就调它，可能被直接拒绝 —— 那时不该就此后退。
 * 策略：失败一次就挂个一次性监听，用户第一次碰窗口再试一次；而且每次只挂一个，
 * 不会变成重试风暴。 */
let rtRetryArmed = false;
function armRealtimeRetry() {
  if (rtRetryArmed) return;
  rtRetryArmed = true;
  const once = () => {
    window.removeEventListener('pointerdown', once, true);
    window.removeEventListener('keydown', once, true);
    if (!rt.on && config && config.realtime !== false) {
      startRealtimeBackdrop().catch(() => { /* 再失败就彻底留在静态基底 */ });
    }
  };
  window.addEventListener('pointerdown', once, true);
  window.addEventListener('keydown', once, true);
}

function stopRealtimeBackdrop() {
  rt.on = false;
  if (rt.raf) { cancelAnimationFrame(rt.raf); rt.raf = 0; }
  if (rt.video) { try { rt.video.pause(); } catch (e) { /* 忽略 */ } rt.video.srcObject = null; rt.video = null; }
  if (rt.stream) {
    try { rt.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* 忽略 */ }
    rt.stream = null;
  }
  rt.ctx = null;
  document.body.classList.remove('realtime');
  if (typeof API.stopRealtime === 'function') {
    Promise.resolve(API.stopRealtime()).catch(() => {});
  }
  updateRealtimeInfo('已关闭（静态壁纸）', 'no');
}

async function startRealtimeBackdrop() {
  const canvas = document.getElementById('deskCanvas');
  if (!canvas) return false;
  if (typeof API.startRealtime !== 'function') return false;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') return false;
  try {
    // ① 主进程放行采集 + 自拍排除 + 回传显示器几何
    const info = await API.startRealtime();
    if (!info) { updateRealtimeInfo('不可用（静态壁纸）', 'no'); return false; }
    rt.info = info;
    rt.infoAt = Date.now();

    // ② 拿屏幕流。frameRate 压到 15：桌面底材不需要 60fps，省电也省 GPU
    rt.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: RT_FPS, max: 24 } },
      audio: false
    });
    const track = rt.stream.getVideoTracks()[0];
    if (!track) { stopRealtimeBackdrop(); return false; }

    rt.video = document.createElement('video');
    rt.video.muted = true;
    rt.video.playsInline = true;
    rt.video.srcObject = rt.stream;
    await rt.video.play();

    rt.ctx = canvas.getContext('2d');
    rt.on = true;
    // 采集被系统掐断（显示器拔了 / 权限回收 / 会话切换）→ 干净地退回静态底材
    track.addEventListener('ended', () => stopRealtimeBackdrop());
    document.body.classList.add('realtime');
    updateRealtimeInfo('实时桌面', 'ok');
    rt.raf = requestAnimationFrame(rtLoop);
    return true;
  } catch (e) {
    // 用户/系统拒绝了采集：退回静态基底，不打扰用户。
    // 顺手挂个一次性重试 —— 若是"缺用户手势"导致的拒绝，用户碰一下窗口就能起来。
    stopRealtimeBackdropQuiet();
    updateRealtimeInfo('不可用（静态壁纸）', 'no');
    armRealtimeRetry();
    return false;
  }
}

/* 采集失败时收尾但**不**再调 IPC 的 stop（没成功过，没必要解除内容保护） */
function stopRealtimeBackdropQuiet() {
  rt.on = false;
  if (rt.raf) { cancelAnimationFrame(rt.raf); rt.raf = 0; }
  if (rt.video) { try { rt.video.pause(); } catch (e) { /* 忽略 */ } rt.video.srcObject = null; rt.video = null; }
  if (rt.stream) {
    try { rt.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* 忽略 */ }
    rt.stream = null;
  }
  rt.ctx = null;
  document.body.classList.remove('realtime');
}

/* 把视频帧里"窗口矩形"那一块裁出来铺满 canvas。
 * 坐标系：info.x/y 是显示器左上角（DIP），bounds 也是 DIP，
 * 乘 scaleFactor 换算到物理像素；canvas 后备分辨率同样取物理像素 → 1:1 不糊。 */
function drawRealtimeFrame() {
  if (!rt.on || !rt.ctx || !rt.video || !rt.info) return;
  if (rt.video.readyState < 2) return;
  const vw = rt.video.videoWidth, vh = rt.video.videoHeight;
  if (!vw || !vh) return;

  const s = rt.info.scaleFactor || 1;
  const bw = Math.max(1, Math.round(bounds.width * s));
  const bh = Math.max(1, Math.round(bounds.height * s));
  const canvas = document.getElementById('deskCanvas');
  if (!canvas) return;
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }

  // 浏览器可能给的是降采样后的流（4K 屏只给 1080p），用实测分辨率再校一次比例
  const kx = vw / Math.max(1, rt.info.w * s);
  const ky = vh / Math.max(1, rt.info.h * s);
  const sx = Math.max(0, Math.min(vw - 1, (bounds.x - rt.info.x) * s * kx));
  const sy = Math.max(0, Math.min(vh - 1, (bounds.y - rt.info.y) * s * ky));
  const sw = Math.max(1, Math.min(vw - sx, bounds.width * s * kx));
  const sh = Math.max(1, Math.min(vh - sy, bounds.height * s * ky));
  rt.ctx.drawImage(rt.video, sx, sy, sw, sh, 0, 0, bw, bh);
}

function rtLoop(ts) {
  if (!rt.on) return;
  rt.raf = requestAnimationFrame(rtLoop);
  if (document.hidden) return;                 // 窗口藏在托盘：rAF 本来也不跑，双保险
  if (ts - rt.last < 1000 / RT_FPS) return;    // 15fps 足够，60fps 纯属浪费
  rt.last = ts;
  drawRealtimeFrame();
}

/* 窗口挪动/缩放后立刻补一帧，否则要等下一个节流窗口才对齐（拖动时会有"滞后感"）。
 * 顺便每 800ms 重新拉一次显示器几何 —— 跨屏拖动 / 改了缩放比例时要用新值。 */
let rtInfoTimer = 0;
function refreshRealtimeBounds() {
  if (!rt.on) return;
  drawRealtimeFrame();
  if (rtInfoTimer) return;
  rtInfoTimer = setTimeout(() => {
    rtInfoTimer = 0;
    if (!rt.on || typeof API.getDisplayInfo !== 'function') return;
    Promise.resolve(API.getDisplayInfo())
      .then((info) => { if (info) { rt.info = info; drawRealtimeFrame(); } })
      .catch(() => { /* 拉不到就继续用旧值 */ });
  }, 800);
}

function updateRealtimeInfo(text, cls) {
  const el = document.getElementById('realtimeInfo');
  if (!el) return;
  el.textContent = text;
  el.className = 'val blur-info ' + (cls || '');
}

/* ---------- 透明度 ---------- */
let hideTimer;
function showOpacityBar() {
  if (editMode) return;
  opacityBar.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => opacityBar.classList.remove('show'), 2800);
}
widget.addEventListener('mouseenter', showOpacityBar);
widget.addEventListener('mousemove', showOpacityBar);
widget.addEventListener('mouseleave', () => opacityBar.classList.remove('show'));

function applyOpacity(v) {
  v = Math.min(1, Math.max(0, v));
  config.opacity = v;
  // 直接驱动玻璃背景层 CSS 变量（不依赖 IPC 回写，
  // 旧实现只 saveConfig 是不够的：主进程已停用 setOpacity）。
  widget.style.setProperty('--glass-alpha', v);
  API.saveConfig(config);
  opacityRange.value = v;
  $('setOpacity').value = v;
  $('opacityVal').textContent = Math.round(v * 100) + '%';
}
opacityRange.addEventListener('input', (e) => applyOpacity(parseFloat(e.target.value)));

/* ---------- 圆角弧度（v2.2.2）----------
 * 只调"主界面外轮廓"：--radius（.widget 本体）与 --t-r-win（面板/U盘区等
 * 窗级圆角随动）。卡片/控件半径仍由各主题自己的 token 决定。
 * config.cornerRadius = null 表示"跟随主题"（不写内联变量）。 */
function applyRadius(px, persist) {
  const v = (typeof px === 'number' && !isNaN(px)) ? Math.round(px) : null;
  config.cornerRadius = (v && v >= 8 && v <= 40) ? v : null;
  if (config.cornerRadius == null) {
    widget.style.removeProperty('--radius');
    widget.style.removeProperty('--t-r-win');
    $('radiusVal').textContent = '跟随主题';
  } else {
    widget.style.setProperty('--radius', config.cornerRadius + 'px');
    widget.style.setProperty('--t-r-win', config.cornerRadius + 'px');
    $('radiusVal').textContent = config.cornerRadius + 'px';
  }
  if (persist !== false) API.saveConfig(config);
}
$('setRadius').addEventListener('input', (e) => applyRadius(parseInt(e.target.value, 10)));

/* ---------- 编辑模式 ---------- */
function toggleEditMode() {
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  if (editMode) {
    titleInput.classList.add('editable');
    titleInput.readOnly = false;
    titleInput.focus();
    titleInput.select();
  } else {
    titleInput.classList.remove('editable');
    titleInput.readOnly = true;
    config.title = titleInput.value.trim() || 'FClassPal';
    persist();
  }
  render();
}
titleInput.addEventListener('blur', () => {
  if (editMode) {
    config.title = titleInput.value.trim() || 'FClassPal';
    persist();
  }
});

/* ---------- 锁定位置 ----------
 * 锁定后：标题栏不可拖（鼠标/触摸都拦）、缩放手柄隐藏、
 * 大小按钮与重置位置禁用；主进程侧还有 setMovable/setResizable 双保险。 */
function applyLocked() {
  const locked = !!(config && config.locked);
  document.body.classList.toggle('locked', locked);
  $('lockBadge').classList.toggle('hidden', !locked);
  const lockItem = ctxMenu.querySelector('[data-act="lock"]');
  if (lockItem) {
    const use = lockItem.querySelector('use');
    if (use) use.setAttribute('href', locked ? '#i-unlock' : '#i-lock');
    const lab = lockItem.querySelector('.ctx-label');
    if (lab) lab.textContent = locked ? '解锁位置' : '锁定位置';
  }
}

function toggleLocked() {
  config.locked = !config.locked;
  if (typeof API.setLocked === 'function') API.setLocked(config.locked);
  applyLocked();
  persist();
  toast(config.locked ? '已锁定：窗口位置和大小不可再改动' : '已解锁，可自由拖动/缩放');
}

/* ---------- 设置面板 ---------- */
function openSettings() {
  $('setTitle').value = config.title || 'FClassPal';
  $('setOpacity').value = config.opacity;
  $('opacityVal').textContent = Math.round(config.opacity * 100) + '%';
  /* 圆角滑块：跟随主题时把滑块摆到当前主题的实际值上（读计算样式） */
  const curRadius = config.cornerRadius ||
    parseInt(getComputedStyle(widget).getPropertyValue('--radius'), 10) || 28;
  $('setRadius').value = curRadius;
  $('radiusVal').textContent = config.cornerRadius ? config.cornerRadius + 'px' : '跟随主题';
  $('setBottom').checked = config.keepBottom !== false;
  $('setAutoLaunch').checked = !!config.autoLaunch;
  $('setLock').checked = !!config.locked;
  $('setRealtime').checked = config.realtime === true;   // 默认"只模糊壁纸"
  $('sizeVal').textContent = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
  syncSettingsControls();
  describePalette(wallInfo && wallInfo.palette);
  $('settingsPanel').classList.remove('hidden');
}

/* 取色控件：**各套风格都能用**（包括液态玻璃）。
 * 之前只在非 glass 主题下显示，结果默认主题是玻璃 → 用户根本找不到选色入口。 */
function syncSettingsControls() {
  const box = $('md3ColorBox');
  /* 取色面板在三套动态配色主题下显示（包括默认的液态玻璃——
   * 旧版只在非 glass 时显示，结果默认主题下用户根本找不到选色入口）。
   * kitty/dog/miuix/harmony 是固定配色主题，取色对它们无效 → 隐藏面板、显示说明，
   * 否则用户会在这里选了色却"没反应"，又变成一次"手动选色用不了"。 */
  const fixed = FIXED_PALETTE_THEMES.indexOf(currentTheme) >= 0;
  if (box) box.classList.toggle('hidden', fixed);
  const hint = $('fixedPaletteHint');
  if (hint) {
    hint.classList.toggle('hidden', !fixed);
    if (fixed) {
      hint.textContent = '「' + (THEME_LABEL[currentTheme] || currentTheme) +
        '」使用官方规范固定配色，不跟壁纸取色。想自定义配色请切回液态玻璃 / MD3 / Fluent。';
    }
  }
  const mode = config.colorMode === 'manual' ? 'manual' : 'auto';
  const seg = $('colorModeSeg');
  if (seg) {
    seg.querySelectorAll('.seg-btn').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
    });
  }
  const manual = mode === 'manual';
  const row = $('manualRow');
  const sw = $('swatches');
  if (row) row.classList.toggle('hidden', !manual);
  if (sw) sw.classList.toggle('hidden', !manual);
  const color = config.accentColor || '#6750A4';
  const input = $('accentColor');
  if (input) input.value = color;
  const hex = $('accentHex');
  if (hex) hex.textContent = color.toUpperCase();
  const want = String(color).toUpperCase();
  if (sw) {
    sw.querySelectorAll('.swatch').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.color || '').toUpperCase() === want ? 'true' : 'false');
    });
  }
}
$('btnSettingsClose').addEventListener('click', () => $('settingsPanel').classList.add('hidden'));

$('setTitle').addEventListener('input', (e) => {
  config.title = e.target.value || 'FClassPal';
  titleInput.value = config.title;
  persist();
});
$('setOpacity').addEventListener('input', (e) => applyOpacity(parseFloat(e.target.value)));
$('setBottom').addEventListener('change', (e) => {
  config.keepBottom = e.target.checked;
  config.alwaysOnTop = false;   // 置顶已弃用
  API.setKeepBottom(config.keepBottom);
  persist();
  toast(config.keepBottom ? '已置底：窗口始终在其他窗口之下' : '已取消置底');
});
$('setAutoLaunch').addEventListener('change', async (e) => {
  const want = e.target.checked;
  let res = { success: true };
  if (typeof API.setAutoLaunch === 'function') {
    try { res = await API.setAutoLaunch(want); } catch (err) { res = { success: false, error: err.message }; }
  }
  config.autoLaunch = want;
  persist();
  if (res && res.success === false) {
    toast('设置自启动失败：' + (res.error || '未知错误'));
    e.target.checked = !want;
    config.autoLaunch = !want;
  } else if (want && res && res.enabled === false) {
    toast('已注册，但系统报告未生效，请检查安全软件拦截');
  } else {
    toast(want ? '已开启开机自启动' : '已关闭开机自启动');
  }
});
$('setLock').addEventListener('change', (e) => {
  config.locked = e.target.checked;
  if (typeof API.setLocked === 'function') API.setLocked(config.locked);
  applyLocked();
  persist();
});
/* 风格切换（v2.2.2 起为下拉栏）。切换瞬间做一次 cross-fade：直接换变量虽然也能看，
 * 但颜色/形状是硬跳的；用 Web Animations 给 widget 一个很短的透明度回补，
 * 观感上是"融"过去的。 */
function switchTheme(t) {
  const prev = currentTheme;
  currentTheme = t;
  config.theme = currentTheme;
  applyTheme(currentTheme);
  // 手动模式下，如果用户没亲手挑过色，就把主色换成新风格的推荐色，
  // 这样"换风格"是整套气质的切换，而不是同一套紫到处套壳。
  // ※ 固定配色主题 CSS 里已经写死了整套 --md3-*，换主色没意义。
  if (config.colorMode === 'manual' && !accentPicked &&
      FIXED_PALETTE_THEMES.indexOf(currentTheme) < 0) {
    const next = THEME_ACCENT[currentTheme];
    if (next && String(config.accentColor).toUpperCase() !== next.toUpperCase()) {
      config.accentColor = next;
      syncSettingsControls();
      applyPaletteChange({ colorMode: 'manual', accentColor: next });
    }
  }
  syncSettingsControls();
  persist();
  // 配色是共用的，壁纸已经取过就直接用那一份，不必再算
  if (wallInfo && wallInfo.palette) applyPalette(wallInfo.palette);
  motionCrossFade();
  toast(currentTheme === 'glass'
    ? '已切换到液态玻璃风格'
    : '已切换到 ' + (THEME_LABEL[currentTheme] || currentTheme) + ' 风格');
  if (prev !== currentTheme) motionReflowItems();
}
$('themeSelect').addEventListener('change', (e) => {
  if (e.target.value) switchTheme(e.target.value);
});

/* ---------- 主色来源：莫奈取色 / 手动指定 ----------
 * 两种模式走同一条派生链路（主进程 SchemeTonalSpot），差别只在于 source color
 * 来自壁纸聚类打分还是用户手选。选完立即向主进程要一份新的 palette 写进 CSS 变量。
 * 三套动态配色主题（液态玻璃/MD3/Fluent）共用这套控件；固定配色主题不显示。 */
async function requestPalette(patch) {
  if (typeof API.getPalette !== 'function') return null;
  try {
    return await API.getPalette(patch);
  } catch (e) {
    console.warn('[palette]', e);
    return null;
  }
}

function describePalette(p) {
  const el = $('paletteInfo');
  if (!el) return;
  /* 手动模式下直接把用户挑的那个色写出来——这是"选色生效了"最直接的反馈，
   * 不必等 palette 回来（palette 是异步的，写它会让数字闪一下才稳定）。 */
  if (config.colorMode === 'manual') {
    el.textContent = '手动 · ' + String(config.accentColor || '').toUpperCase();
    return;
  }
  if (!p) {
    // 浏览器预览没有主进程也没有壁纸，别报"取色失败"吓人
    el.textContent = PREVIEW_MODE ? '预览模式 · 基线色' : '取色失败';
    return;
  }
  if (p.preview) { el.textContent = '预览近似色 · ' + String(p.source || '').toUpperCase(); return; }
  el.textContent = p.dynamic ? ('壁纸 · ' + String(p.source || '').toUpperCase()) : '灰白壁纸 · 基线色';
}

async function applyPaletteChange(patch) {
  const p = await requestPalette(patch || { colorMode: config.colorMode, accentColor: config.accentColor });
  if (!p) { describePalette(null); return; }
  if (wallInfo) wallInfo.palette = p;   // 之后切风格直接用这一份，不必再算
  applyPalette(p);
  describePalette(p);
  motionCrossFade();
}

/* 原生取色器拖动时是连续 input 事件：每次都发 IPC 太浪费，
 * 但只在 change 时才生效又会让用户觉得"拖了半天没反应"（旧版就是这样，
 * 还写了没人读的 --md3-swatch）。折中：input 里 120ms 防抖去求一次 palette，
 * 手动派生不走聚类（只是 HCT 换算），一次 <1ms，拖起来就是实时的。 */
let accentInputTimer = 0;
function accentLivePreview(hex) {
  config.accentColor = hex;
  config.colorMode = 'manual';
  $('accentHex').textContent = String(hex).toUpperCase();
  clearTimeout(accentInputTimer);
  accentInputTimer = setTimeout(() => {
    applyPaletteChange({ colorMode: 'manual', accentColor: config.accentColor });
  }, 120);
}

$('colorModeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || !btn.dataset.mode) return;
  const wasAuto = config.colorMode !== 'manual';
  config.colorMode = btn.dataset.mode;
  // 从"莫奈取色"切到"手动指定"时，起点用当前风格的推荐主色：
  // 用户还没挑过色（仍是别的风格的默认值）才替换，挑过就尊重用户。
  if (config.colorMode === 'manual' && wasAuto) {
    const cur = String(config.accentColor || '').toUpperCase();
    if (!accentPicked && (cur === '' || THEME_ACCENT_LIST.indexOf(cur) >= 0)) {
      config.accentColor = THEME_ACCENT[currentTheme] || config.accentColor;
    }
  }
  syncSettingsControls();
  persist();
  applyPaletteChange({ colorMode: config.colorMode, accentColor: config.accentColor });
  toast(config.colorMode === 'manual' ? '已切换为手动指定主色' : '已切换为壁纸莫奈取色');
});

$('accentColor').addEventListener('input', (e) => {
  accentLivePreview(e.target.value);
});
$('accentColor').addEventListener('change', (e) => {
  accentPicked = true; config.accentPicked = true;
  clearTimeout(accentInputTimer);
  config.accentColor = e.target.value;
  config.colorMode = 'manual';
  syncSettingsControls();
  persist();
  applyPaletteChange({ colorMode: 'manual', accentColor: config.accentColor });
});

$('swatches').addEventListener('click', (e) => {
  const btn = e.target.closest('.swatch');
  if (!btn || !btn.dataset.color) return;
  accentPicked = true; config.accentPicked = true;
  config.accentColor = btn.dataset.color;
  config.colorMode = 'manual';
  syncSettingsControls();
  persist();
  applyPaletteChange({ colorMode: 'manual', accentColor: config.accentColor });
});

$('setRealtime').addEventListener('change', async (e) => {
  const want = e.target.checked;
  config.realtime = want;
  persist();
  if (want) {
    const ok = await startRealtimeBackdrop();
    toast(ok ? '已开启实时桌面模糊' : '开启失败，已退回静态壁纸底材');
    if (!ok) { config.realtime = false; e.target.checked = false; persist(); }
  } else {
    stopRealtimeBackdrop();
    toast('已关闭实时模糊，改用静态壁纸底材');
  }
});

$('btnSizeUp').addEventListener('click', () => changeSize(40));
$('btnSizeDown').addEventListener('click', () => changeSize(-40));
function changeSize(delta) {
  if (config && config.locked) { toast('位置已锁定，请先解锁'); return; }
  bounds.width = Math.max(MIN_W, bounds.width + delta);
  bounds.height = Math.max(MIN_H, bounds.height + delta * 0.9);
  API.setBounds(bounds);
  // 这里以前要重画置换贴图。现在方向场由 SVG 滤镜按轮廓现算，与像素尺寸无关，
  // 改尺寸不需要任何重算，删掉即可。
  $('sizeVal').textContent = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
  persist();
}
$('btnResetPos').addEventListener('click', () => {
  if (config && config.locked) { toast('位置已锁定，请先解锁'); return; }
  bounds.x = 100; bounds.y = 100;
  API.setBounds(bounds);
  persist();
  toast('窗口位置已重置');
});

/* ---------- 添加/编辑快捷方式 ---------- */
const itemModal = $('itemModal');
function openItemModalFromMenu() {
  if (config.groups.length === 0) {
    config.groups.push({ id: 'g-' + Date.now(), name: '我的快捷方式', items: [] });
  }
  openItemModal(0, null);
}

function fillGroupSelect(sel) {
  sel.innerHTML = '';
  config.groups.forEach((g, idx) => {
    const o = document.createElement('option');
    o.value = idx;
    o.textContent = g.name;
    sel.appendChild(o);
  });
}

/* ---------- 图标编辑器 ---------- */
function updateIconPreview() {
  const prev = $('iconPreview');
  prev.innerHTML = '';
  if (iconState.path) {
    const img = document.createElement('img');
    img.src = iconState.path;
    img.alt = '';
    prev.appendChild(img);
    let tail = iconState.path;
    try { tail = decodeURIComponent(tail.split('/').pop() || tail); } catch (e) { /* 忽略解码失败 */ }
    $('iconPathName').textContent = '已选图片：' + tail;
    $('iconPathRow').classList.remove('hidden');
  } else {
    $('iconPathRow').classList.add('hidden');
    if (iconState.char) prev.textContent = iconState.char;      // 自定义字符
    else prev.innerHTML = svgIcon(ICONS[iconState.preset] || 'i-star');  // 预设 SVG
  }
}

function setIconState(preset, char, path) {
  iconState.preset = preset || 'app';
  iconState.char = char || '';
  iconState.path = path || '';
  $('itemIcon').value = ICONS[iconState.preset] ? iconState.preset : 'app';
  $('itemIconChar').value = iconState.char;
  updateIconPreview();
}

$('itemIcon').addEventListener('change', (e) => {
  iconState.preset = e.target.value;
  iconState.char = '';
  iconState.path = '';
  iconUserPicked = true;
  $('itemIconChar').value = '';
  updateIconPreview();
});

$('itemIconChar').addEventListener('input', (e) => {
  iconState.char = e.target.value;
  iconState.path = '';   // 自定义字符优先于预设，同时清掉图片
  iconUserPicked = true;
  updateIconPreview();
});

$('btnPickIcon').addEventListener('click', async () => {
  const res = await API.selectImage();
  if (res && res.url) {
    iconState.path = res.url;
    iconState.char = '';
    iconUserPicked = true;
    $('itemIconChar').value = '';
    updateIconPreview();
  } else if (res && res.error) {
    toast('选择图片失败：' + res.error);
  }
});

$('btnClearIcon').addEventListener('click', () => {
  iconState.path = '';
  iconUserPicked = false;   // 清空后允许再次自动提取
  updateIconPreview();
});

/* ---------- 从 exe / 文件提取系统图标 ---------- */
async function extractIconFromTarget(target, silent) {
  const type = $('itemType').value;
  if (type === 'web') {
    if (!silent) toast('网页类型没有本地图标，可手动选图片');
    return false;
  }
  if (type === 'folder') {
    if (!silent) toast('文件夹请用内置图标，或手动选一张图片');
    return false;
  }
  if (!target) {
    if (!silent) toast('请先选择目标文件');
    return false;
  }
  if (typeof API.getFileIcon !== 'function') return false;

  try {
    const res = await API.getFileIcon(target);
    if (res && res.url) {
      iconState.path = res.url;
      iconState.char = '';
      $('itemIconChar').value = '';
      updateIconPreview();
      if (!silent) toast('已提取该文件图标');
      return true;
    }
    if (!silent) toast('提取图标失败：' + ((res && res.error) || '未知错误'));
  } catch (e) {
    if (!silent) toast('提取图标失败：' + e.message);
  }
  return false;
}

// 手动"取图标"按钮：用户主动触发，因此标记为已手动选择
$('btnExtractIcon').addEventListener('click', async () => {
  const ok = await extractIconFromTarget($('itemTarget').value.trim(), false);
  if (ok) iconUserPicked = true;
});

function openItemModal(groupIndex, itemIndex) {
  currentEdit = { groupIndex, itemIndex };
  fillGroupSelect($('itemGroup'));
  if (itemIndex !== null) {
    const it = config.groups[groupIndex].items[itemIndex];
    $('itemModalTitle').textContent = '编辑快捷方式';
    $('itemName').value = it.name;
    $('itemType').value = it.type;
    $('itemTarget').value = it.target;
    setIconState(it.icon, it.iconChar, it.iconPath);
    // 已有自定义图片图标（含已提取的 exe 图标）→ 视为用户选定，别被自动提取冲掉
    iconUserPicked = !!it.iconPath;
    $('itemGroup').value = groupIndex;
    $('btnItemDelete').classList.remove('hidden');
  } else {
    $('itemModalTitle').textContent = '添加快捷方式';
    $('itemName').value = '';
    $('itemType').value = 'app';
    $('itemTarget').value = '';
    setIconState('app', '', '');
    iconUserPicked = false;   // 新建项允许自动提取
    $('itemGroup').value = groupIndex;
    $('btnItemDelete').classList.add('hidden');
  }
  syncTargetUI();
  itemModal.classList.remove('hidden');
  $('itemName').focus();
}

$('btnItemClose').addEventListener('click', () => itemModal.classList.add('hidden'));
$('btnItemCancel').addEventListener('click', () => itemModal.classList.add('hidden'));

$('itemType').addEventListener('change', () => syncTargetUI());

/* 类型变了：占位符、提示语、两个按钮一起跟着变 */
function syncTargetUI() {
  const t = $('itemType').value;
  $('itemTarget').placeholder = t === 'web' ? 'https://...' : (t === 'folder' ? '例如：D:\\教学资料' : '路径');
  const tip = $('targetTip');
  if (tip) {
    tip.textContent = t === 'folder'
      ? '点"选择"打开目录对话框（支持新建文件夹）'
      : (t === 'web' ? '填完整网址，会自动用浏览器打开' : '选择 exe 后会自动提取它的图标');
  }
  syncTargetButtons();
}

/* 网页类型没有本地文件可提取图标；文件夹类型用内置"文件夹"图标更贴切，
 * 因此这两类都隐藏"取图标"（文件夹仍可手动选图片图标）。 */
function syncTargetButtons() {
  const t = $('itemType').value;
  const local = t !== 'web';
  $('btnPick').style.display = local ? 'inline-block' : 'none';
  $('btnExtractIcon').style.display = (local && t !== 'folder') ? 'inline-block' : 'none';
}

$('btnPick').addEventListener('click', async () => {
  const type = $('itemType').value;
  let p = null;
  if (type === 'app') p = await API.selectApp();
  else if (type === 'file') p = await API.selectFile();
  else if (type === 'folder') p = await API.selectFolder();
  if (!p) return;
  $('itemTarget').value = p;

  // 名称还空着就用文件名兜底，省得再手打一遍
  if (!$('itemName').value.trim()) {
    const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    $('itemName').value = base.replace(/\.[^.]+$/, '');
  }
  if (type === 'folder') {
    // 文件夹没有可提取的专属图标，直接套内置文件夹图标（用户手动选过就不动）
    if (!iconUserPicked && iconState.preset !== 'folder') setIconState('folder', '', '');
    return;
  }
  // 自动套用 exe 自带图标（静默失败：拿不到图标就维持现状）
  if (!iconUserPicked) await extractIconFromTarget(p, true);
});

$('btnItemSave').addEventListener('click', () => {
  const name = $('itemName').value.trim();
  const type = $('itemType').value;
  const target = $('itemTarget').value.trim();
  const gi = parseInt($('itemGroup').value, 10);
  if (!name) { toast('请填写名称'); return; }
  if (!target) { toast('请填写目标路径或网址'); return; }

  const item = { id: 'it-' + Date.now(), name, type, target, icon: iconState.preset };
  if (iconState.char) item.iconChar = iconState.char;
  if (iconState.path) item.iconPath = iconState.path;

  if (currentEdit.itemIndex !== null) {
    const oldGroup = config.groups[currentEdit.groupIndex];
    const newGroup = config.groups[gi];
    if (oldGroup === newGroup) {
      oldGroup.items[currentEdit.itemIndex] = item;
    } else {
      // 编辑时切换了分组：从原组移除，加入新组
      oldGroup.items.splice(currentEdit.itemIndex, 1);
      newGroup.items.push(item);
    }
  } else {
    config.groups[gi].items.push(item);
  }
  persist();
  itemModal.classList.add('hidden');
  render();
  toast('已保存');
});

$('btnItemDelete').addEventListener('click', () => {
  if (currentEdit.itemIndex !== null) {
    config.groups[currentEdit.groupIndex].items.splice(currentEdit.itemIndex, 1);
    persist();
    itemModal.classList.add('hidden');
    render();
    toast('已删除');
  }
});

/* ---------- 分组管理 ---------- */
const groupModal = $('groupModal');
$('btnManageGroups').addEventListener('click', () => {
  renderGroupList();
  groupModal.classList.remove('hidden');
});
$('btnGroupClose').addEventListener('click', () => groupModal.classList.add('hidden'));

function renderGroupList() {
  const list = $('groupList');
  list.innerHTML = '';
  config.groups.forEach((g, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(g.name)} <small style="color:#888">(${g.items.length})</small></span>`;
    const del = document.createElement('button');
    del.className = 'del-group';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      if (confirm(`确定删除分组「${g.name}」及其下所有快捷方式？`)) {
        config.groups.splice(idx, 1);
        persist();
        renderGroupList();
        render();
      }
    });
    li.appendChild(del);
    list.appendChild(li);
  });
}

$('btnAddGroup').addEventListener('click', () => {
  const name = $('newGroupName').value.trim();
  if (!name) return;
  config.groups.push({ id: 'g-' + Date.now(), name, items: [] });
  $('newGroupName').value = '';
  persist();
  renderGroupList();
  render();
});

/* ---------- 右键 / 长按 弹出菜单 ---------- */
let ctxOpen = false;
function showCtxMenu(x, y) {
  ctxMenu.classList.remove('hidden');
  ctxOpen = true;
  ctxMenu.style.left = (x || 8) + 'px';
  ctxMenu.style.top = (y || 8) + 'px';
  // 防止超出视口右/下边界
  setTimeout(() => {
    const r = ctxMenu.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    if (r.right > W) ctxMenu.style.left = Math.max(4, W - r.width - 6) + 'px';
    if (r.bottom > H) ctxMenu.style.top = Math.max(4, H - r.height - 6) + 'px';
  }, 0);
}
function hideCtxMenu() { ctxMenu.classList.add('hidden'); ctxOpen = false; }

ctxMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.ctx-item');
  if (!btn) return;
  const act = btn.dataset.act;
  hideCtxMenu();
  if (act === 'add') openItemModalFromMenu();
  else if (act === 'edit') toggleEditMode();
  else if (act === 'settings') openSettings();
  else if (act === 'lock') toggleLocked();
  else if (act === 'hide') API.hideWindow();
  else if (act === 'quit') API.close();
});

// 右键（鼠标）
widget.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // 拖动/缩放期间（含取消后的宽限期）不弹菜单：触摸"按住再拖"时系统仍会补发
  // contextmenu，菜单在拖动中途出现会带来一次整屏重绘 = 闪。
  if (dragging || dragPointerDown || resizing || rsPointerDown || dragEndTimer || rsEndTimer) return;
  showCtxMenu(e.clientX, e.clientY);
});

// 长按（触摸）
let lpTimer = null, lpX = 0, lpY = 0, lpFired = false;
widget.addEventListener('pointerdown', (e) => {
  lpFired = false;
  // 正在拖动/缩放时不武装长按（标题栏也在这个 widget 里，pointerdown 会冒泡上来）
  if (dragging || dragPointerDown || resizing || rsPointerDown) return;
  if (e.pointerType === 'touch') {
    lpX = e.clientX; lpY = e.clientY;
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }   // 防多次 pointerdown 叠定时器
    lpTimer = setTimeout(() => {
      lpTimer = null;
      if (dragging || dragPointerDown) return;   // 550ms 内已经开始拖动 → 别弹菜单
      lpFired = true;
      showCtxMenu(lpX, lpY);
    }, 550);
  }
});
widget.addEventListener('pointermove', (e) => {
  if (lpTimer && (Math.abs(e.clientX - lpX) > 12 || Math.abs(e.clientY - lpY) > 12)) {
    clearTimeout(lpTimer); lpTimer = null;
  }
});
function cancelLp() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
widget.addEventListener('pointerup', cancelLp);
widget.addEventListener('pointercancel', cancelLp);
// 长按触发后吞掉随后的 click，避免误开快捷方式
widget.addEventListener('click', (e) => {
  if (lpFired) { e.stopPropagation(); e.preventDefault(); lpFired = false; }
}, true);

// 点击别处 / 在 widget 外部再次右键 关闭菜单
document.addEventListener('click', (e) => { if (ctxOpen && !e.target.closest('#ctxMenu')) hideCtxMenu(); });
document.addEventListener('contextmenu', (e) => {
  if (ctxOpen && !e.target.closest('#ctxMenu') && !e.target.closest('#widget')) hideCtxMenu();
});

/* ---------- U 盘区域 ----------
 * 可移动磁盘由主进程的常驻 PowerShell 监听，插拔时通过 usb-changed 推过来。
 * 没有 U 盘时整块隐藏（连同那行安全提示），不占地方。 */
const usbSection = $('usbSection');
const usbList = $('usbList');
let usbDrives = [];

function fmtBytes(n) {
  if (!n || n <= 0) return '0 MB';
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return Math.round(n / (1024 * 1024)) + ' MB';
}

function renderUsb() {
  usbList.innerHTML = '';
  if (!usbDrives.length) {
    usbSection.classList.add('hidden');
    return;
  }
  usbSection.classList.remove('hidden');
  $('usbCount').textContent = usbDrives.length + ' 个';

  usbDrives.forEach((d, di) => {
    const row = document.createElement('div');
    row.className = 'usb-item';
    staggerIndex(row, di);
    row.classList.add('t-enter');

    const icon = document.createElement('span');
    icon.className = 'usb-icon';
    icon.innerHTML = svgIcon('i-plug');

    const info = document.createElement('div');
    info.className = 'usb-info';
    const nm = document.createElement('div');
    nm.className = 'usb-name';
    nm.textContent = d.name + ' (' + d.letter + ':)';
    nm.title = nm.textContent;                    // 名称过长时悬浮看全
    const meta = document.createElement('div');
    meta.className = 'usb-meta';
    meta.textContent = d.size
      ? ('剩余 ' + fmtBytes(d.free) + ' / 共 ' + fmtBytes(d.size))
      : '容量未知';
    info.append(nm, meta);

    const openBtn = document.createElement('button');
    openBtn.className = 'usb-btn primary';
    openBtn.textContent = '打开';
    openBtn.addEventListener('click', async () => {
      const r = await API.openDrive(d.letter);
      if (r && !r.success) toast('打开失败：' + r.error);
    });

    const ejectBtn = document.createElement('button');
    ejectBtn.className = 'usb-btn';
    ejectBtn.textContent = '弹出';
    /* 两次点击两套语义：
     *   ① 普通点击 = 用户态的五层弹出（免 UAC，绝大多数情况够用）
     *   ② 上一轮失败且主进程说"可能缺权限"→ 按钮变「管理员重试」，
     *      再点一次走 UAC 提权（CM 弹节点 + mountvol /p 在提权后才解锁）。
     * 不用 confirm 弹窗：无边框窗口一直置底，原生确认框容易被压在别的窗口下面。 */
    ejectBtn.addEventListener('click', async () => {
      const asAdmin = ejectBtn.dataset.admin === '1';
      ejectBtn.disabled = true;
      ejectBtn.textContent = asAdmin ? '提权中' : '弹出中';
      let r;
      if (asAdmin) {
        r = (typeof API.ejectDriveElevated === 'function')
          ? await API.ejectDriveElevated(d.letter)
          : { success: false, error: '当前环境不支持提权弹出' };
      } else {
        r = await API.ejectDrive(d.letter);
      }
      ejectBtn.disabled = false;
      if (r && r.success) {
        ejectBtn.textContent = '弹出';
        ejectBtn.dataset.admin = '0';
        toast('已弹出 ' + d.letter + ':，可以安全拔出了');
      } else {
        // detail 是各层策略的真实输出，打到控制台方便定位（界面上太长放不下）
        if (r && r.detail) console.warn('[eject] ' + d.letter + ': ' + r.detail);
        toast('弹出失败：' + ((r && r.error) || '请确认没有文件正在使用'));
        if (r && r.needAdmin) {
          ejectBtn.textContent = '管理员重试';
          ejectBtn.dataset.admin = '1';
          ejectBtn.title = '再点一次将以管理员身份重新弹出（会弹出系统授权提示）';
        } else {
          ejectBtn.textContent = '弹出';
        }
      }
    });

    row.append(icon, info, openBtn, ejectBtn);
    usbList.appendChild(row);
  });
}

async function refreshUsb() {
  if (typeof API.getUsbDrives !== 'function') return;
  try {
    usbDrives = (await API.getUsbDrives()) || [];
    renderUsb();
  } catch (e) { /* 获取失败时保持上一次状态，不打断界面 */ }
}

if (typeof API.onUsbChange === 'function') {
  API.onUsbChange((list) => {
    usbDrives = list || [];
    renderUsb();
  });
}

/* ---------- 托盘菜单动作 ---------- */
if (typeof API.onTrayAction === 'function') {
  API.onTrayAction((action) => {
    if (action === 'add') openItemModalFromMenu();
    else if (action === 'settings') openSettings();
  });
}

/* ---------- 初始化 ---------- */
(async function init() {
  config = await API.getConfig();
  bounds = {
    x: config.x ?? 100, y: config.y ?? 100,
    width: config.width ?? 480, height: config.height ?? 420
  };
  titleInput.value = config.title || 'FClassPal';
  opacityRange.value = config.opacity ?? 0.55;
  widget.style.setProperty('--glass-alpha', config.opacity ?? 0.55);
  /* 下拉栏选项由 THEME_LABEL 生成（新增主题只改一处注册表） */
  const themeSelect = $('themeSelect');
  if (themeSelect && !themeSelect.options.length) {
    themeSelect.innerHTML = THEMES.map((t) =>
      '<option value="' + t + '">' + (THEME_LABEL[t] || t) + '</option>').join('');
  }
  if (themeSelect) themeSelect.value = config.theme || 'glass';
  applyRadius(config.cornerRadius ?? null, false);
  API.setBounds(bounds);
  enableLiquidGlass();   // 能力探测通过后点亮 .lg-ready
  // 界面风格要在第一帧就位，否则会看到"先玻璃后 MD3"的闪一下
  applyTheme(config.theme || 'glass');
  // 取色方式的默认值：没配过 = 走壁纸莫奈取色
  if (config.colorMode !== 'manual' && config.colorMode !== 'auto') config.colorMode = 'auto';
  if (!/^#?[0-9a-f]{6}$/i.test(String(config.accentColor || ''))) {
    config.accentColor = THEME_ACCENT[config.theme] || '#6750A4';
  }
  accentPicked = config.accentPicked === true;
  syncSettingsControls();
  // 折射基底：把桌面壁纸对齐画进 #envLayer（取不到就用内置渐变）
  refreshWallpaper();
  // 实时底材默认**关**（用户要的是"只模糊壁纸"）。只有明确开启时才去采集
  // 真实桌面，采集失败/未开启都留在静态壁纸基底。
  if (config.realtime === true) {
    startRealtimeBackdrop().catch(() => { /* 失败已在函数内降级 */ });
  } else {
    updateRealtimeInfo('静态壁纸', 'ok');
  }
  applyLocked();     // 锁定时隐藏缩放手柄、切换菜单文案
  render();
  refreshUsb();   // 启动时先拉一次，已插着的 U 盘要立刻显示出来

  // 环境信息：v1.7 起放弃 mica（它要求窗口不透明，会在四角露出方形底色），
  // 一律 transparent 窗口 + 渲染层自己画真实壁纸当玻璃底材。
  if (typeof API.getEnv === 'function') {
    try {
      const env = await API.getEnv();
      const bi = $('blurInfo');
      if (env && env.platform === 'browser') {
        document.body.classList.add('preview');   // 浏览器预览：深色渐变替身，让玻璃可见
        bi.textContent = '预览模式';
        bi.className = 'val blur-info no';
      } else {
        bi.textContent = wallInfo ? '壁纸基底' : '内置渐变基底';
        bi.className = 'val blur-info ok';
      }
    } catch (e) { /* 环境信息获取失败不影响主功能 */ }
  }
})();
