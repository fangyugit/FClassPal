const path = require('path');
const fs = require('fs');
const extractFile = (_a, rel) => fs.readFileSync(String(rel).replace(/\\/g, '/'));
const asar = path.join('dist', 'win-unpacked', 'resources', 'app.asar');
const main = extractFile(asar, 'main.js').toString();
const pre = extractFile(asar, 'preload.js').toString();
const css = extractFile(asar, 'renderer/style.css').toString();
const app = extractFile(asar, 'renderer/app.js').toString();
const html = extractFile(asar, 'renderer/index.html').toString();
const mapJs = (() => { try { return extractFile(asar, 'renderer/lg-displacement-map.js').toString(); } catch (e) { return ''; } })();
// v1.8：预打包好的 Monet 库（单个 CJS 文件），必须真的进了 asar
const mapJs2 = (() => { try { return extractFile(asar, 'vendor/monet.js').toString(); } catch (e) { return ''; } })();
const cssNC = css.replace(/\/\*[\s\S]*?\*\//g, '');
// 同样剥掉 main.js 的块注释："某 API 已移除"这类断言不能被注释里的旧写法误伤
const mainNC = main.replace(/\/\*[\s\S]*?\*\//g, '');
// 取某条规则的声明体（停在第一个 }），别用 [\s\S]{0,N} 窗口——那会串到下一条规则
const ruleBody = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = cssNC.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
};
const warpBody = ruleBody('.glass-warp');
const veilBody = ruleBody('.glass-veil');
const deskBody = ruleBody('.desk-canvas');
/* 选择器成组时（sel1,\nsel2 { … }）ruleBody 那条拼接 selector+' {' 的写法会落空，
 * 这种就按"从选择器出现处切到第一个 }"取。 */
const ruleBlockFrom = (sel) => {
  const i = cssNC.indexOf(sel);
  if (i < 0) return '';
  const j = cssNC.indexOf('}', i);
  return j < 0 ? '' : cssNC.slice(i, j);
};
/* 取某套主题的 token 块（body.theme-X { ... }）。
 * ※ 前导换行不能省：prefers-reduced-motion 里有一组
 *   "body.theme-md3, body.theme-fluent, ..., body.theme-kitty {" 的选择器列表，
 *   不加换行会先命中那一条，取到"动效归零块"而不是主题 token（实测踩过）。 */
const themeTokens = (t) => {
  const i = cssNC.indexOf('\nbody.theme-' + t + ' {');
  if (i < 0) return '';
  const j = cssNC.indexOf('}', i);
  return j < 0 ? '' : cssNC.slice(i, j);
};
const moveBody = ruleBody('body.is-moving .glass-warp');
const resizeBody = ruleBlockFrom('body.is-resizing .glass-warp');
const srcPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const checks = [
  ['html: SVG sprite svgDefs', html.includes('svgDefs')],
  ['html: 光斑宿主 sheen', html.includes('id="sheen"')],
  ['html: 液态玻璃滤镜 #liquidGlass（v1.6 standard）', html.includes('id="liquidGlass"') && /<feImage/.test(html)],
  ['html: feImage 载入预烘焙位移贴图 #lgMap', /<feImage[^>]*id="lgMap"/.test(html) &&
    /preserveAspectRatio="xMidYMid slice"/.test(html)],
  ['html: 三次 feDisplacementMap 色差链', (html.match(/<feDisplacementMap/g) || []).length === 3],
  ['html: 位移 scale -70/-77/-84（standard 模式取负号）',
    /scale="-70"/.test(html) && /scale="-77"/.test(html) && /scale="-84"/.test(html)],
  ['html: 位移通道 R/B（G 通道均值≈0，Y 必须取 B）',
    (html.match(/xChannelSelector="R"/g) || []).length === 3 &&
    (html.match(/yChannelSelector="B"/g) || []).length === 3],
  ['html: 色散掩膜 feFuncA discrete + 反相 table',
    /feFuncA[^>]*type="discrete"/.test(html) && /feFuncA[^>]*type="table"[^>]*tableValues="1 0"/.test(html)],
  ['html: 滤镜区域 -35%/170% + sRGB', /x="-35%" y="-35%" width="170%" height="170%"/.test(html) &&
    /color-interpolation-filters="sRGB"/.test(html)],
  ['html: 收尾柔化 σ=0.3（原版 aberration 2 → 0.5-0.2）', /stdDeviation="0\.3"/.test(html)],
  ['html: 已移除 v1.5 的 Sobel feConvolveMatrix', !/<feConvolveMatrix/.test(html)],
  ['html: 双层边光环 div', html.includes('lg-border--screen') && html.includes('lg-border--overlay')],
  ['html: 折射基底层 #envLayer', html.includes('id="envLayer"')],
  ['html: 实时底材 canvas #deskCanvas 在 envLayer 内',
    html.includes('id="deskCanvas"') && /id="envLayer"[\s\S]{0,200}id="deskCanvas"/.test(html)],
  ['html: 四层玻璃结构 envLayer / glassWarp / glassVeil',
    html.includes('id="glassWarp"') && html.includes('id="glassVeil"') &&
    /glass-warp[\s\S]{0,400}glass-veil/.test(html)],
  ['html: 实时模糊开关 + 状态行', html.includes('id="setRealtime"') && html.includes('id="realtimeInfo"')],
  ['html: 贴图脚本先于 app.js 加载',
    /lg-displacement-map\.js[\s\S]{0,120}app\.js/.test(html)],
  ['asar: 位移贴图已随包（dataURL）', /LG_DISPLACEMENT_MAP\s*=\s*'data:image\/jpeg;base64,/.test(mapJs)],
  ['css: 滤镜挂在 .glass-warp（非 ::before）',
    /url\(#liquidGlass\)/.test(css) && /body\.lg-ready \.glass-warp/.test(css)],
  ['css: backdrop-filter 里绝不再出现 url()', !/backdrop-filter:[^;]*url\(#/.test(cssNC)],
  ['css: 玻璃底模糊 = blur(6px) saturate(140%)（原版默认）',
    /backdrop-filter:\s*blur\(6px\) saturate\(140%\)/.test(css)],
  ['css: .glass-warp 自身无背景/无描边（滤镜输入必须干净）',
    /pointer-events:\s*none/.test(warpBody) && !/(box-shadow|border:|background:)/.test(warpBody)],
  ['css: 边光环空心 mask', css.includes('mask-composite: exclude') && css.includes('-webkit-mask-composite: xor')],
  ['css: 边光角度/亮度变量', css.includes('var(--lg-angle, 135deg)') && css.includes('var(--lg-glow, 0)')],
  ['css: 面纱/描边/投影已迁到 .glass-veil',
    /box-shadow/.test(veilBody) && /border:\s*1px solid/.test(veilBody) &&
    /background:/.test(veilBody)],
  ['css: 实时 canvas 默认透明，body.realtime 时点亮',
    /opacity:\s*0/.test(deskBody) &&
    /body\.realtime \.desk-canvas[\s\S]{0,120}opacity:\s*1/.test(cssNC)],
  ['css: 三层 z-index -1 / 0 / 1', /\.widget > \.env-layer\s*\{[\s\S]{0,80}z-index:\s*-1/.test(cssNC) &&
    /\.widget > \.glass-warp\s*\{[\s\S]{0,80}z-index:\s*0/.test(cssNC) &&
    /\.widget > \.glass-veil\s*\{[\s\S]{0,80}z-index:\s*1/.test(cssNC)],
  // v1.8：拖动只摘折射、保留模糊（全关会在按下/松手时"掉画质"，用户反馈成闪）；
  // 只有缩放才整套全关
  ['css: 拖动期间只关折射滤镜，模糊必须留着',
    /filter:\s*none\s*!important/.test(moveBody) && !/backdrop-filter/.test(moveBody)],
  ['css: 缩放期间才整套滤镜全关（含 backdrop-filter）',
    /backdrop-filter:\s*none\s*!important/.test(resizeBody) &&
    /filter:\s*none\s*!important/.test(resizeBody)],
  ['css: 白面纱系数 0.26/0.38', /calc\(0\.26 \* var\(--glass-alpha\)\)/.test(css) &&
    /calc\(0\.38 \* var\(--glass-alpha\)\)/.test(css)],
  // 只断言 glass 主题那条基础规则；MD3 的规则（body.theme-flat .opacity-bar）本来就该是
  // 近实色 tonal surface——别再用 [\\s\\S]{0,900} 窗口，那会串到后面的 MD3 规则里
  ['css: 透明度条改用玻璃语言（面纱乘 --glass-alpha）',
    /calc\(0\.34 \* var\(--glass-alpha\)\)/.test(ruleBody('.opacity-bar')) &&
    !/rgba?\([^)]*0\.95\)/.test(ruleBody('.opacity-bar'))],
  ['app.js: enableLiquidGlass 能力探测 + lg-ready',
    app.includes('function enableLiquidGlass') && app.includes("classList.add('lg-ready')")],
  ['app.js: 已移除 buildLiquidGlass 贴图方案', !app.includes('buildLiquidGlass')],
  ['app.js: refreshWallpaper 用 setTimeout（窗口隐藏时 rAF 不触发）',
    /function refreshWallpaper[\s\S]{0,600}setTimeout\(/.test(app)],
  ['app.js: repositionWallpaper 用屏幕坐标 bounds', /function repositionWallpaper[\s\S]{0,500}bounds\.x/.test(app)],
  ['app.js: 鼠标驱动边光变量', app.includes("setProperty('--lg-angle'") && app.includes("setProperty('--lg-glow'")],
  ['app.js: 贴图 dataURL 注入 #lgMap（含 xlink 兜底）',
    app.includes('LG_DISPLACEMENT_MAP') && app.includes("setAttribute('href'") && app.includes("'xlink:href'")],
  ['app.js: 能力探测改用 CSS.supports(filter, url())',
    app.includes("CSS.supports('filter'") && !app.includes("CSS.supports('backdrop-filter'")],
  ['app.js: 实时底材 RT_FPS=15', /const RT_FPS = 15/.test(app)],
  ['app.js: startRealtimeBackdrop 走 getDisplayMedia',
    app.includes('function startRealtimeBackdrop') && app.includes('getDisplayMedia')],
  ['app.js: 失败降级 + 首次交互重试 armRealtimeRetry',
    app.includes('function armRealtimeRetry') && app.includes('stopRealtimeBackdropQuiet')],
  ['app.js: 采集按窗口 bounds 裁剪 drawImage', /function drawRealtimeFrame[\s\S]{0,1600}drawImage\(/.test(app)],
  ['app.js: 拖动/缩放后刷新底材几何', app.includes('refreshRealtimeBounds')],
  ['app.js: 开关联动 + 回落提示', app.includes("$('setRealtime')") && app.includes('静态壁纸底材')],
  ['main.js: setDisplayMediaRequestHandler 自动放行本屏',
    main.includes('setDisplayMediaRequestHandler') && main.includes("types: ['screen']")],
  ['main.js: setContentProtection 防自拍无限镜面', main.includes('setContentProtection(true)')],
  ['main.js: realtime-start / realtime-stop / get-display-info',
    main.includes("'realtime-start'") && main.includes("'realtime-stop'") && main.includes("'get-display-info'")],
  ['preload: startRealtime / stopRealtime / getDisplayInfo',
    pre.includes('startRealtime') && pre.includes('stopRealtime') && pre.includes('getDisplayInfo')],
  ['html: 无 emoji', !/[\u{1F000}-\u{1FAFF}\u{2B50}\u{2600}-\u{27BF}\u{FE0F}]/u.test(html + css + app)],
  ['css: 液态玻璃 sheen 光斑', css.includes('.sheen')],
  ['css: hover 光感仅鼠标设备', /@media \(hover: hover\) and \(pointer: fine\)/.test(css)],
  ['css: 玻璃层已拆成 warp/veil 两层（不再用 ::before）',
    /\.glass-warp\s*\{/.test(css) && /\.glass-veil\s*\{/.test(css) && !/\.widget::before\s*\{/.test(cssNC)],
  ['css: --glass-alpha 变量', css.includes('--glass-alpha')],
  ['app.js: svgIcon 工厂', app.includes('function svgIcon')],
  ['app.js: sheen 光斑 rAF', app.includes('sheenRaf') && app.includes("pointerType !== 'mouse'")],
  ['app.js: 透明度只控玻璃（setProperty --glass-alpha）',
    !app.includes('widget.style.opacity') && app.includes("setProperty('--glass-alpha'")],
  ['app.js: browser 预览模式', app.includes("body.classList.add('preview')")],
  ['main.js: 已停止 OS 级 setOpacity（仅注释）',
    !/mainWindow\.setOpacity\s*\(/.test(main) && main.includes('OS 级窗口透明度已停用')],
  ['main.js: get-wallpaper IPC + 壁纸矩形计算',
    /ipcMain\.handle\('get-wallpaper'/.test(main) && /function wallpaperRect/.test(main) &&
    /function readRegValue/.test(main)],
  ['main.js: 窗口始终 transparent（圆角靠 per-pixel alpha）', /transparent:\s*true/.test(main)],
  ['main.js: 已移除 mica（不透明窗口会在四角露出方形底色）',
    !/setBackgroundMaterial/.test(mainNC) && !/useMica/.test(mainNC)],
  ['main.js: 壁纸变更监听 + wallpaper-changed 推送',
    /function checkWallpaperChanged/.test(main) && /send\('wallpaper-changed'/.test(main) &&
    /setInterval\(checkWallpaperChanged/.test(main)],
  ['main.js: 壁纸指纹含文件 mtime（幻灯片轮播只改 mtime）',
    /function wallpaperSignature/.test(main) && /meta\.mtime/.test(main)],
  ['preload: onWallpaperChanged', pre.includes('onWallpaperChanged')],
  ['app.js: 收到 wallpaper-changed 重画基底', app.includes('API.onWallpaperChanged')],
  ['main.js: 默认只模糊壁纸（realtime:false）', /realtime:\s*false/.test(main)],
  ['app.js: 只有显式开启才起屏幕采集', app.includes('config.realtime === true')],
  ['main.js: 弹出 U 盘时上溯到 USB 父节点（CM_Get_Parent）',
    /CM_Get_Parent/.test(main) && /CM_Get_Device_IDW/.test(main) && /USB\\{4,}/.test(main)],
  ['main.js: WMI 关联链取 PNPDeviceID（免管理员）',
    /Win32_LogicalDiskToPartition/.test(main) && /Win32_DiskDriveToDiskPartition/.test(main)],
  ['main.js: WMI Dismount 兜底层', /MethodName Dismount/.test(main)],
  /* ---- v2.2.3 三处修复的打包层断言（源码层在 smoke-test 里有更细的版本） ---- */
  ['main.js: VETO 码 9=供电不足 / 12=权限不足（旧版 9 被误写成权限）',
    /9: '设备供电不足/.test(main) && /12: '权限不足/.test(main) &&
    /5: '该 U 盘上还有未关闭的文件句柄/.test(main)],
  ['main.js: CM 码 51=CR_ACCESS_DENIED（旧版误写成"设备正忙"）',
    /51: '访问被拒绝（CR_ACCESS_DENIED）/.test(main) && !/51: '设备正忙/.test(main)],
  ['main.js: 卷级弹出层（LOCK/DISMOUNT/MEDIA_REMOVAL/EJECT + DeleteVolumeMountPointW）',
    /function buildVolumeEjectScript/.test(main) && /0x00090018u/.test(main) &&
    /0x00090020u/.test(main) && /0x002D1400u/.test(main) && /0x002D4808u/.test(main) &&
    /DeleteVolumeMountPointW/.test(main)],
  ['main.js: CM 弹出逻辑抽成 InvokeCmEject 函数（提权模式复用同一份）',
    /function buildCmEjectFn/.test(main) && /function InvokeCmEject\(\$l\)/.test(main)],
  ['main.js: 失败回传 needAdmin + 提权通道 eject-drive-elevated（UAC）',
    /needAdmin: needAdmin \|\| driveExists\(\)/.test(main) &&
    /ipcMain\.handle\('eject-drive-elevated'/.test(main) && /-Verb RunAs/.test(main)],
  ['preload: ejectDriveElevated 已暴露给渲染层', /ejectDriveElevated:/.test(pre)],
  ['app.js: 弹出失败后按钮变「管理员重试」，第二次点击才提权',
    /ejectBtn\.dataset\.admin/.test(app) && /'管理员重试'/.test(app) &&
    /API\.ejectDriveElevated/.test(app)],
  ['main.js: select-folder 通道用 openDirectory（Windows 的 openFile 选不到目录）',
    /ipcMain\.handle\('select-folder'/.test(main) && /properties: \['openDirectory'/.test(main)],
  ['main.js: select-file 仍是 openFile（没被改过头）',
    /ipcMain\.handle\('select-file'[\s\S]{0,120}properties: \['openFile'\]/.test(main)],
  ['main.js: open-target 支持 folder 类型', /item\.type === 'folder'/.test(main)],
  ['preload: selectFolder 已暴露', /selectFolder: \(\) => ipcRenderer\.invoke\('select-folder'\)/.test(pre)],
  ['html: 类型下拉栏拆出"文件夹（目录）"选项',
    /<option value="folder">文件夹（目录）<\/option>/.test(html) && !/文件 \/ 文件夹/.test(html)],
  ['app.js: folder 走 selectFolder + 自动套文件夹图标',
    /type === 'folder'\) p = await API\.selectFolder\(\)/.test(app) &&
    /setIconState\('folder', '', ''\)/.test(app)],
  ['app.js: 拖动改用整数位置（nx/ny），位置按 pointerId 归属',
    /API\.moveWindow\(nx, ny\)/.test(app) && /dragPointerId = e\.pointerId/.test(app) &&
    /e\.pointerId !== dragPointerId/.test(app)],
  ['app.js: 拖动卡死自救（旧指针 up 被吞掉时，静止 1.5s 后允许重新开始）',
    /dragLastAt/.test(app) && /Date\.now\(\) - dragLastAt < 1500/.test(app)],
  ['app.js: pointercancel 软结束（宽限期续拖，滤镜不反复摘戴）',
    /DRAG_CANCEL_GRACE = 260/.test(app) && /softEndDrag/.test(app) &&
    /softEndResize/.test(app)],
  ['app.js: 拖动期间不弹长按/右键菜单',
    /if \(dragging \|\| dragPointerDown \|\| resizing \|\| rsPointerDown\) return;/.test(app)],
  ['main.js: Monet 取色（QuantizerCelebi + Score + SchemeTonalSpot）',
    /QuantizerCelebi\.quantize/.test(main) && /Score\.score/.test(main) &&
    /new monet\.SchemeTonalSpot/.test(main) && /MD3_ROLE_MAP/.test(main) &&
    !/function pickSourceHue/.test(main)],
  ['main.js: toBitmap 按 BGRA 取通道', /argbFromRgb\(buf\[i \+ 2\], buf\[i \+ 1\], buf\[i\]\)/.test(main)],
  ['main.js: 灰白壁纸退回基线紫 + dynamic 标记',
    /MD3_BASELINE\s*=\s*'#6750a4'/.test(main) && /best === fallback/.test(main)],
  ['main.js: 手动指定主色 + get-palette IPC',
    /function monetSourceFromHex/.test(main) && /ipcMain\.handle\('get-palette'/.test(main) &&
    /palette: await buildPalette/.test(main)],
  ['main.js: 调色板缓存（key 含 mode + color + sig）',
    /PALETTE_CACHE/.test(main) && /paletteCacheSet/.test(main)],
  ['asar: vendor/monet.js 随包（ESM 在 asar 里 import 不了，必须预打成 CJS）',
    mapJs2.length > 50000 && /MaterialDynamicColors/.test(mapJs2)],
  // 注意：asar 内的 package.json 会被 builder 剥掉 build 字段（老坑），
  // 所以这条查的是源码那份；实际有没有打进去由上一条 extractFile 说话。
  ['打包白名单放行 vendor/**（漏了就无法 require）',
    (srcPkg.build && srcPkg.build.files || []).includes('vendor/**/*')],
  ['asar: 位移贴图随包', /LG_DISPLACEMENT_MAP\s*=\s*'data:image\/jpeg;base64,/.test(mapJs)],
  ['html: 风格分段选择器（glass / md3）',
    html.includes('id="themeSelect"') && !html.includes('id="themeSeg"')],
  ['html: MD3 取色方式（莫奈取色 / 手动指定）',
    html.includes('id="colorModeSeg"') && /data-mode="auto"/.test(html) &&
    /data-mode="manual"/.test(html)],
  ['html: 手动模式的取色器 + 预设色板',
    html.includes('id="accentColor"') && html.includes('id="swatches"') && /class="swatch"/.test(html)],
  ['app.js: 拖动用屏幕坐标（clientX 会随窗口位移，是自激振荡的根源）',
    /dragStartX = lastX = e\.screenX/.test(app) && !/dragStartX = lastX = e\.clientX/.test(app)],
  ['app.js: 拖动每帧重算壁纸偏移', /repositionWallpaper\(\);\s*\n\}/.test(app)],
  ['app.js + main.js + preload: set-dragging 三件套',
    /API\.setDragging\(true\)/.test(app) && /ipcMain\.on\('set-dragging'/.test(main) &&
    /setDragging:/.test(pre)],
  ['main.js: 拖拽期间不回推 bounds / 不改 Z 序',
    /if \(!renderDragging\) pushBounds\(b\)/.test(main) &&
    /!renderDragging\)[\s\S]{0,80}moveBottom/.test(main)],
  ['main.js: 透明窗口显式 #00000000 底色（免首次合成白闪）',
    /backgroundColor: '#00000000'/.test(main)],
  ['main.js: 拖动诊断只在异常时落 drag-diag.log（正常拖拽零 IO）',
    /drag-diag\.log/.test(main) && /dragStat\.maxStep > 400/.test(main) &&
    /function dragDiagWrite/.test(main)],
  ['preload: getPalette', /getPalette:/.test(pre)],
  ['app.js: MD3 动效 helper（cross-fade / stagger / 重播）',
    /function motionCrossFade/.test(app) && /function staggerIndex/.test(app) &&
    /function motionReplay/.test(app)],
  ['app.js: 尊重 prefers-reduced-motion', /prefers-reduced-motion: reduce/.test(app)],
  ['css: MD3 motion token（缓动 + 时长档位）',
    /--md3-ease-standard:\s*cubic-bezier\(0\.2, 0, 0, 1\)/.test(css) &&
    /--md3-ease-emphasized-decelerate:\s*cubic-bezier\(0\.05, 0\.7, 0\.1, 1\)/.test(css) &&
    /--md3-dur-short1:\s*50ms/.test(css) && /--md3-dur-extra-long2:\s*800ms/.test(css)],
  ['css: 入场动效用 backwards（不用 both/forwards，否则压掉 :active 按压反馈）',
    /animation-fill-mode:\s*backwards/.test(cssNC) &&
    (cssNC.match(/backwards/g) || []).length >= 11 &&
    /animation-delay:\s*calc\(var\(--i, 0\) \* var\(--t-stagger\)\)/.test(cssNC) &&
    !/animation:\s*t-(?:in|panel|toast)-[\w-]+[^;]*\b(?:both|forwards)\b/.test(cssNC)],
  ['css: 十套入场动画名互不相同',
    ['md3', 'fluent', 'miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'].every((t) =>
      new RegExp('@keyframes t-in-' + t + '\\b').test(cssNC))],
  ['css: reduced-motion 让路', /@media \(prefers-reduced-motion: reduce\)/.test(css)],
  ['css: 预设色板样式', /\.swatch\s*\{/.test(css) && /\.swatch\[aria-pressed="true"\]/.test(css)],
  ['多主题: 已彻底移除 theme-flat 共底（十套风格各自自足）',
    !/theme-flat/.test(cssNC) && !/theme-flat/.test(app) &&
    !/md3-enter/.test(cssNC) && !/md3-enter/.test(app)],
  ['多主题: 主题选择为下拉栏（#themeSelect 由 THEME_LABEL 填充；分段按钮已移除）',
    html.includes('<select id="themeSelect"') && !/data-theme="/.test(html) &&
    /themeSelect\.innerHTML = THEMES\.map/.test(app)],
  ['多主题: app.js THEMES 清单 10 套 + 每套推荐主色 + accentPicked 守卫',
    /const THEMES = \['glass', 'md3', 'fluent', 'miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'\]/.test(app) &&
    /kitty:\s*'#C2185B'/.test(app) && /dog:\s*'#4FA8E8'/.test(app) &&
    /kuromi:\s*'#8E5BC8'/.test(app) && /melody:\s*'#EC6FA8'/.test(app) &&
    /sanrio:\s*'#E8548A'/.test(app) && /accentPicked/.test(app)],
  ['多主题: 固定配色主题集合（kitty/dog/miuix/harmony/kuromi/melody/sanrio）',
    /const FIXED_PALETTE_THEMES = \['kitty', 'dog', 'miuix', 'harmony', 'kuromi', 'melody', 'sanrio'\]/.test(app)],
  ['多主题: 十套主题各自定义完整 token（形状/模糊/表面/强调色/动效）',
    ['md3', 'fluent', 'miuix', 'harmony', 'kitty', 'dog', 'kuromi', 'melody', 'sanrio'].every((t) => {
      const b = themeTokens(t);
      return /--t-r-win:/.test(b) && /--t-r-card:/.test(b) && /--t-btn-r:/.test(b) &&
        /--t-blur:/.test(b) && /--t-surface:/.test(b) && /--t-accent:/.test(b) &&
        /--t-ease:/.test(b) && /--t-dur:/.test(b) && /--t-stagger:/.test(b);
    })],
  ['多主题: 十套形状标度各就各位（16/8/16/20/24/22/20/22/22）',
    /--t-r-card:\s*16px/.test(themeTokens('md3')) &&
    /--t-r-card:\s*8px/.test(themeTokens('fluent')) &&
    /--t-r-card:\s*16px/.test(themeTokens('miuix')) &&
    /--t-r-card:\s*20px/.test(themeTokens('harmony')) &&
    /--t-r-card:\s*24px/.test(themeTokens('kitty')) &&
    /--t-r-card:\s*22px/.test(themeTokens('dog')) &&
    /--t-r-card:\s*20px/.test(themeTokens('kuromi')) &&
    /--t-r-card:\s*22px/.test(themeTokens('melody')) &&
    /--t-r-card:\s*22px/.test(themeTokens('sanrio'))],
  ['多主题: 十套模糊强度互不相同',
    /blur\(14px\) saturate\(118%\)/.test(themeTokens('md3')) &&
    /blur\(30px\) saturate\(125%\)/.test(themeTokens('fluent')) &&
    /blur\(22px\) saturate\(150%\)/.test(themeTokens('miuix')) &&
    /blur\(24px\) saturate\(140%\)/.test(themeTokens('harmony')) &&
    /blur\(18px\) saturate\(140%\)/.test(themeTokens('kitty')) &&
    /blur\(26px\) saturate\(130%\)/.test(themeTokens('dog')) &&
    /blur\(20px\) saturate\(130%\)/.test(themeTokens('kuromi')) &&
    /blur\(18px\) saturate\(135%\)/.test(themeTokens('melody')) &&
    /blur\(22px\) saturate\(135%\)/.test(themeTokens('sanrio'))],
  ['多主题: Fluent 小圆角 4px 控件 / 亚克力 / 噪点 / Reveal 高光',
    /--t-r-ctl:\s*4px/.test(themeTokens('fluent')) &&
    /feTurbulence/.test(cssNC) &&
    /radial-gradient\(circle at var\(--rv-x, ?50%\) var\(--rv-y, ?50%\)/.test(cssNC) &&
    /--rv-x/.test(app)],
  ['多主题: MIUIX v2.1 对齐 compose-miuix-ui（固定 #3482FF / 16dp 家族 / 掠光 / HyperOS 缓动）',
    /linear-gradient/.test(ruleBlockFrom('body.theme-miuix .glass-veil {')) &&
    /--md3-primary:\s*#3482FF/.test(themeTokens('miuix')) &&
    /--t-btn-r:\s*16px/.test(themeTokens('miuix')) &&
    /cubic-bezier\(0\.2, 0, 0, 1\)/.test(themeTokens('miuix')) &&
    /background-position:\s*130% 0, 0 0/.test(css)],
  ['多主题: 鸿蒙 v2.1 对齐官方规范（固定 #0A59F7 / 沉浸光感边缘流光环）',
    /--md3-primary:\s*#0A59F7/.test(themeTokens('harmony')) &&
    /@property --hl-angle/.test(cssNC) &&
    /conic-gradient\(from var\(--hl-angle\)/.test(css) &&
    /@keyframes hl-orbit/.test(cssNC) &&
    /body\.theme-harmony \.item-icon \{[^}]*border-radius:\s*50%/.test(cssNC)],
  ['多主题: Kitty v2.2 = 固定粉白配色 + 真实裁剪图片（5 张素材 8 处贴图位）',
    /--md3-primary:\s*#E8548A/.test(themeTokens('kitty')) &&
    /--t-accent:\s*#E8548A/.test(themeTokens('kitty')) &&
    /#FFF7FA/.test(themeTokens('kitty')) &&
    /body\.theme-kitty \.titlebar::after[^}]*theme\/kitty\/kitty-head\.png/.test(cssNC) &&
    /body\.theme-kitty \.widget::after[^}]*theme\/kitty\/kitty-full\.png/.test(cssNC) &&
    /body\.theme-kitty \.glass-veil::before[^}]*theme\/kitty\/kitty-wave\.png/.test(cssNC) &&
    /body\.theme-kitty \.usb-section::before[^}]*theme\/kitty\/kitty-ballet\.png/.test(cssNC) &&
    /body\.theme-kitty \.group-title::before[^}]*%3Csvg/.test(cssNC)],
  ['资产: kitty 图片进了 asar（随 renderer 白名单打包）',
    /* ※ @electron/asar 的 extractFile 对多级子目录只认反斜杠（实测：
     *   'renderer/theme/kitty/x.png' 报 not found，'renderer\theme\kitty\x.png' 才行）。 */
    ['kitty-head.png', 'kitty-full.png', 'kitty-sit.png', 'kitty-wave.png', 'kitty-ballet.png', 'kitty-kimono.png'].every((f) => {
      try {
        return extractFile(asar, 'renderer\\theme\\kitty\\' + f).length > 1000;
      } catch (e) { return false; }
    })],
  ['多主题: 玉桂狗 v2.2 = 固定蓝白配色 + 真实裁剪图片（头像/飞机/眨眼）',
    /--md3-primary:\s*#4FA8E8/.test(themeTokens('dog')) &&
    /--t-accent:\s*#4FA8E8/.test(themeTokens('dog')) &&
    /--t-r-card:\s*22px/.test(themeTokens('dog')) &&
    /body\.theme-dog \.titlebar::after[^}]*theme\/dog\/cinna-head\.png/.test(cssNC) &&
    /body\.theme-dog \.widget::after[^}]*theme\/dog\/cinna-plane\.png/.test(cssNC) &&
    /body\.theme-dog \.usb-section::after[^}]*theme\/dog\/cinna-wink\.png/.test(cssNC)],
  ['资产: dog 图片进了 asar（v2.2.2 含单车/草莓）',
    ['cinna-head.png', 'cinna-plane.png', 'cinna-wink.png', 'cinna-bike.png', 'cinna-berry.png'].every((f) => {
      try {
        return extractFile(asar, 'renderer\\theme\\dog\\' + f).length > 500;
      } catch (e) { return false; }
    })],
  ['多主题: 库洛米 v2.2 = 固定紫粉配色（#8E5BC8/#F06292）+ 真实裁剪图片',
    /--md3-primary:\s*#8E5BC8/.test(themeTokens('kuromi')) &&
    /--md3-secondary:\s*#F06292/.test(themeTokens('kuromi')) &&
    /--t-accent:\s*#8E5BC8/.test(themeTokens('kuromi')) &&
    /--t-btn-r:\s*14px/.test(themeTokens('kuromi')) &&
    /body\.theme-kuromi \.titlebar::after[^}]*theme\/kuromi\/kuromi-head\.png/.test(cssNC) &&
    /body\.theme-kuromi \.widget::after[^}]*theme\/kuromi\/kuromi-stand\.png/.test(cssNC) &&
    /body\.theme-kuromi \.usb-section::after[^}]*theme\/kuromi\/kuromi-love\.png/.test(cssNC) &&
    /body\.theme-kuromi \.panel::after[^}]*theme\/kuromi\/kuromi-face\.png/.test(cssNC)],
  ['资产: kuromi 图片进了 asar（v2.2.2 含躺姿/伤心）',
    ['kuromi-stand.png', 'kuromi-love.png', 'kuromi-face.png', 'kuromi-head.png', 'kuromi-lie.png', 'kuromi-cry.png'].every((f) => {
      try {
        return extractFile(asar, 'renderer\\theme\\kuromi\\' + f).length > 500;
      } catch (e) { return false; }
    })],
  ['多主题: 美乐蒂 v2.2 = 固定粉白配色（#EC6FA8）+ 真实裁剪图片',
    /--md3-primary:\s*#EC6FA8/.test(themeTokens('melody')) &&
    /--t-accent:\s*#EC6FA8/.test(themeTokens('melody')) &&
    /--t-btn-r:\s*999px/.test(themeTokens('melody')) &&
    /body\.theme-melody \.titlebar::after[^}]*theme\/melody\/melody-cheer\.png/.test(cssNC) &&
    /body\.theme-melody \.widget::after[^}]*theme\/melody\/melody-full\.png/.test(cssNC) &&
    /body\.theme-melody \.usb-section::after[^}]*theme\/melody\/melody-cheer\.png/.test(cssNC)],
  ['资产: melody 图片进了 asar（v2.2.2 含刺绣）',
    ['melody-full.png', 'melody-cheer.png', 'melody-head.png', 'melody-emb.png'].every((f) => {
      try {
        return extractFile(asar, 'renderer\\theme\\melody\\' + f).length > 500;
      } catch (e) { return false; }
    })],
  ['多主题: 装饰不串（只有 Fluent 有噪点、md3/harmony 标题栏无贴图）',
    !/body\.theme-md3 \.titlebar::after/.test(cssNC) &&
    !/body\.theme-harmony \.titlebar::after/.test(cssNC) &&
    !/feTurbulence/.test(ruleBlockFrom('body.theme-md3 .glass-veil::after {'))],
  ['多主题: 三丽鸥混合 = 四家配色合体 + 每表面一个角色贴图（同屏四家同框）',
    /--md3-primary:\s*#E8548A/.test(themeTokens('sanrio')) &&
    /--md3-secondary:\s*#8E5BC8/.test(themeTokens('sanrio')) &&
    /--md3-tertiary:\s*#4FA8E8/.test(themeTokens('sanrio')) &&
    /body\.theme-sanrio \.titlebar::after[^}]*theme\/kitty\/kitty-head\.png/.test(cssNC) &&
    /body\.theme-sanrio \.widget::after[^}]*theme\/kuromi\/kuromi-stand\.png/.test(cssNC) &&
    /body\.theme-sanrio \.glass-veil::before[^}]*theme\/dog\/cinna-plane\.png/.test(cssNC) &&
    /body\.theme-sanrio \.usb-section::before[^}]*theme\/melody\/melody-cheer\.png/.test(cssNC) &&
    /body\.theme-sanrio \.panel::after[^}]*theme\/melody\/melody-full\.png/.test(cssNC) &&
    /body\.theme-sanrio \.ctx-menu::after[^}]*theme\/kitty\/kitty-wave\.png/.test(cssNC)],
  ['多主题: 贴图主题不改写 panel/ctx-menu 定位（v2.2.1 事故守卫；modal-card 锚点合法）',
    ['dog', 'kuromi', 'melody', 'sanrio'].every((t) =>
      !new RegExp('body\\\\.theme-' + t + ' \\\\.(?:panel|ctx-menu)[^{};]*\\\\{[^}]*position:\\\\s*relative').test(cssNC))],
  ['圆角: 主界面圆角弧度可调（滑块写 --radius/--t-r-win，null 跟随主题）',
    html.includes('id="setRadius"') && html.includes('id="radiusVal"') &&
    /function applyRadius/.test(app) &&
    /setProperty\('--radius', config\.cornerRadius \+ 'px'\)/.test(app) &&
    /removeProperty\('--radius'\)/.test(app) &&
    /applyRadius\(config\.cornerRadius \?\? null, false\)/.test(app) &&
    /cornerRadius: null,/.test(main)],
  ['多主题: 分段控件保留（色板模式两键）+ 主题下拉样式',
    /\.seg \{[^}]*flex-wrap:\s*wrap/.test(cssNC) && /\.theme-select\s*\{/.test(cssNC)],
  ['css: MD3 tonal palette 变量 + 形状标度',
    css.includes('--md3-primary:') && css.includes('--md3-shape-xl: 28px') &&
    css.includes('--md3-shape-l: 16px')],
  ['css: MD3 主表面是平的 tonal 色（alpha 跟随透明度滑块）',
    /rgb\(var\(--md3-surface-rgb\) \/ calc\(0\.74/.test(cssNC)],
  ['css: --t-veil 与 background 声明在同一条规则内（否则整条声明作废）',
    /--t-veil:[\s\S]*?background:\s*var\(--t-veil\)/.test(ruleBlockFrom('body.theme-md3 .glass-veil {')) &&
    /--t-veil:[\s\S]*?background:\s*var\(--t-veil\)/.test(ruleBlockFrom('body.theme-kitty .glass-veil {'))],
  ['css: MD3 关掉折射并隐藏 sheen/边光环',
    /body\.theme-md3 \.glass-warp[\s\S]*?filter:\s*none\s*!important/.test(cssNC) &&
    /body\.theme-md3 \.sheen/.test(cssNC)],
  ['css: MD3 state layer + ripple', /body\.theme-md3 \.item::before/.test(cssNC) &&
    /@keyframes md3-ripple/.test(cssNC)],
  ['app.js: applyTheme / applyPalette / spawnRipple',
    app.includes('function applyTheme') && app.includes('function applyPalette') &&
    app.includes('function spawnRipple')],
  ['app.js: 取色面板动态主题显示 / 固定配色主题隐藏并提示（不留"没反应"的入口）',
    /box\.classList\.toggle\('hidden', fixed\)/.test(app) &&
    /hint\.classList\.toggle\('hidden', !fixed\)/.test(app) &&
    !/toggle\('hidden',\s*!isMd3\)/.test(app)],
  ['app.js: 手动选色有防抖即时预览 + accentPicked 守卫',
    /function accentLivePreview/.test(app) && /accentInputTimer/.test(app) &&
    /accentPicked = true/.test(app) && /config\.accentPicked === true/.test(app)],
  ['app.js: 预览模式用本地近似算法派生调色板（不再恒返回 null）',
    /function previewPalette/.test(app) && /PREVIEW_ROLE_TONE/.test(app) &&
    !/getPalette:\s*\(\) => Promise\.resolve\(null\)/.test(app)],
  ['app.js: ripple 只在 MD3 生效', (app.match(/currentTheme !== 'md3'/g) || []).length >= 2],
  ['配置: productName = GuanJia（进程名简化）', srcPkg.build && srcPkg.build.productName === 'GuanJia'],
  ['配置: artifactName 保留「管家助手-${version}.exe」习惯命名',
    srcPkg.build && srcPkg.build.artifactName === '管家助手-${version}.exe'],
  ['配置: win.icon 指向 build/icon.ico', srcPkg.build && srcPkg.build.win && srcPkg.build.win.icon === 'build/icon.ico'],
  ['资产: build/icon.ico 与 icon.png 存在',
    fs.existsSync('build/icon.ico') && fs.existsSync('build/icon.png')],
  ['main: BrowserWindow 挂 icon（开发模式/alt-tab 也有图标）',
    /icon:\s*fs\.existsSync\(path\.join\(__dirname, 'build', 'icon\.ico'\)\)/.test(main)],
  ['产物: 便携 exe 已生成（v2.2.3）', fs.existsSync('dist/管家助手-2.2.3.exe')],
  ['配置: 版本号 2.2.3', srcPkg.version === '2.2.3'],
  ['配置: 已移除 package.json description（exe 属性不再带描述）',
    srcPkg.description === undefined],
  ['author = yu', srcPkg.author === 'yu'],
  ['main: moveBottom 置底', main.includes('moveBottom')],
  ['main: keepBottom 状态', main.includes('keepBottom')],
  ['main: focus 时压回底层', main.includes("on('focus'")],
  ['main: 不再 alwaysOnTop 置顶创建', /alwaysOnTop:\s*false/.test(main)],
  ['main: set-keep-bottom IPC', main.includes("'set-keep-bottom'")],
  ['preload: setKeepBottom', pre.includes('setKeepBottom')],
  ['app.js: keepBottom 默认开', app.includes('keepBottom: true')],
  ['app.js: 置底开关联动', app.includes("$('setBottom')")],
  ['html: 窗口置底开关', html.includes('id="setBottom"') && html.includes('窗口置底')],
  ['html: 无旧置顶开关', !html.includes('setTop') && !html.includes('始终置顶')],
  ['托盘提示 = 管家助手', main.includes("setToolTip('管家助手')")],
  ['U盘弹出修复仍在', main.includes('CM_Request_Device_EjectW')]
];
let bad = 0;
checks.forEach((c) => {
  const ok = !!c[c.length - 1];
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + c[0]);
  if (!ok) bad++;
});
process.exit(bad ? 1 : 0);
