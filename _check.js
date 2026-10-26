const path = require('path');
const fs = require('fs');
const { extractFile } = require('@electron/asar');
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
  /* 角色主题已经不在本体里了：它的"token"就是整个主题包（角色色一块、
   * 形状/模糊/veil 一块，分散在多个规则里，所以整包一起看）。 */
  if (PACK_IDS.indexOf(t) >= 0) return packNC[t] || '';
  const i = cssNC.indexOf('\nbody.theme-' + t + ' {');
  if (i < 0) return '';
  const j = cssNC.indexOf('}', i);
  return j < 0 ? '' : cssNC.slice(i, j);
};
const moveBody = ruleBody('body.is-moving .glass-warp');
const resizeBody = ruleBlockFrom('body.is-resizing .glass-warp');
const srcPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
// README / CHANGELOG 不在 asar 里（不是运行时文件），从磁盘读，用来防"发版忘了同步文档"
const readme = (() => { try { return fs.readFileSync('README.md', 'utf8'); } catch (e) { return ''; } })();
const changelog = (() => { try { return fs.readFileSync('CHANGELOG.md', 'utf8'); } catch (e) { return ''; } })();
/* 主题包 id 清单在三个探针里各存一份（_check / smoke-test / _rt/_palettecheck），
 * 必须同步 —— 改 id 时漏掉一个，那个探针会读不到包文件、断言整片变红
 * （2026-10-14 milk → NaiWa 时 smoke-test 与 _palettecheck 就漏了）。
 * 后两个不在 asar 里，直接从磁盘抠出 PACK_IDS 数组字面量来比对。 */
const probeIds = (file) => {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/const PACK_IDS = \[([\s\S]*?)\]/);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  } catch (e) { return []; }
};
const smokeIds = probeIds('smoke-test.js');
const paletteIds = probeIds(path.join('_rt', '_palettecheck.js'));
/* 安卓壳的桥接层也不在 asar 里（build.files 不收 mobile/），同样从磁盘读 */
const bridge = (() => {
  try { return fs.readFileSync('mobile/web/mobile-bridge.js', 'utf8'); } catch (e) { return ''; }
})();
/* ============================================================================
 * v2.5.0：应用本体与主题分离
 *   本体只留五套内置皮肤（glass / md3 / fluent / miuix / harmony），
 *   13 套角色主题剥离成独立 .fcpt 主题包 —— 源树在 FClassPal-theme 仓库，
 *   随包附带的 themes/*.fcpt 是同一份内容。
 * 因此：凡是"某套角色主题应该有什么"的断言，一律改成查**主题包源文件**。
 * 不是删掉断言，而是换个正确的位置查（本体里已经查不到了，留着只会永远红）。
 * ==========================================================================*/
const PACK_ROOT = 'D:/workb/FClassPal-theme/themes';
const PACK_IDS = ['kitty', 'dog', 'kuromi', 'melody', 'sanrio', 'pochacco', 'purin',
  'NaiWa', 'tianyi', 'ling', 'teto', 'whale', 'miku'];
const packCss = {}, packNC = {}, packManifest = {};
PACK_IDS.forEach((t) => {
  try { packCss[t] = fs.readFileSync(path.join(PACK_ROOT, t, 'theme.css'), 'utf8'); } catch (e) { packCss[t] = ''; }
  packNC[t] = packCss[t].replace(/\/\*[\s\S]*?\*\//g, '');
  try { packManifest[t] = JSON.parse(fs.readFileSync(path.join(PACK_ROOT, t, 'manifest.json'), 'utf8')); } catch (e) { packManifest[t] = {}; }
});
const packsAll = () => PACK_IDS.map((t) => packNC[t]).join('\n');
/** 某套主题的 CSS：角色主题看它自己的包，内置主题看本体 */
const themeSrc = (t) => (PACK_IDS.indexOf(t) >= 0 ? (packNC[t] || '') : cssNC);
/** 某套主题里某条规则的声明体（包里的选择器和 `{` 之间没有空格） */
const ruleInTheme = (t, sel) => {
  const hay = themeSrc(t);
  const i = hay.indexOf(sel + '{');
  if (i < 0) return '';
  const j = hay.indexOf('}', i);
  return j < 0 ? '' : hay.slice(i, j);
};
const checks = [
  /* ★★★ v2.5.0 真机事故守卫：asar 必须能解析 main.js 的每一个相对 require。
   * v2.4.6/2.4.7 的 build.files 漏了 pack.js：开发态全绿（磁盘上有），
   * 打包版 main.js:1631 require('./pack') 崩 → 全局 uncaughtException 兜住后
   * 应用照常起窗，但 1631 行之后的四个导入导出 handler 根本没注册，
   * 用户点按钮只看到「操作失败」。探针两层全绿、真机全灭，就是这个类型。 */
  ['★ asar: main.js 的相对 require 全部可解析（防 build.files 漏文件）',
    (() => {
      const reqs = [...new Set([...mainNC.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)].map((m) => m[2]))];
      if (!reqs.length) return false;
      for (const r of reqs) {
        const base = r.replace(/^\.\//, '');
        const candidates = [base, base + '.js', base + '.json', base + '/index.js'];
        let ok = false;
        for (const c of candidates) {
          try { extractFile(asar, c); ok = true; break; } catch (e) { /* 继续试 */ }
        }
        if (!ok) return false;
      }
      return true;
    })()],
  ['★ asar: pack.js 在包里（.fcpc/.fcpt 导入导出的依赖）',
    (() => { try { extractFile(asar, 'pack.js'); return true; } catch (e) { return false; } })()],
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
  ['asar: 位移贴图已随包（v2.3.0 起 PNG dataURL，JPEG 已不被 feImage 渲染）', /LG_DISPLACEMENT_MAP\s*=\s*'data:image\/png;base64,/.test(mapJs)],
  ['css: 滤镜挂在 .glass-warp（非 ::before）',
    /url\(#liquidGlass\)/.test(css) && /body\.lg-ready \.glass-warp/.test(css)],
  ['css: backdrop-filter 里绝不再出现 url()', !/backdrop-filter:[^;]*url\(#/.test(cssNC)],
  ['css: 玻璃底模糊走 --lg-blur 变量、默认 6px / saturate 140%（v2.3.1 overLight 会提到 14px）',
    /backdrop-filter:\s*blur\(var\(--lg-blur, 6px\)\) saturate\(140%\)/.test(css)],
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
  ['asar: 位移贴图随包（无 JPEG 残留）', /LG_DISPLACEMENT_MAP\s*=\s*'data:image\/png;base64,/.test(mapJs) && !/data:image\/jpeg/.test(mapJs)],
  ['html: 主题两处入口（v2.5.4：设置面板恢复老样式下拉管"切换"，管理弹窗管"安装/排序/导入"）',
    html.includes('id="rowThemePick"') && html.includes('id="themeSelectBtn"') &&
    html.includes('id="themeSelectPop"') && !/<select id="themeSelect"/.test(html) &&
    html.includes('id="rowThemeManage"') && html.includes('id="btnThemeManage"')],
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
  /* v2.5.4：挪窗口时主进程绝不回推 bounds，也不顺手改 Z 序；另加一道时间戳保险
     （move-window 触发的 setPosition 会反过来发 'move'，set-dragging(true) 迟到
     一拍时靠它挡住那一记回推）；松手后的置底/落盘延后 250ms 执行。 */
  ['main.js: 拖拽期间不回推 bounds / 不改 Z 序（v2.5.4 加时间戳保险 + 延后置底）',
    /if \(!renderDragging && Date\.now\(\) - lastProgrammaticMove > 500\) pushBounds\(b\)/.test(main) &&
    /!renderDragging\)[\s\S]{0,80}moveBottom/.test(main) &&
    /if \(dragEndTimer\) \{ clearTimeout\(dragEndTimer\); dragEndTimer = 0; \}/.test(main) &&
    /dragEndTimer = setTimeout\([\s\S]{0,200}?\}, 250\)/.test(main)],
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
    // v2.5.0：13 套角色主题的入场动画已进各自主题包，所以要在本体 + 全部包里数
    /animation-fill-mode:\s*backwards/.test(cssNC) &&
    ((cssNC + packsAll()).match(/backwards/g) || []).length >= 19 &&
    /animation-delay:\s*calc\(var\(--i, 0\) \* var\(--t-stagger\)\)/.test(cssNC) &&
    !/animation:\s*t-(?:in|panel|toast)-[\w-]+[^;]*\b(?:both|forwards)\b/.test(cssNC + packsAll())],
  ['css: 入场动画名各套互不相同（内置在本体、角色主题在各自包里；keyframes 前缀统一小写）',
    ['md3', 'fluent', 'miuix', 'harmony'].every((t) =>
      new RegExp('@keyframes t-in-' + t + '\\b').test(cssNC)) &&
    PACK_IDS.every((t) => new RegExp('@keyframes t-in-' + t.toLowerCase() + '\\b').test(packNC[t]))],
  ['css: reduced-motion 让路', /@media \(prefers-reduced-motion: reduce\)/.test(css)],
  ['css: 预设色板样式', /\.swatch\s*\{/.test(css) && /\.swatch\[aria-pressed="true"\]/.test(css)],
  ['多主题: 已彻底移除 theme-flat 共底（十套风格各自自足）',
    !/theme-flat/.test(cssNC) && !/theme-flat/.test(app) &&
    !/md3-enter/.test(cssNC) && !/md3-enter/.test(app)],
  /* v2.5.4：安卓真机上"只靠弹窗切换"不稳，快速切换换回自绘下拉（v2.5.2 老样式），
   * 管理弹窗保留安装/导入/排序/删除。两条入口各管一件事，数据源都还是注册表。 */
  ['多主题 v2.5.4: 切换走自绘下拉（注册表驱动）+ 管理走弹窗',
    html.includes('id="themeModal"') && html.includes('id="btnThemeManage"') &&
    html.includes('id="themeSelectBtn"') && !/<select id="themeSelect"/.test(html) &&
    !/data-theme="/.test(html) &&
    /function openThemeModal\(\)/.test(app) &&
    /function renderThemeOptions\(\)/.test(app) && /pop\.innerHTML = THEMES\.map/.test(app) &&
    /function syncThemeSelect\(\)/.test(app)],
  ['v2.5.4: 随包主题启动自动补装（安卓"附带的用不了"的兜底）',
    /function autoInstallBundledPacks\(\)/.test(app) &&
    /autoInstallBundledPacks\(\)\.catch/.test(app) &&
    /API\.themesInstallBundled\(b\.file\)/.test(app)],
  ['v2.5.4: 拖动/缩放走会话式降载（一次手势只摘戴一次滤镜，治触摸拖动闪动）',
    /function beginMoveSession\(/.test(app) && /function endMoveSession\(/.test(app) &&
    /beginMoveSession\(null\)/.test(app) && /beginMoveSession\('is-resizing'\)/.test(app) &&
    /const DRAG_SETTLE\s*=/.test(app)],
  /* v2.6.0：希沃桌面工具类型 + 自由布局 + 主题风格下拉只在安卓端显示 */
  ['v2.6.0: 快捷方式新增「希沃桌面工具」类型（8 个工具选择器自动填名称/图标/目标）',
    /<option value="seewo">希沃桌面工具<\/option>/.test(html) &&
    html.includes('id="seewoToolGrid"') && html.includes('id="seewoField"') &&
    /const SEEWO_TOOLS = \[/.test(app) &&
    /function buildSeewoToolGrid\(\)/.test(app) &&
    /function syncSeewoSelection\(\)/.test(app)],
  ['v2.6.0: 希沃工具图标随类型走（8 个 symbol + 预设映射齐）',
    ['annotate', 'calendar', 'random', 'people', 'magnifier', 'timer', 'half', 'screenshot']
      .every((k) => html.includes('id="i-seewo-' + k + '"') &&
        app.includes("'s-" + k + "': 'i-seewo-" + k + "'"))],
  ['v2.6.0: 主进程启动希沃桌面工具（open-target 分流 + 安装目录关键字搜索 + 手动路径直开）',
    /async function launchSeewoTool\(item\)/.test(mainNC) &&
    /item\.type === 'seewo'/.test(mainNC) &&
    /function findSeewoToolExe\(toolId\)/.test(mainNC) &&
    /const SEEWO_TOOL_MATCH = \{/.test(mainNC)],
  ['v2.6.0: 安卓端希沃工具明确报错（不许静默）',
    bridge.includes('希沃桌面工具是电脑端功能')],
  ['v2.6.0: 主题风格下拉只在安卓端显示（UA 先兜底、env 回来再校正）',
    /function applyThemePickVisibility\(/.test(app) &&
    /applyThemePickVisibility\(IS_ANDROID\)/.test(app) &&
    /applyThemePickVisibility\(env && env\.platform === 'android'\)/.test(app)],
  ['v2.6.0: 主题下拉 portal 到 body（逃出设置面板 overflow 裁剪 + 放不下朝上弹）',
    /if \(pop\.parentNode !== document\.body\) document\.body\.appendChild\(pop\)/.test(app) &&
    /body > \.tselect-pop \{ position: fixed; \}/.test(css)],
  ['v2.6.0: 自由布局（网格/自由分段 + 拖动/手柄缩放 + 一键整理/还原尺寸/恢复默认）',
    html.includes('id="layoutSeg"') && html.includes('id="btnLayoutTidy"') &&
    html.includes('id="btnLayoutResetSize"') && html.includes('id="btnLayoutReset"') &&
    html.includes('id="itemLayoutField"') &&
    /function layoutMode\(\)/.test(app) && /function ensureFreeLayouts\(\)/.test(app) &&
    /function applyFreeLayout\(el, it\)/.test(app) &&
    /function syncItemLayoutField\(/.test(app) &&
    /#content\.free-layout \.group,/.test(css) && /\.item-grip/.test(css)],
  ['v2.6.0: 网格拖拽在自由布局下让位（同一次手势不会两套拖拽都接）',
    /if \(layoutMode\(\) === 'free'\) return;/.test(app)],
  /* v2.6.0 触摸热修（版本号不变，2026-10-26 下午）：win 触摸拖动还是抖的两个根因 */
  ['v2.6.0 热修: 拖拽/缩放事件挂 document 捕获段（pointercancel 丢捕获后也续得上）',
    /const onDragMove = \(e\) => \{/.test(app) &&
    /document\.addEventListener\('pointermove', onDragMove, true\)/.test(app) &&
    /document\.addEventListener\('pointerup', onDragUp, true\)/.test(app) &&
    /document\.addEventListener\('pointercancel', onDragCancel, true\)/.test(app) &&
    /document\.addEventListener\('pointermove', onRsMove, true\)/.test(app)],
  ['v2.6.0 热修: 触摸坐标 EMA 平滑（鼠标路径保持原手感不动）',
    /const DRAG_SMOOTH = 0\.45/.test(app) &&
    /dragSmX = dragSmY = null/.test(app) && /rsSmX = rsSmY = null/.test(app) &&
    /dragSmX \+ \(sx - dragSmX\) \* DRAG_SMOOTH/.test(app) &&
    /rsSmX \+ \(sx - rsSmX\) \* DRAG_SMOOTH/.test(app) &&
    /if \(e\.pointerType === 'mouse'\) \{\s*\n\s*lastX = e\.screenX; lastY = e\.screenY;/.test(app)],
  ['多主题 v2.5.0: 内置五套 + 运行时可刷新注册表（装/删/排序后不用改代码）',
    /const BUILTIN_THEMES = \['glass', 'md3', 'fluent', 'miuix', 'harmony'\]/.test(app) &&
    /let THEMES = BUILTIN_THEMES\.slice\(\)/.test(app) &&
    /function applyThemeRegistry\(cards\)/.test(app) &&
    /function loadThemeRegistry\(\)/.test(app) &&
    /glass:\s*'#6750A4'/.test(app) && /miuix:\s*'#3482FF'/.test(app) &&
    /harmony:\s*'#0A59F7'/.test(app) && /accentPicked/.test(app)],
  ['多主题 v2.5.0: 固定配色主题 = MIUI/鸿蒙 本体写死 + 主题包按 manifest.fixedPalette',
    /const BUILTIN_FIXED = \['miuix', 'harmony'\]/.test(app) &&
    /fixedPalette: raw\.fixedPalette !== false/.test(fs.readFileSync('themes.js', 'utf8')) &&
    PACK_IDS.every((t) => packManifest[t].fixedPalette === true)],
  ['多主题: 每套主题各自定义完整 token（本体 5 套 + 主题包 13 套）',
    ['md3', 'fluent', 'miuix', 'harmony'].concat(PACK_IDS).every((t) => {
      const b = themeTokens(t);
      return /--t-r-win:/.test(b) && /--t-r-card:/.test(b) && /--t-btn-r:/.test(b) &&
        /--t-blur:/.test(b) && /--t-surface:/.test(b) && /--t-accent:/.test(b) &&
        /--t-ease:/.test(b) && /--t-dur:/.test(b) && /--t-stagger:/.test(b);
    })],
  ['多主题: 形状标度各就各位（本体 4 套 + 角色包老五套；16/8/16/20/24/22/20/22/22）',
    /--t-r-card:\s*16px/.test(themeTokens('md3')) &&
    /--t-r-card:\s*8px/.test(themeTokens('fluent')) &&
    /--t-r-card:\s*16px/.test(themeTokens('miuix')) &&
    /--t-r-card:\s*20px/.test(themeTokens('harmony')) &&
    /--t-r-card:\s*24px/.test(themeTokens('kitty')) &&
    /--t-r-card:\s*22px/.test(themeTokens('dog')) &&
    /--t-r-card:\s*20px/.test(themeTokens('kuromi')) &&
    /--t-r-card:\s*22px/.test(themeTokens('melody')) &&
    /--t-r-card:\s*22px/.test(themeTokens('sanrio'))],
  ['多主题: 模糊强度各就各位（本体 4 套 + 角色包老五套）',
    /blur\(14px\) saturate\(118%\)/.test(themeTokens('md3')) &&
    /blur\(30px\) saturate\(125%\)/.test(themeTokens('fluent')) &&
    /blur\(22px\) saturate\(150%\)/.test(themeTokens('miuix')) &&
    /blur\(24px\) saturate\(140%\)/.test(themeTokens('harmony')) &&
    /blur\(18px\) saturate\(140%\)/.test(themeTokens('kitty')) &&
    /blur\(26px\) saturate\(130%\)/.test(themeTokens('dog')) &&
    /blur\(20px\) saturate\(130%\)/.test(themeTokens('kuromi')) &&
    /blur\(18px\) saturate\(135%\)/.test(themeTokens('melody')) &&
    /blur\(22px\) saturate\(135%\)/.test(themeTokens('sanrio'))],
  ['多主题 v2.5.0: 17 套主题的配色身份互不相同 + 形状/模糊不塌成一套（不共底）',
    (() => {
      const all = ['md3', 'fluent', 'miuix', 'harmony'].concat(PACK_IDS);
      const pick = (t, name) => {
        const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(themeTokens(t));
        return m ? m[1].trim() : '';
      };
      const accents = all.map((t) => pick(t, 't-accent'));
      // 八套生成主题（帕恰狗 / 布丁狗 / 奶蛙 / 洛天依 / 乐正绫 / 初音 / 重音Teto / 鲸鱼娘）
      // 当初是拿 kitty 当骨架生成的：形状与模糊沿用 24px / blur(18px)，只在配色和
      // 贴图上做出差异 —— 这是刻意的取舍（用户要的就是"kitty 那套感觉 + 新角色素材"），
      // 不是漏改。所以这里只要求"别塌成同一套"，同时配色身份必须各自独立
      // （sanrio 用 kitty 粉当主色是设计如此，所以放宽到 >= 14）。
      const combos = all.map((t) => pick(t, 't-r-card') + '|' + pick(t, 't-blur'));
      return accents.every((x) => x) && new Set(accents).size >= 14 &&
        combos.every((x) => x !== '|') && new Set(combos).size >= 9;
    })()],
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
  ['多主题: Kitty = 固定粉白配色 + 真实裁剪图片（v2.5.0 起在主题包 kitty 里）',
    /--md3-primary:\s*#E8548A/.test(themeTokens('kitty')) &&
    /--t-accent:\s*#E8548A/.test(themeTokens('kitty')) &&
    /#FFF7FA/.test(themeTokens('kitty')) &&
    ruleInTheme('kitty', 'body.theme-kitty .titlebar::after').includes('assets/kitty-head.png') &&
    ruleInTheme('kitty', 'body.theme-kitty .widget::after').includes('assets/kitty-full.png') &&
    ruleInTheme('kitty', 'body.theme-kitty .glass-veil::before').includes('assets/kitty-wave.png') &&
    ruleInTheme('kitty', 'body.theme-kitty .usb-section::before').includes('assets/kitty-ballet.png') &&
    ruleInTheme('kitty', 'body.theme-kitty .group-title::before').includes('%3Csvg')],
  ['资产 v2.5.0: 角色素材随主题包分发（本体不再内嵌，asar 白名单已排除 renderer/theme）',
    ['kitty-head.png', 'kitty-full.png', 'kitty-sit.png', 'kitty-wave.png', 'kitty-ballet.png', 'kitty-kimono.png'].every((f) =>
      fs.existsSync(path.join(PACK_ROOT, 'kitty', 'assets', f))) &&
    fs.existsSync('themes/kitty.fcpt') && fs.existsSync('themes/miku.fcpt') &&
    srcPkg.build.files.some((x) => /^!renderer\/theme/.test(x))],
  ['多主题: 玉桂狗 = 固定蓝白配色 + 真实裁剪图片（头像/飞机/眨眼）',
    /--md3-primary:\s*#4FA8E8/.test(themeTokens('dog')) &&
    /--t-accent:\s*#4FA8E8/.test(themeTokens('dog')) &&
    /--t-r-card:\s*22px/.test(themeTokens('dog')) &&
    ruleInTheme('dog', 'body.theme-dog .titlebar::after').includes('assets/cinna-head.png') &&
    ruleInTheme('dog', 'body.theme-dog .widget::after').includes('assets/cinna-plane.png') &&
    ruleInTheme('dog', 'body.theme-dog .usb-section::after').includes('assets/cinna-wink.png')],
  ['资产: dog 素材随主题包分发（含单车/草莓）',
    ['cinna-head.png', 'cinna-plane.png', 'cinna-wink.png', 'cinna-bike.png', 'cinna-berry.png'].every((f) =>
      fs.existsSync(path.join(PACK_ROOT, 'dog', 'assets', f)))],
  ['多主题: 库洛米 = 固定紫粉配色（#8E5BC8/#F06292）+ 真实裁剪图片',
    /--md3-primary:\s*#8E5BC8/.test(themeTokens('kuromi')) &&
    /--md3-secondary:\s*#F06292/.test(themeTokens('kuromi')) &&
    /--t-accent:\s*#8E5BC8/.test(themeTokens('kuromi')) &&
    /--t-btn-r:\s*14px/.test(themeTokens('kuromi')) &&
    ruleInTheme('kuromi', 'body.theme-kuromi .titlebar::after').includes('assets/kuromi-head.png') &&
    ruleInTheme('kuromi', 'body.theme-kuromi .widget::after').includes('assets/kuromi-stand.png') &&
    ruleInTheme('kuromi', 'body.theme-kuromi .usb-section::after').includes('assets/kuromi-love.png') &&
    ruleInTheme('kuromi', 'body.theme-kuromi .panel::after').includes('assets/kuromi-face.png')],
  ['资产: kuromi 素材随主题包分发（含躺姿/伤心）',
    ['kuromi-stand.png', 'kuromi-love.png', 'kuromi-face.png', 'kuromi-head.png', 'kuromi-lie.png', 'kuromi-cry.png'].every((f) =>
      fs.existsSync(path.join(PACK_ROOT, 'kuromi', 'assets', f)))],
  ['多主题: 美乐蒂 = 固定粉白配色（#EC6FA8）+ 真实裁剪图片',
    /--md3-primary:\s*#EC6FA8/.test(themeTokens('melody')) &&
    /--t-accent:\s*#EC6FA8/.test(themeTokens('melody')) &&
    /--t-btn-r:\s*999px/.test(themeTokens('melody')) &&
    ruleInTheme('melody', 'body.theme-melody .titlebar::after').includes('assets/melody-cheer.png') &&
    ruleInTheme('melody', 'body.theme-melody .widget::after').includes('assets/melody-full.png') &&
    ruleInTheme('melody', 'body.theme-melody .usb-section::after').includes('assets/melody-cheer.png')],
  ['资产: melody 素材随主题包分发（含刺绣）',
    ['melody-full.png', 'melody-cheer.png', 'melody-head.png', 'melody-emb.png'].every((f) =>
      fs.existsSync(path.join(PACK_ROOT, 'melody', 'assets', f)))],
  ['多主题: 装饰不串（只有 Fluent 有噪点、md3/harmony 标题栏无贴图）',
    !/body\.theme-md3 \.titlebar::after/.test(cssNC) &&
    !/body\.theme-harmony \.titlebar::after/.test(cssNC) &&
    !/feTurbulence/.test(ruleBlockFrom('body.theme-md3 .glass-veil::after {'))],
  ['多主题: 三丽鸥混合 = 四家配色合体 + 每表面一个角色贴图（同屏四家同框）',
    /--md3-primary:\s*#E8548A/.test(themeTokens('sanrio')) &&
    /--md3-secondary:\s*#8E5BC8/.test(themeTokens('sanrio')) &&
    /--md3-tertiary:\s*#4FA8E8/.test(themeTokens('sanrio')) &&
    ruleInTheme('sanrio', 'body.theme-sanrio .titlebar::after').includes('assets/kitty-head.png') &&
    ruleInTheme('sanrio', 'body.theme-sanrio .widget::after').includes('assets/kuromi-stand.png') &&
    ruleInTheme('sanrio', 'body.theme-sanrio .glass-veil::before').includes('assets/cinna-plane.png') &&
    ruleInTheme('sanrio', 'body.theme-sanrio .usb-section::before').includes('assets/melody-cheer.png') &&
    ruleInTheme('sanrio', 'body.theme-sanrio .panel::after').includes('assets/melody-full.png') &&
    ruleInTheme('sanrio', 'body.theme-sanrio .ctx-menu::after').includes('assets/kitty-wave.png')],
  ['多主题: 贴图主题不改写 panel/ctx-menu 定位（v2.2.1 事故守卫；modal-card 锚点合法）',
    // v2.5.0：断言原来的正则被转义了两层（`\\\\.`），永远匹配不到东西 —— 等于空转。
    // 改回真匹配，并且覆盖全部 13 个角色主题包（贴图都在包里）。
    PACK_IDS.every((t) =>
      !new RegExp('body\\.theme-' + t + ' \\.(?:panel|ctx-menu)[^{};]*\\{[^}]*position:\\s*relative').test(packNC[t]))],
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
    // v2.5.0：md3 在本体；角色主题的 veil 规则在各自包里（那里面的 `{` 前没空格）
    /--t-veil:[\s\S]*?background:\s*var\(--t-veil\)/.test(ruleBlockFrom('body.theme-md3 .glass-veil {')) &&
    PACK_IDS.every((t) => /--t-veil:[\s\S]*?background:\s*var\(--t-veil\)/.test(ruleInTheme(t, 'body.theme-' + t + ' .glass-veil')))],
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
  ['配置: productName = FClassPal', srcPkg.build && srcPkg.build.productName === 'FClassPal'],
  ['配置: appId = top.fangyum.classpal', srcPkg.build && srcPkg.build.appId === 'top.fangyum.classpal'],
  ['配置: artifactName = FClassPal-${version}.exe',
    srcPkg.build && srcPkg.build.artifactName === 'FClassPal-${version}.exe'],
  ['配置: win.icon 指向 build/icon.ico', srcPkg.build && srcPkg.build.win && srcPkg.build.win.icon === 'build/icon.ico'],
  ['资产: build/icon.ico 与 icon.png 存在',
    fs.existsSync('build/icon.ico') && fs.existsSync('build/icon.png')],
  ['main: BrowserWindow 挂 icon（开发模式/alt-tab 也有图标）',
    /icon:\s*fs\.existsSync\(path\.join\(__dirname, 'build', 'icon\.ico'\)\)/.test(main)],
  /* v2.6.0 起改为钉当前版本：dist 会清旧产物，钉死 2.4.6 的老断言只会永远假红 */
  ['产物: 便携 exe 已生成（当前版本）', fs.existsSync('dist/FClassPal-' + srcPkg.version + '.exe')],
  /* 版本一致性（不再钉死某个号）：源码版本 = README 徽章 = CHANGELOG 有对应小节
   * = dist 里真有这个版本的 exe。改版本只改 package.json 一处，其余不同步就判红。 */
  ['配置: 版本号三处同源（package.json / README 徽章 / CHANGELOG 小节）',
    /^\d+\.\d+\.\d+$/.test(srcPkg.version) &&
    readme.includes('version-' + srcPkg.version + '-orange') &&
    new RegExp('##\\s*v' + srcPkg.version.replace(/\./g, '\\.') + '\\s*—').test(changelog)],
  ['配置: dist 里存在当前版本的便携 exe（防发版发了上一版产物）',
    fs.existsSync('dist/FClassPal-' + srcPkg.version + '.exe')],
  ['配置: 已移除 package.json description（exe 属性不再带描述）',
    srcPkg.description === undefined],
  ['author = YU（用户在远端改的大写）', srcPkg.author === 'YU'],
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
  ['托盘提示 = FClassPal', main.includes("setToolTip('FClassPal')")],
  ['v2.3.0: 位移贴图是 PNG data URL（feImage 不再渲染 JPEG）',
    /'data:image\/png;base64,/.test(mapJs) && !/data:image\/jpeg/.test(mapJs)],
  ['v2.3.0: 关于区块（版本号占位 / 作者 / GitHub 按钮）',
    html.includes('id="aboutVersion"') && html.includes('id="aboutGithub"') &&
    html.includes('作者 YU')],
  ['v2.3.0: app.js 填版本号 + GitHub 链接走 openExternal',
    /API\.getAppVersion\(\)\.then/.test(app) &&
    app.includes("'https://github.com/fangyugit/FClassPal'")],
  ['v2.3.0: main 提供版本号 IPC + open-external 域名白名单',
    main.includes("ipcMain.handle('get-app-version'") &&
    main.includes("ipcMain.handle('open-external'") &&
    /\^https:\\\/\\\/github\\\.com\\\//.test(main)],
  ['v2.3.0: preload 暴露 getAppVersion / openExternal',
    pre.includes('getAppVersion') && pre.includes('openExternal')],
  ['v2.3.1: 苹果滑块作用域锁在玻璃主题（轨道两段式；拇指隐藏由珠子接管）',
    /body\.theme-glass input\[type="range"\]::-webkit-slider-runnable-track/.test(css) &&
    /var\(--md3-primary[^)]*\) 0 var\(--sl-fill/.test(css) &&
    /body\.theme-glass \.sl-wrap input\[type="range"\]::-webkit-slider-thumb\s*\{\s*\n\s*opacity: 0;/.test(css)],
  ['v2.3.1: 其他主题滑块未被苹果风污染（md3 轨道里没有 systemFill 灰）',
    !/body\.theme-md3 input\[type="range"\]::-webkit-slider-runnable-track\s*\{[^}]*120, 120, 128/.test(css)],
  ['v2.3.1: app.js 填充段同步（事件委托 + 写 value 后补刷）',
    /document\.addEventListener\('input', \(e\) => syncRangeFill\(e\.target\), true\)/.test(app) &&
    /opacityRange\.value = v;\s*\n\s*syncRangeFill\(opacityRange\)/.test(app)],
  ['v2.3.1: glass 主题挂 theme-glass 标记类',
    /classList\.toggle\('theme-glass', t === 'glass'\)/.test(app)],
  ['v2.3.1: overLight 链路（阈值 / 状态类 / 折射减半 / 实时采样 / 静态接线）',
    /const OVER_LIGHT_LUM = 0\.62/.test(app) &&
    /setDisplacementScale\(on \? 0\.5 : 1\)/.test(app) &&
    /querySelectorAll\('#liquidGlass feDisplacementMap'\)/.test(app) &&
    /sampleRealtimeLuminance\(\)/.test(app) &&
    /applyOverLight\(info\.luminance\)/.test(app)],
  ['v2.3.1: main 壁纸亮度采样并随 wallInfo 下发',
    /function wallpaperLuminance\(file\)/.test(main) &&
    /luminance: wallpaperLuminance\(file\)/.test(main)],
  ['v2.3.1: html 三个 feDisplacementMap 有 id（overLight 改 scale 用）',
    html.includes('id="lgDispR"') && html.includes('id="lgDispG"') &&
    html.includes('id="lgDispB"')],
  ['v2.3.1: overLight 视觉（--lg-blur 14px + 薄墨），仅玻璃主题',
    /body\.theme-glass\.over-light\s*\{\s*\n\s*--lg-blur: 14px;/.test(css) &&
    /rgba\(10, 14, 30, 0\.22\)/.test(css)],
  ['v2.3.1: 液态玻璃珠（贴图 alpha=形状遮罩 + 药丸距离场 + 主贴图禁用兜底）',
    /const r = d \/ R;/.test(app) &&
    /px\[q \+ 3\] = Math\.round\(ss\(1\.03, 0\.97, r\) \* 255\)/.test(app) &&
    !/makeBeadMap\(\) \|\|/.test(app) &&
    !/EDGE_CIRCLED/.test(app)],
  ['v2.3.2: 液态玻璃珠药丸形（34x22 + border-radius:999px + 中间透明 + feImage none 拉伸）',
    /body\.theme-glass \.sl-bead\s*\{[\s\S]{0,700}?width: var\(--sl-bead-w, 34px\)/.test(css) &&
    /body\.theme-glass \.sl-bead\s*\{[\s\S]{0,700}?border-radius: 999px/.test(css) &&
    /inset 0 0 5px 1px rgba\(255, 255, 255, 0\.38\)/.test(css) &&
    /input\[type="range"\]:active ~ \.sl-bead\s*\{[\s\S]{0,120}?scale\(1\.42\)/.test(css) &&
    /dstMap\.setAttribute\('preserveAspectRatio', 'none'\)/.test(app)],
  ['v2.4.0: 黑暗模式（body.dark 黑纱 veil + Monet 暗色方案 isDark + 只压表面不动强调色）',
    /body\.dark \.glass-veil\s*\{[\s\S]{0,700}?rgba\(6, 8, 14, calc\(0\.62 \* var\(--glass-alpha\)\)\)/.test(css) &&
    /body\.dark:not\(\.dyn\) \{[\s\S]{0,900}?--md3-surface: #0F1116/.test(css) &&
    /new monet\.SchemeTonalSpot\(hct, !!isDark, 0\)/.test(main) &&
    /p\.dark = !!isDark;/.test(main) &&
    /classList\.toggle\('dark', a === 'dark'\)/.test(app)],
  ['★ v2.4.0 花屏事故守卫：CSS 里不存在裸 body.theme-* / body.dark 选择器（逗号紧跟类名）',
    !/(^|\n)body\.theme-[a-z0-9]+,(\s*\n|\s*\{)/.test(css) &&
    !/(^|\n)body\.dark,/.test(css) &&
    /body\.theme-glass \.sl-bead \{/.test(css) &&
    /body\.theme-glass\.lg-ready \.sl-bead \{/.test(css)],
  ['v2.4.0: 自定义背景图（选图 IPC + 蒙版渐变 + 模糊补偿缩放 + 顶替壁纸）',
    /ipcMain\.handle\('pick-background'/.test(main) &&
    /function customBackgroundFile\(cfg\)/.test(main) &&
    /layers\.push\('linear-gradient\(rgba\(255, 255, 255, '/.test(app) &&
    /if \(bgIsOn\(\)\) return;/.test(app) &&
    /body\.bg-custom \.env-layer/.test(css) &&
    /id="bgFitSelect"/.test(html)],
  ['★ v2.4.1 点不动事故守卫：body 状态标记类没有被写成裸「.类名」规则（会命中 body）',
    // 裸 `.bg-custom` 曾让 body 吃到 position:absolute + pointer-events:none，
    // 再顺着继承糊满整棵子树 → 界面看着完好却一个都点不动
    ['bg-custom', 'dark', 'dyn', 'lg-ready', 'over-light', 'preview', 'realtime']
      .every((m) => !new RegExp('(^|,)\\s*\\.' + m.replace(/-/g, '\\-') + '\\s*(,|\\{)', 'm')
        .test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) &&
    /#bgCustom \{/.test(css) &&
    /class="bg-layer"/.test(html) &&
    !/class="bg-custom"/.test(html) &&
    /\.widget \{[\s\S]{0,900}?pointer-events:\s*auto/.test(css)],
  ['v2.4.0: 已下线主题回收（配置里存着 transparent 时收回 glass）',
    /if \(config\.theme === 'transparent'\) \{[\s\S]{0,80}?config\.theme = 'glass';/.test(main)],
  ['★ v2.4.2 图标外观：body 状态标记类都在"裸类名①"守卫名单里',
    // ic-ring / ic-none / ic-contain / ic-shape 挂在 body 上。写成裸 `.ic-ring{...}`
    // 会命中 body 本身，一旦那条规则带 position/pointer-events 就整片界面点不动（v2.4.1 真事故）
    ['bg-custom', 'dark', 'dyn', 'lg-ready', 'over-light', 'preview', 'realtime',
      'ic-ring', 'ic-none', 'ic-contain', 'ic-shape']
      .every((m) => !new RegExp('(^|,)\\s*\\.' + m.replace(/-/g, '\\-') + '\\s*(,|\\{)', 'm')
        .test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) &&
    /body\.ic-ring \.item-icon\.item-icon,/.test(css) &&
    /body\.ic-none \.item-icon\.item-icon,/.test(css) &&
    /body\.ic-shape \.item-icon\.item-icon,/.test(css) &&
    /body\.ic-contain \.item-icon img,/.test(css)],
  ['★ v2.4.2/3 图标外观：选择器刻意重复类名压过主题块（(0,3,1) > (0,2,1)，不靠文件顺序）',
    /body\.ic-ring \.item-icon\.item-icon,\s*\nbody\.ic-ring \.icon-preview\.icon-preview \{/.test(css) &&
    /body\.ic-none \.icon-preview\.icon-preview \{/.test(css)],
  ['★ v2.4.3 描边色：一套解析链管三种取色策略，末层必须是确定值',
    // 自定义属性取不到值会让整条声明在计算期作废，border-color 是非继承属性，
    // 作废后落到 initial = currentColor —— 描边变成文字色，那是另一种 bug
    /--ic-c: var\(--ic-ring-c, var\(--t-accent, var\(--accent\)\)\)/.test(css) &&
    /border-color: var\(--ic-c\)/.test(css) &&
    /--accent\s*:/.test(css)],
  ['★ v2.4.3 跟随主题：靠 CSS 回退链，**不写任何 JS 颜色钩子**（否则换主题会留下陈旧色）',
    // theme 模式下 JS 一个颜色变量都不写 → --ic-ring-c 未定义 → 回退到 --t-accent
    /body\.classList\.toggle\('ic-ring',/.test(app) &&
    /function iconRingColorFor[\s\S]{0,900}?return '';/.test(app) &&
    // 「跟随主题」分支里不允许出现"算出颜色再写变量"的代码 —— 那正是要避免的钩子
    !/iconBorder === 'theme'[\s\S]{0,400}?setProperty\('--ic-ring-c'/.test(app)],
  ['★ v2.4.3 外发光/底色：透明度用 color-mix 现算（跟随主题模式才能免钩子自动变色）',
    /drop-shadow\(0 5px 11px color-mix\(in srgb, var\(--ic-c\) 45%, transparent\)\)/.test(css) &&
    /background: color-mix\(in srgb, var\(--ic-c\) 20%, transparent\)/.test(css)],
  ['★ v2.4.2 外发光：drop-shadow 只给三个长度（它没有 spread，多写一个会静默作废整条 filter）',
    // 真事故：写成 drop-shadow(0 5px 11px -2px var(--ic-glow)) →
    // 解析期整条声明作废、不报错，computed filter 变成 none，外发光凭空消失。
    // 这里查"四个连续长度"（规范里 drop-shadow 最多三个长度，第四个就是 spread）。
    // 注意别去 indexOf 找"第一条 drop-shadow"：style.css 里早有别的元素在用
    // drop-shadow(0 2px 4px rgb(...))，抓到它就会得到一串无关数字。
    !/drop-shadow\(\s*(?:-?(?:\d+|\d*\.\d+)(?:px|r?em|%|vw|vh|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q)?\s+){3}-?(?:\d+|\d*\.\d+)(?:px|r?em|%|vw|vh|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q)?(?=[\s,)])/.test(css) &&
    /filter: drop-shadow\(0 5px 11px color-mix/.test(css)],
  ['v2.4.2 图标外观：底色层 absolute（不参与 item-icon 的 flex 居中排布）',
    /body\.ic-ring \.item-icon::before,[\s\S]{0,120}?position: absolute;/.test(css)],
  ['v2.4.2 图标外观：img 的 object-fit 读 --ic-fit（主界面 + 弹窗预览两处）',
    (css.match(/object-fit: var\(--ic-fit, cover\)/g) || []).length >= 2],
  ['★ v2.4.2：--ic-fit / --ic-pad / 状态类都写在 body 上（#itemModal 是 #widget 的兄弟，挂 #widget 弹窗读不到）',
    /const body = document\.body;/.test(app) &&
    /body\.style\.setProperty\('--ic-fit', fit\)/.test(app) &&
    /body\.style\.setProperty\('--ic-pad',/.test(app) &&
    !/widget\.style\.setProperty\('--ic-fit'/.test(app)],
  ['v2.4.2 图标外观：状态类 toggle 到 body（ic-ring 有色 / ic-none 透明 / ic-contain 内部）',
    /body\.classList\.toggle\('ic-ring',/.test(app) &&
    /body\.classList\.toggle\('ic-none', bd === 'none'\)/.test(app) &&
    /body\.classList\.toggle\('ic-contain', fit === 'contain'\)/.test(app)],
  ['v2.4.3 图标外观：颜色来源只在一处决定（自定义 > 图自己的主色 > CSS 回退主题色）',
    /function iconRingColorFor/.test(app) &&
    /const custom = normalizeHex\(config\.iconRingColor\);\s*\n\s*if \(custom && config\.iconBorder !== 'none'\) return custom;/.test(app) &&
    // 透明必须能盖过自定义色：上面那行已经保证，这里再钉死"none 时不写任何色"
    /if \(config\.iconBorder === 'none'\)[\s\S]{0,200}?body\.classList\.toggle\('ic-none', true\)/.test(app) === false ||
    /bd !== 'glass' && bd !== 'none'/.test(app)],
  ['★ v2.4.3 自定义色管所有图标类型：refreshIconLook 只有一遍遍历（分"图片写/非图片清"会把自定义色清掉）',
    // 真事故：预设 SVG / 字符图标没有取色源，被当成"该清变量"的一类，
    // 结果设了自定义色只有图片图标变色。统一交给 iconRingColorFor() 决定。
    /document\.querySelectorAll\('\.item-icon, \.icon-preview'\)\.forEach\(\(el\) => \{[\s\S]{0,200}?applyIconColorVars\(el, img \? img\.getAttribute\('src'\) : ''\)/.test(app) &&
    !/el\.querySelector\('img'\) \? el\.style\.removeProperty/.test(app)],
  ['★ v2.4.2 图标取色：并发批次的刷新不能丢（Promise 串行化 + 落地后按差集重算）',
    // 用布尔标志"有批次在跑就 return"会把并发刷新静默吞掉：
    // 切到自动取色的同时保存了新图标 → 第二次调用啥也没干 → 图标一直是主题色
    /let iconColorsInFlight = null/.test(app) &&
    /if \(iconColorsInFlight\) \{ try \{ await iconColorsInFlight; \}/.test(app) &&
    /const want = \(paths \|\| \[\]\)\.filter\(\(p\) => p && !iconColors\.has\(p\)\)/.test(app) &&
    !/iconColorsPending/.test(app)],
  ['v2.4.2 图标取色：取不到色也记 null 缓存（避免每次 render 重问主进程）',
    /iconColors\.set\(p, got\[p\] \|\| null\)/.test(app)],
  ['v2.4.2 图标外观：切开关走就地刷新，不重建 DOM（否则重放 t-enter 入场动画）',
    // render() 会给每个格子加 t-enter 入场动画，切个开关整套重放会很跳。
    // ★ 判"函数体里有没有 render()"不能直接用 [\s\S]{0,N} 开窗：
    //   setIconBorder 后面隔着几十行就是 `/* ---- 渲染 ---- */ function render() {`，
    //   窗口一大就把下一个函数的 render() 数进来，得到永远为红的假失败。
    //   这里按"函数头 → 第一个行首 }"切出真正的函数体再判。
    (function () {
      const fnBody = (name) => {
        const i = app.indexOf('function ' + name + '(');
        if (i < 0) return null;
        const j = app.indexOf('\n}', i);
        return j < 0 ? null : app.slice(i, j);
      };
      const names = ['setIconFit', 'setIconBorder', 'setIconShape', 'setIconRadius',
        'setIconRingColor', 'refreshIconLook'];
      const bodies = names.map(fnBody);
      if (bodies.some((b) => b === null)) return false;
      return bodies.every((b) => !/\brender\(\)/.test(b));
    })() &&
    /config\.iconFit = next;\s*\n\s*syncSettingsControls\(\);\s*\n\s*refreshIconLook\(\);\s*\n\s*persist\(\);/.test(app) &&
    /config\.iconBorder = next;\s*\n\s*syncSettingsControls\(\);\s*\n\s*refreshIconLook\(\);\s*\n\s*persist\(\);/.test(app)],
  ['v2.4.3 图标外观：三个新 setter 也走就地刷新 + 落盘',
    /function setIconShape[\s\S]{0,420}?refreshIconLook\(\)/.test(app) &&
    /function setIconRadius[\s\S]{0,420}?refreshIconLook\(\)/.test(app) &&
    /function setIconRingColor[\s\S]{0,520}?persist\(\)/.test(app)],
  ['★ v2.4.3 「内部」= 完整落在边框形状内：内缩量 = 0.2929 × 圆角半径百分比',
    // 只写 object-fit: contain 是内切于**方框**，方形图的四角照样顶在圆外被切掉。
    // 0.2929 = 1 - 1/√2 的一半（正方形内切于圆角矩形的解析解）。
    /\(0\.2929 \* radiusPct\)\.toFixed\(2\)/.test(app) &&
    /body\.ic-contain \.item-icon img,[\s\S]{0,120}?padding:\s*var\(--ic-pad, 0\)/.test(css)],
  ['★ v2.4.3 内缩只作用于 contain 模式（cover 模式照旧铺满、由 overflow:hidden 裁）',
    !/\.item-icon img \{[\s\S]{0,260}?padding:\s*var\(--ic-pad/.test(css) &&
    /\.item-icon img \{[\s\S]{0,260}?box-sizing:\s*border-box/.test(css) &&
    /\.icon-preview img \{[\s\S]{0,260}?box-sizing:\s*border-box/.test(css)],
  ['★ v2.4.3 形状=跟随主题：不写 --ic-rad、不挂 ic-shape（十套主题各自的形状语言要活着）',
    /body\.classList\.toggle\('ic-shape', shape !== 'auto'\)/.test(app) &&
    /body\.style\.removeProperty\('--ic-rad'\)/.test(app) &&
    /function measureIconRadiusPct/.test(app) &&
    /measured === null \? 50 : measured/.test(app)],
  ['★ v2.4.3 换主题要重算内缩几何（否则 MD3 会沿用玻璃的 14.65%，白白多留一圈白）',
    /function applyTheme[\s\S]{0,2600}?refreshIconLook\(\);\s*\n\s*syncThemeSelect\(\);/.test(app) &&
    /render\(\);[\s\S]{0,320}?refreshIconLook\(\);/.test(app)],
  ['v2.4.2 图标外观：首帧就带着颜色渲染（init 里 auto 模式先 await 取色再 render）',
    /if \(config\.iconBorder === 'auto' && !config\.iconRingColor\) \{[\s\S]{0,200}?await ensureIconColors\(\)[\s\S]{0,120}?render\(\);/.test(app)],
  ['v2.4.2 图标外观：弹窗预览也用未保存的图去取色（选图即见效果）',
    /function syncPreviewIconColor\(\)/.test(app) &&
    /fetchIconColors\(\[path\]\)/.test(app) &&
    /syncPreviewIconColor\(\)/.test(app)],
  ['v2.4.2 主进程：图标取色跳过透明像素（否则主色恒为黑，每个图标都套黑圈）',
    /if \(buf\[i \+ 3\] < 8\) continue;/.test(main) && /ICON_SAMPLE_DIM = 32/.test(main)],
  ['v2.4.2 主进程：图标取色关掉 Score 的 filter（默认过滤会拒绝低饱和候选→塌回回退紫）',
    /filter: false/.test(main) && /ipcMain\.handle\('get-icon-colors'/.test(main) &&
    /function iconColorFromFile/.test(main)],
  ['v2.4.2 主进程：取色缓存键含 mtime（换图立刻重新取色）',
    /iconColorKey/.test(main) && /mtimeMs/.test(main)],
  ['v2.4.2 preload 暴露 getIconColors；app.js 只在函数存在时才调',
    /getIconColors: \(paths\) => ipcRenderer\.invoke\('get-icon-colors', paths\)/.test(pre) &&
    /typeof API\.getIconColors !== 'function'/.test(app)],
  ['v2.4.2/3 配置项：五个图标外观键的默认值（全部等于"现在的样子"）',
    /iconFit: 'cover',/.test(mainNC) && /iconBorder: 'glass',/.test(mainNC) &&
    /iconShape: 'auto',/.test(mainNC) && /iconRadius: 22,/.test(mainNC) &&
    /iconRingColor: '',/.test(mainNC)],
  /* v2.5.2：奶蛙 id 'milk' → 'NaiWa'。老配置里 theme / themeOrder 还写着 'milk'，
   * 而随包附带的旧 milk.fcpt 已经不在包里了 —— 不迁移的话升级用户会停在
   * "主题指向一个不存在的包"，界面直接退回玻璃底。
   * ★ 顺序是这条迁移的全部难点：随包主题**不是开机自动安装的**（要用户点"一键装随包"），
   *   所以直接改 id 等于把用户从奶蛙踹回玻璃底，比不迁移更糟。必须先装包、再改指向、
   *   最后才删旧包；拿不到新包就维持原样。 */
  ['v2.5.2 配置迁移：老配置的 milk → NaiWa（单个标记键位，跑一次即止）',
    /themeMigratedToNaiWa/.test(mainNC) &&
    /const wasOnMilk = config\.theme === 'milk';/.test(mainNC) &&
    /id === 'milk' \? 'NaiWa' : id/.test(mainNC) &&
    /path\.join\(CONFIG_DIR, 'themes', 'milk'\)/.test(mainNC)],
  ['v2.5.2 迁移顺序：先装 NaiWa 包再改指向，且只在不再指向 milk 时才删旧包目录',
    /if \(wasOnMilk && naiReady\) config\.theme = 'NaiWa';/.test(mainNC) &&
    /if \(wasOnMilk && !naiReady\) \{\s*naiReady = installBundledPack\('NaiWa'\);/.test(mainNC) &&
    /if \(config\.theme !== 'milk'\) \{/.test(mainNC)],
  ['v2.5.2 随包安装抽成 installBundledPack()，升级兜底与 id 迁移共用一份实现',
    /function installBundledPack\(id\) \{/.test(mainNC) &&
    /if \(installBundledPack\(id\)\) return;/.test(mainNC)],
  ['v2.5.2 主题名表跟着改名（.fcps 方案导出不该把 NaiWa 显示成裸 id）',
    /NaiWa: '奶蛙'/.test(mainNC) && !/\bmilk:/.test(mainNC)],
  ['v2.5.2 主题包 id 清单三处同步（_check / smoke-test / _palettecheck 都不许留 milk）',
    PACK_IDS.indexOf('NaiWa') >= 0 && PACK_IDS.indexOf('milk') < 0 &&
    smokeIds.indexOf('NaiWa') >= 0 && smokeIds.indexOf('milk') < 0 &&
    paletteIds.indexOf('NaiWa') >= 0 && paletteIds.indexOf('milk') < 0],
  /* 安卓侧同一件事：配置在 WebView 的 localStorage 里，loadCfg 里做同名迁移。
   * 安卓不删旧包目录（主题包是用户自己导进 Android/data/<包名>/files/themes 的）。 */
  ['v2.5.2 安卓侧同步迁移：mobile-bridge 的 loadCfg 有 themeMigratedToNaiWa 分支',
    /themeMigratedToNaiWa/.test(bridge) &&
    /if \(base\.theme === 'milk'\) base\.theme = 'NaiWa';/.test(bridge) &&
    /if \(seenOrder\[id\]\) return false;/.test(bridge)],
  ['v2.4.2/3 配置项：渲染层只做"非法值收回默认"，不另立一套默认值（避免两边打架）',
    /if \(config\.iconFit !== 'contain'\) config\.iconFit = 'cover';/.test(app) &&
    /\['glass', 'auto', 'theme', 'none'\]\.indexOf\(config\.iconBorder\) < 0\) config\.iconBorder = 'glass';/.test(app) &&
    /\['circle', 'rounded', 'square'\]\.indexOf\(config\.iconShape\) < 0\) config\.iconShape = 'auto';/.test(app) &&
    /config\.iconRingColor = normalizeHex\(config\.iconRingColor\);/.test(app)],
  ['v2.4.2/3 预览 mock 与 DEFAULT_CONFIG 对齐（缺键会让面板读出一堆空值）',
    /iconFit: 'cover', iconBorder: 'glass',/.test(app) &&
    /iconShape:\s*'auto', iconRadius:\s*22, iconRingColor:\s*''/.test(app)],
  ['v2.4.2/3 UI：设置面板四组控件 + 圆角滑块 + 边框颜色自定义 + 弹窗预览容器',
    html.includes('id="iconFitSeg"') && html.includes('id="iconBorderSeg"') &&
    html.includes('id="iconShapeSeg"') && html.includes('id="iconRadius"') &&
    html.includes('id="iconRadiusRow"') && html.includes('id="iconRingColor"') &&
    html.includes('id="btnIconRingClear"') &&
    html.includes('data-fit="contain"') && html.includes('data-fit="cover"') &&
    html.includes('data-border="auto"') && html.includes('data-border="theme"') &&
    html.includes('data-border="none"') &&
    html.includes('data-shape="auto"') && html.includes('data-shape="circle"') &&
    html.includes('data-shape="rounded"') && html.includes('data-shape="square"') &&
    html.includes('id="iconPreview"')],
  ['v2.4.3 事件绑定：形状 seg / 圆角滑块 / 颜色取色器 / 恢复默认按钮',
    /iconShapeSeg\.addEventListener\('click'/.test(app) &&
    /iconRadiusEl\.addEventListener\('input'/.test(app) &&
    /iconRingColorEl\.addEventListener\('change'/.test(app) &&
    /\$\('btnIconRingClear'\)\.addEventListener\('click'/.test(app)],
  ['v2.4.3 圆角大小只在「圆角」形状下露出（调了没反应的控件不该出现）',
    /rRow\.classList\.toggle\('hidden', shape !== 'rounded'\)/.test(app)],
  ['★ v2.4.2 用户报的按钮溢出：选择图片 / 清除 移出 30×30 的 .size-controls',
    // .size-controls 是 30×30 的方形图标按钮容器，被复用去装文字按钮后
    // `.size-controls button`(0,1,1) 压过 `.text-btn`(0,1,0)，又把按钮挤成 30px 宽，
    // 而容器没有 overflow:hidden → 文字直接溢出到框外
    /\.btn-row \{ display: flex;/.test(css) &&
    /\.size-controls button\.text-btn \{ width: auto; height: auto; \}/.test(css) &&
    /\.text-btn \{[\s\S]{0,300}?white-space: nowrap;/.test(css) &&
    !/<div class="size-controls" id="bgRow"/.test(html)],
  ['★ v2.4.4 统一图标风格：iconMonoActive 要求 contain（它是「内部」的附加项，裁剪下让位）',
    /function iconMonoActive\(\)\s*\{[^}]*config\.iconFit === 'contain'/.test(app)],
  ['★ v2.4.4 统一色由 body 一处下发（逐图标写内联值会把"一个色"拆成 N 份）',
    /body\.classList\.toggle\('ic-mono', iconMonoActive\(\)\)/.test(app) &&
    /iconMonoActive\(\) && normalizeHex\(config\.iconRingColor\)\)[\s\S]{0,140}?setProperty\('--ic-ring-c'[\s\S]{0,140}?removeProperty\('--ic-ring-c'\)/.test(app)],
  ['★ v2.4.4 统一模式下逐图标取色一律返回空（返回 \'\'=交给 CSS 回退）',
    /function iconRingColorFor[\s\S]{0,120}?if \(iconMonoActive\(\)\) return '';/.test(app)],
  ['★ v2.4.4 蒙版变量：从元素自己的 <img> 取（img.src 已编码），关掉时真清掉，同一次遍历里刷',
    /function applyIconMaskVar\(el\)[\s\S]{0,700}?querySelector\('img'\)[\s\S]{0,700}?removeProperty\('--ic-mask'\)[\s\S]{0,700}?setProperty\('--ic-mask',/.test(app) &&
    /querySelectorAll\('\.item-icon, \.icon-preview'\)\.forEach\(\(el\) => \{[\s\S]{0,260}?applyIconMaskVar\(el\)/.test(app)],
  ['★ v2.4.4 CSS：蒙版层几何与图片内容盒一致（inset=--ic-pad / contain），且用 :has(img) 限定',
    /body\.ic-mono \.item-icon:has\(img\)::after[\s\S]{0,900}?inset:\s*var\(--ic-pad, 0\)[\s\S]{0,900}?mask-image:\s*var\(--ic-mask\)[\s\S]{0,900}?mask-size:\s*contain/.test(css) &&
    // 选择器是两个（.item-icon.item-icon + .icon-preview.icon-preview）的列表，别锚成单选择器加 {
    /body\.ic-mono \.item-icon\.item-icon,[\s\S]{0,200}?--ic-c: var\(--ic-ring-c, var\(--t-accent, var\(--accent\)\)\)/.test(css)],
  ['★ v2.4.4 CSS：color 混合保留明暗细节（满幅不透明图标才不会变成纯色方块）+ isolation',
    /body\.ic-mono \.item-icon:has\(img\)::after[\s\S]{0,900}?mix-blend-mode:\s*color/.test(css) &&
    /body\.ic-mono \.item-icon\.item-icon,[\s\S]{0,300}?isolation:\s*isolate/.test(css)],
  ['v2.4.4 事件绑定 + 开关行只在「内部」下露出 + 老配置回收布尔默认',
    /\$\('iconMono'\)\.addEventListener\('change'/.test(app) &&
    /mnRow\.classList\.toggle\('hidden', fitNow !== 'contain'\)/.test(app) &&
    /config\.iconMono = !!config\.iconMono/.test(app) &&
    /function setIconMono\(on\)[\s\S]{0,420}?persist\(\)/.test(app)],
  ['v2.4.4: README / CHANGELOG 已同步到本版（防"发版忘了改文档"）',
    /2\.4\.4/.test(readme) && /CHANGELOG\.md/.test(readme) &&
    /##\s*v2\.4\.4/.test(changelog) && /2\.4\.4/.test(changelog)],
  /* v2.4.5 那条原本是「README 里能搜到 2.4.5」——纯粹的历史字面量，v2.5.2 清理 README
   * 下载表时（原来那几行还写着"FClassPal-2.4.5-linux-*.deb 沿用上一版"）它必然变红。
   * 真正值得守的是"下载表指向当前版本"，所以改成查这个 —— 断言不删，换到正确的位置查。 */
  ['v2.4.5: README 下载表指向当前版本（别再留"沿用上一版"的陈旧行）',
    readme.includes('releases/tag/v' + srcPkg.version) &&
    !/沿用上一版/.test(readme) &&
    new RegExp('FClassPal-' + srcPkg.version.replace(/\./g, '\\.') + '-linux-loong64').test(readme) &&
    /##\s*v2\.4\.5/.test(changelog)],
  ['v2.4.5: CHANGELOG 只写新增/改变（本版没有"测试"小节，规范改了）',
    /##\s*v2\.4\.5[\s\S]*?(?=\n##\s|\n*$)/.test(changelog) &&
    !/##\s*v2\.4\.5[\s\S]*?###\s*测试/.test(changelog)],
  ['v2.4.5: 明暗三档（主进程解析 + 渲染层解析 + 第三档按钮）',
    /function resolvedAppearance\(cfg\)/.test(main) &&
    /nativeTheme\.shouldUseDarkColors/.test(main) &&
    /nativeTheme\.on\('updated'/.test(main) &&
    main.includes("'system-appearance-changed'") &&
    pre.includes('getSystemAppearance') &&
    /function resolveDarkValue\(v\)/.test(app) &&
    /function effectiveDark\(\)/.test(app) &&
    html.includes('data-appearance="auto"')],
  ['v2.4.5: get-palette 不再把 auto 折叠成 light（跟随系统要被记住）',
    /get-palette', \(event, patch\) => \{[\s\S]{0,800}?cfg\.appearance = patch\.appearance/.test(main) &&
    /patch\.appearance === 'auto' \|\| patch\.appearance === 'light'/.test(main) &&
    !/patch\.appearance === 'auto' \? 'light' : patch\.appearance/.test(main)],
  ['v2.4.5: 安卓壳就位（装配脚本 / 桥接 / 原生插件 / 出包脚本）',
    fs.existsSync('mobile/tools/assemble-web.js') &&
    fs.existsSync('mobile/web/mobile-bridge.js') &&
    fs.existsSync('mobile/web/mobile.css') &&
    fs.existsSync('mobile/tools/build-apk.js') &&
    fs.existsSync('mobile/android-overlay/app/src/main/java/com/fclasspal/widget/PalBridgePlugin.java') &&
    fs.existsSync('docs/ANDROID.md')],
  ['v2.4.5: 安卓桥接层在 app.js 之前注入 window.widgetAPI（装配自检保证顺序）',
    /check\.indexOf\('<script src="mobile-bridge\.js"><\/script>'\)/.test(
      fs.readFileSync('mobile/tools/assemble-web.js', 'utf8')) &&
    /atBridge < atApp/.test(fs.readFileSync('mobile/tools/assemble-web.js', 'utf8'))],
  ['v2.4.5: 多平台打包配置（linux deb/tar.gz 双架构 + mac dmg/zip 双架构）',
    !!srcPkg.build.linux && !!srcPkg.build.mac &&
    JSON.stringify(srcPkg.build.linux.target).includes('"x64"') &&
    JSON.stringify(srcPkg.build.linux.target).includes('"arm64"') &&
    JSON.stringify(srcPkg.build.mac.target).includes('"x64"') &&
    JSON.stringify(srcPkg.build.mac.target).includes('"arm64"') &&
    srcPkg.build.linux.artifactName === 'FClassPal-${version}-linux-${arch}.${ext}' &&
    srcPkg.build.mac.artifactName === 'FClassPal-${version}-mac-${arch}.${ext}'],
  /* v2.6.0 起改为钉当前版本：Windows 上本来只能打 tar.gz（deb 缺 fpm），
   * 老断言钉 2.4.5 的 deb 文件名，dist 一清就永远假红 */
  ['v2.4.5: Linux 产物已生成（x64 + arm64 + loong64 的 tar.gz，当前版本）',
    fs.existsSync('dist/FClassPal-' + srcPkg.version + '-linux-x64.tar.gz') &&
    fs.existsSync('dist/FClassPal-' + srcPkg.version + '-linux-arm64.tar.gz') &&
    fs.existsSync('dist/FClassPal-' + srcPkg.version + '-linux-loong64.tar.gz')],
  ['v2.3.2: 进度条跟随（--sl-fill 不在 input 上声明 + syncRangeFill 清元素自身陈旧变量）',
    !/body\.theme-glass input\[type="range"\]\s*\{[^}]*--sl-fill\s*:/.test(css) &&
    /el\.style\.removeProperty\('--sl-fill'\)/.test(app) &&
    /syncRangeFill\(\$\('setOpacity'\)\)/.test(app) &&
    /syncRangeFill\(\$\('setRadius'\)\)/.test(app)],
  ['v2.2.4: 首次启动种子只有一个「希沃应用」空分组',
    /name:\s*'希沃应用',\s*\n\s*items:\s*\[\]/.test(mainNC)],
  ['v2.2.4: 种子里不再预置任何示例快捷方式',
    !/希沃学苑/.test(mainNC) && !/希沃白板5/.test(mainNC) && !/易\+官网/.test(mainNC)],
  ['v2.2.4: 预览 mock 与种子对齐（空希沃应用分组）',
    /name:\s*'希沃应用',\s*items:\s*\[\]/.test(app)],
  ['v2.2.4: 标题栏默认 FClassPal（html + 全部 fallback）',
    html.includes('value="FClassPal"') && html.includes('<title>FClassPal</title>') &&
    !app.includes("'管家助手'")],
  ['U盘弹出修复仍在', main.includes('CM_Request_Device_EjectW')],

  /* ---------------- v2.4.6 ---------------- */
  ['v2.4.6: 圆角滑杆拖动实时预览（input 只预览，不许同步 saveConfig）',
    /setRadius'\)\.addEventListener\('input',\s*\(e\)\s*=>\s*\{\s*applyRadius\(parseInt\(e\.target\.value,\s*10\),\s*false\);\s*syncRangeFill\(e\.target\);\s*\}\)/.test(app)],
  ['v2.4.6: 圆角滑杆 change 才 saveConfig', /setRadius'\)\.addEventListener\('change'/.test(app)],
  ['v2.4.6: veil 底部辉光改 -10px/16px（旧 -22px/34px 会被折射推出白液滴）',
    cssNC.includes('inset 0 -10px 16px -14px') && !cssNC.includes('inset 0 -22px 34px -26px')],
  ['v2.4.6: 长按菜单不抢表单控件（range 拖不动的根因）',
    app.includes("closest('input, select, button, textarea, .panel, .ctx-menu, .usb-section')")],
  ['v2.4.6: input[type=range] touch-action:none（触摸拖滑杆不被打断）',
    /input\[type="range"\]\s*\{[^}]*touch-action:\s*none/.test(css)],
  ['v2.4.6: 编辑模式拖动排序引擎（Pointer Events + ghost + 落点判定）',
    app.includes('startItemDrag') && app.includes('applyItemDrop') &&
    app.includes('dropTargetAt') && app.includes("drag-ghost")],
  ['v2.4.6: 拖动聚合文件夹用 children 标记（type:folder 已被"目录快捷方式"占用）',
    app.includes("function isFolder(it) { return !!(it && Array.isArray(it.children)); }")],
  ['v2.4.6: 文件夹二级菜单（点击文件夹弹出 / 可删除 / 可编辑子项）',
    app.includes('showFolderMenu') && app.includes('closeFolderMenu') &&
    css.includes('folder-menu') && css.includes('folder-badge')],
  ['v2.4.6: 按名称排序（正序/倒序，中文 localeCompare）',
    app.includes('sortGroupsByName') &&
    app.includes("localeCompare") && app.includes('zh-Hans-CN') &&
    html.includes('data-act="sortAsc"') && html.includes('data-act="sortDesc"')],
  ['v2.4.6: 编辑模式菜单项只在编辑态露出', css.includes('body.edit-mode .ctx-menu .ctx-sort')],
  ['v2.4.6: 设置面板描述文字已清空（只留 JS 回填的 fixedPaletteHint；v2.5.2 主题管理提示句按需求删除）',
    (html.match(/class="row-hint/g) || []).length === 1 &&
    html.includes('id="fixedPaletteHint"') && !html.includes('themeManageHint')],
  ['v2.4.6: 占用程序弹窗（三键：关闭占用并重试 / 直接重试 / 取消）',
    app.includes('showOccupiedDialog') && main.includes("'close-drive-occupants'") &&
    pre.includes('closeDriveOccupants') && css.includes('occupied-menu')],
  ['v2.4.6: 弹出被拒立即返回占用列表（不再五层兜底硬磨）',
    /occupied/.test(main) && main.includes('parseOccupants') && main.includes('buildOccupantsScript')],
  ['★ v2.4.7: 配置/主题包按钮不在 .size-controls 里（30×30 会压爆文字且点不到，真机事故）',
    (() => {
      const m = html.match(/id="rowBackup"[\s\S]{0,300}?id="btnCfgImport"/);
      const m2 = html.match(/id="rowThemePack"[\s\S]{0,300}?id="btnThemeImport"/);
      return !!m && !!m2 && /class="btn-row"/.test(m[0]) && /class="btn-row"/.test(m2[0]) &&
        !/class="size-controls"/.test(m[0]) && !/class="size-controls"/.test(m2[0]);
    })()],
  ['★ v2.4.7: .size-controls 块内没有任何带文字/字母的按钮（只能是图标按钮）',
    (() => {
      const blocks = [];
      html.replace(/<div class="size-controls">([\s\S]*?)<\/div>/g, (mm, b) => { blocks.push(b); return mm; });
      return blocks.length > 0 && blocks.every((b) => {
        const t = [];
        b.replace(/<button[^>]*>([\s\S]*?)<\/button>/g, (mm, inner) => { t.push(inner.replace(/<[^>]+>/g, '').trim()); return mm; });
        return t.every((x) => !/[A-Za-z\u4e00-\u9fa5.]/.test(x));
      });
    })()],
  ['v2.4.6: 配置包 .fcpc / 主题包 .fcpt（零依赖 zip + 四个 IPC + 设置面板最下面两行）',
    fs.existsSync('pack.js') && main.includes("require('./pack')") &&
    main.includes("'export-config'") && main.includes("'import-config'") &&
    main.includes("'export-theme'") && main.includes("'import-theme'") &&
    html.includes('id="rowBackup"') && html.includes('id="rowThemePack"') &&
    pre.includes('exportConfig') && pre.includes('importConfig') &&
    pre.includes('exportTheme') && pre.includes('importTheme')],
  ['v2.4.6: 签名密钥已 gitignore（_signing/ 与 *.keystore 绝不入公开仓库）',
    fs.readFileSync('.gitignore', 'utf8').includes('_signing/')],
  ['v2.4.6: 安卓 · 悬浮窗/全屏窗口模式（原生 setWindowMode + 面板切换行）',
    fs.readFileSync('mobile/android-overlay/app/src/main/java/com/fclasspal/widget/PalBridgePlugin.java', 'utf8').includes('setWindowMode') &&
    fs.readFileSync('mobile/web/mobile-bridge.js', 'utf8').includes('injectWindowModeRow')],
  ['v2.4.6: 安卓 · 录屏实时模糊（MediaProjection + 前台服务 + 帧事件过桥）',
    fs.existsSync('mobile/android-overlay/app/src/main/java/com/fclasspal/widget/RealtimeCapture.java') &&
    fs.existsSync('mobile/android-overlay/app/src/main/java/com/fclasspal/widget/ScreenCaptureService.java') &&
    fs.readFileSync('mobile/android-overlay/app/src/main/AndroidManifest.xml', 'utf8').includes('FOREGROUND_SERVICE_MEDIA_PROJECTION') &&
    fs.readFileSync('mobile/web/mobile-bridge.js', 'utf8').includes('onRealtimeFrame')],
  ['v2.4.6: 渲染层外部帧模式（onRealtimeFrame 在则走原生帧，不走 getDisplayMedia）',
    app.includes('startExternalRealtime') && app.includes('onRealtimeFrame')],
  ['v2.4.6: 安卓版本号与桌面同源（package.json 是唯一版本源；"-fix" 后缀 = 安卓热修豁免）',
    (() => {
      const v = srcPkg.version;
      const mb = fs.readFileSync('mobile/web/mobile-bridge.js', 'utf8');
      return mb.includes("APP_VERSION = '" + v + "'") || mb.includes("APP_VERSION = '" + v + "-fix'");
    })() &&
    JSON.parse(fs.readFileSync('mobile/package.json', 'utf8')).version === srcPkg.version],
  ['v2.4.6: 应用图标 = 加号卡片（重绘源 + 安卓满幅前景层修圆角）',
    fs.existsSync('build/icon_fullsquare.png') &&
    fs.readFileSync('_rt/_mkandroidicons.js', 'utf8').includes('icon_fullsquare.png') &&
    srcPkg.build.win.icon === 'build/icon.ico'],
  ['v2.4.6: exe 体积优化（最大压缩 + 只留中英语言包）',
    srcPkg.build.win.compression === 'maximum' &&
    Array.isArray(srcPkg.build.electronLanguages) &&
    srcPkg.build.electronLanguages.join(',') === 'zh-CN,en-US'],
  /* 2026-10 真事故：8 个包的 `--t-veil: linear-gradient(...` 少了右括号，渲染层
   * 又把 13 个包拼成一个 <style>，Blink 从出错点往后整份丢弃 —— 一个字符带走了
   * 8 套主题。括号不配平这种错肉眼看着是配平的，必须机器数（_rt/_csslint.js，
   * 先剥注释和字符串再数，_packthemes.js 打包前也用同一份体检拦一道）。 */
  ['主题包: CSS 语法体检 —— 圆括号/大括号/注释配平，13 个包全部干净',
    (function () {
      const lint = require('./_rt/_csslint').lintCss;
      let ok = true;
      PACK_IDS.forEach((t) => {
        const ps = lint(packCss[t] || '', t);
        if (ps.length) {
          ok = false;
          console.log('      · ' + t + '：' +
            ps.map((x) => '第' + (x.line || '?') + '行 ' + x.msg).join('；'));
        }
      });
      return ok;
    })()],
  ['主题包: 渲染层一包一表注入（一个包写坏不许连坐其它主题）',
    app.includes("setAttribute('data-theme-pack'") &&
    app.includes("querySelectorAll('style[data-theme-pack]')") &&
    !app.includes("getElementById('themePackCss')")]
];
let bad = 0;
checks.forEach((c) => {
  const ok = !!c[c.length - 1];
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + c[0]);
  if (!ok) bad++;
});
process.exit(bad ? 1 : 0);

// ── 本文件由 _mksrccheck.js 从 _check.js 自动生成，请勿手工编辑 ──
