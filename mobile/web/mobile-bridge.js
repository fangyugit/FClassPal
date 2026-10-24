/* ============================================================================
 * FClassPal 安卓壳 · 运行环境桥（v2.4.5）
 *
 * 桌面版由 Electron 的 preload.js 注入 window.widgetAPI；安卓版由这里注入**同名对象**，
 * 方法签名逐个对齐，所以 renderer/app.js 一行都不用改 —— 它只判断"这个对象在不在"，
 * 在就走真机路径，不在才走浏览器预览 mock。
 *
 * 本文件必须在 app.js **之前**执行（装配脚本保证顺序）：app.js 顶层就
 * `const API = window.widgetAPI || 预览桩`，晚一步注入就变成预览模式了。
 *
 * 能力取舍（安卓没有的东西一律给"安全值"，绝不抛异常让界面白屏）：
 *   保留：主题 / 明暗（含跟随系统）/ 圆角 / 玻璃透明度 / 图标五项外观 / 分组与快捷方式
 *   新增：读安卓真实壁纸当玻璃底材（对应桌面的"只模糊壁纸"）、Android 12+ 系统取色、
 *         已安装应用列表 + 应用图标 + 按名称启动、原生 Toast、返回键退到后台
 *   v2.4.6：窗口模式（全屏 / 悬浮窗，像桌面版的小玻璃）+ 录屏权限实时模糊
 *         （MediaProjection，原生裁帧推 realtimeFrame 事件，悬浮窗模式默认开）
 *   退化：U 盘（无）、窗口拖动/缩放/置底/自启/锁定（全屏模式下无窗口系统可操作）
 *
 * 原生能力走 PalBridge 插件（mobile/android/app/src/main/java/.../PalBridgePlugin.java）；
 * 插件缺失时每个方法都有纯 Web 兜底，界面仍可用（只是少了原生那部分）。
 * ==========================================================================*/
(function () {
  'use strict';

  // 桌面版已经注入了就什么都别做（同一份 www 也能在 Electron 里跑，便于对照排错）
  if (window.widgetAPI) return;

  var MOBILE_KEY = 'fclasspal-mobile-config';
  var FALLBACK_ACCENT = '#6750A4';   // 与桌面版 DEFAULT_CONFIG.accentColor 一致
  var APP_VERSION = '2.5.3-fix';

  /* ---------------------------------------------------------------- 原生插件 */
  function plugin() {
    var C = window.Capacitor;
    return (C && C.Plugins && C.Plugins.PalBridge) || null;
  }

  /** 调原生方法；插件不存在或方法没实现 -> reject，由调用方走兜底。 */
  function call(name, opts) {
    var p = plugin();
    if (!p || typeof p[name] !== 'function') return Promise.reject(new Error('no-plugin:' + name));
    try { return Promise.resolve(p[name](opts || {})); }
    catch (e) { return Promise.reject(e); }
  }

  /** 调原生方法并吃掉异常，永远 resolve 成 fallback（给"可有可无"的能力用）。 */
  function soft(name, opts, fallback) {
    return call(name, opts).then(function (r) {
      return (r === undefined || r === null) ? fallback : r;
    }, function () { return fallback; });
  }

  function info() { return soft('getInfo', {}, {}); }

  /* ------------------------------------------------------- 调色板（HSL 近似）
   * 真机桌面版由主进程用 Monet 的 SchemeTonalSpot 派生 tonal 角色；安卓壳里跑不了
   * 那套 Kotlin/JS 包，这里用和 renderer/app.js 预览模式**同一张 tone 表**做近似：
   * 源色取色相，按 MD3 的 tone 阶梯给每个角色指定饱和/明度。
   * 源色优先用安卓 12+ 的"系统取色"（就是从壁纸来的动态主色，和 Material You 同源），
   * 拿不到就退回配置里的主色。 */
  var TONE_LIGHT = {
    primary: [0, 0.52, 0.40], onPrimary: [0, 0.60, 1.00],
    primaryContainer: [0, 0.60, 0.90], onPrimaryContainer: [0, 0.66, 0.15],
    secondary: [-8, 0.22, 0.40], onSecondary: [0, 0.30, 1.00],
    secondaryContainer: [-8, 0.26, 0.86], onSecondaryContainer: [-8, 0.32, 0.16],
    tertiary: [60, 0.34, 0.40], onTertiary: [0, 0.30, 1.00],
    tertiaryContainer: [60, 0.46, 0.90], onTertiaryContainer: [60, 0.46, 0.16],
    surface: [0, 0.32, 0.99], surfaceDim: [0, 0.10, 0.87],
    surfaceContainer: [0, 0.24, 0.95], surfaceContainerHigh: [0, 0.16, 0.90],
    onSurface: [0, 0.12, 0.11], onSurfaceVariant: [0, 0.08, 0.30],
    outline: [0, 0.05, 0.47], outlineVariant: [0, 0.07, 0.79],
    error: [null, 0.66, 0.40], onError: [0, 0.60, 1.00]
  };
  var TONE_DARK = {
    primary: [0, 0.45, 0.78], onPrimary: [0, 0.55, 0.20],
    primaryContainer: [0, 0.45, 0.30], onPrimaryContainer: [0, 0.55, 0.90],
    secondary: [-8, 0.22, 0.78], onSecondary: [-8, 0.25, 0.20],
    secondaryContainer: [-8, 0.24, 0.30], onSecondaryContainer: [-8, 0.28, 0.88],
    tertiary: [60, 0.30, 0.78], onTertiary: [0, 0.28, 0.20],
    tertiaryContainer: [60, 0.38, 0.30], onTertiaryContainer: [60, 0.40, 0.88],
    surface: [0, 0.28, 0.06], surfaceDim: [0, 0.24, 0.04],
    surfaceContainer: [0, 0.22, 0.10], surfaceContainerHigh: [0, 0.20, 0.15],
    onSurface: [0, 0.12, 0.92], onSurfaceVariant: [0, 0.10, 0.72],
    outline: [0, 0.06, 0.55], outlineVariant: [0, 0.08, 0.28],
    error: [null, 0.62, 0.80], onError: [0, 0.55, 0.20]
  };

  function hexToHsl(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var l = (mx + mn) / 2, h = 0, s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h * 360, s, l];
  }

  function hslToHex(h, s, l) {
    var hh = (((h % 360) + 360) % 360) / 360;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function f(t0) {
      var t = (t0 + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    function to(v) { return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'); }
    return '#' + to(f(hh + 1 / 3)) + to(f(hh)) + to(f(hh - 1 / 3));
  }

  function buildPalette(seed, dark) {
    var hsl = hexToHsl(seed) || hexToHsl(FALLBACK_ACCENT);
    var h = hsl[0];
    var tone = dark ? TONE_DARK : TONE_LIGHT;
    var out = { dynamic: true, source: String(seed || FALLBACK_ACCENT).toLowerCase(), preview: false, dark: !!dark };
    Object.keys(tone).forEach(function (role) {
      var row = tone[role];
      out[role] = hslToHex(row[0] === null ? 25 : h + row[0], row[1], row[2]);
    });
    return out;
  }

  /* ------------------------------------------------------- 配置（localStorage）
   * 桌面版落在 %APPDATA%/desktop-widget/config.json；安卓版没有可写的用户目录，
   * 存 WebView 的 localStorage（Capacitor 的 WebView 默认持久，升级 App 不丢）。
   * 键名与桌面版不同，两边配置不互通（路径/壁纸本来就不可移植）。 */
  var DEFAULT_CONFIG = {
    title: 'FClassPal',
    width: 480, height: 420, x: 0, y: 0,
    opacity: 0.55,
    alwaysOnTop: false,
    keepBottom: false,          // 安卓没有"窗口置底"这回事，统一 false
    autoLaunch: false,
    locked: false,
    realtime: false,            // v2.5.0 起默认关：录屏权限只在用户打开实时选项时才要（不要开屏就弹）
    androidMode: 'fullscreen',  // fullscreen=铺满 | float=悬浮小窗（像桌面版）
    theme: 'glass',
    // 安卓首启默认"跟随系统"：手机几乎都开着深色定时切换，这一档最省心
    appearance: 'auto',
    background: { enabled: false, path: '', blur: 0, mask: 0, scale: 100, offsetX: 50, offsetY: 50, fit: 'cover' },
    colorMode: 'auto',          // auto = 安卓 12+ 的系统取色（壁纸动态色）
    accentColor: FALLBACK_ACCENT,
    accentPicked: false,
    cornerRadius: null,
    iconFit: 'cover',
    iconBorder: 'glass',
    iconShape: 'auto',
    iconRadius: 22,
    iconRingColor: '',
    iconMono: false,
    // v2.5.2：奶蛙主题 id 'milk' → 'NaiWa' 的一次性迁移标记（桌面版 main.js 同名键）
    themeMigratedToNaiWa: false,
    // 首启种子：一个空分组，快捷方式由用户自己加（和桌面版同一条产品原则）
    groups: [{ id: 'group-1', name: '我的应用', items: [] }]
  };

  var cfg = null;

  function cloneDef() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }

  function loadCfg() {
    var raw = null;
    try { raw = localStorage.getItem(MOBILE_KEY); } catch (e) { raw = null; }
    var base = cloneDef();
    if (!raw) return base;
    var saved = null;
    try { saved = JSON.parse(raw); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return base;
    // 逐键合并：旧版本配置缺新键时补默认值，不会因为少一个字段整块设置面板读空
    Object.keys(base).forEach(function (k) {
      if (saved[k] !== undefined) base[k] = saved[k];
    });
    if (!Array.isArray(base.groups) || !base.groups.length) base.groups = cloneDef().groups;
    base.keepBottom = false;
    /* v2.5.2：奶蛙主题 id 'milk' → 'NaiWa'。安卓配置在 WebView 的 localStorage 里，
     * 同样会带着旧 id 升级上来——不迁移的话用户会停在"指向一个包里已经没有的主题"。
     * 桌面版在 main.js 的 createWindow() 里做同一件事，两边保持一致的语义：
     * theme 单值映射、themeOrder 映射去重、只跑一次。
     * 安卓不做"清理旧包目录"：主题包装在 Android/data/<包名>/files/themes 下，
     * 是用户自己导进去的，不该由升级过程代删；这里只保证指向正确。 */
    if (!base.themeMigratedToNaiWa) {
      base.themeMigratedToNaiWa = true;
      if (base.theme === 'milk') base.theme = 'NaiWa';
      if (Array.isArray(base.themeOrder)) {
        var seenOrder = {};
        base.themeOrder = base.themeOrder.map(function (id) {
          return id === 'milk' ? 'NaiWa' : id;
        }).filter(function (id) {
          if (seenOrder[id]) return false;
          seenOrder[id] = 1;
          return true;
        });
      }
      try { localStorage.setItem(MOBILE_KEY, JSON.stringify(base)); } catch (e) { /* 配额满就下次再说 */ }
    }
    return base;
  }

  function persist(c) {
    var next = c || cfg;
    try {
      localStorage.setItem(MOBILE_KEY, JSON.stringify(next));
      return { success: true };
    } catch (e) {
      // 配额满（图标/背景图是 data URL，几十个大图有可能撑到 10MB 上限）
      soft('toast', { text: '保存失败：本机存储空间不足，请清理一些自定义图标' }, null);
      return { success: false, error: String(e && e.message || e) };
    }
  }

  /* -------------------------------------------------- 明暗（含"跟随系统"）
   * 桌面版读 nativeTheme.shouldUseDarkColors；安卓读 Configuration.uiMode。
   * 为什么不用 matchMedia('(prefers-color-scheme)')：Android WebView 里那个值历史上
   * 跟的是"宿主 App 的主题"，不一定是系统设置里的深色开关。所以以原生为准，
   * matchMedia 只当插件缺失时的兜底，并额外订阅它的变化来触发重查。 */
  var systemDark = false;
  var appearanceListeners = [];
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function systemDarkNow() {
    if (mql && !plugin()) return !!mql.matches;
    return !!systemDark;
  }

  function refreshSystemAppearance() {
    return soft('getAppearance', {}, null).then(function (r) {
      var next = (r && typeof r.isDark === 'boolean') ? r.isDark : (mql ? !!mql.matches : false);
      var changed = next !== systemDark;
      systemDark = next;
      if (changed) appearanceListeners.forEach(function (fn) { try { fn({ isDark: next }); } catch (e) { } });
      return { isDark: next, changed: changed };
    });
  }

  // Android 的深色开关变化只会在 Activity 重建/配置变化时体现，WebView 里没有事件；
  // 回到前台 + 每 5 秒轻量轮询各查一次（原生调用的代价是读一个 int，可以忽略）。
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      refreshSystemAppearance().then(function (r) {
        if (r.changed) refreshWallpaperUI();
      });
    }
  });
  setInterval(function () { refreshSystemAppearance(); }, 5000);
  if (mql && mql.addEventListener) {
    mql.addEventListener('change', function () { refreshSystemAppearance(); });
  }

  function resolveDark(v) {
    var want = v || (cfg && cfg.appearance) || 'light';
    if (want === 'auto') return systemDarkNow();
    return want === 'dark';
  }

  /* ------------------------------------------------------------- 壁纸底材
   * 桌面版的"只模糊壁纸"是拿 Windows 壁纸当玻璃底材；安卓对应物就是系统壁纸
   * （WallpaperManager.getDrawable）。原生侧压到 900px 宽 JPEG 再回传，避免
   * 大图过桥。拿不到（部分 ROM 会拒绝）就返回 null，界面退回内置渐变基底 —— 和
   * 桌面版"无壁纸"分支走的是同一条降级路径。 */
  var wallCache = null;
  var wallpaperListeners = [];

  function averageLuminance(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = 24; c.height = 24;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 24, 24);
          var d = ctx.getImageData(0, 0, 24, 24).data;
          var sum = 0, n = 0;
          for (var i = 0; i < d.length; i += 4) {
            sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
            n += 1;
          }
          resolve(n ? sum / n : 0.5);
        } catch (e) { resolve(0.5); }
      };
      img.onerror = function () { resolve(0.5); };
      img.src = dataUrl;
    });
  }

  function loadWallpaperInfo() {
    return soft('wallpaper', { maxWidth: 900 }, null).then(function (r) {
      if (!r || !r.dataUrl) return null;
      var vw = window.innerWidth || 400, vh = window.innerHeight || 800;
      var dpr = window.devicePixelRatio || 1;
      return averageLuminance(r.dataUrl).then(function (lum) {
        return computePalette({}).then(function (palette) {
          return {
            url: r.dataUrl,
            // 全屏铺满：底材尺寸就用视口像素，坐标 0,0（桌面版这里的 x/y 是窗口屏幕坐标）
            w: Math.round(vw * dpr),
            h: Math.round(vh * dpr),
            x: 0, y: 0,
            luminance: lum,
            desktop: false,
            bg: null,
            /* v2.5.3-fix：必须带 palette —— 桌面版由主进程附上，这里之前漏了，
             * openSettings 的 describePalette 读 wallInfo.palette 得到 undefined，
             * 设置面板"当前主色"永远显示"取色失败"。 */
            palette: palette
          };
        });
      });
    });
  }

  /** 当前调色板（getPalette 与 loadWallpaperInfo 共用）。 */
  function computePalette(patch) {
    var p = patch || {};
    var mode = p.colorMode || (cfg && cfg.colorMode) || 'auto';
    var seed = (cfg && cfg.accentColor) || FALLBACK_ACCENT;
    if (mode === 'manual' && p.accentColor) seed = p.accentColor;
    var dark = resolveDark(p.appearance);
    if (mode === 'manual') return Promise.resolve(buildPalette(seed, dark));
    // 自动模式：先问安卓 12+ 要系统动态色（从壁纸来，和 Material You 同源）
    return soft('systemAccent', {}, null).then(function (r) {
      var got = r && r.color;
      return buildPalette(got || seed, dark);
    });
  }

  function refreshWallpaperUI() {
    return loadWallpaperInfo().then(function (info) {
      wallCache = info;
      wallpaperListeners.forEach(function (fn) { try { fn(info); } catch (e) { } });
      return info;
    });
  }

  /* --------------------------------------------------------- 图标主色（JS 版）
   * 桌面版在主进程用 nativeImage 取色；安卓壳在渲染层用 canvas 取：
   * 缩到 48x48、跳过透明像素（不做这一步主色永远是黑的，透明区域的 RGB 是 0,0,0）、
   * 按 4bit/通道分桶计数，取"去黑白后的最大桶"平均色。
   * 只为"图标边框 - 自动取色"服务，取不到返回 null 让 CSS 回退链接手。 */
  function dominantColor(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = 48; c.height = 48;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 48, 48);
          var d = ctx.getImageData(0, 0, 48, 48).data;
          var buckets = {};
          for (var i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 8) continue;                    // 透明像素不算数
            var r = d[i], g = d[i + 1], b = d[i + 2];
            var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            var sat = mx ? (mx - mn) / mx : 0;
            var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            if (sat < 0.12 || lum < 0.08 || lum > 0.95) continue;   // 灰/近黑/近白不要
            var key = (r >> 4) + '_' + (g >> 4) + '_' + (b >> 4);
            var o = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0, sat: 0 });
            o.n += 1; o.r += r; o.g += g; o.b += b; o.sat += sat;
          }
          var best = null;
          Object.keys(buckets).forEach(function (k) {
            var o = buckets[k];
            var score = o.n * (0.5 + o.sat / o.n);       // 数量 × 平均彩度：宁可少而艳
            if (!best || score > best.score) best = { score: score, o: o };
          });
          if (!best) { resolve(null); return; }
          var o2 = best.o;
          var hx = function (v) { return Math.round(v / o2.n).toString(16).padStart(2, '0'); };
          resolve('#' + hx(o2.r) + hx(o2.g) + hx(o2.b));
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  /* ------------------------------------------------------------ 选择器兜底
   * 桌面弹系统对话框；安卓没有"文件路径"这个概念，能选的就是"已安装应用"和
   * "本机图片"。图片走 WebView 自带的 <input type=file>（Capacitor 已经接好了
   * 原生选择器），读完转 data URL 存进配置。 */
  function pickImageFile(maxBytes, accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || 'image/*';
      input.style.position = 'fixed';
      input.style.left = '-1000px';
      document.body.appendChild(input);
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        try { input.remove(); } catch (e) { }
        resolve(v);
      }
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) { finish(null); return; }
        if (maxBytes && f.size > maxBytes) {
          soft('toast', { text: '图片太大（上限 ' + Math.round(maxBytes / 1024) + 'KB），请换一张小图' }, null);
          finish(null);
          return;
        }
        var fr = new FileReader();
        fr.onload = function () { finish(String(fr.result || '')); };
        fr.onerror = function () { finish(null); };
        fr.readAsDataURL(f);
      });
      // 用户取消时 change 不触发；靠 focus 回来 + 超时收尾，避免 Promise 永远挂着
      window.addEventListener('focus', function once() {
        window.removeEventListener('focus', once);
        setTimeout(function () { finish(null); }, 800);
      });
      input.click();
    });
  }

  function imageLuminance(dataUrl) { return averageLuminance(dataUrl); }

  /* ------------------------------------------------------------ .fcpc/.fcpt 打包工具（v2.5.0）
   * 写：STORE（不压缩，容器手工拼 —— 和桌面版 pack.js 读得到的布局一致）。
   * 读：EOCD → central directory → local header，deflate 条目用
   * DecompressionStream('deflate-raw') 解（桌面包是 deflate 压的）。 */
  function packStamp() {
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  var CRC_T = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipBuild(entries) {
    var enc = new TextEncoder();
    var parts = [], centrals = [], offset = 0, count = 0;
    var now = new Date();
    var dTime = ((now.getHours() & 0x1F) << 11) | ((now.getMinutes() & 0x3F) << 5) | ((now.getSeconds() / 2) & 0x1F);
    var dDate = (((now.getFullYear() - 1980) & 0x7F) << 9) | (((now.getMonth() + 1) & 0xF) << 5) | now.getDate();
    function w16(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); }
    function w32(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
    entries.forEach(function (e) {
      var name = enc.encode(e.name);
      var data = e.u8 || enc.encode(e.text || '');
      var crc = crc32(data);
      var local = [];
      w32(local, 0x04034b50); w16(local, 20); w16(local, 0x0800); w16(local, 0);
      w16(local, dTime); w16(local, dDate);
      w32(local, crc); w32(local, data.length); w32(local, data.length);
      w16(local, name.length); w16(local, 0);
      var cen = [];
      w32(cen, 0x02014b50); w16(cen, 20); w16(cen, 20); w16(cen, 0x0800); w16(cen, 0);
      w16(cen, dTime); w16(cen, dDate);
      w32(cen, crc); w32(cen, data.length); w32(cen, data.length);
      w16(cen, name.length); w16(cen, 0); w16(cen, 0); w16(cen, 0); w16(cen, 0);
      w32(cen, 0); w32(cen, offset);
      parts.push(new Uint8Array(local), name, data);
      centrals.push(new Uint8Array(cen), name);
      offset += local.length + name.length + data.length;
      count++;
    });
    var cdStart = offset, cdSize = 0;
    centrals.forEach(function (b) { cdSize += b.length; });
    var end = [];
    w32(end, 0x06054b50); w16(end, 0); w16(end, 0);
    w16(end, count); w16(end, count);
    w32(end, cdSize); w32(end, cdStart); w16(end, 0);
    var all = parts.concat(centrals, [new Uint8Array(end)]);
    var total = 0;
    all.forEach(function (b) { total += b.length; });
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (b) { out.set(b, pos); pos += b.length; });
    return Promise.resolve(out);
  }

  function inflateRaw(u8) {
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('WebView 太旧，不支持解压'));
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer()
      .then(function (ab) { return new Uint8Array(ab); });
  }

  function zipRead(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    /* 从尾部扫 EOCD（0x06054b50） */
    var i = u8.length - 22;
    while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
    if (i < 0) return Promise.reject(new Error('不是合法的 zip 包'));
    var count = dv.getUint16(i + 10, true);
    var cdOff = dv.getUint32(i + 16, true);
    var dec = new TextDecoder();
    var p = cdOff, files = {};
    var chain = Promise.resolve();
    for (var k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var cSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var cmtLen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + cmtLen;
      if (name.slice(-1) === '/') continue;
      /* 跳过 local header 拿数据起点 */
      var lnLen = dv.getUint16(lho + 26, true), lxLen = dv.getUint16(lho + 28, true);
      var dStart = lho + 30 + lnLen + lxLen;
      var raw = u8.slice(dStart, dStart + cSize);
      (function (name2, method2, raw2) {
        chain = chain.then(function () {
          if (method2 === 0) { files[name2] = raw2; return null; }
          if (method2 === 8) return inflateRaw(raw2).then(function (out) { files[name2] = out; });
          throw new Error('不认识的压缩方式 ' + method2);
        });
      })(name, method, raw);
    }
    return chain.then(function () {
      var out = {};
      Object.keys(files).forEach(function (n) {
        out[n] = n === 'config.json' || n === 'theme.json' || n === 'manifest.json'
          ? new TextDecoder().decode(files[n]) : files[n];
      });
      try { out.manifest = out['manifest.json'] ? JSON.parse(out['manifest.json']) : {}; } catch (e) { out.manifest = {}; }
      return out;
    });
  }

  function u8ToB64(u8) {
    var s = '';
    var CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  function pickAndReadPack() {
    return new Promise(function (resolve) {
      var p = plugin();
      if (!p || typeof p.addListener !== 'function' || typeof p.pickPack !== 'function') {
        resolve(null);
        return;
      }
      var done = false;
      var off = function () { };
      var timer = setTimeout(function () { if (!done) { done = true; try { off(); } catch (e) { } resolve(null); } }, 120000);
      Promise.resolve(p.addListener('packPicked', function (r) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { off(); } catch (e) { }
        if (!r || r.canceled) { resolve(null); return; }
        try {
          var bin = atob(r.base64 || '');
          var u8 = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          zipRead(u8).then(resolve, function () { resolve(null); });
        } catch (e) { resolve(null); }
      })).then(function (h) {
        if (h && typeof h.remove === 'function') off = function () { try { h.remove(); } catch (e) { } };
        Promise.resolve(soft('pickPack', {}, null)).then(function (r) {
          if (!r || !r.started) { if (!done) { done = true; clearTimeout(timer); try { off(); } catch (e) { } resolve(null); } }
        });
      });
    });
  }

  /* ------------------------------------------------------------ API 实现 */
  var API = {
    /* ---- 配置 ---- */
    getConfig: function () {
      cfg = loadCfg();
      return Promise.resolve(cfg);
    },
    saveConfig: function (c) {
      cfg = c || cfg;
      if (cfg) { cfg.keepBottom = false; cfg.realtime = false; }
      // 透明度只驱动玻璃表面层的 --glass-alpha（和桌面版同一条约定）
      try {
        var w = document.getElementById('widget');
        if (w) w.style.setProperty('--glass-alpha', (cfg && cfg.opacity != null) ? cfg.opacity : 0.55);
      } catch (e) { }
      return Promise.resolve(persist(cfg));
    },

    /* ---- 打开目标 ---- */
    openTarget: function (it) {
      var type = it && it.type;
      var target = String((it && it.target) || '').trim();
      if (!target) return Promise.resolve({ success: false, error: '目标为空' });
      if (type === 'web') {
        return soft('openUrl', { url: normalizeUrl(target) }, { opened: false }).then(function (r) {
          return r && r.opened === false ? { success: false, error: '打不开这个网址' } : { success: true };
        });
      }
      if (type === 'app') {
        // 目标可能是应用名（选择器回填的就是名字），也可能直接是包名 —— 两种都给原生
        var byPkg = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(target);
        var payload = byPkg ? { pkg: target } : { label: target };
        return soft('launchApp', payload, { launched: false }).then(function (r) {
          if (r && r.launched) return { success: true };
          return { success: false, error: '找不到这个应用，可能已卸载' };
        });
      }
      return Promise.resolve({
        success: false,
        error: '安卓版只能打开网页和应用；文件/文件夹请在桌面版使用'
      });
    },

    /* ---- 选择目标（桌面是系统对话框，安卓是应用列表 / 图片选择器） ---- */
    selectApp: function () {
      return soft('pickApp', {}, null).then(function (r) {
        if (r && r.label) return r.label;   // 回名字，让"名称"输入框自动填得好看
        if (r && r.pkg) return r.pkg;
        return null;
      });
    },
    selectFile: function () { return Promise.resolve(null); },
    selectFolder: function () { return Promise.resolve(null); },
    selectImage: function () {
      // 300KB 上限：图标会以 data URL 进配置（localStorage 只有 ~10MB）
      return pickImageFile(300 * 1024, 'image/*').then(function (url) {
        if (!url) return null;
        return { path: url, url: url };
      });
    },
    getFileIcon: function (target) {
      var t = String(target || '').trim();
      if (!t) return Promise.resolve({ error: '目标为空' });
      if (/^data:image\//i.test(t)) return Promise.resolve({ path: t, url: t });
      var payload = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(t) ? { pkg: t } : { label: t };
      return soft('appIcon', payload, null).then(function (r) {
        if (r && r.dataUrl) return { path: t, url: r.dataUrl };
        return { error: '安卓版只能提取已安装应用的图标' };
      });
    },
    getIconColors: function (paths) {
      var list = Array.isArray(paths) ? paths : [paths];
      return Promise.all(list.map(function (p) {
        if (!p || !/^data:image\//i.test(String(p))) return Promise.resolve(null);
        return dominantColor(String(p));
      })).then(function (colors) {
        var out = {};
        list.forEach(function (p, i) { out[p] = colors[i] || null; });
        return out;
      });
    },

    /* ---- 自定义背景图 ---- */
    pickBackground: function () {
      // 背景图会整张进配置，卡在 1.5MB 以内（再大 localStorage 就装不下了）
      return pickImageFile(1500 * 1024, 'image/*').then(function (url) {
        if (!url) return null;
        return imageLuminance(url).then(function (lum) {
          return { url: url, path: url, luminance: lum };
        });
      });
    },
    loadBackground: function () {
      var bg = cfg && cfg.background;
      if (!bg || !bg.enabled || !bg.path) return Promise.resolve(null);
      if (!/^data:image\//i.test(String(bg.path))) return Promise.resolve(null);
      return imageLuminance(bg.path).then(function (lum) {
        return { url: bg.path, path: bg.path, luminance: lum };
      });
    },

    /* ---- 环境 ---- */
    getEnv: function () {
      return info().then(function (i) {
        return {
          transparent: false,          // 安卓是全屏不透明窗口，玻璃靠壁纸底材呈现
          platform: 'android',         // 千万别给 'browser'，那会让渲染层切到预览样式
          isMobile: true,
          touch: true,
          realtime: true,              // 录屏实时模糊可用（悬浮窗模式；全屏自动退壁纸）
          release: String(i.androidRelease || ''),
          sdk: i.sdkInt || 0,
          version: i.versionName || APP_VERSION,
          model: i.model || ''
        };
      });
    },
    getAppVersion: function () {
      return info().then(function (i) { return i.versionName || APP_VERSION; });
    },
    /* ---- 检测更新（v2.5.3-fix 补）：此前安卓没实现这条，点「检测更新」必报
     * "检测失败：API.checkUpdate is not a function"。桌面版走主进程（带 DoH 兜底），
     * 安卓 WebView 里直接 fetch GitHub API（api.github.com 允许跨域），拿不到就
     * 明确说网络问题，不装死。 */
    checkUpdate: function () {
      var cur = APP_VERSION;
      var core = function (s) {
        var m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      var c = core(cur);
      return new Promise(function (resolve) {
        var done = false;
        var fin = function (r) { if (!done) { done = true; resolve(r); } };
        var timer = setTimeout(function () { fin({ success: false, error: '网络超时，稍后再试' }); }, 12000);
        fetch('https://api.github.com/repos/fangyugit/FclassPal/releases/latest', { cache: 'no-store' })
          .then(function (res) { return res.json(); })
          .then(function (j) {
            var tag = String((j && j.tag_name) || '').replace(/^v/i, '');
            var n = core(tag);
            if (!n) { clearTimeout(timer); return fin({ success: false, error: '远端版本信息异常' }); }
            var newer = !c || n[0] > c[0] ||
              (n[0] === c[0] && (n[1] > c[1] || (n[1] === c[1] && n[2] > c[2])));
            clearTimeout(timer);
            fin({ success: true, current: cur, latest: tag, update: newer });
          })
          .catch(function () {
            clearTimeout(timer);
            fin({ success: false, error: '网络不可达（GitHub 访问受限或无网络）' });
          });
      });
    },
    getDisplayInfo: function () { return Promise.resolve(null); },

    /* ---- 壁纸 / 配色 ---- */
    getWallpaper: function () {
      if (!wallCache) return loadWallpaperInfo().then(function (info2) { wallCache = info2; return info2; });
      return Promise.resolve(wallCache);
    },
    onWallpaperChanged: function (cb) {
      wallpaperListeners.push(cb);
      return function () {
        var i = wallpaperListeners.indexOf(cb);
        if (i >= 0) wallpaperListeners.splice(i, 1);
      };
    },
    getPalette: function (patch) {
      return computePalette(patch);
    },

    /* ---- 明暗 ---- */
    getSystemAppearance: function () {
      return refreshSystemAppearance().then(function (r) {
        return { isDark: r.isDark, forced: false };
      });
    },
    onSystemAppearanceChanged: function (cb) {
      appearanceListeners.push(cb);
      return function () {
        var i = appearanceListeners.indexOf(cb);
        if (i >= 0) appearanceListeners.splice(i, 1);
      };
    },

    /* ---- 窗口：全屏模式下没有可操作的窗口系统，一律安全空实现；
     * 悬浮窗模式（config.androidMode='float'）走原生 setWindowMode/moveWindow，
     * 把 Activity 窗口缩小成桌面版那样的小玻璃，标题栏拖动即移动 OS 窗口 ---- */
    setBounds: function (b) {
      return soft('setBounds', {
        x: b && b.x, y: b && b.y, width: b && b.width, height: b && b.height
      }, { applied: false });
    },
    moveWindow: function (x, y) { soft('moveWindow', { x: x, y: y }, null); },
    setDragging: function () { },
    setKeepBottom: function () { },
    setAutoLaunch: function () { return Promise.resolve({ success: false, error: '安卓版不支持开机自启' }); },
    setLocked: function () { return Promise.resolve({ success: true }); },
    hideWindow: function () { soft('minimize', {}, null); },
    close: function () { soft('exitApp', {}, null); },
    onBoundsChanged: function () { return function () { }; },

    /* ---- 实时屏幕模糊：MediaProjection 录屏采集（悬浮窗模式）。
     * 原生裁好帧推 realtimeFrame 事件（JPEG dataUrl），渲染层画进 #deskCanvas；
     * 'consent' 表示系统授权对话框还挂着，渲染层挂起等帧，不算失败。---- */
    startRealtime: function () {
      return soft('startRealtime', {}, { ok: false, reason: 'no-plugin' });
    },
    stopRealtime: function () {
      return soft('stopRealtime', {}, { stopped: true });
    },
    onRealtimeFrame: function (cb) {
      var p = plugin();
      if (!p || typeof p.addListener !== 'function') return function () { };
      var unsub = function () { };
      try {
        Promise.resolve(p.addListener('realtimeFrame', function (f) {
          if (cb) { try { cb(f); } catch (e) { } }
        })).then(function (h) {
          if (h && typeof h.remove === 'function') {
            unsub = function () { try { h.remove(); } catch (e) { } };
          }
        });
      } catch (e) { }
      return function () { unsub(); };
    },
    onRealtimeEnded: function (cb) {
      var p = plugin();
      if (!p || typeof p.addListener !== 'function') return function () { };
      var unsub = function () { };
      try {
        Promise.resolve(p.addListener('realtimeEnded', function (r) {
          if (cb) { try { cb(r); } catch (e) { } }
        })).then(function (h) {
          if (h && typeof h.remove === 'function') {
            unsub = function () { try { h.remove(); } catch (e) { } };
          }
        });
      } catch (e) { }
      return function () { unsub(); };
    },

    /* ---- U 盘：安卓没有（手机接 OTG 也不会出现在这个维度上） ---- */
    getUsbDrives: function () { return Promise.resolve([]); },
    openDrive: function () { return Promise.resolve({ success: false, error: '安卓版不支持 U 盘弹出' }); },
    ejectDrive: function () { return Promise.resolve({ success: false, error: '安卓版不支持 U 盘弹出' }); },
    ejectDriveElevated: function () { return Promise.resolve({ success: false, error: '安卓版不支持 U 盘弹出' }); },

    /* ================================================================ 配置包 .fcpc / 主题包 .fcpt（v2.5.0）
     * 桌面版走系统文件对话框；安卓是 SAF 选文件 + MediaStore 落盘（下载/FClassPal/）。
     * zip 打包/解包在渲染层做（STORE 写出最稳；读桌面包的 deflate 用
     * DecompressionStream('deflate-raw')，Android System WebView 103+ 支持）。
     * 图标/背景在安卓侧本来就是 data URL 存在 config 里，随 JSON 一起走，
     * 不需要桌面版那套 icons/ 资产袋；桌面版导入时对 data: 原样保留。 */
    exportConfig: function () {
      if (!cfg) return Promise.resolve({ success: false, error: '配置还没加载' });
      var out = JSON.parse(JSON.stringify(cfg));
      ['x', 'y', 'width', 'height', 'androidMode', 'autoLaunch'].forEach(function (k) { delete out[k]; });
      var n = 0;
      (out.groups || []).forEach(function (g) { (g.items || []).forEach(function (it) { n += (it.children ? it.children.length + 1 : 1); }); });
      var entries = [
        { name: 'manifest.json', text: JSON.stringify({ kind: 'fcpc', app: 'FClassPal', version: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString() }, null, 2) },
        { name: 'config.json', text: JSON.stringify(out, null, 2) },
        { name: '说明.txt', text: 'FClassPal 配置包（.fcpc）\r\n\r\n安卓版导出。config.json 里是全部设置与快捷方式，\r\n图标/背景以 data URL 内嵌。桌面版「导入 .fcpc」可直接吃。\r\n\r\n快捷方式数：' + n + '\r\n导出时间：' + new Date().toLocaleString() + '\r\n' }
      ];
      return zipBuild(entries).then(function (u8) {
        var stamp = packStamp();
        return soft('savePack', { name: 'FClassPal-配置-' + stamp + '.fcpc', base64: u8ToB64(u8) }, null)
          .then(function (r) {
            if (r && r.saved) return { success: true, path: r.path || '下载/FClassPal/', items: n };
            return { success: false, error: (r && r.error) || '保存失败' };
          });
      });
    },
    exportTheme: function () {
      if (!cfg) return Promise.resolve({ success: false, error: '配置还没加载' });
      var KEYS = ['theme', 'appearance', 'cornerRadius', 'opacity', 'title',
        'background', 'iconFit', 'iconBorder', 'iconShape', 'iconRadius', 'iconRingColor', 'iconMono', 'colorMode', 'accentColor', 'accentPicked'];
      var scheme = {};
      KEYS.forEach(function (k) { if (cfg[k] !== undefined) scheme[k] = cfg[k]; });
      var entries = [
        { name: 'manifest.json', text: JSON.stringify({ kind: 'fcpt', app: 'FClassPal', version: 1, appVersion: APP_VERSION, theme: scheme.theme, exportedAt: new Date().toISOString() }, null, 2) },
        { name: 'theme.json', text: JSON.stringify(scheme, null, 2) },
        { name: 'README.txt', text: 'FClassPal 主题方案（.fcpt）\r\n\r\n界面风格　' + (scheme.theme || 'glass') + '\r\n安卓版导出，桌面版「导入 .fcpt」可直接吃（只改观感，不动快捷方式）。\r\n' }
      ];
      return zipBuild(entries).then(function (u8) {
        return soft('savePack', { name: 'FClassPal-主题-' + (cfg.theme || 'glass') + '-' + packStamp() + '.fcpt', base64: u8ToB64(u8) }, null)
          .then(function (r) {
            if (r && r.saved) return { success: true, path: r.path || '下载/FClassPal/' };
            return { success: false, error: (r && r.error) || '保存失败' };
          });
      });
    },
    importConfig: function () {
      return pickAndReadPack().then(function (pack) {
        if (!pack) return { success: false, canceled: true };
        if (pack.manifest && pack.manifest.kind && pack.manifest.kind !== 'fcpc')
          return { success: false, error: '这不是配置包（是 ' + pack.manifest.kind + '），请在「主题方案」处导入' };
        if (!pack['config.json']) return { success: false, error: '包里没有 config.json，文件可能不完整' };
        var incoming;
        try { incoming = JSON.parse(pack['config.json']); } catch (e) { return { success: false, error: 'config.json 解析失败' }; }
        var cur = cfg || {};
        ['x', 'y', 'width', 'height', 'androidMode', 'autoLaunch'].forEach(function (k) { incoming[k] = cur[k]; });
        incoming.androidMode = cur.androidMode || 'fullscreen';
        incoming.realtime = false;   // 录屏令牌不跨设备，导入后回到默认关
        cfg = incoming;
        persist(cfg);
        var n = 0;
        (incoming.groups || []).forEach(function (g) { (g.items || []).forEach(function (it) { n += (it.children ? it.children.length + 1 : 1); }); });
        return { success: true, items: n, theme: incoming.theme };
      });
    },
    importTheme: function () {
      return pickAndReadPack().then(function (pack) {
        if (!pack) return { success: false, canceled: true };
        if (pack.manifest && pack.manifest.kind && pack.manifest.kind !== 'fcpt')
          return { success: false, error: '这不是主题方案（是 ' + pack.manifest.kind + '），请在「配置备份」处导入' };
        if (!pack['theme.json']) return { success: false, error: '包里没有 theme.json，文件可能不完整' };
        var scheme;
        try { scheme = JSON.parse(pack['theme.json']); } catch (e) { return { success: false, error: 'theme.json 解析失败' }; }
        var KEYS = ['theme', 'appearance', 'cornerRadius', 'opacity', 'title',
          'background', 'iconFit', 'iconBorder', 'iconShape', 'iconRadius', 'iconRingColor', 'iconMono', 'colorMode', 'accentColor', 'accentPicked'];
        KEYS.forEach(function (k) { if (scheme[k] !== undefined) cfg[k] = scheme[k]; });
        persist(cfg);
        return { success: true, theme: cfg.theme };
      });
    },

    /* ================================================================ 主题包 .fcpt 管理（v2.5.2）
     * 桌面版引擎在 themes.js（主进程）；安卓没有主进程，落盘/校验/zip 解包在
     * 原生 themeInstall 里做，包落在应用专属目录
     * Android/data/com.fclasspal.widget/files/themes/（免运行时权限，卸载即清）。
     * 顺序存在本机配置（themeOrder），themesList 按它排 —— 与桌面 config.themeOrder 等价。 */
    themesList: function () {
      return call('themesList', {}).then(function (r) {
        if (!r || !r.success || !r.data) return { success: false };
        var order = (cfg && cfg.themeOrder) || [];
        var known = {};
        (r.data.themes || []).forEach(function (t) { known[t.id] = t; });
        var sorted = [];
        order.forEach(function (id) {
          if (known[id]) { sorted.push(known[id]); delete known[id]; }
        });
        Object.keys(known).forEach(function (id) { sorted.push(known[id]); });
        r.data.themes = sorted;
        // 随包离线库存：已装上过的标记 installed，UI 就不再重复展示
        var have = {};
        sorted.forEach(function (t) { have[String(t.id).toLowerCase()] = 1; });
        (r.data.bundled || []).forEach(function (b) {
          b.installed = !!have[String(b.id || '').toLowerCase()];
        });
        return r;
      }, function () { return { success: false }; });
    },
    themesCss: function () {
      return call('themesCss', {}).then(function (r) {
        return (r && r.success) ? r : { success: false, css: {} };
      }, function () { return { success: false, css: {} }; });
    },
    themesInstall: function () {
      // SAF 选包 → packPicked 事件带 base64 → 原生解 zip、校验、落盘
      return new Promise(function (resolve) {
        var p = plugin();
        if (!p || typeof p.addListener !== 'function' || typeof p.pickPack !== 'function' ||
            typeof p.themeInstall !== 'function') {
          resolve({ success: false, canceled: true });
          return;
        }
        var done = false;
        var off = function () { };
        var timer = setTimeout(function () {
          if (!done) { done = true; try { off(); } catch (e) { } resolve({ success: false, error: '选择超时' }); }
        }, 180000);
        Promise.resolve(p.addListener('packPicked', function (r) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { off(); } catch (e) { }
          if (!r || r.canceled) { resolve({ success: false, canceled: true }); return; }
          /* v2.5.3-fix：原生明确报错（如系统没回传所选文件）要冒泡成 toast，
           * 不许静默 —— 用户分不清"没点上"和"坏了"。 */
          if (r.error) { resolve({ success: false, error: r.error }); return; }
          Promise.resolve(p.themeInstall({ base64: r.base64 })).then(resolve, function (e) {
            resolve({ success: false, error: String((e && e.message) || e) });
          });
        })).then(function (h) {
          if (h && typeof h.remove === 'function') off = function () { try { h.remove(); } catch (e) { } };
          Promise.resolve(soft('pickPack', {}, null)).then(function (r2) {
            if (!r2 || !r2.started) {
              if (!done) { done = true; clearTimeout(timer); try { off(); } catch (e) { } resolve({ success: false, canceled: true }); }
            }
          });
        });
      });
    },
    themesInstallBundled: function (file) {
      return call('themeInstallBundled', { file: file })
        .catch(function () { return { success: false, error: '原生不支持' }; });
    },
    themesRemove: function (id) {
      return call('themesRemove', { id: id }).then(function (r) {
        if (r && r.success) {
          cfg = cfg || loadCfg();
          if (cfg.theme === id) { cfg.theme = 'glass'; persist(cfg); }   // 删的是在用的 → 退回玻璃
          r.theme = cfg.theme;
          /* 渲染层 afterThemeMutation 需要 r.data（删后完整清单）。桌面版主进程会带，
           * 原生 themesRemove 只回 success —— 这里补拉一次 themesList，否则删包必崩
           * （TypeError: Cannot read properties of undefined）。 */
          return call('themesList', {}).then(function (li) {
            if (li && li.success && li.data) r.data = li.data;
            return r;
          }, function () { return r; });
        }
        return r;
      }, function () { return { success: false, error: '原生不支持' }; });
    },
    themesReorder: function (ids) {
      cfg = cfg || loadCfg();
      cfg.themeOrder = ids;
      persist(cfg);
      return Promise.resolve({ success: true, order: ids });
    },
    themesOpenFolder: function () {
      return soft('toast', { text: '主题包目录：Android/data/com.fclasspal.widget/files/themes' }, null)
        .then(function () { return { success: true }; });
    },

    /* ---- 悬浮窗权限（v2.5.0） ---- */
    overlayGranted: function () {
      return soft('overlayGranted', {}, { granted: false }).then(function (r) { return !!(r && r.granted); });
    },
    requestOverlay: function () { return soft('requestOverlay', {}, null); },
    onUsbChange: function () { return function () { }; },

    /* ---- 托盘：安卓没有托盘，菜单一律在应用内 ---- */
    onTrayAction: function () { return function () { }; },

    /* ---- 外链 ---- */
    openExternal: function (url) {
      return soft('openUrl', { url: String(url || '') }, { opened: false }).then(function (r) {
        return !!(r && r.opened !== false);
      });
    }
  };

  function normalizeUrl(u) {
    var s = String(u || '').trim();
    if (!s) return s;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;   // 已有 scheme
    if (/^\/\//.test(s)) return 'https:' + s;
    return 'https://' + s;
  }

  /* ================================================== 手机端界面适配（不改 app.js）
   * 只做三件事，全部限定在 html.mobile 作用域内（body 标记类有铁律：任何被加到
   * body 上的状态类都不允许有"裸 .类名"规则，所以这里一律挂在 <html> 上）：
   *   ① 隐藏桌面专有设置行（窗口置底 / 开机自启 / 锁定位置 / 实时桌面模糊）
   *   ② 隐藏 U 盘区、缩放手柄、透明度浮条（手机上没意义）
   *   ③ 改写几处"专有名词"文案：Windows -> 安卓、壁纸取色 -> 系统取色
   * 全部按"找不到就跳过"写，renderer 以后改文案最多是少改几句，不会报错。 */
  /* setRadius 也藏掉：全屏时圆角只会把四个角削出 Activity 底色，没有可调空间。
   * setRealtime **不再藏**（v2.4.6 起悬浮窗模式走录屏实时模糊，默认打开）。 */
  var HIDE_ROWS = ['setBottom', 'setAutoLaunch', 'setLock', 'setRadius'];
  // v2.5.0 起 rowBackup/rowThemePack 不再藏：.fcpc/.fcpt 导入导出在安卓用
  // SAF + MediaStore 实现了（见 API.exportConfig/importConfig）
  var HIDE_ROW_WITH = ['blurInfo'];

  function hideRowById(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var row = el.closest ? el.closest('.row') : null;
    if (row) row.setAttribute('data-mobile-hide', '1');
  }

  function textReplace(sel, from, to) {
    var nodes = document.querySelectorAll(sel);
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.textContent.indexOf(from) >= 0) el.textContent = el.textContent.split(from).join(to);
    });
  }

  function rewriteCopy() {
    // 明暗模式那一整段：Windows 的"应用模式" -> 安卓的深色主题
    textReplace('.row-hint', '跟着 Windows 的"应用模式"走：系统在暗色/亮色之间切换',
      '跟着安卓的深色主题走：系统在暗色/亮色之间切换');
    textReplace('.row-hint', '（含设置里的定时切换、日落到日出）时本应用立刻跟着变，不用重开。',
      '（含显示设置里的定时切换、日落到日出）时本界面立刻跟着变，不用重开。');
    // 主色来源：桌面是壁纸取色，安卓是系统动态色（Android 12+）
    textReplace('#colorModeSeg .seg-btn', '壁纸取色', '系统取色');
    textReplace('.row-hint', '「壁纸取色」走 Material You 官方算法：先把壁纸在 Lab 空间聚类，',
      '「系统取色」读 Android 12+ 的系统动态色（Material You，本身就来自壁纸）：');
    textReplace('.row-hint', '再按色相占比 × 接近目标彩度打分挑出主色，最后由该色派生整套 tonal palette。',
      '系统未提供时退回下面指定的颜色。');
    textReplace('.row-hint', '「手动指定」用你选的颜色走同一条派生链路，拖动取色器即时生效。',
      '「手动指定」用你选的颜色派生整套 tonal palette，拖动取色器即时生效。');
    // 物品编辑弹窗里"选 exe 提取图标"的说明，安卓换成"选应用"
    textReplace('.row-hint', '选择 exe 后会自动提取它的图标', '选择应用后会自动提取它的图标');
    // 风格说明里"三套跟随壁纸取色"：安卓走系统动态色
    textReplace('.row-hint', '三套跟随壁纸取色', '三套跟随系统取色');
    // "只模糊壁纸"那一段整段换掉：桌面讲的是 Windows 壁纸，安卓讲的是手机壁纸
    Array.prototype.forEach.call(document.querySelectorAll('.row-hint'), function (el) {
      if (el.textContent.indexOf('只模糊壁纸') >= 0) {
        el.textContent = '玻璃里显示的就是你的手机壁纸本身（读取系统壁纸，不需要存储权限），' +
          '换壁纸后返回前台会自动同步。玻璃表面层是半透明的，透明度滑块调节的就是它。';
      }
    });
    // 提示条：手机上是长按，没有右键
    textReplace('.hint', '右键 / 长按 打开菜单', '长按打开菜单');
    // 实时模糊：安卓录屏的是"屏幕"不是"桌面"
    textReplace('.row span', '实时桌面模糊', '实时屏幕模糊');
    var sel = document.getElementById('itemType');
    if (sel) {
      Array.prototype.forEach.call(sel.options, function (o) {
        if (o.value === 'file' || o.value === 'folder') {
          o.disabled = true;                                  // 安卓没有文件路径语义
          if (o.textContent.indexOf('桌面') < 0) o.textContent = o.textContent + '（仅桌面版）';
        }
      });
    }
  }

  /* ------------------------------------------------ 窗口模式（全屏 / 悬浮窗）
   * 桌面版是无边框小窗；安卓默认全屏 Activity。悬浮窗模式由原生把窗口缩小，
   * 这里只负责：① 启动时把存的模式告诉原生 + 给 html 挂 float 标记类；
   * ② 在设置面板注入切换行（桌面不需要这行，所以不在 index.html 里写死）。 */
  function applyWindowMode() {
    var isFloat = !!(cfg && cfg.androidMode === 'float');
    document.documentElement.classList.toggle('float', isFloat);
    if (!isFloat) return;
    ensureOverlayThenApply();
  }

  /* v2.5.0：悬浮窗模式先看「显示在其他应用上层」权限。
   * 没授予：照常应用应用内悬浮（行为不变），但引导去开权限；
   * 已授予：带 overlay:true 重新应用，把窗口升级成系统悬浮层。 */
  function ensureOverlayThenApply() {
    API.overlayGranted().then(function (granted) {
      soft('setWindowMode', {
        mode: 'float', x: cfg && cfg.x, y: cfg && cfg.y,
        width: cfg && cfg.width, height: cfg && cfg.height,
        overlay: granted
      }, null);
      if (!granted && !ensureOverlayThenApply._asked) {
        ensureOverlayThenApply._asked = true;   // 只引导一次，别每次启动都打扰
        soft('toast', { text: '想要在任何界面上显示？去系统设置授予「显示在其他应用上层」权限' }, null);
        setTimeout(function () { API.requestOverlay(); }, 1200);
      }
    });
  }

  function injectWindowModeRow() {
    var anchor = document.getElementById('setRealtime');
    if (!anchor) return;
    var row = anchor.closest ? anchor.closest('.row') : null;
    if (!row || document.getElementById('setWinMode')) return;
    var div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = '<span>窗口模式</span>' +
      '<div class="seg" id="setWinMode" role="group" aria-label="窗口模式">' +
      '<button type="button" class="seg-btn" data-win="fullscreen">全屏</button>' +
      '<button type="button" class="seg-btn" data-win="float">悬浮窗</button>' +
      '</div>';
    row.parentNode.insertBefore(div, row);
    var seg = div.querySelector('#setWinMode');
    var cur = (cfg && cfg.androidMode) === 'float' ? 'float' : 'fullscreen';
    var sync = function () {
      Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-win') === cur ? 'true' : 'false');
      });
    };
    sync();
    Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) {
      b.addEventListener('click', function () {
        var want = b.getAttribute('data-win');
        if (!want || want === cur) return;
        cur = want;
        sync();
        if (cfg) { cfg.androidMode = want; persist(); }
        document.documentElement.classList.toggle('float', want === 'float');
        if (want === 'float') { ensureOverlayThenApply(); }
        else {
          soft('setWindowMode', {
            mode: 'fullscreen', x: cfg && cfg.x, y: cfg && cfg.y,
            width: cfg && cfg.width, height: cfg && cfg.height
          }, null);
        }
        soft('toast', { text: want === 'float' ? '已切换为悬浮窗' : '已切换为全屏' }, null);
        /* v2.5.3-fix：不能 reload！真机实测（Flyme）：切到悬浮窗后 reload 会把刚
         * 套上的小窗整个打没（WebView 重建时窗口属性被重置/进程直接退出），用户
         * 看到"悬浮窗一闪而过就没"。所有状态在上面已经活着应用完了：cfg 已存、
         * float 类已挂、原生 setWindowMode 已调、录屏采集的窗口矩形由原生侧
         * capture.setWindowRect 同步 —— 没有任何一步需要重启页面。 */
      });
    });
  }

  function adaptChrome() {
    document.documentElement.classList.add('mobile');
    HIDE_ROWS.forEach(hideRowById);
    HIDE_ROW_WITH.forEach(hideRowById);
    // 隐藏整块：U 盘区、缩放手柄、透明度浮条（设置里的透明度仍然可用）
    ['usbSection', 'resizeHandle', 'opacityBar'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.setAttribute('data-mobile-hide', '1');
    });
    // 右键菜单里"隐藏到托盘 / 锁定位置"在安卓没有对应物
    Array.prototype.forEach.call(document.querySelectorAll('.ctx-item'), function (b) {
      var act = b.getAttribute('data-act');
      if (act === 'hide' || act === 'lock') b.setAttribute('data-mobile-hide', '1');
    });
    rewriteCopy();
    injectWindowModeRow();
    applyWindowMode();
    clampContextMenu();
  }

  /* 长按菜单的坐标由 app.js 按"桌面 480x420 窗口"算，手机上在屏幕底部/右侧长按时
   * 会有一部分落到视口外。这里只做一次坐标回拉（不改 app.js）：等菜单显示后量一下
   * 尺寸，越界就改写它的 left/top 内联值。 */
  function clampContextMenu() {
    var menu = document.getElementById('ctxMenu');
    if (!menu || typeof MutationObserver !== 'function') return;
    var pad = 8;
    var fix = function () {
      if (menu.classList.contains('hidden')) return;
      var r = menu.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      var left = parseFloat(menu.style.left);
      var top = parseFloat(menu.style.top);
      if (!isFinite(left)) left = r.left;
      if (!isFinite(top)) top = r.top;
      var nl = Math.max(pad, Math.min(left, vw - r.width - pad));
      var nt = Math.max(pad, Math.min(top, vh - r.height - pad));
      if (nl !== left) menu.style.left = nl + 'px';
      if (nt !== top) menu.style.top = nt + 'px';
    };
    new MutationObserver(function () {
      if (menu.classList.contains('hidden')) return;
      // 显示的那一帧还是 transition 的起始态，量不到真实高度：下一帧再量
      requestAnimationFrame(fix);
    }).observe(menu, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  /* 安卓物理返回键：默认行为会直接退出 Activity（桌面版"退出"才该这样）。
   * Capacitor 不拦返回键，所以这里用一个历史条目兜住第一次返回：
   * 有面板/菜单开着先关掉，否则退到后台而不是杀掉进程。 */
  function wireBackButton() {
    history.replaceState({ fcpRoot: 1 }, '');
    window.addEventListener('popstate', function () {
      var panel = document.getElementById('settingsPanel');
      var menu = document.getElementById('ctxMenu');
      var modal = document.getElementById('itemModal');
      if (panel && !panel.classList.contains('hidden')) {
        var close = document.getElementById('btnSettingsClose');
        if (close) close.click();
      } else if (menu && !menu.classList.contains('hidden')) {
        menu.classList.add('hidden');
      } else if (modal && !modal.classList.contains('hidden')) {
        var cancel = document.getElementById('btnItemCancel');
        if (cancel) cancel.click();
      } else {
        soft('minimize', {}, null);
      }
      history.pushState({ fcpRoot: 1 }, '');
    });
    history.pushState({ fcpRoot: 1 }, '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { adaptChrome(); wireBackButton(); });
  } else {
    adaptChrome(); wireBackButton();
  }

  /* 启动时预热：系统明暗 + 壁纸（两者都是原生调用，异步进行，不挡首帧） */
  refreshSystemAppearance().then(function () { return refreshWallpaperUI(); });

  window.widgetAPI = API;
})();
