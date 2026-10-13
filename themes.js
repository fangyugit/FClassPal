/* ---------- 主题包引擎（v2.5.0）----------
 * 本体只带五套内置主题（glass / md3 / fluent / miuix / harmony），
 * 其余角色主题一律以 .fcpt 主题包形式分发，用户导入后落在
 * `~/.desktop-widget/themes/<id>/`，启动时由主进程读出来注入渲染层。
 *
 * .fcpt 结构（规范见 FClassPal-theme 仓库 SPEC.md）：
 *   manifest.json   元数据（id/name/version/author/accent/fixedPalette…）
 *   theme.css       全套 `body.theme-<id> { … }` 规则；素材写 url("assets/xxx.png")
 *   assets/*.png    贴纸素材
 *
 * 三条安全底线（导入的是别人给的 zip，不能盲信）：
 *   ① 目录项名不许出现绝对路径 / `..`（zip slip）；
 *   ② id 必须 `[a-z][a-z0-9-]{1,23}` 且不能占用内置 id；
 *   ③ theme.css 里必须真的出现 `body.theme-<id>`，否则视为无效包。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readZip } = require('./pack');

const SPEC_VERSION = 1;
const ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
const MAX_BYTES = 24 * 1024 * 1024;   // 单个包上限 24MB
const MAX_ENTRIES = 400;

/* 内置五套：名字与推荐主色是本体唯一事实源，渲染层从 listThemes 拿 */
const BUILTIN = [
  { id: 'glass', name: '液态玻璃', accent: '#6750A4', fixedPalette: false,
    desc: '基线皮肤：真实壁纸透出 + 液态玻璃高光。' },
  { id: 'md3', name: 'MD3', accent: '#6750A4', fixedPalette: false,
    desc: 'Material Design 3 / Material You，跟随壁纸取色。' },
  { id: 'fluent', name: 'Fluent', accent: '#0B57D0', fixedPalette: false,
    desc: 'Windows 11 Fluent 亚克力质感，跟随壁纸取色。' },
  { id: 'miuix', name: 'MIUI', accent: '#3482FF', fixedPalette: true,
    desc: '小米 HyperOS / compose-miuix-ui 规范浅色方案。' },
  { id: 'harmony', name: '鸿蒙', accent: '#0A59F7', fixedPalette: true,
    desc: 'HarmonyOS 品牌蓝，圆角与控件沿用系统语言。' },
];
const BUILTIN_IDS = BUILTIN.map((t) => t.id);

function fail(msg) {
  const e = new Error(msg);
  e.themePackError = true;
  return e;
}

function themesDir(configDir) {
  return path.join(configDir, 'themes');
}

function normalizeManifest(raw, dir) {
  const id = String(raw.id || '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw fail('主题 id 不合法（只允许小写字母、数字、连字符，2-24 位）：' + (raw.id || '空'));
  if (BUILTIN_IDS.indexOf(id) >= 0) throw fail('id「' + id + '」是本体内置主题，主题包不能占用');
  const name = String(raw.name || id).trim().slice(0, 40);
  return {
    id,
    name,
    version: String(raw.version || '1.0.0').trim().slice(0, 20),
    author: String(raw.author || '未署名').trim().slice(0, 40),
    desc: String(raw.description || raw.desc || '').trim().slice(0, 200),
    accent: /^#[0-9a-fA-F]{6}$/.test(String(raw.accent || '')) ? String(raw.accent) : '',
    fixedPalette: raw.fixedPalette !== false,
    spec: parseInt(raw.spec, 10) || SPEC_VERSION,
    minApp: String(raw.minApp || '').trim().slice(0, 20),
    dir,
  };
}

/** 扫描已安装主题；损坏的包不静默吞掉，标 broken + 原因给 UI 显示 */
function scanInstalled(configDir) {
  const root = themesDir(configDir);
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const mf = path.join(dir, 'manifest.json');
      const css = path.join(dir, 'theme.css');
      if (!fs.existsSync(mf) || !fs.existsSync(css)) {
        out.push({ id: name, name, broken: '缺少 manifest.json 或 theme.css', dir });
        continue;
      }
      const t = normalizeManifest(JSON.parse(fs.readFileSync(mf, 'utf8')), dir);
      t.builtin = false;
      out.push(t);
    } catch (e) {
      out.push({ id: name, name, broken: (e && e.message) || '读取失败', dir });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** 包内 CSS 交出来之前，把 url("assets/x.png") 改成绝对 file:/// 路径。
 *  渲染层是注入 <style>，相对路径会按 index.html 解析 —— 必须改写。 */
function cssFor(themeDir, id) {
  const p = path.join(themeDir, 'theme.css');
  if (!fs.existsSync(p)) throw fail('主题包缺少 theme.css');
  let css = fs.readFileSync(p, 'utf8');
  css = css.replace(/url\(\s*(['"]?)assets\/([^'")]+)\1\s*\)/g, (m, q, rel) => {
    const abs = path.resolve(themeDir, 'assets', rel);
    if (!abs.startsWith(path.resolve(themeDir))) return 'none';
    if (!fs.existsSync(abs)) return 'none';
    return 'url("' + pathToFileURL(abs).href + '")';
  });
  return css;
}

/** 列出随包附带的离线主题包（安装目录 themes/ 下的 .fcpt） */
function listBundled(bundledDir, installedIds) {
  const out = [];
  if (!bundledDir || !fs.existsSync(bundledDir)) return out;
  for (const f of fs.readdirSync(bundledDir)) {
    if (!f.toLowerCase().endsWith('.fcpt')) continue;
    const full = path.join(bundledDir, f);
    const item = { file: full, name: f.replace(/\.fcpt$/i, ''), installed: false, id: '', desc: '' };
    try {
      const buf = fs.readFileSync(full);
      const byName = entriesToMap(readZip(buf));
      const raw = JSON.parse(byName['manifest.json'].toString('utf8'));
      item.id = String(raw.id || '').toLowerCase();
      item.name = String(raw.name || item.name);
      item.desc = String(raw.description || raw.desc || '').slice(0, 80);
      item.installed = installedIds.indexOf(item.id) >= 0;
    } catch (e) {
      item.broken = (e && e.message) || '包损坏';
    }
    out.push(item);
  }
  return out;
}

function entriesToMap(entries) {
  const m = {};
  entries.forEach((e) => { m[e.name] = e.data; });
  return m;
}

/** 从 zip 缓冲装到 themes/<id>/；已存在则先移除（覆盖安装） */
function installFromBuffer(configDir, buf) {
  if (buf.length > MAX_BYTES) throw fail('主题包太大（上限 24MB）');
  let entries;
  try {
    entries = readZip(buf);
  } catch (e) {
    throw fail('不是有效的主题包（zip 解析失败）：' + e.message);
  }
  if (entries.length > MAX_ENTRIES) throw fail('主题包内文件过多（上限 400）');
  const byName = entriesToMap(entries);
  const rawMf = byName['manifest.json'];
  const rawCss = byName['theme.css'];
  if (!rawMf) throw fail('包里没有 manifest.json，不是主题包');
  if (!rawCss) throw fail('包里没有 theme.css，不是主题包');
  let mfRaw;
  try {
    mfRaw = JSON.parse(rawMf.toString('utf8'));
  } catch (e) {
    throw fail('manifest.json 不是合法 JSON');
  }
  const dest = path.join(themesDir(configDir), String(mfRaw.id || '').toLowerCase());
  const t = normalizeManifest(mfRaw, dest);
  if (!new RegExp('body\\.theme-' + t.id + '\\b').test(rawCss.toString('utf8'))) {
    throw fail('theme.css 里没有 body.theme-' + t.id + ' 规则，选择器必须带主题 id');
  }

  /* ★ 先把目录项名全部校验完，再落一个字节：以前是"边建目录边写"，
   * 撞到非法条目（zip slip）时已经 mkdir 出了 <id>/，于是 themes/ 里留下一个
   * 空壳目录 —— scanInstalled 会把它当成"读不出来的主题包"，用户在主题管理里
   * 看到的是一个查不出原因的幽灵卡片。 */
  const rootAbs = path.resolve(dest);
  const planned = [];
  for (const e of entries) {
    const name = String(e.name).replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').indexOf('..') >= 0) {
      throw fail('主题包里有非法路径：' + e.name);
    }
    if (name.endsWith('/')) continue;
    const target = path.resolve(dest, name);
    if (!target.startsWith(rootAbs + path.sep)) throw fail('主题包路径越界：' + e.name);
    planned.push({ target, data: e.data });
  }

  const existed = fs.existsSync(dest);
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const p of planned) {
      fs.mkdirSync(path.dirname(p.target), { recursive: true });
      fs.writeFileSync(p.target, p.data);
    }
  } catch (e) {
    // 覆盖安装失败时不要把用户原来那套也删掉，只有新建的才清理
    if (!existed) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e2) { /* 清不掉就留给 UI 标 broken */ } }
    throw fail('主题包写入失败：' + ((e && e.message) || e));
  }
  // 生效前再核一遍，避免装完才发现不能读
  const finalManifest = normalizeManifest(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')), dest);
  finalManifest.builtin = false;
  return finalManifest;
}

function removeTheme(configDir, id) {
  if (BUILTIN_IDS.indexOf(id) >= 0) throw fail('内置主题不能删除');
  if (!ID_RE.test(id)) throw fail('主题 id 不合法');
  const dir = path.join(themesDir(configDir), id);
  const rootAbs = path.resolve(themesDir(configDir));
  if (!path.resolve(dir).startsWith(rootAbs + path.sep)) throw fail('路径越界');
  if (!fs.existsSync(dir)) throw fail('主题没安装：' + id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { success: true, id };
}

/** 主题顺序：内置在前（按 config.themeOrder 排），未列入的一律补在后面 */
function orderedIds(configOrder, installedIds) {
  const all = scopeOrder(configOrder, installedIds);
  return all;
}

function scopeOrder(configOrder, installedIds) {
  const known = BUILTIN_IDS.concat(installedIds);
  const seen = [];
  const src = Array.isArray(configOrder) ? configOrder : [];
  src.forEach((id) => {
    if (known.indexOf(id) >= 0 && seen.indexOf(id) < 0) seen.push(id);
  });
  known.forEach((id) => { if (seen.indexOf(id) < 0) seen.push(id); });
  return seen;
}

module.exports = {
  SPEC_VERSION, BUILTIN, BUILTIN_IDS, ID_RE,
  themesDir, scanInstalled, cssFor, listBundled, installFromBuffer, removeTheme, orderedIds,
};
