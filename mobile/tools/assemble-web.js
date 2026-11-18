#!/usr/bin/env node
/* ============================================================================
 * FClassPal 安卓壳 · Web 资源装配（v2.4.5）
 *
 * 设计原则：**不 fork 渲染层**。
 *   桌面版 renderer/ 是唯一一份界面代码，安卓版在装配阶段把它整份复制到
 *   mobile/www/，再叠三样东西：
 *     ① mobile/web/mobile.css        —— 手机布局覆盖（全屏、安全区、隐藏桌面专有行）
 *     ② mobile/web/mobile-bridge.js   —— 注入 window.widgetAPI（34 个方法的安卓实现）
 *     ③ index.html 的两处标签注入
 *   renderer/app.js 因此一行都不用改：它只认 window.widgetAPI 这个对象，
 *   对象存在就不走预览模式，走的是和桌面完全相同的界面与交互。
 *
 * 两处注入都用"找不到锚点就报错退出"的写法：renderer/index.html 以后若改了
 * 标签顺序，装配会直接失败而不是悄悄产出一个没桥接的包（那种包打开就是白屏）。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC_RENDERER = path.resolve(ROOT, '..', 'renderer');
const SRC_WEB = path.resolve(ROOT, 'web');
const OUT = path.resolve(ROOT, 'www');

const ANCHOR_STYLE = '<link rel="stylesheet" href="style.css" />';
const ANCHOR_SCRIPT = '<script src="lg-displacement-map.js"></script>';
const ANCHOR_VIEWPORT = 'name="viewport" content="width=device-width, initial-scale=1.0';

function log(msg) { process.stdout.write('[mobile] ' + msg + '\n'); }
function die(msg) { process.stderr.write('[mobile] 失败：' + msg + '\n'); process.exit(1); }

function copyTree(from, to, filter) {
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (filter && !filter(s, entry)) continue;
    if (entry.isDirectory()) n += copyTree(s, d, filter);
    else if (entry.isFile()) { fs.copyFileSync(s, d); n += 1; }
  }
  return n;
}

/* ---------------- 极简 zip 读取（只认 stored / deflate 两种） ----------------
 * 随包主题 .fcpt 就是普通 zip，本仓库用 python zipfile / _packthemes 生成，
 * 压缩方式只会是 0（stored）或 8（deflate）。这里不引第三方库：装配脚本
 * 要保持零依赖，CI 上 npm i 失败也不能把出包卡死。 */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法 zip（找不到中央目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const exLen = buf.readUInt16LE(p + 30);
    const cmLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + fnLen).toString('utf8').replace(/\\/g, '/');
    const lnLen = buf.readUInt16LE(lho + 26);
    const leLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnLen + leLen;
    const raw = buf.slice(start, start + csize);
    if (!name.endsWith('/')) {
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  return out;
}

/* 主题包 CSS 里的 url("assets/x") → 文档相对路径。
 * 注入的 <style> 在文档里，相对 URL 是按文档基准解析的，所以必须补上前缀，
 * 否则贴图全 404（这套包的特点就是贴图多、纯色少）。 */
function rewriteCssUrls(css, id) {
  return css.replace(/url\(\s*(['"]?)assets\/([^'")]+)\1\s*\)/g, (m, q, rel) =>
    'url("themepacks/' + id + '/assets/' + rel + '")');
}

/* 清空产出目录。
 * 注意 这里不能用 fs.rmSync(dir,{recursive:true})：本机的 Node 预加载了
 * safe-delete 垫片（NODE_OPTIONS 里的 node-language-shim.cjs），rmSync 会转去调
 * 回收站程序，在 www/ 这种几万个小文件的目录上会 ETIMEDOUT 直接抛错。
 * 自己走 unlink + rmdir 最稳（逐个文件删，垫片不拦这两个）。 */
function purgeDir(dir) {
  if (!fs.existsSync(dir)) return;
  let files = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) files += purgeDir(p);
    else { fs.unlinkSync(p); files += 1; }
  }
  fs.rmdirSync(dir);
  return files;
}

function main() {
  if (!fs.existsSync(path.join(SRC_RENDERER, 'index.html'))) die('找不到 renderer/index.html');
  if (!fs.existsSync(path.join(SRC_WEB, 'mobile-bridge.js'))) die('找不到 web/mobile-bridge.js');

  // 只清自己产出的目录：www/ 完全由本脚本生成，没有用户数据
  const purged = purgeDir(OUT);
  if (purged) log('清空上一版 www/：' + purged + ' 个文件');

  // ① 桌面渲染层整份复制（含 theme/ 角色贴图与 icons/）
  const nRenderer = copyTree(SRC_RENDERER, OUT);
  log('复制 renderer/ -> www/：' + nRenderer + ' 个文件');

  // ② 手机外壳覆盖层
  const nWeb = copyTree(SRC_WEB, OUT);
  log('叠加 web/ -> www/：' + nWeb + ' 个文件');

  // ②.5 随包主题包：复制进 www/themes/ —— cap sync 后落在 APK assets 的
  //     public/themes/，PalBridge.themeInstallBundled 从这里读，首启由
  //     renderer 的 autoInstallBundledPacks() 一次性装好。
  //
  //     ※ v2.6.6 起**安卓内置全套**（用户：「以后安卓端直接内置所有主题」）。
  //     以前这里只认本体 package.json 的 build.files（8 套），另外 5 套
  //     （洛天依 / 初音 / 重音Teto / 乐正绫 / 鲸鱼娘）在手机上没有入口 ——
  //     桌面端从主题仓库导入很方便，手机上要先下载文件再用文件选择器捞，
  //     用户根本不会去干。所以这里改成扫整个 themes/ 目录。
  //     桌面端的随包清单不动（build.files 仍是 8 套）：那是安装包体积的取舍，
  //     和"手机上要开箱即用"不是一回事。
  const SRC_PKG = JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', 'package.json'), 'utf8'));
  const desktopBundled = (SRC_PKG.build && SRC_PKG.build.files || [])
    .map((f) => String(f))
    .filter((f) => f.startsWith('themes/') && f.toLowerCase().endsWith('.fcpt'));
  const SRC_THEMES = path.resolve(ROOT, '..', 'themes');
  /* v2.6.8-fix3：这一版起 .fcpt **不再拷进 APK**，只当作解包源（见 ②.6）。
   * 理由：同一批素材没必要在包里存两份（fcpt 一份 + 解出来的静态文件一份），
   * 会白胖 6MB；而"随包离线包"这个入口在全部主题都内置之后已经没有意义了。 */
  const packSources = new Map();          // 文件名 -> 绝对路径
  if (fs.existsSync(SRC_THEMES)) {
    const all = fs.readdirSync(SRC_THEMES)
      .filter((f) => f.toLowerCase().endsWith('.fcpt'))
      .sort();
    if (!all.length) die('themes/ 下一个 .fcpt 都没有，APK 里不会有内置主题');
    for (const f of all) packSources.set(f, path.join(SRC_THEMES, f));
    /* v2.6.9b：主题仓库（FClassPal-theme/dist）里的包也一并内置 ——
     * 「安卓版全部主题都预装不要点击导入」。同名包以主题仓库的新版为准
     * （仓库随 release 更新更快），桌面 themes/ 里没有的（BlackKitty 等）
     * 直接补进来。仓库不在的机器上静默跳过，只用本体那 13 套。 */
    const REPO_DIST = path.resolve(ROOT, '..', '..', 'FClassPal-theme', 'dist');
    let repoN = 0;
    if (fs.existsSync(REPO_DIST)) {
      const repoPacks = fs.readdirSync(REPO_DIST)
        .filter((f) => f.toLowerCase().endsWith('.fcpt') && !f.startsWith('example-'))
        .sort();
      for (const f of repoPacks) {
        packSources.set(f, path.join(REPO_DIST, f));
        repoN += 1;
      }
    }
    log('内置主题源：合计 ' + packSources.size + ' 套（本体 themes/ + 主题仓库 dist，同名以仓库版为准；' +
      '桌面端随包 ' + desktopBundled.length + ' 套）');
  } else {
    log('警告：找不到 themes/ 目录，APK 里不会有内置主题');
  }

  // ②.6 随包主题【真内置】（v2.6.8-fix3）
  //   用户原话：「我让你直接完全自带内置而不是要补装」。
  //   原来这套包得先"装"（原生 themeInstallBundled 解 zip、写到应用目录）才算存在，
  //   而这一步在真机上一失败，主题列表就只剩内置五套，用户还没法自救。
  //   现在改成装配期就把每个 .fcpt 解成同源静态文件：
  //     www/themepacks/<id>/{theme.css, assets/*, preview.png, manifest.json}
  //     www/themepacks/index.json      ← 渲染层 fetch 一次即得全部清单
  //   渲染层按需 fetch 主题 CSS（只取当前用的那一套），不经过任何原生安装流程，
  //   也不需要点击。自定义包（用户自己导入的 .fcpt）仍旧走原生那条路，互不干扰。
  const PACKS_OUT = path.join(OUT, 'themepacks');
  if (packSources.size) {
    fs.mkdirSync(PACKS_OUT, { recursive: true });
    const packs = [];
    let skipped = 0;
    for (const f of Array.from(packSources.keys()).sort()) {
      let ent;
      try {
        ent = zipEntries(fs.readFileSync(packSources.get(f)));
      } catch (e) {
        log('警告：主题包读不出来，跳过 ' + f + '（' + e.message + '）');
        skipped += 1;
        continue;
      }
      const mfRaw = ent.get('manifest.json');
      const cssRaw = ent.get('theme.css');
      if (!mfRaw || !cssRaw) { log('警告：' + f + ' 缺 manifest.json / theme.css，跳过'); skipped += 1; continue; }
      let mf;
      try { mf = JSON.parse(mfRaw.toString('utf8')); } catch (e) {
        log('警告：' + f + ' 的 manifest.json 不是合法 JSON，跳过'); skipped += 1; continue;
      }
      const id = String(mf.id || '').trim();
      /* 与原生 themes.js / PalBridgePlugin 同一条 id 规则：一串不合格的主题名
       * 会让目录名带路径味道（../、空格、中文），WebView 里 fetch 就崩。 */
      if (!/^[a-zA-Z][a-zA-Z0-9-]{1,23}$/.test(id)) {
        log('警告：' + f + ' 的 id「' + id + '」不合法，跳过'); skipped += 1; continue;
      }
      const dir = path.join(PACKS_OUT, id);
      fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
      for (const [name, bytes] of ent) {
        if (name.startsWith('/') || name.split('/').includes('..') || name.indexOf(':') === 1) continue;
        const dst = path.join(dir, name);
        if (!path.resolve(dst).startsWith(path.resolve(dir) + path.sep)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (name === 'theme.css') {
          fs.writeFileSync(dst, rewriteCssUrls(bytes.toString('utf8'), id), 'utf8');
        } else {
          fs.writeFileSync(dst, bytes);
        }
      }
      const hasPreview = ent.has(String(mf.preview || 'preview.png'));
      packs.push({
        id: id,
        name: String(mf.name || id),
        version: String(mf.version || '1.0.0'),
        author: String(mf.author || ''),
        desc: String(mf.description || mf.desc || ''),
        accent: /^#[0-9a-fA-F]{6}$/.test(String(mf.accent || '')) ? mf.accent : '',
        fixedPalette: String(mf.fixedPalette) !== 'false',
        blur: mf.blur === true,
        repo: String(mf.repo || ''),
        css: 'themepacks/' + id + '/theme.css',
        preview: hasPreview ? 'themepacks/' + id + '/' + String(mf.preview || 'preview.png') : '',
        file: f,
        gen: SRC_PKG.version
      });
    }
    packs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    fs.writeFileSync(path.join(PACKS_OUT, 'index.json'),
      JSON.stringify({ spec: 1, gen: SRC_PKG.version, packs: packs }, null, 1), 'utf8');
    if (!packs.length) die('随包主题解包后一套都不剩，内置主题会是空的');
    log('内置主题（同源静态）：' + packs.length + ' 套 -> www/themepacks/' +
      (skipped ? '（跳过 ' + skipped + ' 个坏包）' : ''));
  } else {
    log('警告：没有 www/themes/，跳过去内置主题解包');
  }

  // ③ index.html 注入
  const idxPath = path.join(OUT, 'index.html');
  let html = fs.readFileSync(idxPath, 'utf8');

  if (html.indexOf(ANCHOR_STYLE) < 0) die('index.html 里找不到 style.css 的 <link>，装配锚点失效');
  html = html.replace(ANCHOR_STYLE, ANCHOR_STYLE + '\n  <link rel="stylesheet" href="mobile.css" />');

  if (html.indexOf(ANCHOR_SCRIPT) < 0) die('index.html 里找不到 lg-displacement-map.js 的 <script>，装配锚点失效');
  /* mobile-wear.js 紧跟在桥接之后：它要用 window.FCP_LAN（桥接末尾才挂上去的），
   * 而它自己只在 DOMContentLoaded / 点设置时动手，所以放在 app.js 之前也安全。 */
  html = html.replace(ANCHOR_SCRIPT,
    '<script src="mobile-bridge.js"></script>\n  <script src="mobile-wear.js"></script>\n  ' + ANCHOR_SCRIPT);

  // 刘海屏适配：webview 覆盖到状态栏/手势条下面，靠 env(safe-area-inset-*) 让开
  if (html.indexOf(ANCHOR_VIEWPORT) > 0 && html.indexOf('viewport-fit=cover') < 0) {
    html = html.replace(ANCHOR_VIEWPORT, ANCHOR_VIEWPORT + ', viewport-fit=cover');
  }

  fs.writeFileSync(idxPath, html);

  // 装配自检：三处注入必须都在，否则打包出来的就是白屏包
  const check = fs.readFileSync(idxPath, 'utf8');
  const atBridge = check.indexOf('<script src="mobile-bridge.js"></script>');
  const atWear = check.indexOf('<script src="mobile-wear.js"></script>');
  const atApp = check.indexOf('<script src="app.js"></script>');
  const ok =
    check.indexOf('<link rel="stylesheet" href="mobile.css" />') > 0 &&
    atBridge > 0 &&
    atWear > atBridge &&          // 手机端「连电脑」面板要用桥接挂出来的 FCP_LAN
    check.indexOf('viewport-fit=cover') > 0 &&
    atBridge < atApp;   // 必须早于 app.js：它顶层就取 window.widgetAPI
  if (!ok) die('注入自检未通过（mobile.css / mobile-bridge.js / viewport-fit 或桥接顺序不对）');

  const total = fs.readdirSync(OUT).length;
  log('注入完成：mobile.css + mobile-bridge.js + mobile-wear.js（都在 app.js 之前）+ viewport-fit=cover');
  log('www/ 就绪：' + total + ' 个顶层条目 -> ' + OUT);
}

main();
