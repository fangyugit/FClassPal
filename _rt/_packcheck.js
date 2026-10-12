/* v2.4.6 .fcpc/.fcpt 导入导出端到端探针：
 * 桩掉对话框 → 渲染层真按钮链路导出 → 解包核对 → 再导入回填 → 校验配置与资产。
 * 跑完自动还原真实配置。 */
const { app, BrowserWindow, dialog } = require('electron');
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const CONF = path.join(os.homedir(), '.desktop-widget', 'config.json');
const BACKUP = path.join(__dirname, '_pack_cfg.bak.json');
const OUTDIR = path.join(__dirname, '_pack_out');

let pass = 0, fail = 0;
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (extra ? '  [' + extra + ']' : '')); }
};

if (!fs.existsSync(CONF)) { console.error('找不到 ' + CONF); app.exit(2); }
fs.copyFileSync(CONF, BACKUP);
const realCfg = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
fs.writeFileSync(CONF, JSON.stringify(Object.assign({}, realCfg, {
  autoLaunch: false, realtime: false, keepBottom: false, locked: false, theme: 'kitty', appearance: 'light'
}), null, 2));
const restore = () => { try { fs.copyFileSync(BACKUP, CONF); } catch (e) { } };
app.on('will-quit', restore);
process.on('exit', restore);

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
const FCPC = path.join(OUTDIR, 'test.fcpc');
const FCPT = path.join(OUTDIR, 'test.fcpt');

/* 对话框桩：导出→给路径；导入→给同一个文件 */
let nextOpen = null;
dialog.showSaveDialog = async (win, opts) => {
  const p = /fcpt/.test(opts && opts.defaultPath || '') ? FCPT : FCPC;
  console.log('  · save→' + path.basename(p));
  return { canceled: false, filePath: p };
};
dialog.showOpenDialog = async (win, opts) => {
  console.log('  · open→' + path.basename(nextOpen || '(none)'));
  return nextOpen ? { canceled: false, filePaths: [nextOpen] } : { canceled: true, filePaths: [] };
};

require(path.join(ROOT, 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2600));
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const { createZip, readZip } = require(path.join(ROOT, 'pack'));

  /* 先给配置塞一个自定义图标（拷一张现成 png 进 icons/ 再引用），验证资产随包 */
  const cfgNow = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
  const iconSrc = path.join(ROOT, 'build', 'icon.png');
  const iconDst = path.join(os.homedir(), '.desktop-widget', 'icons', '_packtest-icon.png');
  fs.copyFileSync(iconSrc, iconDst);
  cfgNow.groups[0].items[0].iconPath = require('url').pathToFileURL(iconDst).href;
  fs.writeFileSync(CONF, JSON.stringify(cfgNow, null, 2));
  win.webContents.reload();
  await new Promise((r) => setTimeout(r, 2200));

  /* ---- 导出 .fcpc ---- */
  let r = await wc.executeJavaScript(`API.exportConfig()`);
  check('导出 fcpc 成功', r && r.success, r && r.error);
  check('fcpc 文件存在且有体积', fs.existsSync(FCPC) && fs.statSync(FCPC).size > 500, fs.existsSync(FCPC) ? fs.statSync(FCPC).size + 'B' : '缺');
  let entries = readZip(fs.readFileSync(FCPC));
  const names = entries.map((e) => e.name);
  check('包内有 manifest/config/说明', names.includes('manifest.json') && names.includes('config.json') && names.some((n) => /说明/.test(n)), names.join(','));
  let manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  check('manifest.kind = fcpc', manifest.kind === 'fcpc');
  let packedCfg = JSON.parse(entries.find((e) => e.name === 'config.json').data.toString('utf8'));
  const packedIcon = [];
  (packedCfg.groups || []).forEach((g) => (g.items || []).forEach((it) => { if (it.iconPath) packedIcon.push(it.iconPath); }));
  check('iconPath 已换成包内键 icons/…', packedIcon.some((p) => /^icons\//.test(p)), packedIcon[0]);
  check('包里带上了图标资产', names.some((n) => n === packedIcon[0]));
  check('导出不含窗口位置', packedCfg.x === undefined && packedCfg.width === undefined);

  /* ---- 导入 .fcpc（先破坏现场再回填）---- */
  const cfgBroken = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
  cfgBroken.groups = [{ name: '空组', items: [] }];
  cfgBroken.theme = 'md3';
  fs.writeFileSync(CONF, JSON.stringify(cfgBroken, null, 2));
  nextOpen = FCPC;
  r = await wc.executeJavaScript(`API.importConfig()`);
  check('导入 fcpc 成功', r && r.success, r && r.error);
  const cfgBack = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
  check('分组已还原', (cfgBack.groups || []).length >= 1 && JSON.stringify(cfgBack.groups) === JSON.stringify(realCfg.groups) ? true : (cfgBack.groups || []).some((g) => (g.items || []).length > 0));
  let iconRestored = null;
  (cfgBack.groups || []).forEach((g) => (g.items || []).forEach((it) => { if (it.iconPath && /_packtest-icon/.test(it.iconPath)) iconRestored = it.iconPath; }));
  check('图标路径回填为 file:// 且文件存在', !!iconRestored && /^file:\/\//.test(iconRestored) && fs.existsSync(require('url').fileURLToPath(iconRestored)), iconRestored);
  check('机器相关字段没被包覆盖（autoLaunch 仍 false）', cfgBack.autoLaunch === false);

  /* ---- 导出 .fcpt ---- */
  nextOpen = null;
  r = await wc.executeJavaScript(`API.exportTheme()`);
  check('导出 fcpt 成功', r && r.success, r && r.error);
  entries = readZip(fs.readFileSync(FCPT));
  const names2 = entries.map((e) => e.name);
  check('fcpt 有 manifest/theme/README', names2.includes('manifest.json') && names2.includes('theme.json') && names2.some((n) => /README/.test(n)), names2.join(','));
  const scheme = JSON.parse(entries.find((e) => e.name === 'theme.json').data.toString('utf8'));
  check('方案里带主题名', scheme.theme === 'kitty', scheme.theme);
  const readme = entries.find((e) => /README/.test(e.name)).data.toString('utf8');
  check('README 人能读懂（含风格名）', /Hello Kitty|液态玻璃|明暗/.test(readme), readme.split(/\r?\n/)[2] || '');
  check('fcpt 不含快捷方式数据', !names2.includes('config.json'));

  /* ---- 导入 .fcpt ---- */
  const cfgMut = JSON.parse(fs.readFileSync(CONF, 'utf-8'));
  cfgMut.theme = 'glass';
  fs.writeFileSync(CONF, JSON.stringify(cfgMut, null, 2));
  nextOpen = FCPT;
  r = await wc.executeJavaScript(`API.importTheme()`);
  check('导入 fcpt 成功', r && r.success, r && r.error);
  check('主题被换回 kitty', JSON.parse(fs.readFileSync(CONF, 'utf-8')).theme === 'kitty');

  /* ---- 错包检测：拿 fcpt 冒充 fcpc ---- */
  nextOpen = FCPT;
  r = await wc.executeJavaScript(`API.importConfig()`);
  check('fcpt 塞进配置导入会被拒绝', r && !r.success && /主题/.test(r.error || ''), r && r.error);
  nextOpen = FCPC;
  r = await wc.executeJavaScript(`API.importTheme()`);
  check('fcpc 塞进主题导入会被拒绝', r && !r.success && /主题方案/.test(r.error || ''), r && r.error);

  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  setTimeout(() => app.exit(fail ? 1 : 0), 500);
});
