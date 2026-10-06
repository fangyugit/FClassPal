/* 真 Electron 验证：从 main.js 源码文本里按括号配平抓出 saveBounds / pushBounds
 * 函数体再 eval —— 测的是出货代码而不是手抄副本（SKILL §16 的套路）。
 * 目的：证明 set-dragging 结束时 saveBounds 不再 ReferenceError，且位置真的落盘。
 *
 * ※ 要点：saveBounds 里读的 renderDragging / boundsSaveTimer 是 main.js 的模块级
 *   变量，抽函数出来后必须挂在 globalThis 上（用 getter 才能动态改值），
 *   不能靠参数传——参数会闭包住调用那一刻的值，测不到"拖拽期间"分支。 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/** 按括号配平从源码里抓 "function NAME(...) { ... }" */
function grabFn(name) {
  const key = 'function ' + name + '(';
  const i = src.indexOf(key);
  if (i < 0) throw new Error('找不到函数 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) { j = k + 1; break; } }
  }
  return src.slice(i, j);
}

let passed = 0, failed = 0;
const check = (n, c) => { c ? passed++ : failed++; console.log((c ? '  PASS  ' : '  FAIL  ') + n); };

app.whenReady().then(() => {
  // ---- 模块级状态的动态替身（getter/setter 挂 globalThis） ----
  const state = { rd: false, timer: 0 };
  Object.defineProperty(globalThis, 'renderDragging', { get: () => state.rd, configurable: true });
  Object.defineProperty(globalThis, 'boundsSaveTimer', {
    get: () => state.timer, set: (v) => { state.timer = v; }, configurable: true });

  const sent = [];
  const saved = [];
  const mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 111, y: 222, width: 480, height: 420 }),
    webContents: { send: (ch, b) => sent.push([ch, b]) },
  };
  const loadConfig = () => ({ title: '管家助手' });
  const saveConfig = (cfg) => saved.push(cfg);

  const code = grabFn('saveBounds') + '\n' + grabFn('pushBounds');
  // eslint-disable-next-line no-new-func
  const fn = new Function('mainWindow', 'loadConfig', 'saveConfig', 'clearTimeout', 'setTimeout',
    code + '\nreturn { saveBounds };');
  const bound = fn(mainWindow, loadConfig, saveConfig, clearTimeout, setTimeout);

  // ---- 断言 ----
  check('main.js 顶层存在 function saveBounds（不是 createWindow 闭包里的局部量）',
    /function saveBounds\(/.test(src) && !/const saveBounds =/.test(src));
  check('set-dragging 的 IPC 处理器仍然调用 saveBounds',
    // v2.2.3 起处理器里先做拖动诊断统计，窗口开到 1200 才够（别再往回收）
    /ipcMain\.on\('set-dragging'[\s\S]{0,1200}saveBounds\(\)/.test(src));
  check('main.js 已挂 uncaughtException / unhandledRejection 兜底（不再弹主进程报错框）',
    /process\.on\('uncaughtException'/.test(src) && /process\.on\('unhandledRejection'/.test(src));

  let threw = null;
  try { bound.saveBounds(); } catch (e) { threw = e; }
  check('saveBounds() 可直接调用且不抛 ReferenceError', threw === null);

  setTimeout(() => {
    check('300ms 防抖后把 x/y/width/height 写进配置（拖完位置真的落盘）',
      saved.length === 1 && saved[0].x === 111 && saved[0].y === 222 &&
      saved[0].width === 480 && saved[0].height === 420);
    check('非拖拽状态下会回推 bounds 给渲染层', sent.some((s) => s[0] === 'bounds-changed'));

    state.rd = true; sent.length = 0; saved.length = 0;
    bound.saveBounds();
    setTimeout(() => {
      check('拖拽期间落盘但不回推 bounds（防闪跳）', saved.length === 1 && sent.length === 0);
      console.log('结果: ' + passed + ' 通过, ' + failed + ' 失败');
      app.exit(failed ? 1 : 0);
    }, 380);
  }, 380);
}).catch((e) => { console.error('FATAL', e); app.exit(2); });
