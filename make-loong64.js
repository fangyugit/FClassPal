#!/usr/bin/env node
/* 打龙芯（LoongArch64 / loong64）tar.gz。
 *
 * 为什么不用 electron-builder：它的配置 schema 只认
 *   arm64 / armv7l / ia32 / universal / x64
 * （写 loong64 会直接 ValidationError 拒绝），官方 Electron 也没有 loong64 产物，
 * 所以 LoongArch 这一份只能自己拼：拿一份 **LoongArch 的 Electron 运行时**，
 * 把当前构建出来的 `resources/app.asar` 换进去，再打成 tar.gz。
 *
 * 前提：先跑 `npm run build:linux`，保证 dist/linux-unpacked/resources/app.asar 是新的。
 *   asar 里没有任何 .node 原生模块（只有 JS/HTML/CSS/图片/主题包），所以它与架构无关，
 *   同一份 asar 可以同时喂给 x64 / arm64 / loong64。
 *
 * 运行时从哪来（按顺序找，找到即用）：
 *   1. --runtime <目录>            显式指定一份已解开的 LoongArch Electron 目录
 *   2. dist/loong64-runtime/       本机构建缓存（首次运行会从下面某处解出来）
 *   3. _rt/_loong/                 手工解开的 LoongArch Electron（历史遗留目录）
 *   4. _rt/ 或 dist/ 下的 electron-v*-linux-loong64.zip
 *   5. dist/FClassPal-*-linux-loong64.tar.gz   从历史龙芯包里解出来当运行时
 *      （历史包里那份 app.asar 会被替换掉，只借它的 Electron 本体）
 *   找不到就明确报错，不会静默产出一个假包。
 *
 * ★ 关于 LoongArch 的 Electron 本体：Electron 官方与 npmmirror 都**没有** loong64 产物
 *   （两个源对 electron-v31.7.7-linux-loong64.zip 都是 404），本机现成的是
 *   `_rt/electron-v31.7.7-linux-loong64.zip`（151.6 MB，来源为龙芯侧的第三方构建，
 *   2026-10-13 随 2.5.0 那次打包下载）。所以这份运行时必须自己留好：
 *   `_rt/_loong/electron` 与从 zip 重新解出来的是同一份（sha256 6e5488ce…，已核对），
 *   找不到时按上面的顺序兜底。
 *
 * 用法：
 *   node make-loong64.js
 *   node make-loong64.js --runtime D:/some/electron-loong64
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PKG_DIRNAME = 'FClassPal-linux-loong64';   // 包内顶层目录名（沿用历史命名）

function die(msg) { console.error('\n[loong64] ' + msg + '\n'); process.exit(1); }
function say(msg) { console.log('[loong64] ' + msg); }

/* ★ tar 的参数必须是**相对路径 + 正斜杠**。
 * 传 `D:\workb\...` 这种绝对 Windows 路径时，tar 会把 `D:` 当成"远程主机"语法直接
 * 报 status 2（而且 stderr 在 stdio inherit 下还看不见，只看到一句 Command failed）。
 * 所以统一 chdir 到项目根、把路径转成相对形式。 */
function tarRun(args) {
  execFileSync('tar', args, { cwd: ROOT, stdio: 'inherit' });
}
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/* 壳语言包：与 electron-builder 的 electronLanguages=[zh-CN,en-US] 保持一致，
 * 别的 Linux 包都只留这两个，龙芯包没理由多带 70 份 */
const KEEP_LOCALES = ['zh-CN.pak', 'en-US.pak'];

function argRuntime() {
  const i = process.argv.indexOf('--runtime');
  return i >= 0 ? process.argv[i + 1] : null;
}

function looksLikeRuntime(dir) {
  return fs.existsSync(path.join(dir, 'electron')) &&
    fs.existsSync(path.join(dir, 'resources'));
}

/* 从历史龙芯包解出运行时（只借 Electron 本体，包内的 app.asar 一定被覆盖） */
function unsealFromArchive(tarPath) {
  const out = path.join(DIST, 'loong64-runtime');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, '_loongtmp'), { recursive: true });
  say('从历史包解出运行时：' + path.basename(tarPath));
  tarRun(['-xzf', rel(tarPath), '-C', rel(path.join(DIST, '_loongtmp'))]);
  const inner = fs.readdirSync(path.join(DIST, '_loongtmp'))[0];
  const src = path.join(DIST, '_loongtmp', inner);
  if (!inner || !looksLikeRuntime(src)) {
    die('历史包里没找到 electron 运行时目录（结构变了？）');
  }
  fs.renameSync(src, out);
  fs.rmSync(path.join(DIST, '_loongtmp'), { recursive: true, force: true });
  return out;
}

/* 从原生的 LoongArch Electron zip 解出运行时。
 * 用 7zip-bin 自带的 7za（electron-builder 的依赖，装了就有）：
 * bsdtar 虽然也认 zip，但 node 里 spawn 'tar' 会命中哪个实现不确定，
 * 7za 是同步调用、行为确定。 */
function unsealFromZip(zipPath) {
  let sevenZip;
  try { sevenZip = require('7zip-bin').path7za; }
  catch (e) { die('需要 7zip-bin 解压 zip（npm install 后就有了）'); }
  const out = path.join(DIST, 'loong64-runtime');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  say('从 ' + path.basename(zipPath) + ' 解出运行时…');
  execFileSync(sevenZip, ['x', zipPath, '-o' + out, '-y', '-bso0', '-bsp0'], { stdio: 'inherit' });
  if (!looksLikeRuntime(out)) die('zip 解出来后不像 Electron 运行时：' + out);
  return out;
}

function findRuntime() {
  const explicit = argRuntime();
  if (explicit) {
    if (!looksLikeRuntime(explicit)) die('--runtime 指向的目录不像 Electron 运行时：' + explicit);
    return explicit;
  }
  const cached = path.join(DIST, 'loong64-runtime');
  if (looksLikeRuntime(cached)) return cached;

  // 手工解开的运行时（历史遗留，优先于从 zip / 历史包解）
  const hand = path.join(ROOT, '_rt', '_loong');
  if (looksLikeRuntime(hand)) return hand;

  if (!fs.existsSync(DIST)) die('没有 dist/ 目录，先跑 npm run build:linux');
  // 原生的 LoongArch Electron zip
  const zip = [
    ...fs.readdirSync(path.join(ROOT, '_rt')).filter((f) => /linux-loong64\.zip$/i.test(f))
      .map((f) => path.join(ROOT, '_rt', f)),
    ...fs.readdirSync(DIST).filter((f) => /linux-loong64\.zip$/i.test(f))
      .map((f) => path.join(DIST, f)),
  ][0];
  if (zip) return unsealFromZip(zip);

  const cand = fs.readdirSync(DIST)
    .filter((f) => /^FClassPal-.*-linux-loong64\.tar\.gz$/.test(f))
    .sort();
  if (cand.length) return unsealFromArchive(path.join(DIST, cand[cand.length - 1]));
  die('找不到 LoongArch 的 Electron 运行时。\n' +
    '  · 把 electron-v<ver>-linux-loong64.zip 放进 _rt/ 或 dist/，或\n' +
    '  · 放一份解开的运行时到 dist/loong64-runtime/（里面要有 electron 与 resources/），或\n' +
    '  · 用 --runtime <目录> 指定，或\n' +
    '  · 把历史龙芯包 FClassPal-*-linux-loong64.tar.gz 放进 dist/');
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: false });
}

function main() {
  const runtime = findRuntime();
  say('运行时：' + runtime);

  const appAsar = path.join(DIST, 'linux-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(appAsar)) {
    die('没有 dist/linux-unpacked/resources/app.asar —— 先跑 `npm run build:linux`');
  }

  const stageRoot = path.join(DIST, 'loong64-stage');
  const stage = path.join(stageRoot, PKG_DIRNAME);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });
  copyTree(runtime, stage);

  // 1) 换进当前版本的应用代码
  const dstAsar = path.join(stage, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(dstAsar), { recursive: true });
  fs.copyFileSync(appAsar, dstAsar);
  say('已换入 app.asar（' + (fs.statSync(dstAsar).size / 1048576).toFixed(2) + ' MB）');

  // 2) 去掉 Electron 自带的占位应用（electron-builder 的产物里也不带它）
  const defApp = path.join(stage, 'resources', 'default_app.asar');
  if (fs.existsSync(defApp)) fs.rmSync(defApp, { force: true });

  // 3) 裁语言包
  const loc = path.join(stage, 'locales');
  if (fs.existsSync(loc)) {
    let dropped = 0;
    for (const f of fs.readdirSync(loc)) {
      if (!KEEP_LOCALES.includes(f)) { fs.rmSync(path.join(loc, f), { force: true }); dropped++; }
    }
    say('语言包裁到 ' + KEEP_LOCALES.length + ' 份（去掉 ' + dropped + ' 份）');
  }

  // 4) 打包
  const out = path.join(DIST, 'FClassPal-' + pkg.version + '-linux-loong64.tar.gz');
  if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  tarRun(['-czf', rel(out), '-C', rel(stageRoot), PKG_DIRNAME]);

  const size = fs.statSync(out).size;
  say('完成：' + out + '  (' + (size / 1048576).toFixed(2) + ' MB, ' + size + ' B)');
  say('校验：tar -tzf "' + path.basename(out) + '" | head   # 顶层应只有 ' + PKG_DIRNAME + '/');
  say('运行：解压后执行 ./' + PKG_DIRNAME + '/electron');
}

main();
