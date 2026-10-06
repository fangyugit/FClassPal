/* 渲染层冒烟测试：验证触摸拖拽、锁定位置、自启动开关（mock 模式） */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf-8');
const css = fs.readFileSync(path.join(__dirname, 'renderer', 'style.css'), 'utf-8');
const js = fs.readFileSync(path.join(__dirname, 'renderer', 'app.js'), 'utf-8');
const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf-8');
const preloadJs = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf-8');
// 位移贴图脚本：v2.3.0 起必须是 PNG data URL（feImage 不再渲染 JPEG）
const mapJs = fs.readFileSync(path.join(__dirname, 'renderer', 'lg-displacement-map.js'), 'utf-8');
/* 剥掉块注释再断言"某 API 已移除"：注释里引用旧写法是常事
 * （比如"之前用 setBackgroundMaterial('mica')"），不剥就会误报。 */
const mainNC = mainJs.replace(/\/\*[\s\S]*?\*\//g, '');

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true   // 提供 requestAnimationFrame
});
const { window } = dom;
const { document } = window;

window.alert = () => {};
window.confirm = () => true;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name); }
}

/* 取出某条 CSS 规则的完整声明块。用 indexOf(sel + ' {') 精确定位，
 * 避免 "/\.opacity-bar\s*\{[\s\S]{0,N}/" 这种定长窗口正则 —— 规则一改长度
 * 断言就会莫名其妙失效或误报。 */
function ruleBlock(sel) {
  const i = css.indexOf(sel + ' {');
  if (i < 0) return '';
  const j = css.indexOf('}', i);
  return j < 0 ? '' : css.slice(i, j + 1);
}
/* v2.0 起每套风格都是自足的设计系统（不再有 theme-flat 共底），
 * 选择器前缀统一是 body.theme-<name>，取规则块时给出主题名即可。
 * glass 是基线皮肤（body 上不加任何主题类），它的规则走无前缀的基线块。 */
function ruleBlockTheme(theme, sel) {
  return ruleBlock('body.theme-' + theme + ' ' + sel);
}
/* 取某套主题的 token 块（body.theme-X { ... }）。
 * ※ 前导换行不能省：prefers-reduced-motion 里有一组
 *   "body.theme-md3, body.theme-fluent, ..., body.theme-kitty {" 的选择器列表，
 *   不加换行会先命中那一条，取到的是"动效归零块"而不是主题 token。 */
function themeTokens(theme) {
  const i = css.indexOf('\nbody.theme-' + theme + ' {');
  if (i < 0) return '';
  const j = css.indexOf('}', i);
  return j < 0 ? '' : css.slice(i, j + 1);
}

(async () => {
  // CSS 检查：app-region 必须已移除（触摸不响应的根因）
  console.log('[CSS]');
  check('titlebar 不再使用 -webkit-app-region: drag', !/\.titlebar[^{]*\{[^}]*app-region:\s*drag/.test(css));
  check('titlebar 保留 touch-action: none', /touch-action:\s*none/.test(css));
  check('锁定态隐藏缩放手柄', /body\.locked \.resize-handle\s*\{\s*display:\s*none/.test(css));

  // 液态玻璃 + 去 emoji 检查
  console.log('[LiquidGlass UI]');
  const isEmojiCp = (cp) => (cp >= 0x1F000 && cp <= 0x1FAFF) || cp === 0xFE0F ||
    (cp >= 0x2600 && cp <= 0x27BF) || cp === 0x2B50 || cp === 0x2B55 || cp === 0x200D || cp === 0x20E3;
  const countEmoji = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { if (isEmojiCp(s.codePointAt(i))) n++; if (s.codePointAt(i) > 0xFFFF) i++; } return n; };
  check('界面源码（html/css/js）无 emoji', countEmoji(html + css + js) === 0);
  check('内联 SVG 图标库存在', html.includes('id="svgDefs"') && html.includes('<use href="#i-gear"'));
  check('菜单图标均为 SVG use', /data-act="add"[\s\S]{0,120}?<use href="#i-plus"/.test(html) && !/➖|➕|✏️|⚙️|👁️|🔒/.test(html));
  check('预设图标下拉无 emoji', !/📘|📁|⚙️|⭐|🛡️|📷/.test(html));
  check('CSS 含 sheen 光斑层', css.includes('.sheen') && css.includes('radial-gradient(circle'));
  check('CSS hover 光感仅鼠标设备生效', /@media \(hover: hover\) and \(pointer: fine\)/.test(css) && /\.item:hover\s*\{/.test(css));
  check('CSS 浏览器预览有渐变桌面', css.includes('body.preview'));
  check('app.js 提供 svgIcon 助手', js.includes('function svgIcon'));
  check('app.js 锁定菜单切 SVG+label', js.includes(".ctx-label") && js.includes('#i-unlock'));
  check('app.js sheen 光斑 rAF 跟随', js.includes('sheenRaf') && js.includes('translate3d'));
  check('app.js 预览模式加 preview 背景', js.includes("classList.add('preview')"));

  /* 液态玻璃折射（v1.6）：改为 liquid-glass-react 的 standard 模式
   * —— 预烘焙置换贴图 + feImage + 三次 feDisplacementMap，逐条对齐参考实现。
   * 上一版"Chromium 不渲染 feImage"的结论是错的，已用 A/B 截图证伪：
   * 开关滤镜两张图在玻璃中心差 0.00/0%、边缘带 102/168（72%/95%）、玻璃外 0.03/0%。 */
  console.log('[LiquidGlass v1.6 - standard refraction]');
  check('html: 液态玻璃滤镜 #liquidGlass 存在', html.includes('id="liquidGlass"'));
  check('html: feImage 载入预烘焙置换贴图（A/B 实测可用，别再退回 Sobel 现算）',
    /<feImage id="lgMap"[\s\S]{0,200}preserveAspectRatio="xMidYMid slice"/.test(html) &&
    (html.match(/<feImage/g) || []).length === 1);
  check('html: 三次 feDisplacementMap（RGB 三通道色差）',
    (html.match(/<feDisplacementMap/g) || []).length === 3);
  check('html: scale 取负号 -70/-77/-84（standard = -displacementScale，负号=向中心收缩 0.855x）',
    /scale="-70"/.test(html) && /scale="-77"/.test(html) && /scale="-84"/.test(html));
  check('html: xChannelSelector=R / yChannelSelector=B（贴图的 Y 分量在 B 通道）',
    (html.match(/xChannelSelector="R" yChannelSelector="B"/g) || []).length === 3);
  check('html: 边缘遮罩 discrete "0 0.1 1" + 反相遮罩 table "1 0"',
    /feFuncA type="discrete" tableValues="0 0\.1 1"/.test(html) &&
    /feFuncA type="table" tableValues="1 0"/.test(html));
  check('html: 滤镜区域 -35%/170% + sRGB 色彩空间（与参考实现一致）',
    /id="liquidGlass" x="-35%" y="-35%" width="170%" height="170%" color-interpolation-filters="sRGB"/.test(html));
  check('html: 贴图独立成文件且在 app.js 之前加载（app.js 启动时填 href）',
    fs.existsSync(path.join(__dirname, 'renderer', 'lg-displacement-map.js')) &&
    /lg-displacement-map\.js[\s\S]{0,120}src="app\.js"/.test(html));
  check('html: 四层结构 env-layer / glass-warp / glass-veil / sheen',
    html.includes('id="glassWarp"') && html.includes('id="glassVeil"') &&
    html.includes('id="envLayer"') && html.includes('id="deskCanvas"'));
  check('app.js: 把贴图 dataURL 填进 #lgMap 的 href（含 xlink 兜底）',
    /getElementById\('lgMap'\)[\s\S]{0,400}setAttribute\('href',\s*url\)/.test(js) &&
    /setAttributeNS\('http:\/\/www\.w3\.org\/1999\/xlink'/.test(js));
  check('app.js: 能力探测改用 CSS.supports(filter, url(...))',
    /CSS\.supports\('filter',\s*'url\(#liquidGlass\)'\)/.test(js));
  check('html: 双层边光环 div（screen + overlay）',
    html.includes('lg-border--screen') && html.includes('lg-border--overlay'));
  /* 折射挂在 filter 上，不是 backdrop-filter —— Chromium 不认 backdrop-filter 里的
   * url()，一个不合法函数会让整条声明作废，这就是上一版"只有模糊没有折射"的根因。 */
  check('css: 折射挂在 .glass-warp 的 filter 属性上',
    /url\(#liquidGlass\)/.test(ruleBlock('body.lg-ready .glass-warp')));
  /* 断言只看真正的声明：注释里会**引用**这个反例来说明历史坑，
   * 直接对原文跑正则会被注释命中而误报。 */
  const cssNC = css.replace(/\/\*[\s\S]*?\*\//g, '');
  check('css: backdrop-filter 里绝不再出现 url()（会让整条声明作废）',
    !/backdrop-filter:[^;]*url\(#/.test(cssNC));
  check('css: .glass-warp 自身不画颜色（面纱会被一起位移 → 白边重影 + 压掉折射对比）',
    !/background/.test(ruleBlock('.glass-warp')) && !/box-shadow/.test(ruleBlock('.glass-warp')));
  check('css: blur 走 --lg-blur 变量、默认 6px / saturate 140%（参考实现 4 + 0.0625*32）',
    /blur\(var\(--lg-blur, 6px\)\) saturate\(140%\)/.test(ruleBlock('.glass-warp')));
  check('css: 三层 z-index 排序 env(-1) < warp(0) < veil(1)',
    /\.widget > \.env-layer\s*\{\s*z-index:\s*-1/.test(css) &&
    /\.widget > \.glass-warp\s*\{\s*z-index:\s*0/.test(css) &&
    /\.widget > \.glass-veil\s*\{\s*z-index:\s*1/.test(css));
  check('css: 已移除旧的 .widget::before 玻璃层（改由 .glass-veil 承担）',
    !/\.widget::before\s*\{/.test(css));
  check('css: 边光环空心 mask（content-box + exclude/xor）',
    css.includes('mask-composite: exclude') && css.includes('-webkit-mask-composite: xor'));
  check('css: 边光环渐变用 --lg-angle/--lg-glow 变量',
    css.includes('var(--lg-angle, 135deg)') && css.includes('var(--lg-glow, 0)'));
  // v1.8：拖动与缩放分开。只挪位置时**保留模糊**，否则按下/松手那两帧会"掉画质"，
  // 用户反馈就是"拖动会闪"；只有改尺寸才需要整套滤镜全关（图层要重新分配）。
  check('css: 拖动期间只摘折射滤镜（模糊必须留着，否则一按就闪）',
    /filter:\s*none\s*!important/.test(ruleBlock('body.is-moving .glass-warp')) &&
    !/backdrop-filter/.test(ruleBlock('body.is-moving .glass-warp')));
  check('css: 缩放期间才整套滤镜全关',
    /body\.is-resizing \.glass-warp[\s\S]{0,240}backdrop-filter:\s*none !important/.test(css) &&
    /body\.is-resizing \.glass-warp[\s\S]{0,240}filter:\s*none !important/.test(css));
  check('css: 拖动/缩放期间隐藏边光环',
    /body\.is-moving \.lg-border[\s\S]{0,80}display:\s*none/.test(css));
  check('app.js: enableLiquidGlass 能力探测通过后才点亮 lg-ready',
    /* ※ 这里用惰性 `[\s\S]*?` 而不是定长窗口 {0,N}：窗口一改长度断言就会突然变红
     *   （实测函数里补两句注释，间距就从 600 以内涨到 639，白跑一轮）。
     *   惰性 + 顺序本身就是"探测通过后才点亮"要表达的意思。 */
    (js.match(/classList\.add\('lg-ready'\)/g) || []).length === 1 &&
    /function enableLiquidGlass[\s\S]*?if \(!CSS\.supports\('filter', 'url\(#liquidGlass\)'\)\) return;[\s\S]*?classList\.add\('lg-ready'\)/.test(js));
  check('app.js: 鼠标驱动 --lg-angle/--lg-glow（sheen rAF 内）',
    js.includes("setProperty('--lg-angle'") && js.includes("setProperty('--lg-glow'"));

  // 折射基底：真实壁纸按屏幕坐标画进 #envLayer（mica 是 DWM 层，CSS 看不到）
  console.log('[LiquidGlass - wallpaper substrate]');
  check('html: 存在 #envLayer 折射基底层', /id="envLayer"/.test(html));
  check('css: .env-layer 绝对定位铺满',
    /position:\s*absolute/.test(ruleBlock('.env-layer')) || /\.env-layer\s*\{[\s\S]{0,120}position:\s*absolute/.test(css));
  check('css: .widget > .env-layer 压到玻璃层之下（z-index:-1）',
    /\.widget > \.env-layer\s*\{[^}]*z-index:\s*-1/.test(css));
  check('main.js: 注册 get-wallpaper IPC', /ipcMain\.handle\('get-wallpaper'/.test(mainJs));
  check('main.js: 读注册表取壁纸路径 + 计算平铺矩形',
    /function readRegValue/.test(mainJs) && /function wallpaperRect/.test(mainJs) &&
    /HKCU\\\\Control Panel\\\\Desktop/.test(mainJs));
  /* v1.7：放弃 mica。它要求 transparent:false（与 DWM 材质互斥），窗口会变成
   * 不透明矩形 —— CSS 的 border-radius 只裁掉了玻璃层，四角外面露出一圈方形
   * 底色，就是用户报的"主界面圆角有问题"。而且 mica 画在窗口外，Chromium 的
   * backdrop-filter 根本采不到，对模糊毫无贡献。现在一律 transparent 窗口。 */
  check('main.js: 窗口始终 transparent（圆角靠 per-pixel alpha，不被 DWM 底色填满）',
    /transparent:\s*true/.test(mainJs) && !/transparent:\s*!useMica/.test(mainJs));
  check('main.js: 已移除 mica（它要求不透明窗口，会在四角露出方形底色）',
    !/setBackgroundMaterial/.test(mainNC) && !/useMica/.test(mainNC));

  // 换壁纸要同步（v1.7）：静态基底最怕"开窗那一刻冻结"
  check('main.js: 壁纸指纹 = 路径 + mtime + 填充方式（幻灯片轮播只改 mtime）',
    /function wallpaperSignature/.test(mainJs) && /meta\.mtime/.test(mainJs));
  check('main.js: 轮询壁纸变更并推送 wallpaper-changed',
    /function checkWallpaperChanged/.test(mainJs) &&
    /send\('wallpaper-changed'/.test(mainJs) &&
    /setInterval\(checkWallpaperChanged/.test(mainJs));
  check('main.js: 退出时清理壁纸监听',
    /function stopWallpaperWatcher/.test(mainJs) && /stopWallpaperWatcher\(\)/.test(mainJs));
  check('preload: 暴露 onWallpaperChanged',
    /onWallpaperChanged:/.test(preloadJs));
  check('app.js: 收到 wallpaper-changed 就重画基底（含配色）',
    /API\.onWallpaperChanged/.test(js) && /onWallpaperChanged\(\(info\)[\s\S]{0,200}applyWallpaper/.test(js));
  check('app.js: refreshWallpaper 支持 force 重取（换壁纸时不能只本地换算偏移）',
    /function refreshWallpaper\(force\)/.test(js) && /if \(!force && wallInfo/.test(js));
  check('app.js: refreshWallpaper 用 setTimeout 合并节流（窗口隐藏时 rAF 不触发）',
    /function refreshWallpaper[\s\S]{0,600}setTimeout\(/.test(js) &&
    !/function refreshWallpaper[\s\S]{0,600}requestAnimationFrame/.test(js));
  check('app.js: repositionWallpaper 用屏幕坐标 bounds（不用 getBoundingClientRect）',
    /function repositionWallpaper[\s\S]{0,500}bounds\.x/.test(js) &&
    !/function repositionWallpaper[\s\S]{0,500}getBoundingClientRect/.test(js));
  check('app.js: 已有 ax/ay 时跳过 IPC 直接本地换算',
    /wallInfo\s*&&\s*typeof wallInfo\.ax === 'number'\)\s*\{\s*repositionWallpaper\(\);\s*return;/.test(js));

  /* 实时玻璃底材（v1.6）：静态壁纸快照解决不了"模糊不是实时的" ——
   * 快照在窗口打开那一刻就定死了。真正实时必须采屏幕。 */
  console.log('[LiquidGlass v1.6 - realtime backdrop]');
  check('html: #deskCanvas 画布嵌在 #envLayer 内',
    /id="envLayer"[\s\S]{0,300}id="deskCanvas"/.test(html));
  check('css: .desk-canvas 默认透明，body.realtime 时淡入',
    /opacity:\s*0/.test(ruleBlock('.desk-canvas')) &&
    /body\.realtime \.desk-canvas\s*\{\s*opacity:\s*1/.test(css));
  check('main.js: 注册 setDisplayMediaRequestHandler 放行屏幕采集（跳过系统选择器）',
    /setDisplayMediaRequestHandler/.test(mainJs) && /desktopCapturer\.getSources/.test(mainJs));
  check('main.js: 多显示器时优先放行窗口所在那块（按 display_id 匹配）',
    /String\(s\.display_id\) === info\.id/.test(mainJs));
  check('main.js: 开启时 setContentProtection(true) 把本窗口从采集里排除（否则无限镜面）',
    /mainWindow\.setContentProtection\(true\)/.test(mainJs));
  check('main.js: 关闭时解除内容保护', /mainWindow\.setContentProtection\(false\)/.test(mainJs));
  check('main.js: 提供 realtime-start / realtime-stop / get-display-info',
    /ipcMain\.handle\('realtime-start'/.test(mainJs) &&
    /ipcMain\.handle\('realtime-stop'/.test(mainJs) &&
    /ipcMain\.handle\('get-display-info'/.test(mainJs));
  check('preload: 暴露 startRealtime / stopRealtime / getDisplayInfo',
    /startRealtime:/.test(preloadJs) && /stopRealtime:/.test(preloadJs) && /getDisplayInfo:/.test(preloadJs));
  check('app.js: getDisplayMedia 取流 → 按屏幕坐标裁帧画进 canvas',
    /navigator\.mediaDevices\.getDisplayMedia/.test(js) &&
    /function drawRealtimeFrame/.test(js) && /rt\.ctx\.drawImage/.test(js));
  check('app.js: 帧率节流到 15fps（桌面底材不需要 60fps）', /const RT_FPS = 15/.test(js));
  check('app.js: 裁帧坐标用屏幕 bounds × scaleFactor，并校正流的降采样比例',
    /bounds\.x - rt\.info\.x/.test(js) && /rt\.info\.scaleFactor/.test(js) && /vw \/ Math\.max\(1, rt\.info\.w/.test(js));
  check('app.js: 采集失败/被拒时静默退回静态基底（不弹错、不白屏）',
    /function stopRealtimeBackdropQuiet/.test(js) && /track\.addEventListener\('ended'/.test(js));
  check('app.js: 窗口挪动后立刻补帧 + 定时刷新显示器几何（跨屏拖动要用新值）',
    /function refreshRealtimeBounds/.test(js) && /API\.getDisplayInfo\(\)/.test(js));
  check('app.js: 缺用户手势被拒时首次交互重试一次（有界，不会重试风暴）',
    /function armRealtimeRetry/.test(js) && /rtRetryArmed/.test(js) &&
    /addEventListener\('pointerdown', once, true\)/.test(js));
  check('设置面板有实时模糊开关 + 状态行 + 截图副作用说明',
    html.includes('id="setRealtime"') && html.includes('id="realtimeInfo"') &&
    /系统截图/.test(html));
  /* 默认"只模糊壁纸"：实时采集是可选增强，不是默认行为 */
  check('默认配置 realtime:false（只模糊壁纸，不逐帧采屏）',
    /realtime:\s*false/.test(mainJs));
  check('app.js: 只有显式开启才起采集（config.realtime === true）',
    /config\.realtime === true/.test(js));

  /* ---- U 盘弹出（v1.7）：弹 USB 父节点，不是磁盘节点 ---- */
  console.log('[USB eject - USB parent devnode]');
  check('main.js: P/Invoke 引入 CM_Get_Parent / CM_Get_Device_IDW',
    /CM_Get_Parent/.test(mainJs) && /CM_Get_Device_IDW/.test(mainJs));
  /* PS 里写的是 -match '^USB\\'：^ 保证只匹配设备 ID 开头，带反斜杠保证不会
   * 误中 USBSTOR\（那正是"命令成功但盘符还在"的旧坑）。源码里因为 JS 字符串
   * 转义，反斜杠会多出一层，所以这里只数"至少 4 个连续反斜杠"而不写死数量。 */
  check('main.js: 沿父节点上溯直到设备 ID 以 USB\\ 开头（不能匹配 USBSTOR\\）',
    /for \(\$i = 0; \$i -lt 12/.test(mainJs) && /-match[^\n]*USB\\{4,}/.test(mainJs));
  check('main.js: 上溯失败时退回磁盘节点本身（仍能尝试弹出）',
    /if \(-not \$found\) \{ \$target = \$dev/.test(mainJs));
  check('main.js: 用 WMI 关联链取 PNPDeviceID（免管理员，优先）',
    /Win32_LogicalDiskToPartition/.test(mainJs) && /Win32_DiskDriveToDiskPartition/.test(mainJs));
  check('main.js: Get-Partition 作为取 PNPDeviceID 的兜底路径',
    /Get-Partition -DriveLetter \$l/.test(mainJs));
  check('main.js: 加了 WMI Win32_Volume.Dismount 兜底层',
    /Win32_Volume/.test(mainJs) && /MethodName Dismount/.test(mainJs) &&
    /Permanent = \$true/.test(mainJs));
  check('main.js: 每层都验证盘符真的消失才算成功（杜绝 DoIt 假成功）',
    /if \(await waitGone\(/.test(mainJs));
  check('main.js: 失败时回传 detail（各层真实输出，便于定位）',
    /detail:\s*detail\.join/.test(mainJs));
  check('app.js: 弹出失败把 detail 打到控制台',
    /r\.detail[\s\S]{0,80}console\.warn/.test(js));

  /* ---- U 盘弹出 v2.2.3：错误码映射 + 卷级弹出层 + 提权重试 ---- */
  console.log('[USB eject v2.2.3]');
  /* ★ 这两个表旧版是错的：51 被当成"设备正忙"、9 被当成"权限不足"，
   *   而 51 = CR_ACCESS_DENIED（权限），9 = InsufficientPower（供电）。
   *   映射写反 → 用户看到"设备正忙"，完全判断不出是权限问题。 */
  check('main.js: VETO 表把 9 映射为"供电不足"（不是权限）',
    /9: '设备供电不足/.test(mainJs) && !/9: '权限不足/.test(mainJs));
  check('main.js: VETO 表把 12 映射为"权限不足 / 需要管理员"',
    /12: '权限不足/.test(mainJs));
  check('main.js: VETO 表补齐 5 = 未关闭的文件句柄（最常见的占用原因）',
    /5: '该 U 盘上还有未关闭的文件句柄/.test(mainJs));
  check('main.js: CM 表把 51 映射为 CR_ACCESS_DENIED（旧版误写成"设备正忙"）',
    /51: '访问被拒绝（CR_ACCESS_DENIED）/.test(mainJs) && !/51: '设备正忙/.test(mainJs));
  check('main.js: CM 表覆盖 13/23/40/52 等关键返回码',
    /13: '找不到该设备节点/.test(mainJs) && /23: '系统拒绝了移除请求/.test(mainJs) &&
    /40: '该设备不允许被停用/.test(mainJs) && /52: '系统不支持此调用/.test(mainJs));
  check('main.js: 新增卷级弹出层（LOCK/DISMOUNT/MEDIA_REMOVAL/EJECT + 删挂载点）',
    /function buildVolumeEjectScript/.test(mainJs) &&
    /0x00090018u/.test(mainJs) &&   // FSCTL_LOCK_VOLUME
    /0x00090020u/.test(mainJs) &&   // FSCTL_DISMOUNT_VOLUME
    /0x002D1400u/.test(mainJs) &&   // IOCTL_STORAGE_MEDIA_REMOVAL
    /0x002D4808u/.test(mainJs) &&   // IOCTL_STORAGE_EJECT_MEDIA
    /DeleteVolumeMountPointW/.test(mainJs));
  check('main.js: 卷级层先要读写权限、被拒再退只读（可移动卷免管理员）',
    /0xC0000000u : 0x80000000u/.test(mainJs));
  check('main.js: CM 弹出逻辑抽成函数（普通模式与提权模式共用一份）',
    /function buildCmEjectFn/.test(mainJs) && /function InvokeCmEject\(\$l\)/.test(mainJs));
  check('main.js: 失败时回传 needAdmin（界面据此给出提权重试）',
    /needAdmin: needAdmin \|\| driveExists\(\)/.test(mainJs));
  check('main.js: 提供提权弹出通道 eject-drive-elevated（写临时脚本 → RunAs → 读回结果）',
    /eject-drive-elevated/.test(mainJs) && /-Verb RunAs/.test(mainJs) &&
    /fclasspal-eject-/.test(mainJs));
  check('main.js: 用户取消 UAC 时给出明确提示',
    /已取消管理员授权/.test(mainJs));
  check('preload: 暴露 ejectDriveElevated',
    /ejectDriveElevated:/.test(preloadJs));
  check('app.js: 弹出失败且 needAdmin 时按钮变「管理员重试」',
    /ejectBtn\.dataset\.admin/.test(js) && /'管理员重试'/.test(js) &&
    /API\.ejectDriveElevated/.test(js));
  check('app.js: 先走普通弹出，第二次点击才提权（不无脑弹 UAC）',
    /const asAdmin = ejectBtn\.dataset\.admin === '1'/.test(js) &&
    /if \(asAdmin\) \{/.test(js));

  /* ---- 文件夹快捷方式（v2.2.3）---- */
  console.log('[Folder shortcut v2.2.3]');
  check('main.js: 新增 select-folder 通道，用 openDirectory（Windows 的 openFile 选不到目录）',
    /ipcMain\.handle\('select-folder'/.test(mainJs) && /properties: \['openDirectory'/.test(mainJs));
  check('main.js: 旧 select-file 仍是 openFile（没被改成 openDirectory 走过头）',
    /ipcMain\.handle\('select-file'[\s\S]{0,120}properties: \['openFile'\]/.test(mainJs));
  check('main.js: open-target 支持 folder 类型（否则点图标什么都不发生）',
    /item\.type === 'app' \|\| item\.type === 'file' \|\| item\.type === 'folder'/.test(mainJs));
  check('preload: 暴露 selectFolder',
    /selectFolder: \(\) => ipcRenderer\.invoke\('select-folder'\)/.test(preloadJs));
  check('html: 类型下拉栏把"文件"和"文件夹（目录）"拆成两项',
    /<option value="folder">文件夹（目录）<\/option>/.test(html) &&
    /<option value="file">文件<\/option>/.test(html) &&
    !/文件 \/ 文件夹/.test(html));
  check('app.js: 选择按钮对 folder 类型调用 selectFolder',
    /type === 'folder'\) p = await API\.selectFolder\(\)/.test(js));
  check('app.js: 选到文件夹后自动套用内置文件夹图标（用户手动选过就不动）',
    /type === 'folder'[\s\S]{0,220}setIconState\('folder', '', ''\)/.test(js));
  check('app.js: folder 类型隐藏"取图标"（目录没有专属图标）',
    /local && t !== 'folder'/.test(js) || /t !== 'folder'\) \? 'inline-block'/.test(js));
  check('app.js: 目标框提示语与占位符跟着类型变（folder 给路径示例）',
    /function syncTargetUI/.test(js) && /教学资料/.test(js));

  /* ---- MD3 风格（v1.7）---- */
  console.log('[MD3 theme]');
  check('main.js: 打包好的 Monet 库（ESM 在 asar 里 import 不了，所以预打成 CJS）',
    fs.existsSync(path.join(__dirname, 'vendor', 'monet.js')) &&
    /require\('\.\/vendor\/monet\.js'\)/.test(mainJs) &&
    fs.existsSync(path.join(__dirname, 'vendor', 'monet-entry.js')));
  check('main.js: 取色走官方 QuantizerCelebi + Score（不是自己数色相桶）',
    /QuantizerCelebi\.quantize/.test(mainJs) && /Score\.score/.test(mainJs) &&
    !/function pickSourceHue/.test(mainJs));
  check('main.js: toBitmap 按 BGRA 取通道（Windows 上不是 RGBA）',
    /argbFromRgb\(buf\[i \+ 2\], buf\[i \+ 1\], buf\[i\]\)/.test(mainJs));
  check('main.js: 由 source 派生整套 tonal palette（SchemeTonalSpot + MaterialDynamicColors）',
    /new monet\.SchemeTonalSpot/.test(mainJs) && /MaterialDynamicColors/.test(mainJs) &&
    /MD3_ROLE_MAP/.test(mainJs));
  check('main.js: 灰白/纯黑壁纸退回基线紫且标 dynamic=false（暗色模式也照给不误）',
    /MD3_BASELINE\s*=\s*'#6750a4'/.test(mainJs) && /best === fallback/.test(mainJs) &&
    /monetSchemePalette\(monetSourceFromHex\(MD3_BASELINE\), false, isDark\)/.test(mainJs));
  check('main.js: 调色板按取色参数缓存（换壁纸/换主色才重算）',
    /PALETTE_CACHE/.test(mainJs) && /paletteCacheSet/.test(mainJs));
  check('main.js: 手动指定主色走同一条派生链路',
    /function monetSourceFromHex/.test(mainJs) && /colorMode === 'manual'/.test(mainJs));
  check('main.js: get-wallpaper 返回 palette（await 后才能塞进返回值）',
    /palette: await buildPalette/.test(mainJs));
  check('main.js: get-palette IPC（换主色不必重算整套壁纸坐标）',
    /ipcMain\.handle\('get-palette'/.test(mainJs));
  check('main.js: 默认配置含 theme / colorMode / accentColor（v2.4.0 默认主题回到液态玻璃）',
    /theme:\s*'glass'/.test(mainJs) && /colorMode:\s*'auto'/.test(mainJs) &&
    /accentColor:\s*'#6750A4'/.test(mainJs));
  check('html: 设置面板有主题下拉栏（v2.2.2：10 套主题不再用分段按钮）',
    html.includes('id="themeSelect"') && !html.includes('id="themeSeg"'));
  check('app.js: applyTheme 只给非 glass 主题挂 theme-<name>（glass 是基线皮肤，不加类）',
    /function applyTheme/.test(js) &&
    /FLAT_THEMES\.forEach\(\(n\) => document\.body\.classList\.toggle\('theme-' \+ n/.test(js) &&
    /aria-pressed/.test(js));
  check('app.js: 调色板同时写 hex 与 -rgb 三元组（供 rgb(R G B / A) 用）',
    /function hexToRgbTriplet/.test(js) &&
    /setProperty\('--md3-' \+ role \+ '-rgb'/.test(js));
  check('app.js: 切到 MD3 时立刻套用已取到的壁纸配色（明暗方案对得上才直接用）',
    /else if \(have\) \{[\s\S]{0,60}?applyPalette\(wallInfo\.palette\)/.test(js));
  check('css: md3 主表面是平的 tonal 色 + 1px outline（无渐变无内阴影）',
    /--t-veil:\s*rgb\(var\(--md3-surface-rgb\) \/ calc/.test(ruleBlockTheme('md3', '.glass-veil')) &&
    /border:\s*1px solid var\(--t-veil-border\)/.test(ruleBlockTheme('md3', '.glass-veil')) &&
    !/linear-gradient/.test(ruleBlockTheme('md3', '.glass-veil')));
  check('css: md3 关掉折射与边光（filter:none + 隐藏 sheen/lg-border）',
    /filter:\s*none\s*!important/.test(ruleBlockTheme('md3', '.glass-warp')) &&
    /body\.theme-md3 \.sheen,[\s\S]{0,80}display:\s*none\s*!important/.test(css));
  check('css: --t-veil 声明在 .glass-veil 规则内（body 层取不到 #widget 上的 --glass-alpha）',
    /* 这是踩过的坑：--glass-alpha 由 app.js 写在 #widget 上，若把 --t-veil 放进
     * body 的 token 块，var() 替换失败会让整条 background 变成 invalid-at-computed-
     * value-time，面纱整个消失只剩描边。所以断言它必须和 background 同一条规则。 */
    /--t-veil:[\s\S]{0,300}?background:\s*var\(--t-veil\)/.test(ruleBlockTheme('md3', '.glass-veil')) &&
    /--t-veil:[\s\S]{0,400}?background:\s*var\(--t-veil\)/.test(ruleBlockTheme('kitty', '.glass-veil')));
  check('css: md3 形状标度 28/16/12/8，按钮全圆',
    /--md3-shape-xl:\s*28px/.test(css) && /--md3-shape-l:\s*16px/.test(css) &&
    /--md3-shape-m:\s*12px/.test(css) && /--md3-shape-s:\s*8px/.test(css) &&
    /border-radius:\s*999px/.test(css));
  check('css: md3 卡片有 state layer（::before 叠主色，hover 8% / active 10%）',
    /body\.theme-md3 \.item::before/.test(css) &&
    /body\.theme-md3 \.item:hover::before[\s\S]{0,60}opacity:\s*0\.08/.test(css) &&
    /body\.theme-md3 \.item:active::before[\s\S]{0,60}opacity:\s*0\.10/.test(css));
  check('css: md3 ripple 动画', /\.ripple\s*\{/.test(css) && /@keyframes md3-ripple/.test(css));
  check('app.js: ripple 只挂按钮，且不给 .item 加 overflow:hidden（会裁掉删除按钮）',
    /function spawnRipple/.test(js) &&
    /closest\('\.usb-btn[\s\S]{0,160}panel-close'\)/.test(js) &&
    !/closest\('\.item,/.test(js));
  check('app.js: ripple 只在 MD3 生效（其余风格各有自己的按压语言）',
    (js.match(/currentTheme !== 'md3'/g) || []).length >= 2 &&
    /ripple 是 MD3 的按压语言/.test(js) &&
    /Reveal 光斑/.test(js));
  check('css: md3 把 --text/--accent 重定向到 tonal 角色（一次换掉一大片）',
    /--text:\s*var\(--md3-on-surface\)/.test(css) &&
    /--accent:\s*var\(--md3-primary\)/.test(css));
  check('css: md3 分段按钮样式（两风格共用 .seg）',
    /\.seg\s*\{/.test(css) && /\.seg-btn\[aria-pressed="true"\]/.test(css));

  /* ---- MD3 动效 + 主色选择（v1.8）---- */
  console.log('[MD3 motion & color source]');
  check('css: MD3 motion token（缓动曲线 + 时长档位）',
    /--md3-ease-standard:\s*cubic-bezier\(0\.2, 0, 0, 1\)/.test(css) &&
    /--md3-ease-emphasized-decelerate:\s*cubic-bezier\(0\.05, 0\.7, 0\.1, 1\)/.test(css) &&
    /--md3-dur-short1:\s*50ms/.test(css) && /--md3-dur-medium4:\s*400ms/.test(css) &&
    /--md3-dur-long4:\s*600ms/.test(css) && /--md3-dur-extra-long2:\s*800ms/.test(css));
  check('css: 列表 stagger 入场（各套 t-in-* 关键帧 + --i 递进 delay）',
    ['md3', 'fluent', 'miuix', 'harmony', 'kitty', 'kuromi', 'melody'].every((t) => new RegExp('@keyframes t-in-' + t + '\\b').test(css)) &&
    /animation-delay:\s*calc\(var\(--i, 0\) \* var\(--t-stagger\)\)/.test(css) &&
    /body\.theme-md3 \.t-enter\s*\{/.test(css));
  check('css: 入场动画一律 backwards 填充（both/forwards 会压掉 :active 的按压反馈）',
    /animation-fill-mode:\s*backwards/.test(css) &&
    (css.match(/backwards/g) || []).length >= 11 &&
    !/animation:\s*t-(?:in|panel|toast)-[\w-]+[^;]*\b(?:both|forwards)\b/.test(css));
  check('css: 面板/菜单/吐司每套风格各有入场动画',
    ['md3', 'fluent', 'miuix', 'harmony', 'kitty', 'kuromi', 'melody'].every((t) =>
      new RegExp('@keyframes t-panel-' + t + '\\b').test(css) &&
      new RegExp('@keyframes t-toast-' + t + '\\b').test(css)));
  check('css: prefers-reduced-motion 下全部动效让路',
    /@media \(prefers-reduced-motion: reduce\)/.test(css) &&
    /animation: none !important/.test(css));
  check('app.js: 新建卡片/优盘行时打上错峰序号',
    /function staggerIndex/.test(js) && /setProperty\('--i'/.test(js) &&
    /classList\.add\('t-enter'\)/.test(js));
  check('app.js: 换风格/换主色走 cross-fade（不是硬跳）',
    /function motionCrossFade/.test(js) && /widget\.animate\(/.test(js));
  check('app.js: 尊重系统"减弱动效"设置',
    /prefers-reduced-motion: reduce/.test(js) && /REDUCE_MOTION/.test(js));
  check('html: 设置面板有取色方式分段选择器（莫奈取色 / 手动指定）',
    html.includes('id="colorModeSeg"') && /data-mode="auto"/.test(html) && /data-mode="manual"/.test(html));
  check('html: 手动模式提供取色器与预设色板',
    html.includes('id="accentColor"') && html.includes('id="swatches"') &&
    /type="color"/.test(html) && /class="swatch"/.test(html));
  check('app.js: 选色后向主进程要新 palette 并写进 CSS 变量',
    /function applyPaletteChange/.test(js) && /API\.getPalette/.test(js));
  check('app.js: 取色面板五套动态配色主题都显示（含默认的液态玻璃）',
    /* 用户反馈"手动选色用不了"的直接成因：旧代码把 md3ColorBox 在 glass 主题下
     * 隐藏了，而默认主题就是 glass → 打开设置根本看不到选色入口。 */
    /function syncSettingsControls/.test(js) &&
    /box\.classList\.toggle\('hidden', fixed\)/.test(js) &&
    !/classList\.toggle\('hidden',\s*!isMd3\)/.test(js));
  check('app.js: 七套固定配色主题（kitty/dog/miuix/harmony/kuromi/melody/sanrio）隐藏取色面板并给出说明',
    /* 透明（黑背景）是深色固定方案；miuix/harmony 用各自官方配色（MIUIX #3482FF /
     * 鸿蒙 #0A59F7），kitty/dog/kuromi/melody/sanrio 是角色扮演配色；对它们取色都是无效操作 */
    /const FIXED_PALETTE_THEMES = \['kitty', 'dog', 'miuix', 'harmony', 'kuromi', 'melody', 'sanrio'\]/.test(js) &&
    /fixedPaletteHint/.test(js) && /固定主题配色|官方规范固定配色/.test(js));
  check('html: 固定配色提示行存在', /id="fixedPaletteHint"/.test(html));
  check('html: 取色控件不再挂 md3-only（措辞也不再是 MD3 专属）',
    !/id="md3ColorBox"[^>]*md3-only/.test(html) &&
    !/MD3 取色|莫奈取色/.test(html));
  check('app.js: 预览模式 mock 用本地近似算法派生调色板（不再恒返回 null）',
    /function previewPalette/.test(js) && /PREVIEW_ROLE_TONE/.test(js) &&
    /getPalette:\s*\(patch\) =>/.test(js) &&
    !/getPalette:\s*\(\) => Promise\.resolve\(null\)/.test(js));
  check('app.js: 预览派生结果打 preview 标记（不冒充真机 Monet 取色）',
    /preview:\s*true/.test(js) && /预览近似色/.test(js));
  check('app.js: 手动选色有即时反馈（input 防抖 + 写出当前主色）',
    /function accentLivePreview/.test(js) && /accentInputTimer/.test(js) &&
    /clearTimeout\(accentInputTimer\)/.test(js));

  /* ---- 十套独立风格（v2.2.2 起）：Kitty / 玉桂狗 / 库洛米 / 美乐蒂 / 三丽鸥混合 ---- */
  console.log('[Multi theme - ten independent design systems]');
  check('app.js: 主题清单共 10 套（v2.4.0 起「透明（黑背景）」下线，改由黑暗模式承担）+ 固定配色集合',
    /const THEMES = \['glass', 'md3', 'fluent', 'miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'\]/.test(js) &&
    !/transparent/.test(js.slice(js.indexOf('const THEMES'), js.indexOf('const THEME_LABEL'))) &&
    /FLAT_THEMES = THEMES\.filter/.test(js) && /FIXED_PALETTE_THEMES/.test(js));
  check('app.js: 主题下拉栏选项由 THEME_LABEL 生成（新增主题只改注册表一处）',
    /themeSelect\.innerHTML = THEMES\.map/.test(js) && /THEME_LABEL\[t\] \|\| t/.test(js));
  check('app.js: 每套风格各有默认推荐主色（用户没手挑过才套用）',
    /const THEME_ACCENT = \{[\s\S]{0,420}kitty:\s*'#C2185B'[\s\S]{0,120}kuromi:\s*'#8E5BC8'[\s\S]{0,60}melody:\s*'#EC6FA8'[\s\S]{0,60}sanrio:\s*'#E8548A'/.test(js) &&
    /accentPicked/.test(js));
  check('app.js: 切风格不重算颜色（动态配色主题共用同一份 --md3-* 配色中枢；明暗不匹配时才重算）',
    /const have = wallInfo && wallInfo\.palette;/.test(js) &&
    /if \(isDynamicTheme\(currentTheme\) && \(!have \|\| !!have\.dark !== wantDark\)\)/.test(js) &&
    /applyPalette\(wallInfo\.palette\)/.test(js));
  check('app.js: 切换主题的 toast 带主题名', /THEME_LABEL\[currentTheme\]/.test(js) &&
    /THEME_LABEL = \{[^}]*harmony: '鸿蒙'[^}]*kuromi: '库洛米'[^}]*melody: '美乐蒂'[^}]*sanrio: '三丽鸥混合'/.test(js));
  check('app.js: 主题经下拉栏切换（change 事件 → switchTheme，不再用分段按钮点击）',
    /\$\('themeSelect'\)\.addEventListener\('change'/.test(js) &&
    /function switchTheme/.test(js) &&
    !/\$\('themeSeg'\)/.test(js));
  check('html: 主题用下拉栏（9 个 data-theme 按钮已移除）',
    !/data-theme="/.test(html) && /<select id="themeSelect"/.test(html));
  check('css: 已彻底移除 theme-flat 共底（每套主题自足，不再是"平面系共用结构"）',
    !/theme-flat/.test(css) && !/theme-flat/.test(js) && !/md3-enter/.test(css) && !/md3-enter/.test(js));
  check('css: 九套皮肤各自定义同一份表面清单 token（形状/模糊/表面/强调色）',
    ['md3', 'fluent', 'miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'].every((t) => {
      const b = themeTokens(t);
      return /--t-r-win:/.test(b) && /--t-r-card:/.test(b) && /--t-btn-r:/.test(b) &&
        /--t-blur:/.test(b) && /--t-surface:/.test(b) && /--t-accent:/.test(b) &&
        /--t-ease:/.test(b) && /--t-dur:/.test(b) && /--t-stagger:/.test(b);
    }));
  check('css: 黑暗模式层 = body.dark（黑纱 veil + 只压表面不动强调色 + 固定主题表换深色）',
    /body\.dark \.glass-veil\s*\{[\s\S]{0,700}?rgba\(6, 8, 14, calc\(0\.62 \* var\(--glass-alpha\)\)\)/.test(css) &&
    /body\.dark:not\(\.dyn\) \{[\s\S]{0,900}?--md3-surface: #0F1116/.test(css) &&
    /body\.dark \.panel,[\s\S]{0,120}?background: var\(--t-surface-2\)/.test(css));
  check('app.js: 明暗模式（applyAppearance 挂 body.dark；只有动态配色主题重算 Monet 暗色方案）',
    /function applyAppearance\(a\)/.test(js) &&
    /document\.body\.classList\.toggle\('dark', a === 'dark'\)/.test(js) &&
    /function setAppearance\(a\)/.test(js) &&
    /if \(isDynamicTheme\(currentTheme\)\) \{[\s\S]{0,60}?applyPaletteChange\(\{ appearance: next \}\)/.test(js) &&
    /document\.body\.classList\.toggle\('dyn', isDynamicTheme\(t\)\)/.test(js) &&
    /function isDynamicTheme\(t\)/.test(js));
  check('main.js: 黑暗模式走 Monet 暗色方案（SchemeTonalSpot isDark）+ 配色带 dark 标记',
    /function monetSchemePalette\(hct, dynamic, isDark\)/.test(mainJs) &&
    /new monet\.SchemeTonalSpot\(hct, !!isDark, 0\)/.test(mainJs) &&
    /p\.dark = !!isDark;/.test(mainJs) &&
    /appearance === 'dark'/.test(mainJs));
  check('main.js: 默认配置含 appearance / background 两组新配置（含裁剪/蒙版/模糊参数）',
    /appearance: 'light'/.test(mainJs) &&
    /background: \{[\s\S]{0,220}?enabled: false/.test(mainJs) &&
    /blur: 0, mask: 0/.test(mainJs) && /scale: 100, offsetX: 50, offsetY: 50/.test(mainJs));
  check('html: 设置面板有明暗模式分段 + 自定义背景全套控件（模糊/蒙版/缩放/位置/填充）',
    /id="appearanceSeg"/.test(html) && /data-appearance="dark"/.test(html) &&
    /id="setBgOn"/.test(html) && /id="btnBgPick"/.test(html) && /id="btnBgClear"/.test(html) &&
    /id="setBgBlur"/.test(html) && /id="setBgMask"/.test(html) && /id="setBgScale"/.test(html) &&
    /id="setBgX"/.test(html) && /id="setBgY"/.test(html) && /id="bgFitSelect"/.test(html));
  check('app.js: 自定义背景接线（applyCustomBackground 三层背景 + 蒙版渐变 + 模糊补偿缩放）',
    /function applyCustomBackground\(\)/.test(js) &&
    /function bgConfig\(\)/.test(js) && /function bgIsOn\(\)/.test(js) &&
    /function loadCustomBackground\(\)/.test(js) &&
    /layers\.push\('linear-gradient\(rgba\(255, 255, 255, '/.test(js) &&
    /el\.style\.filter = blur > 0 \? 'blur\(' /.test(js) &&
    /el\.style\.transform = zoom > 1\.001/.test(js));
  check('app.js: 自定义背景顶替壁纸（applyWallpaper 早退 + 实时采集让位 + 取色源切换）',
    /if \(bgIsOn\(\)\) \{[\s\S]{0,80}?applyCustomBackground\(\);[\s\S]{0,40}?return true;/.test(js) &&
    /if \(bgIsOn\(\)\) return;/.test(js) &&
    /body\.bg-custom \.env-layer/.test(css));
  check('main.js: 自定义背景 IPC（pick/load）+ 取色优先用自定义图',
    /ipcMain\.handle\('pick-background'/.test(mainJs) &&
    /ipcMain\.handle\('load-background'/.test(mainJs) &&
    /function customBackgroundFile\(cfg\)/.test(mainJs) &&
    /const bgFile = customBackgroundFile\(cfg\)/.test(mainJs) &&
    /pickBackground: \(\) => ipcRenderer\.invoke\('pick-background'\)/.test(preloadJs));

  /* ★★★ 回归守卫：v2.4.0 花屏事故 ★★★
   * 上一轮给滑块/珠子规则批量加"透明主题"作用域时，写成
   *     body.theme-glass,
   *     body.theme-transparent .sl-bead { ... }
   * 逗号把第一段变成了**独立选择器**：body 自己套上了 .sl-bead 的
   * `display:block; position:absolute; width:34px; height:22px; backdrop-filter;
   *  filter:url(#liquidThumb)` —— 整个窗口变成一个 34×22 的折射元素，切到玻璃主题
   * 直接花屏卡死。这条守卫盯的就是"逗号紧跟类名"这个签名。 */
  check('★ 回归守卫（v2.4.0 花屏事故）：不存在裸 body.theme-* / body.dark 选择器',
    !/(^|\n)body\.theme-[a-z0-9]+,(\s*\n|\s*\{)/.test(css) &&
    !/(^|\n)body\.dark,/.test(css) &&
    !/(^|\n)body\.bg-custom,/.test(css));
  check('css: 滑块/珠子规则的选择器都带完整后代（不是裸 body，也不是缺后代的半截）',
    /body\.theme-glass \.sl-bead \{/.test(css) &&
    /body\.theme-glass input\[type="range"\] \{/.test(css) &&
    /body\.theme-glass \.sl-wrap input\[type="range"\]::-webkit-slider-thumb \{/.test(css) &&
    /body\.theme-glass\.lg-ready \.sl-bead \{/.test(css) &&
    /body\.theme-glass \.sl-wrap input\[type="range"\]:active ~ \.sl-bead \{/.test(css));
  check('main.js: 已下线主题的收尾迁移（配置里存着 transparent 时收回 glass）',
    /if \(config\.theme === 'transparent'\) \{[\s\S]{0,80}?config\.theme = 'glass';/.test(mainJs));

  /* ★★★ 回归守卫：v2.4.1「选完背景图整站点不动」事故 ★★★
   * 自定义背景的图层规则写成了裸 `.bg-custom { position:absolute;
   * pointer-events:none; … }`，而渲染层是
   * `document.body.classList.toggle('bg-custom', on)` —— **body 自己也带这个类**，
   * 于是整条规则同时命中 <body>：position/z-index 落到 body 上，
   * pointer-events:none 再顺着继承糊满整棵子树。界面看着完好却一个都点不动。
   *
   * 判据是通用的：凡是"挂在 body 上的状态标记类"，CSS 里都不许出现
   * 只写 `.标记类`（逗号或花括号紧跟其后）的规则 —— 那种写法必然命中 body。
   * 图层元素改名 .bg-layer、样式改用 #bgCustom（id 永不可能命中 body）。 */
  const BODY_MARKERS = ['bg-custom', 'dark', 'dyn', 'lg-ready', 'over-light',
    'preview', 'realtime', 'ic-ring', 'ic-none', 'ic-contain', 'ic-shape'];
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bareMarkers = BODY_MARKERS.filter((m) => new RegExp(
    '(^|,)\\s*\\.' + m.replace(/-/g, '\\-') + '\\s*(,|\\{)', 'm').test(cssNoComment));
  check('★ 回归守卫（v2.4.1 点不动事故）：body 状态标记类不得被写成裸「.类名」规则' +
    (bareMarkers.length ? '（违规：' + bareMarkers.join(', ') + '）' : ''),
    bareMarkers.length === 0);
  check('css: 自定义背景图层用 id 选择器 #bgCustom（不与 body 标记类撞名）',
    /#bgCustom \{/.test(css) && !/(^|\n)\.bg-custom\s*\{/.test(cssNoComment));
  check('html: 背景图层类名是 bg-layer（body 用的是 bg-custom）',
    /class="bg-layer"/.test(html) && !/class="bg-custom"/.test(html));
  check('css: widget 显式收回点击权（pointer-events 会被继承，留一道兜底）',
    /\.widget \{[\s\S]{0,900}?pointer-events:\s*auto/.test(cssNoComment));
  /* ---------- v2.4.2 起：图标填充 / 形状 / 边框配色（v2.4.3 扩充） ---------- */
  check('main.js: 默认配置加了 iconFit / iconBorder（cover + glass = 原来的样子）',
    /iconFit:\s*'cover'/.test(mainJs) && /iconBorder:\s*'glass'/.test(mainJs));
  check('★ main.js: 图标取色跳过透明像素（透明留白是 0,0,0,0，算进去主色恒为黑、图标全被套黑边）',
    /buf\[i \+ 3\] < 8\) continue/.test(mainJs) &&
    /function iconColorFromFile/.test(mainJs));
  check('main.js: 图标取色用 filter:false（不过滤低饱和候选，否则只剩兜底紫、跟图不像）',
    /fallbackColorARGB:\s*fallback,\s*filter:\s*false/.test(mainJs));
  check('main.js: 图标取色缓存带 mtime（同一路径换图不会拿到旧色）',
    /function iconColorKey[\s\S]{0,240}?mtimeMs/.test(mainJs));
  check('main.js + preload: 批量取色 IPC get-icon-colors / getIconColors 已接通',
    /ipcMain\.handle\('get-icon-colors'/.test(mainJs) &&
    /getIconColors:\s*\(paths\)\s*=>\s*ipcRenderer\.invoke\('get-icon-colors'/.test(preloadJs));
  check('main.js: file:// URL 能转回本地路径（渲染层存的就是 file://）',
    /fileURLToPath/.test(mainJs) && /function iconFileArg/.test(mainJs));
  check('html: 设置面板有「图标填充」与「图标边框」两个分段控件',
    /id="iconFitSeg"/.test(html) && /data-fit="cover"/.test(html) &&
    /data-fit="contain"/.test(html) && /id="iconBorderSeg"/.test(html) &&
    /data-border="auto"/.test(html) && /data-border="none"/.test(html));
  check('app.js: setIconFit / setIconBorder / applyIconLook / refreshIconLook 齐备',
    /function setIconFit/.test(js) && /function setIconBorder/.test(js) &&
    /function applyIconLook/.test(js) && /function refreshIconLook/.test(js));
  check('★ app.js: 切换图标外观走 refreshIconLook 而不是 render（render 会重放入场动画）',
    /function setIconBorder[\s\S]{0,420}?refreshIconLook\(\)/.test(js) &&
    /function setIconFit[\s\S]{0,420}?refreshIconLook\(\)/.test(js));
  check('★ app.js: --ic-fit 与状态类 / 几何变量都挂 body（弹窗是 #widget 的兄弟，挂 #widget 管不到预览）',
    /const body = document\.body;/.test(js) &&
    /body\.style\.setProperty\('--ic-fit'/.test(js) &&
    /body\.classList\.toggle\('ic-ring'/.test(js) &&
    /body\.style\.setProperty\('--ic-pad'/.test(js));
  check('app.js: 自动取色在首帧之前先取完色（否则先画主题色再跳成图片色 = 闪一下）',
    /if \(config\.iconBorder === 'auto'[\s\S]{0,200}?await ensureIconColors\(\)[\s\S]{0,120}?render\(\)/.test(js));
  check('app.js: 还没保存的预览图也能取到色（走 fetchIconColors，不是只认配置里的）',
    /function syncPreviewIconColor[\s\S]{0,700}?fetchIconColors\(\[path\]\)/.test(js));
  check('css: 图片填充从 --ic-fit 读，图标网格与弹窗预览都吃这个变量',
    /\.item-icon img \{[\s\S]{0,260}?object-fit:\s*var\(--ic-fit, cover\)/.test(cssNoComment) &&
    /\.icon-preview img \{[\s\S]{0,260}?object-fit:\s*var\(--ic-fit, cover\)/.test(cssNoComment));
  check('★ css: 描边色的回退链末端是确定值（自定义属性取不到值会让整条声明作废→currentColor）',
    /--ic-c:\s*var\(--ic-ring-c, var\(--t-accent, var\(--accent\)\)\)/.test(cssNoComment) &&
    /border-color:\s*var\(--ic-c\)/.test(cssNoComment));
  check('★ css: 图标描边规则重复一次类名提权（主题块同特异性且在文件后半段，不重复会输）',
    /body\.ic-ring \.item-icon\.item-icon/.test(cssNoComment) &&
    /body\.ic-none \.item-icon\.item-icon/.test(cssNoComment) &&
    /body\.ic-shape \.item-icon\.item-icon/.test(cssNoComment));
  check('css: 外发光用 drop-shadow（不被 .item-icon 的 overflow:hidden 裁剪）',
    /filter:\s*drop-shadow\([^;]*var\(--ic-c\)/.test(cssNoComment));
  check('★ css: drop-shadow 只能有三个长度（它没有 box-shadow 那样的扩张半径，多写一个整条 filter 就作废）',
    (function () {
      /* 从 --ic-c 之后取外发光那条，别用"文件里第一条 drop-shadow"——
       * .item:hover .item-icon .ic 早就有自己的 drop-shadow，取错对象会数出一串无关数字。
       * 数长度前要先把 var(...) / color-mix(...) 整体折叠成一个记号：
       * 直接按空格切会让 "color-mix" 和 "VAL" 拆成两个 token。 */
      const at = cssNoComment.indexOf('--ic-c: var(--ic-ring-c');
      if (at < 0) return false;
      const m = /filter:\s*drop-shadow\(([\s\S]*?)\);/.exec(cssNoComment.slice(at));
      if (!m) return false;
      let flat = '', i = 0;
      const arg = m[1];
      while (i < arg.length) {
        const open = arg.indexOf('(', i);
        if (open < 0) { flat += arg.slice(i); break; }
        let nameStart = open;
        while (nameStart > i && /[A-Za-z0-9_-]/.test(arg[nameStart - 1])) nameStart--;
        flat += arg.slice(i, nameStart) + 'VAL';
        let d = 0, j = open;
        for (; j < arg.length; j++) {
          if (arg[j] === '(') d++;
          else if (arg[j] === ')') { d--; if (!d) break; }
        }
        i = j + 1;
      }
      // 颜色（var/color-mix）被折叠成 VAL 记号，所以判据是"非 VAL 的 token 恰好 3 个 = x y blur"
      return flat.trim().split(/\s+/).filter((t) => t && t !== 'VAL').length === 3;
    })());
  check('★ css: 外发光/底色的透明度用 color-mix 现算（跟随主题模式才能免钩子自动变色）',
    /drop-shadow\(0 5px 11px color-mix\(in srgb, var\(--ic-c\) 45%, transparent\)\)/.test(cssNoComment) &&
    /background:\s*color-mix\(in srgb, var\(--ic-c\) 20%, transparent\)/.test(cssNoComment));
  check('★ app.js: 取色批次串行化而不是"有批次在跑就丢掉"（否则并发刷新会被静默跳过）',
    /if\s*\(iconColorsInFlight\)[\s\S]{0,160}?await iconColorsInFlight/.test(js));
  check('css: 底色层是 absolute（否则会参与 .item-icon 的 flex 居中、把图标挤偏）',
    /body\.ic-ring \.item-icon::before[\s\S]{0,260}?position:\s*absolute/.test(cssNoComment));
  check('css: .icon-preview 有定位（底色层是 absolute，定位基准不能缺）',
    /\.icon-preview \{[\s\S]{0,900}?position:\s*relative/.test(cssNoComment));

  /* ---------- v2.4.3：「内部」= 完整落在边框形状之内 ---------- */
  check('★ main.js: 默认配置加了 iconShape / iconRadius / iconRingColor（形状跟随主题 = 现在的样子）',
    /iconShape:\s*'auto'/.test(mainJs) && /iconRadius:\s*22/.test(mainJs) &&
    /iconRingColor:\s*''/.test(mainJs));
  check('★ css: 「内部」的内缩由 body.ic-contain 给（不是写在基础 img 规则上）',
    /body\.ic-contain \.item-icon img,[\s\S]{0,120}?padding:\s*var\(--ic-pad, 0\)/.test(cssNoComment) &&
    !/\.item-icon img \{[\s\S]{0,260}?padding:\s*var\(--ic-pad/.test(cssNoComment));
  check('★ css: img 是 border-box（替换元素默认 content-box 会让内缩的 padding 往外撑、图反而变大）',
    /\.item-icon img \{[\s\S]{0,260}?box-sizing:\s*border-box/.test(cssNoComment) &&
    /\.icon-preview img \{[\s\S]{0,260}?box-sizing:\s*border-box/.test(cssNoComment));
  check('★ app.js: 内缩量按 0.2929 × 圆角半径百分比算（正方形内切于圆角矩形的解析解）',
    /\(0\.2929 \* radiusPct\)\.toFixed\(2\)/.test(js));
  check('★ app.js: 形状选「跟随主题」时实测圆角（写死常量会让圆形主题切角 / 圆角主题缩小一圈）',
    /function measureIconRadiusPct/.test(js) &&
    /borderTopLeftRadius/.test(js) &&
    /document\.querySelector\('\.item-icon'\)/.test(js) &&
    // 圆形 50% → pad 14.65%：量不到就退回这个值，宁可多留白也不能切图
    /measured === null \? 50 : measured/.test(js));
  check('★ app.js: 形状选「跟随主题」时一个 --ic-rad 都不写（十套主题各自的形状语言要活着）',
    /body\.classList\.toggle\('ic-shape', shape !== 'auto'\)/.test(js) &&
    /body\.style\.removeProperty\('--ic-rad'\)/.test(js) &&
    /body\.style\.setProperty\('--ic-rad', radiusPct \+ '%'\)/.test(js));
  check('★ app.js: 换主题要重算内缩几何（否则 MD3 会沿用玻璃的 14.65%，白白多留一圈白）',
    /function applyTheme[\s\S]{0,2200}?refreshIconLook\(\);\s*\n\}/.test(js));
  check('★ app.js: 没有颜色来源时把元素上的内联 --ic-ring-c 清掉（内联优先级高于继承，不清就顶不掉）',
    /function applyIconColorVars[\s\S]{0,420}?removeProperty\('--ic-ring-c'\)/.test(js) &&
    // 而且清变量这条路要对**所有图标类型**统一走：一次遍历、不做"有图才写、没图就清"的分支
    // （早期那个分支会把自定义色一起清掉 → 只有图片图标变色，真机探针抓出来的）
    /querySelectorAll\('\.item-icon, \.icon-preview'\)\.forEach\(\(el\) => \{[\s\S]{0,200}?applyIconColorVars\(el,/.test(js));
  check('★ app.js: 自定义边框色优先于取色策略，但「透明」能盖过它（优先级只在一处决定）',
    /function iconRingColorFor/.test(js) &&
    /const custom = normalizeHex\(config\.iconRingColor\);\s*\n\s*if \(custom && config\.iconBorder !== 'none'\) return custom;/.test(js));
  check('app.js: setIconShape / setIconRadius / setIconRingColor 齐备且都走就地刷新 + 落盘',
    /function setIconShape[\s\S]{0,420}?refreshIconLook\(\)/.test(js) &&
    /function setIconRadius[\s\S]{0,420}?refreshIconLook\(\)/.test(js) &&
    /function setIconRingColor[\s\S]{0,420}?refreshIconLook\(\)/.test(js) &&
    /function setIconRingColor[\s\S]{0,520}?persist\(\)/.test(js));
  check('app.js: 非法形状/半径/颜色一律收回默认（老配置里没有这几个键）',
    /\['circle', 'rounded', 'square'\]\.indexOf\(config\.iconShape\) < 0\) config\.iconShape = 'auto'/.test(js) &&
    /config\.iconRadius = Math\.max\(4, Math\.min\(50, Number\(config\.iconRadius\) \|\| 22\)\)/.test(js) &&
    /config\.iconRingColor = normalizeHex\(config\.iconRingColor\)/.test(js));
  check('★ app.js: init 里 render() 之后再刷一次外观（render 前网格是空的，量不到主题圆角）',
    /render\(\);[\s\S]{0,320}?refreshIconLook\(\);/.test(js));
  check('html: 设置面板新增「图标形状」分段 + 圆角滑块 + 边框颜色自定义',
    /id="iconShapeSeg"/.test(html) && /data-shape="auto"/.test(html) &&
    /data-shape="circle"/.test(html) && /data-shape="rounded"/.test(html) &&
    /data-shape="square"/.test(html) &&
    /id="iconRadius"/.test(html) && /id="iconRadiusRow"/.test(html) &&
    /id="iconRingColor"/.test(html) && /id="btnIconRingClear"/.test(html));
  check('html: 边框样式多了「跟随主题」这一档（data-border="theme"）',
    /data-border="theme"/.test(html) && /跟随主题/.test(html));
  check('app.js: 圆角滑块 input 即时生效（拖动就能看到，同值短路不重复落盘）',
    /iconRadiusEl\.addEventListener\('input'/.test(js) &&
    /function setIconRadius[\s\S]{0,200}?if \(config\.iconRadius === next\) return;/.test(js));
  check('app.js: 圆角大小只在「圆角」形状下显示（调了没反应的控件不该露出来）',
    /rRow\.classList\.toggle\('hidden', shape !== 'rounded'\)/.test(js));
  check('app.js: 预览 mock 与 DEFAULT_CONFIG 对齐（缺键会让面板读出一堆空值）',
    /iconShape:\s*'auto', iconRadius:\s*22, iconRingColor:\s*''/.test(js));
  check('main.js: 配置注释里写清了 iconBorder 四档语义（theme = 跟随主题强调色）',
    /'theme'=跟随主题/.test(mainJs) && /'auto'=自动取色/.test(mainJs) &&
    /'glass'=玻璃白描边/.test(mainJs) && /'none'=透明/.test(mainJs));

  /* ---------- v2.4.1 补丁：文字按钮不得复用方形图标按钮的容器 ---------- */
  check('★ 回归守卫：.size-controls 里不许再出现文字按钮（它写死 30×30，会把字挤到框外）',
    !/class="size-controls"[^>]*>\s*<button[^>]*class="text-btn"/.test(html));
  check('css: 文字按钮容器 .btn-row 存在、.text-btn 不换行、误用兜底也压不扁',
    /\.btn-row \{/.test(cssNoComment) &&
    /\.text-btn \{[\s\S]{0,320}?white-space:\s*nowrap/.test(cssNoComment) &&
    /\.size-controls button\.text-btn \{/.test(cssNoComment));

  check('css: 九套主题形状标度各自符合设计（miuix 卡片 16dp = 官方 CardDefaults）',
    /--t-r-card:\s*16px/.test(themeTokens('md3')) &&
    /--t-r-card:\s*8px/.test(themeTokens('fluent')) &&
    /--t-r-card:\s*16px/.test(themeTokens('miuix')) &&
    /--t-r-card:\s*20px/.test(themeTokens('harmony')) &&
    /--t-r-card:\s*24px/.test(themeTokens('kitty')) &&
    /--t-r-card:\s*22px/.test(themeTokens('dog')) &&
    /--t-r-card:\s*20px/.test(themeTokens('kuromi')) &&
    /--t-r-card:\s*22px/.test(themeTokens('melody')) &&
    /--t-r-card:\s*22px/.test(themeTokens('sanrio')));
  check('css: 主题按钮圆角各有性格（玻璃 11px / Fluent 4px / MIUIX 16px / 库洛米 14px / 其余胶囊）',
    /--t-btn-r:\s*4px/.test(themeTokens('fluent')) &&
    /--t-btn-r:\s*999px/.test(themeTokens('md3')) &&
    /--t-btn-r:\s*999px/.test(themeTokens('kitty')) &&
    /--t-btn-r:\s*16px/.test(themeTokens('miuix')) &&
    /--t-btn-r:\s*14px/.test(themeTokens('kuromi')));
  check('css: 平面主题模糊强度互不相同（各成体系）',
    /--t-blur:\s*blur\(14px\) saturate\(118%\)/.test(themeTokens('md3')) &&
    /--t-blur:\s*blur\(30px\) saturate\(125%\)/.test(themeTokens('fluent')) &&
    /--t-blur:\s*blur\(22px\) saturate\(150%\)/.test(themeTokens('miuix')) &&
    /--t-blur:\s*blur\(24px\) saturate\(140%\)/.test(themeTokens('harmony')) &&
    /--t-blur:\s*blur\(18px\) saturate\(140%\)/.test(themeTokens('kitty')) &&
    /--t-blur:\s*blur\(26px\) saturate\(130%\)/.test(themeTokens('dog')) &&
    /--t-blur:\s*blur\(20px\) saturate\(130%\)/.test(themeTokens('kuromi')) &&
    /--t-blur:\s*blur\(18px\) saturate\(135%\)/.test(themeTokens('melody')) &&
    /--t-blur:\s*blur\(22px\) saturate\(135%\)/.test(themeTokens('sanrio')));
  check('css: Fluent = 小圆角 8/4 + 亚克力 blur(30px) + feTurbulence 噪点 + Reveal 高光',
    /--t-r-ctl:\s*4px/.test(themeTokens('fluent')) &&
    /feTurbulence/.test(css) &&
    /radial-gradient\(circle at var\(--rv-x, ?50%\) var\(--rv-y, ?50%\)/.test(css));
  check('app.js: Fluent Reveal 光斑跟随指针（--rv-x/--rv-y）',
    /--rv-x/.test(js) && /--rv-y/.test(js) && /rvRaf|closest\('\.item'\)/.test(js));
  check('css: MIUIX v2.1 = 官方固定配色 #3482FF + 16dp 家族 + Sink 下沉 + 掠光扫过 + 指针柔光',
    /--md3-primary:\s*#3482FF/.test(themeTokens('miuix')) &&
    /--md3-surface:\s*#F7F7F7/.test(themeTokens('miuix')) &&
    /--t-btn-r:\s*16px/.test(themeTokens('miuix')) &&
    /--t-ease:\s*cubic-bezier\(0\.2, 0, 0, 1\)/.test(themeTokens('miuix')) &&
    /body\.theme-miuix \.item:active \{ transform: translateY\(1px\) scale\(0\.97\); \}/.test(css) &&
    /background-position:\s*130% 0, 0 0/.test(css) &&
    /radial-gradient\(circle at var\(--rv-x, 50%\) var\(--rv-y, 40%\)/.test(css));
  check('css: MIUIX 光感①「天光」顶部环境光渐晕挂在 veil 上',
    /body\.theme-miuix \.glass-veil::after \{[\s\S]{0,200}radial-gradient\(140% 70% at 50% -12%/.test(css));
  check('css: 鸿蒙 v2.1 = 官方固定配色 #0A59F7 + 20px 卡片 + 主色焦点环 + 圆形图标底板',
    /--md3-primary:\s*#0A59F7/.test(themeTokens('harmony')) &&
    /--md3-surface:\s*#F1F3F5/.test(themeTokens('harmony')) &&
    /--t-r-card:\s*20px/.test(themeTokens('harmony')) &&
    /body\.theme-harmony [^:]*:focus-visible[\s\S]{0,140}outline:\s*2px solid/.test(css) &&
    /body\.theme-harmony \.item-icon\s*\{[^}]*border-radius:\s*50%/.test(css));
  check('css: 鸿蒙光感「沉浸光感」边缘流光环（@property 角度动画 + mask 环）',
    /@property --hl-angle/.test(css) &&
    /body\.theme-harmony \.glass-veil::after \{[\s\S]{0,400}conic-gradient\(from var\(--hl-angle\)/.test(css) &&
    /mask-composite:\s*exclude/.test(css) &&
    /@keyframes hl-orbit/.test(css));
  check('css: Kitty 装饰用真实裁剪图片（v2.2 增补：8 处贴图位，含奶瓶/芭蕾新裁剪）',
    /* 用户点名"找 kitty 图片裁剪加进来构成元素"——pngall/pngmart 下载裁剪，
     * 资产在 renderer/theme/kitty/，随 renderer 目录白名单一起打包。 */
    /body\.theme-kitty \.titlebar::after \{[\s\S]{0,220}theme\/kitty\/kitty-head\.png/.test(css) &&
    /body\.theme-kitty \.widget::after \{[\s\S]{0,220}theme\/kitty\/kitty-full\.png/.test(css) &&
    /body\.theme-kitty \.glass-veil::before \{[\s\S]{0,220}theme\/kitty\/kitty-wave\.png/.test(css) &&
    /body\.theme-kitty \.usb-section::before \{[\s\S]{0,220}theme\/kitty\/kitty-ballet\.png/.test(css) &&
    /body\.theme-kitty \.modal-card::after \{[\s\S]{0,220}theme\/kitty\/kitty-wave\.png/.test(css) &&
    /body\.theme-kitty \.ctx-menu::after \{[\s\S]{0,220}theme\/kitty\/kitty-kimono\.png/.test(css) &&
    /body\.theme-kitty \.modal-card::before \{[\s\S]{0,220}theme\/kitty\/kitty-sit\.png/.test(css));
  check('css: Kitty = **固定粉白配色**（body 上覆盖 --md3-* 角色）+ 24px 圆角 + 蝴蝶结/爱心',
    /* v2.0 只重定义了 --t-accent，壁纸一偏色 Kitty 就不粉了 → 用户反馈
     * "没有 hello kitty 元素"。现在整套 --md3-* 在 body 上被固定成 kitty 粉。 */
    /--md3-primary:\s*#E8548A/.test(themeTokens('kitty')) &&
    /--md3-surface:\s*#FFF7FA/.test(themeTokens('kitty')) &&
    /--t-accent:\s*#E8548A/.test(themeTokens('kitty')) &&
    !/var\(--md3-tertiary\)/.test(themeTokens('kitty')) &&
    /#FFF7FA/.test(themeTokens('kitty')) &&
    /body\.theme-kitty \.titlebar::after[\s\S]{0,200}url\('theme\/kitty\/kitty-head\.png'\)/.test(css) &&
    /body\.theme-kitty \.group-title::before[\s\S]{0,220}data:image\/svg\+xml/.test(css));
  check('css: Kitty 真实图片元素（5 张裁剪素材全部落盘）',
    /url\('theme\/kitty\/kitty-head\.png'\)/.test(css) &&
    /url\('theme\/kitty\/kitty-sit\.png'\)/.test(css) &&
    /url\('theme\/kitty\/kitty-full\.png'\)/.test(css) &&
    /url\("theme\/kitty\/kitty-wave\.png"\)/.test(css) &&
    /url\('theme\/kitty\/kitty-ballet\.png'\)/.test(css) &&
    /url\('theme\/kitty\/kitty-kimono\.png'\)/.test(css) &&
    ['kitty-head.png', 'kitty-sit.png', 'kitty-full.png', 'kitty-wave.png', 'kitty-ballet.png', 'kitty-kimono.png'].every((f) =>
      fs.existsSync(path.join(__dirname, 'renderer', 'theme', 'kitty', f))));
  check('css: 玉桂狗 = **固定蓝白配色** + 22px 圆角 + 真实裁剪图片装饰',
    /--md3-primary:\s*#4FA8E8/.test(themeTokens('dog')) &&
    /--t-accent:\s*#4FA8E8/.test(themeTokens('dog')) &&
    /--t-r-card:\s*22px/.test(themeTokens('dog')) &&
    /body\.theme-dog \.titlebar::after[\s\S]{0,220}theme\/dog\/cinna-head\.png/.test(css) &&
    /body\.theme-dog \.group-title::before[\s\S]{0,220}%3Csvg/.test(css));
  check('css: 玉桂狗真实图片元素（v2.2.2：五张裁剪 + 6 处贴图位，含单车/草莓增补）',
    /url\('theme\/dog\/cinna-head\.png'\)/.test(css) &&
    /url\('theme\/dog\/cinna-plane\.png'\)/.test(css) &&
    /url\('theme\/dog\/cinna-wink\.png'\)/.test(css) &&
    /url\('theme\/dog\/cinna-bike\.png'\)/.test(css) &&
    /url\('theme\/dog\/cinna-berry\.png'\)/.test(css) &&
    /body\.theme-dog \.widget::after[\s\S]{0,220}theme\/dog\/cinna-plane\.png/.test(css) &&
    /body\.theme-dog \.usb-section::after[\s\S]{0,220}theme\/dog\/cinna-wink\.png/.test(css) &&
    /body\.theme-dog \.panel::before[\s\S]{0,220}theme\/dog\/cinna-bike\.png/.test(css) &&
    /body\.theme-dog \.ctx-menu::after[\s\S]{0,220}theme\/dog\/cinna-berry\.png/.test(css) &&
    ['cinna-head.png', 'cinna-plane.png', 'cinna-wink.png', 'cinna-bike.png', 'cinna-berry.png'].every((f) =>
      fs.existsSync(path.join(__dirname, 'renderer', 'theme', 'dog', f))));
  check('css: 库洛米 = **固定紫粉配色**（#8E5BC8/#F06292）+ 20px 圆角 + 14px 按钮矩形',
    /--md3-primary:\s*#8E5BC8/.test(themeTokens('kuromi')) &&
    /--md3-secondary:\s*#F06292/.test(themeTokens('kuromi')) &&
    /--md3-surface:\s*#FAF8FD/.test(themeTokens('kuromi')) &&
    /--t-accent:\s*#8E5BC8/.test(themeTokens('kuromi')) &&
    /--t-btn-r:\s*14px/.test(themeTokens('kuromi')) &&
    /body\.theme-kuromi \.item:active \{ transform: scale\(0\.94\) rotate\(1\.2deg\)/.test(css));
  check('css: 库洛米真实图片元素（v2.2.2：六张裁剪 + 7 处贴图位，含躺姿/伤心增补）',
    /url\('theme\/kuromi\/kuromi-stand\.png'\)/.test(css) &&
    /url\('theme\/kuromi\/kuromi-love\.png'\)/.test(css) &&
    /url\('theme\/kuromi\/kuromi-face\.png'\)/.test(css) &&
    /url\('theme\/kuromi\/kuromi-head\.png'\)/.test(css) &&
    /url\('theme\/kuromi\/kuromi-lie\.png'\)/.test(css) &&
    /url\('theme\/kuromi\/kuromi-cry\.png'\)/.test(css) &&
    /body\.theme-kuromi \.titlebar::after[\s\S]{0,220}theme\/kuromi\/kuromi-head\.png/.test(css) &&
    /body\.theme-kuromi \.widget::after[\s\S]{0,220}theme\/kuromi\/kuromi-stand\.png/.test(css) &&
    /body\.theme-kuromi \.usb-section::after[\s\S]{0,220}theme\/kuromi\/kuromi-love\.png/.test(css) &&
    /body\.theme-kuromi \.panel::before[\s\S]{0,220}theme\/kuromi\/kuromi-lie\.png/.test(css) &&
    /body\.theme-kuromi \.ctx-menu::after[\s\S]{0,220}theme\/kuromi\/kuromi-cry\.png/.test(css) &&
    ['kuromi-stand.png', 'kuromi-love.png', 'kuromi-face.png', 'kuromi-head.png', 'kuromi-lie.png', 'kuromi-cry.png'].every((f) =>
      fs.existsSync(path.join(__dirname, 'renderer', 'theme', 'kuromi', f))));
  check('css: 美乐蒂 = **固定粉白配色**（#EC6FA8）+ 22px 圆角 + 药丸按钮 + 软糯按压',
    /--md3-primary:\s*#EC6FA8/.test(themeTokens('melody')) &&
    /--md3-surface:\s*#FFF8FB/.test(themeTokens('melody')) &&
    /--t-accent:\s*#EC6FA8/.test(themeTokens('melody')) &&
    /--t-btn-r:\s*999px/.test(themeTokens('melody')) &&
    /body\.theme-melody \.item:active \{ transform: scale\(0\.93\)/.test(css));
  check('css: 美乐蒂真实图片元素（v2.2.2：四张裁剪 + 7 处贴图位，含刺绣增补）',
    /url\('theme\/melody\/melody-full\.png'\)/.test(css) &&
    /url\('theme\/melody\/melody-cheer\.png'\)/.test(css) &&
    /url\('theme\/melody\/melody-head\.png'\)/.test(css) &&
    /url\('theme\/melody\/melody-emb\.png'\)/.test(css) &&
    /body\.theme-melody \.titlebar::after[\s\S]{0,220}theme\/melody\/melody-cheer\.png/.test(css) &&
    /body\.theme-melody \.widget::after[\s\S]{0,220}theme\/melody\/melody-full\.png/.test(css) &&
    /body\.theme-melody \.usb-section::after[\s\S]{0,220}theme\/melody\/melody-cheer\.png/.test(css) &&
    /body\.theme-melody \.panel::before[\s\S]{0,220}theme\/melody\/melody-emb\.png/.test(css) &&
    /body\.theme-melody \.ctx-menu::after[\s\S]{0,220}theme\/melody\/melody-full\.png/.test(css) &&
    ['melody-full.png', 'melody-cheer.png', 'melody-head.png', 'melody-emb.png'].every((f) =>
      fs.existsSync(path.join(__dirname, 'renderer', 'theme', 'melody', f))));
  check('css: 玉桂狗的危险色是柔和红（不是主色蓝，删除按钮要看得出来）',
    /--md3-error:\s*#E57373/.test(themeTokens('dog')) &&
    /--danger:\s*#E57373/.test(themeTokens('dog')));
  check('css: Kitty 装饰是内联 SVG data-URL（不是 emoji）',
    /%3Csvg/.test(css) && countEmoji(ruleBlockTheme('kitty', '.titlebar::after')) === 0);
  check('css: 只有 Fluent 有噪点伪元素、只有 Kitty 有蝴蝶结（风格不会互相串）',
    !/feTurbulence/.test(ruleBlockTheme('md3', '.glass-veil::after')) &&
    !/body\.theme-md3 \.titlebar::after/.test(css) &&
    !/body\.theme-harmony \.titlebar::after/.test(css));
  check('css: 主题选择为下拉栏样式（.theme-select；分段控件只剩色板模式两键）',
    /\.theme-select\s*\{/.test(css) && /id="colorModeSeg"/.test(html));
  check('css: 三丽鸥混合 = 四家配色合体（粉主/紫次/蓝三）+ 四角色同框贴图',
    /--md3-primary:\s*#E8548A/.test(themeTokens('sanrio')) &&
    /--md3-secondary:\s*#8E5BC8/.test(themeTokens('sanrio')) &&
    /--md3-tertiary:\s*#4FA8E8/.test(themeTokens('sanrio')) &&
    /--t-accent:\s*#E8548A/.test(themeTokens('sanrio')) &&
    /body\.theme-sanrio \.titlebar::after[\s\S]{0,220}theme\/kitty\/kitty-head\.png/.test(css) &&
    /body\.theme-sanrio \.widget::after[\s\S]{0,220}theme\/kuromi\/kuromi-stand\.png/.test(css) &&
    /body\.theme-sanrio \.glass-veil::before[\s\S]{0,220}theme\/dog\/cinna-plane\.png/.test(css) &&
    /body\.theme-sanrio \.usb-section::before[\s\S]{0,220}theme\/melody\/melody-cheer\.png/.test(css) &&
    /body\.theme-sanrio \.usb-section::after[\s\S]{0,220}theme\/kitty\/kitty-sit\.png/.test(css) &&
    /body\.theme-sanrio \.panel::before[\s\S]{0,220}theme\/kuromi\/kuromi-face\.png/.test(css) &&
    /body\.theme-sanrio \.panel::after[\s\S]{0,220}theme\/melody\/melody-full\.png/.test(css) &&
    /body\.theme-sanrio \.modal-card::after[\s\S]{0,220}theme\/dog\/cinna-wink\.png/.test(css) &&
    /body\.theme-sanrio \.ctx-menu::after[\s\S]{0,220}theme\/kitty\/kitty-wave\.png/.test(css) &&
    /body\.theme-sanrio \.item:active \{ transform: scale\(0\.94\) rotate\(-0\.8deg\)/.test(css));
  check('主界面圆角弧度可调（v2.2.2：滑块写 --radius/--t-r-win，null 跟随主题）',
    html.includes('id="setRadius"') && html.includes('id="radiusVal"') &&
    /function applyRadius/.test(js) &&
    /setProperty\('--radius', config\.cornerRadius \+ 'px'\)/.test(js) &&
    /setProperty\('--t-r-win', config\.cornerRadius \+ 'px'\)/.test(js) &&
    /removeProperty\('--radius'\)/.test(js) &&
    /applyRadius\(config\.cornerRadius \?\? null, false\)/.test(js) &&
    /cornerRadius: null,/.test(mainJs));
  check('css: 贴图主题不改写 .panel/.ctx-menu 的定位（v2.2.1 事故回归守卫：' +
        'relative 优先级高于基础 fixed/absolute，会打掉右键菜单与托盘设置面板）',
    /* ※ 窗口用 [^{};]* 锁死在"选择器 → 第一个 {"：[\s\S] 跨规则扫会误伤
     *   下一条 .modal-card { position: relative }（弹窗贴纸锚点是合法的）。 */
    ['kitty', 'dog', 'kuromi', 'melody', 'sanrio'].every((t) =>
      !new RegExp('body\\.theme-' + t + ' \\.(?:panel|ctx-menu)[^{};]*\\{[^}]*position:\\s*relative').test(css)));

  // 拖动不再闪（v1.8）：用屏幕坐标算位移 + 拖拽期间暂停主进程回推
  console.log('[Drag without flicker]');
  check('app.js: 拖动用 screenX/screenY（clientX 会随窗口一起动，导致自激振荡）',
    /dragStartX = lastX = e\.screenX/.test(js) && /lastX = e\.screenX/.test(js) &&
    !/dragStartX = lastX = e\.clientX/.test(js));
  check('app.js: 缩放同样用屏幕坐标',
    /rsStartX = rsLastX = e\.screenX/.test(js));
  check('app.js: 拖拽开始/结束通知主进程（set-dragging）',
    /API\.setDragging\(true\)/.test(js) && /API\.setDragging\(false\)/.test(js));
  check('main.js: 拖拽期间不回推 bounds（回推会把正在用的位置改掉）',
    /if \(!renderDragging\) pushBounds\(b\)/.test(mainJs));
  check('main.js: 拖拽期间不改 Z 序（拿到焦点是常态，别在这一刻 moveBottom）',
    /!renderDragging\)[\s\S]{0,80}moveBottom/.test(mainJs));
  check('main.js: set-dragging IPC 收尾时补一次落盘回推',
    /ipcMain\.on\('set-dragging'/.test(mainJs) && /renderDragging = !!value/.test(mainJs));
  check('main.js: 透明窗口显式写 #00000000 底色（免 compositor 首次合成白闪）',
    /backgroundColor: '#00000000'/.test(mainJs));
  check('preload: 暴露 setDragging / getPalette',
    /setDragging:/.test(preloadJs) && /getPalette:/.test(preloadJs));
  check('app.js: 拖动每帧重算壁纸偏移（画面跟着窗口走，松手不再校正跳一下）',
    /repositionWallpaper\(\);\s*\n\}/.test(js));

  /* 触摸拖动闪屏专项（v2.2.3）：鼠标不闪、触摸闪，差别只有这五点，逐条断言 */
  console.log('[Drag - touch flicker]');
  check('⓪ 拖动仍走 moveWindow（fire-and-forget），且用整数位置',
    /API\.moveWindow\(nx, ny\)/.test(js) && !/API\.moveWindow\(bounds\.x, bounds\.y\)/.test(js));
  check('① 主指针锁定：已有手指按着时忽略新的 pointerdown（第二触点不再重置基准）',
    /if \(dragPointerDown\) \{[\s\S]{0,260}if \(Date\.now\(\) - dragLastAt < 1500\) return;/.test(js) &&
    /dragPointerId = e\.pointerId/.test(js));
  check('① 主指针锁定：move/up/cancel 都校验 pointerId',
    /if \(!dragging \|\| e\.pointerId !== dragPointerId\) return;/.test(js) &&
    /if \(e\.pointerId !== dragPointerId\) return;/.test(js));
  check('② pointercancel 走软结束（宽限期内可无缝续拖，避免折射滤镜反复摘戴）',
    /function softEndDrag|const softEndDrag = \(\) =>/.test(js) &&
    /pointercancel', \(e\) => \{[\s\S]{0,80}softEndDrag\(\)/.test(js) &&
    /DRAG_CANCEL_GRACE\s*=\s*260/.test(js));
  check('② 软结束只用于 cancel / lostpointercapture，pointerup 仍是硬结束',
    /pointerup', \(e\) => \{[\s\S]{0,60}endDrag\(\)/.test(js));
  check('② 缩放同样有软结束', /softEndResize/.test(js) && /rsEndTimer/.test(js));
  check('③ 位置按整数落位（与主进程 round 对齐，底材不再每帧重采样）',
    /Math\.round\(dragOriginX \+ \(lastX - dragStartX\)\)/.test(js) &&
    /Math\.round\(rsW \+ \(rsLastX - rsStartX\)\)/.test(js));
  check('③ 亚像素抖动不触发重绘（同一整数位置直接 return）',
    /if \(nx === bounds\.x && ny === bounds\.y\) return;/.test(js));
  check('④ 单帧限速 DRAG_MAX_STEP（坏采样最多走 240px，且不会卡死）',
    /DRAG_MAX_STEP\s*=\s*240/.test(js) && /Math\.sign\(dx\) \* DRAG_MAX_STEP/.test(js));
  check('⑤ 拖动/缩放期间不武装长按、不响应 contextmenu',
    /if \(dragging \|\| dragPointerDown \|\| resizing \|\| rsPointerDown\) return;/.test(js) &&
    /if \(dragging \|\| dragPointerDown \|\| resizing \|\| rsPointerDown \|\| dragEndTimer \|\| rsEndTimer\) return;/.test(js));
  check('⑤ 长按回调内二次校验（550ms 内已开始拖动则不弹菜单）',
    /lpTimer = setTimeout\(\(\) => \{[\s\S]{0,140}if \(dragging \|\| dragPointerDown\) return;/.test(js));
  /* 主进程侧诊断：只在异常时落一行（正常拖拽不产生任何 IO），
   * 拿得到"开关次数 / 单帧最大位移"，用户回传即可定位残余闪屏。 */
  check('main.js: 拖动诊断只在异常时写 drag-diag.log（不产生常驻 IO）',
    /drag-diag\.log/.test(mainJs) && /dragStat\.toggles > 2 \|\| dragStat\.maxStep > 400/.test(mainJs) &&
    /appendFileSync/.test(mainJs));

  // 玻璃背景与透明度解耦（用户要求：调透明度只控背景，前景不淡）
  console.log('[LiquidGlass - bg/foreground split]');
  check('.widget 自身 opacity:1 锁定（前景永不透明）', /\.widget\s*\{[^}]*opacity:\s*1/.test(css));
  check('玻璃表面层改到独立的 .glass-veil 元素（不再用伪元素，好控制层级）',
    /\.glass-veil\s*\{/.test(css));
  check('.glass-veil 承载白面纱 + 描边（透明度滑块唯一作用的层）',
    /linear-gradient\(158deg/.test(ruleBlock('.glass-veil')) &&
    /border:\s*1px solid var\(--glass-edge\)/.test(ruleBlock('.glass-veil')));
  check('.glass-veil 承载玻璃厚度感阴影（inset 上亮 + 外侧悬浮投影）',
    /box-shadow:[\s\S]{0,80}inset 0 1px 1px var\(--glass-hi\)/.test(ruleBlock('.glass-veil')));
  check('白面纱系数 0.26/0.38/0.14/0.20 乘 --glass-alpha（奶白感压住但保留受光）',
    /calc\(0\.26 \* var\(--glass-alpha\)\)/.test(ruleBlock('.glass-veil')) &&
    /calc\(0\.38 \* var\(--glass-alpha\)\)/.test(ruleBlock('.glass-veil')));
  check('定义 --glass-alpha CSS 变量', css.includes('--glass-alpha'));
  check('app.js 用 setProperty 驱动 --glass-alpha（不再 widget.style.opacity）',
    !js.includes("widget.style.opacity") && js.includes("setProperty('--glass-alpha'"));
  check('applyOpacity 直接驱动 --glass-alpha（不只依赖 saveConfig 回写）',
    /function\s+applyOpacity[\s\S]{0,400}?setProperty\('--glass-alpha',\s*v\)/.test(js));
  check('app.js 透明度滑块范围 0~1（不再 0.3~1 卡死下限）',
    /Math\.min\(1,\s*Math\.max\(0,\s*v\)\)/.test(js) || /Math\.min\(1,\s*Math\.max\(0/.test(js));
  check('主进程不再调 OS 级 setOpacity（仅注释保留说明）',
    (mainJs.match(/mainWindow\.setOpacity\s*\(/g) || []).length === 0);

  // 透明度条：与主玻璃同一套液态玻璃语言（用户：透明度条也要玻璃样式）
  console.log('[LiquidGlass - opacity bar]');
  const bar = ruleBlock('.opacity-bar');
  check('透明度条白面纱乘 var(--glass-alpha)（跟随滑块一起变透）',
    /rgba\(255,\s*255,\s*255,\s*calc\(0\.34 \* var\(--glass-alpha\)\)\)/.test(bar));
  check('透明度条不再使用近乎实心的白（0.95/0.74/0.46 已移除）',
    !/rgba\(255,\s*255,\s*255,\s*0\.95\)/.test(bar) && !/rgba\(255,\s*255,\s*255,\s*0\.46\)/.test(bar));
  check('透明度条复用 --glass-edge / --glass-hi 描边语言',
    /border:\s*1px solid var\(--glass-edge\)/.test(bar) && /var\(--glass-hi\)/.test(bar));
  check('透明度条 backdrop-filter 同步降到 12px', /backdrop-filter:\s*blur\(12px\)/.test(bar));

  // JS 源码检查：IPC 通道对齐
  console.log('[Source]');
  check('拖拽使用 moveWindow 而非每帧 setBounds',
    /if \(typeof API\.moveWindow === 'function'\) \{/.test(js) && /API\.moveWindow\(nx, ny\)/.test(js));
  check('预览模式（无 moveWindow）仍回退到 setBounds',
    /API\.setBounds\(bounds\);   \/\/ 浏览器预览模式/.test(js));
  check('使用 setPointerCapture（手指滑出标题栏不丢事件）', js.includes('titlebar.setPointerCapture'));
  check('拖拽检查锁定状态', /pointerdown[\s\S]{0,400}config\.locked\) return;/.test(js));
  check('锁定切换函数存在', js.includes('function toggleLocked()'));
  check('自启动设置存在', js.includes("setAutoLaunch"));

  // 运行时：浏览器 mock 模式
  console.log('[Runtime]');
  await new Promise((r) => { window.eval(js); setTimeout(r, 50); });
  const $ = (id) => document.getElementById(id);

  check('脚本无运行时错误地完成初始化', !!$('groups').children.length);

  // 触摸拖拽：模拟 pointer 事件序列（pointerType=touch）
  // v1.8 起脚本读的是 screenX/screenY，所以事件要带上这两个字段
  const titlebar = $('titlebar');
  const fire = (el, type, x, y, pt) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, {
      clientX: x, clientY: y,
      screenX: x, screenY: y,
      pointerId: 1, pointerType: pt || 'touch'
    });
    el.dispatchEvent(ev);
  };
  // jsdom 的 Element 上没有 setPointerCapture，脚本里已 try/catch 包裹
  fire(titlebar, 'pointerdown', 100, 50, 'touch');
  fire(titlebar, 'pointermove', 180, 90, 'touch');
  await new Promise((r) => window.requestAnimationFrame(r));
  const widgetEl = $('widget');
  const leftAfter = widgetEl.style.left;
  check('触摸拖动后窗口位置已更新（100+80=180）', leftAfter === '180px');
  fire(titlebar, 'pointerup', 180, 90, 'touch');

  /* 触摸拖动加固的运行时行为（v2.2.3）：第二根手指不能改变拖拽基准，
   * 单帧离群采样要被限速而不是瞬移。 */
  {
    fire(titlebar, 'pointerdown', 200, 100, 'touch');       // 主指针
    fire(titlebar, 'pointermove', 260, 100, 'touch');
    await new Promise((r) => window.requestAnimationFrame(r));
    const mid = widgetEl.style.left;                        // 180 + 60 = 240
    fire(titlebar, 'pointerdown', 900, 900, 'touch');       // 第二根手指（应被忽略）
    fire(titlebar, 'pointermove', 320, 100, 'touch');
    await new Promise((r) => window.requestAnimationFrame(r));
    check('第二触点不改变拖拽基准（位置连续，不跳回）',
      mid === '240px' && widgetEl.style.left === '300px');
    // 单帧 400px 的离群采样：限速到 240px，不瞬移
    fire(titlebar, 'pointermove', 720, 100, 'touch');
    await new Promise((r) => window.requestAnimationFrame(r));
    check('单帧离群采样被限速（最多 +240px，不瞬移）', widgetEl.style.left === '540px');
    fire(titlebar, 'pointerup', 720, 100, 'touch');
  }

  // 锁定位置：右键菜单点击
  const lockItem = document.querySelector('.ctx-item[data-act="lock"]');
  check('菜单包含锁定项', !!lockItem && lockItem.textContent.includes('锁定'));
  lockItem.dispatchEvent(new window.Event('click', { bubbles: true }));
  check('锁定后标题徽标显示', !$('lockBadge').classList.contains('hidden'));
  check('锁定后菜单文案变为解锁', lockItem.textContent.includes('解锁'));

  // 锁定状态下触摸拖动应被拦截
  const leftBeforeLock = widgetEl.style.left;
  fire(titlebar, 'pointerdown', 100, 50, 'touch');
  fire(titlebar, 'pointermove', 200, 100, 'touch');
  await new Promise((r) => window.requestAnimationFrame(r));
  check('锁定状态下触摸拖动无效', widgetEl.style.left === leftBeforeLock);
  fire(titlebar, 'pointerup', 200, 100, 'touch');

  // 设置面板：两个新开关存在并联动
  $('ctxMenu').classList.add('hidden');
  const settingsBtn = document.querySelector('.ctx-item[data-act="settings"]');
  settingsBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  check('设置面板含开机自启动开关', !!$('setAutoLaunch'));
  check('设置面板含锁定位置开关', !!$('setLock'));
  check('锁定开关与状态同步', $('setLock').checked === true);
  $('setLock').checked = false;
  $('setLock').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('取消勾选后解除锁定', $('lockBadge').classList.contains('hidden'));

  /* 添加界面：文件夹类型必须能真正选到目录（v2.2.3 用户反馈的核心）
   * 预览模式的 selectFolder mock 返回 'C:\Demo\示例文件夹'，
   * 走完"选类型 → 点选择 → 名称/图标自动补齐"的完整链路。 */
  console.log('[Folder pick - runtime]');
  $('settingsPanel').classList.add('hidden');
  window.openItemModal(0, null);
  check('添加弹窗已打开', !$('itemModal').classList.contains('hidden'));
  $('itemType').value = 'folder';
  $('itemType').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('类型下拉栏有 folder 选项', !!$('itemType').querySelector('option[value="folder"]'));
  check('folder 类型隐藏"取图标"按钮', $('btnExtractIcon').style.display === 'none');
  check('folder 类型仍显示"选择"按钮', $('btnPick').style.display === 'inline-block');
  check('folder 类型占位符是目录路径示例', $('itemTarget').placeholder.indexOf('教学资料') >= 0);
  $('itemName').value = '';
  $('btnPick').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  check('点"选择"拿到的是文件夹路径（走 selectFolder 而不是 selectFile）',
    $('itemTarget').value === 'C:\\Demo\\示例文件夹');
  check('名称自动用文件夹名兜底', $('itemName').value === '示例文件夹');
  check('文件夹自动套内置文件夹图标', $('itemIcon').value === 'folder');
  // 保存后确实落进分组（类型为 folder，能被 open-target 的 folder 分支接住）
  $('btnItemSave').dispatchEvent(new window.Event('click', { bubbles: true }));
  check('保存后弹窗关闭', $('itemModal').classList.contains('hidden'));
  check('新项已渲染进列表', document.querySelectorAll('#groups .item').length > 0);

  /* ---- v2.2.4：改名 FClassPal + 首次启动种子 ---- */
  console.log('\n[v2.2.4 改名与首次启动种子]');
  check('窗口标题默认 FClassPal', $('titleInput').value === 'FClassPal');
  check('html <title> = FClassPal', /<title>FClassPal<\/title>/.test(html));
  check('托盘提示 = FClassPal', mainJs.includes("setToolTip('FClassPal')"));
  check('标题 fallback 全部换成 FClassPal（不再残留旧名）',
    js.indexOf("'管家助手'") < 0 && (js.match(/\|\| 'FClassPal'/g) || []).length >= 6);
  check('main 种子：只有一个分组且名为「希沃应用」',
    (mainNC.match(/name:\s*'希沃应用'/g) || []).length === 1 &&
    /name:\s*'希沃应用',\s*\n\s*items:\s*\[\]/.test(mainNC));
  check('main 种子：不再预置任何示例快捷方式',
    mainNC.indexOf('希沃学苑') < 0 && mainNC.indexOf('希沃白板5') < 0 &&
    mainNC.indexOf('易+官网') < 0);
  check('预览 mock 种子与 main 对齐（空「希沃应用」分组）',
    /name:\s*'希沃应用',\s*items:\s*\[\]/.test(js));
  check('打包配置已改名（productName / artifactName / appId）',
    /"productName":\s*"FClassPal"/.test(
      fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')) &&
    /"artifactName":\s*"FClassPal-\$\{version\}\.exe"/.test(
      fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')));

  /* ---- v2.3.0：折射修复（JPEG 贴图 → PNG）与关于界面 ---- */
  console.log('\n[v2.3.0 折射修复与关于界面]');
  check('位移贴图是 PNG data URL（feImage 不再渲染 JPEG）',
    /'data:image\/png;base64,/.test(mapJs) && !/data:image\/jpeg/.test(mapJs));
  check('html 有关于区块（版本号 / 作者 / GitHub）',
    html.includes('id="aboutVersion"') && html.includes('id="aboutGithub"') &&
    html.includes('作者 YU'));
  check('app.js 拉取版本号并填充 aboutVersion',
    /API\.getAppVersion\(\)\.then/.test(js) && /aboutVersion/.test(js));
  check('GitHub 链接指向 fangyugit/FClassPal 且走 openExternal',
    js.includes("'https://github.com/fangyugit/FClassPal'") &&
    /openExternal\(GITHUB_URL\)/.test(js));
  check('main: get-app-version + open-external（带 GitHub 域名白名单）',
    mainJs.includes("ipcMain.handle('get-app-version'") &&
    mainJs.includes("ipcMain.handle('open-external'") &&
    /\^https:\\\/\\\/github\\\.com\\\//.test(mainJs));
  check('preload 暴露 getAppVersion / openExternal',
    preloadJs.includes('getAppVersion') && preloadJs.includes('openExternal'));

  /* ---- v2.3.1：苹果风滑块（玻璃主题）+ overLight 亮底自适应 ---- */
  console.log('\n[v2.3.1 苹果滑块 / overLight]');

  // 苹果滑块：作用于 glass + transparent（v2.3.3 起透明主题沿用玻璃滑块语言）
  const slTrack = ruleBlock('body.theme-glass input[type="range"]::-webkit-slider-runnable-track');
  check('css: 玻璃主题滑块轨道 = 强调色已填充段 + 系统填充灰（苹果两段轨道）',
    /var\(--md3-primary/.test(slTrack) && /var\(--sl-fill/.test(slTrack) &&
    /rgba\(120, 120, 128, 0\.28\)/.test(slTrack));
  check('css: 玻璃主题原生拇指只留 hit area（视觉由 .sl-bead 玻璃珠接管，v2.3.1 二次迭代）',
    /body\.theme-glass \.sl-wrap input\[type="range"\]::-webkit-slider-thumb\s*\{\s*\n\s*opacity: 0;/.test(css));
  check('css: 原生拇指不再带白盘放大（按下膨胀移交给 .sl-bead 的 1.45）',
    !/body\.theme-glass input\[type="range"\]:hover::-webkit-slider-thumb[\s\S]{0,120}?scale\(1\.08\)/.test(css));
  check('css: 苹果滑块的作用域锁在 body.theme-glass（不污染其余九套主题）',
    css.includes('body.theme-glass input[type="range"]::-webkit-slider-runnable-track') &&
    !/body\.theme-(md3|fluent|miuix|harmony|kitty|dog|kuromi|melody|sanrio) input\[type="range"\]::-webkit-slider-runnable-track\s*\{[^}]*120, 120, 128/.test(css));

  // 苹果滑块的填充段：--sl-fill 由 JS 写
  check('app.js: syncRangeFill 按 min/max/value 算百分比写入 --sl-fill',
    /function syncRangeFill\(el\)/.test(js) && /setProperty\('--sl-fill'/.test(js) &&
    /\(b - a\)/.test(js));
  check('app.js: input 事件委托覆盖全部滑块（新增控件不用改代码）',
    /document\.addEventListener\('input', \(e\) => syncRangeFill\(e\.target\), true\)/.test(js));
  check('app.js: 代码直接写 .value 的那条路径补了 syncRangeFill（写 value 不派发 input）',
    /opacityRange\.value = v;\s*\n\s*syncRangeFill\(opacityRange\)/.test(js));
  check('app.js: glass 主题挂 theme-glass 标记类（皮肤覆盖仍只走 FLAT_THEMES）',
    /classList\.toggle\('theme-glass', t === 'glass'\)/.test(js) &&
    /FLAT_THEMES\.forEach\(\(n\) => document\.body\.classList\.toggle\('theme-' \+ n/.test(js));

  // overLight：亮底自适应
  check('app.js: overLight 阈值 0.62 + 状态类 + 折射 scale 减半',
    /const OVER_LIGHT_LUM = 0\.62/.test(js) &&
    /classList\.toggle\('over-light', on\)/.test(js) &&
    /setDisplacementScale\(on \? 0\.5 : 1\)/.test(js));
  check('app.js: setDisplacementScale 遍历滤镜里的三个 feDisplacementMap',
    /querySelectorAll\('#liquidGlass feDisplacementMap'\)/.test(js) &&
    /const DISP_BASE_SCALE = \[-70, -77, -84\]/.test(js) &&
    /setAttribute\('scale'/.test(js));
  check('html: 三个 feDisplacementMap 有 id（供 overLight 改 scale）',
    html.includes('id="lgDispR"') && html.includes('id="lgDispG"') &&
    html.includes('id="lgDispB"') &&
    (html.match(/<feDisplacementMap/g) || []).length === 3);
  check('app.js: 实时底材顺手采样亮度（8x8 缩略 + 600ms 节流）',
    /function sampleRealtimeLuminance\(\)/.test(js) &&
    /const RT_LUM_INTERVAL = 600/.test(js) &&
    /drawImage\(src, 0, 0, 8, 8\)/.test(js) &&
    /rt\.ctx\.drawImage\(rt\.video[\s\S]{0,160}?sampleRealtimeLuminance\(\)/.test(js));
  check('app.js: 静态壁纸亮度接到 applyWallpaper',
    /applyOverLight\(info\.luminance\)/.test(js));
  check('main.js: wallpaperLuminance 与 Monet 同口径采样（72px / BGRA）',
    /function wallpaperLuminance\(file\)/.test(mainJs) &&
    /MONET_MAX_DIM/.test(mainJs) && /buf\[i \+ 2\] \+ 0\.7152 \* buf\[i \+ 1\]/.test(mainJs) &&
    /luminance: wallpaperLuminance\(file\)/.test(mainJs));
  check('css: overLight 把模糊提到 14px 并压一层薄墨（仅玻璃主题）',
    /body\.theme-glass\.over-light\s*\{\s*\n\s*--lg-blur: 14px;/.test(css) &&
    /body\.theme-glass\.over-light \.glass-veil\s*\{[\s\S]{0,600}?rgba\(10, 14, 30, 0\.22\)/.test(css));

  /* ---- v2.3.1：液态玻璃滑块珠（折射 + 按下膨胀） ---- */
  console.log('\n[v2.3.1 液态玻璃珠]');
  check('app.js: 珠子注入（.sl-wrap 包裹 + .sl-bead 真实盒 + aria-hidden）',
    /function wrapRange\(el\)/.test(js) &&
    /wrap\.className = 'sl-wrap'/.test(js) &&
    /bead\.className = 'sl-bead'/.test(js) &&
    /bead\.setAttribute\('aria-hidden', 'true'\)/.test(js) &&
    /initGlassBeads\(\)/.test(js));
  check('app.js: 珠贴图 = 药丸距离场（v2.3.3：到核心线段的距离，r = d/R，R = 半高；band 起点 0.42）',
    /const R = H \/ 2;/.test(js) &&
    /const ax = R, bx = W - R;/.test(js) &&
    /const r = d \/ R;/.test(js) &&
    /ss\(0\.42, 1, Math\.min\(1, r\)\)/.test(js) &&
    !/BEAD_MAP_EDGE/.test(js));
  check('app.js: 珠贴图 alpha = 药丸形状遮罩（EDGE_MASK 来自贴图 alpha，形状由它决定）',
    /px\[q \+ 3\] = Math\.round\(ss\(1\.03, 0\.97, r\) \* 255\)/.test(js));
  check('app.js: 珠贴图失败不借主贴图（主贴图 alpha 是自己的形状，罩珠子仍是方）',
    /const href = makeBeadMap\(\);\s*\n\s*if \(href\) \{/.test(js) &&
    !/makeBeadMap\(\) \|\|/.test(js) &&
    !/thumbMap\.setAttribute/.test(js));
  check('app.js: 滤镜链尾没有追加 feComposite 圆裁（EDGE_MASK 已裁，追加会把白雾裁没）',
    !/EDGE_CIRCLED/.test(js));
  check('app.js: 珠子滤镜 scale 缩到珠子量级（-70×14/70 → -14）',
    /n\.setAttribute\('scale', \(s \* \(14 \/ 70\)\)\.toFixed\(2\)\)/.test(js));
  check('css: 珠子作用域锁玻璃主题（单选择器，带完整后代）+ 左右药丸 34x22（border-radius:999px，用户点名左右要圆）+ 事件穿透',
    /body\.theme-glass \.sl-bead\s*\{[\s\S]{0,700}?width: var\(--sl-bead-w, 34px\)/.test(css) &&
    /body\.theme-glass \.sl-bead\s*\{[\s\S]{0,700}?height: var\(--sl-bead-h, 22px\)/.test(css) &&
    /body\.theme-glass \.sl-bead\s*\{[\s\S]{0,700}?border-radius: 999px/.test(css) &&
    !/body\.theme-glass \.sl-bead\s*\{[\s\S]{0,700}?border-radius: 50%/.test(css) &&
    /var\(--sl-ratio, 0\.5\) \* \(100% - var\(--sl-bead-w, 34px\)\)/.test(css) &&
    /body\.theme-glass \.sl-bead\s*\{[\s\S]{0,700}?pointer-events: none/.test(css) &&
    /\.sl-bead \{ display: none; \}/.test(css));
  check('css: 珠子中间透明（不铺底色，白雾壳 = inset 环，随药丸圆端走，不再用椭圆径向渐变）',
    !/body\.theme-glass \.sl-bead\s*\{[\s\S]{0,1600}?background:/.test(css) &&
    /body\.theme-glass \.sl-bead\s*\{[\s\S]{0,1600}?inset 0 0 5px 1px rgba\(255, 255, 255, 0\.38\)/.test(css) &&
    !/body\.theme-glass \.sl-bead\s*\{[\s\S]{0,1600}?closest-side ellipse/.test(css));
  check('css: 折射滤镜字面量 url(#liquidThumb) 且只在 lg-ready 后挂（var() 中转不生效）',
    /body\.theme-glass\.lg-ready \.sl-bead\s*\{\s*\n\s*filter: url\(#liquidThumb\);/.test(css) &&
    !/filter:\s*var\(--sl-filter/.test(css));
  check('css: 悬停 1.12 / 按下 1.42 的膨胀（等比，药丸不变形）',
    /input\[type="range"\]:hover ~ \.sl-bead\s*\{[\s\S]{0,80}?scale\(1\.12\)/.test(css) &&
    /input\[type="range"\]:active ~ \.sl-bead\s*\{[\s\S]{0,120}?scale\(1\.42\)/.test(css));
  check('css: --sl-fill 不在 input 上声明（元素自身声明会压过 .sl-wrap 的继承值 → 进度条不跟随）',
    !/body\.theme-glass input\[type="range"\]\s*\{[^}]*--sl-fill\s*:/.test(css));
  check('app.js: syncRangeFill 写 .sl-wrap 时清掉元素自身的陈旧变量（修"拖动进度条不跟随"）',
    /if \(host !== el\) \{\s*\n\s*el\.style\.removeProperty\('--sl-fill'\);\s*\n\s*el\.style\.removeProperty\('--sl-ratio'\);/.test(js));
  check('app.js: 珠注入完成后整体补一次 syncAllRangeFills（写在 initGlassBeads 里）',
    /document\.querySelectorAll\('input\[type="range"\]'\)\.forEach\(wrapRange\);\s*\n[\s\S]{0,260}?syncAllRangeFills\(\);\s*\n\}/.test(js));
  check('app.js: 珠滤镜 feImage 改 preserveAspectRatio=none（圆形 alpha 才能落成椭圆）',
    /dstMap\.setAttribute\('preserveAspectRatio', 'none'\)/.test(js));
  check('html: 主滤镜区域 170%（珠贴图 1/1.7 归一化的前提）',
    /<filter id="liquidGlass" x="-35%" y="-35%" width="170%" height="170%"/.test(html));

  // 位移贴图：保持预烘焙 + slice —— 这里拦的是"重新发明按比例生成"
  check('回归：位移贴图仍是预烘焙单文件 + feImage 用 slice（勿改成运行时生成）',
    /href="" preserveAspectRatio="xMidYMid slice"/.test(html) &&
    !/lg-map-gen/.test(html) &&
    !fs.existsSync(path.join(__dirname, 'renderer', 'lg-map-gen.js')) &&
    !/refreshDisplacementMap|LG_MAP_GEN/.test(js));
  check('回归：app.js 里留了 A/B 结论（宽扁窗口并不丢上下折射），防止再改一遍',
    /宽扁丢上下折射/.test(js) && /probe_aspect_/.test(js));

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
