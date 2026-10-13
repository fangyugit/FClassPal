/* 探针沙箱 —— `_rt/` 下所有会写配置的验证探针都从这里取路径。
 *
 * 起因（真事故，v2.5.0）：`_iconcheck.js` 等探针直接往用户真实配置目录
 * `~/.desktop-widget/config.json` 里写测试快捷方式，靠 `app.on('will-quit')`
 * 还原；探针进程被强杀（超时杀掉 / 会话结束）时还原根本不会跑 ——
 * 用户的真实配置就被 "测试分组 / C:/x" 这种测试数据永久覆盖了。
 *
 * 现在的规则：
 *   ① 探针只用 `_rt/_sandbox/cfg`，不设例外；
 *   ② main.js 见到 entry 落在 `_rt/` 下会自动把配置根目录重定向到沙箱，
 *      探针自己忘了改也逃不掉（见 main.js 顶部 IS_PROBE）；
 *   ③ 首次运行用真实配置"读一份"当模板种进沙箱，保证 fixture 字段完整 ——
 *      **只读**真实文件，绝不回写。
 *
 * 用法（在 `require('../main.js')` 之前）：
 *   const SB = require('./_sandbox');
 *   SB.seed(Object.assign({}, SB.realConfig(), { theme: 'glass' }));
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const REAL_DIR = path.join(os.homedir(), '.desktop-widget');
const DIR = path.join(__dirname, '_sandbox', 'cfg');

if (path.resolve(DIR) === path.resolve(REAL_DIR)) {
  throw new Error('沙箱目录不能等于真实用户目录：' + DIR);
}
// 让 main.js 用沙箱（它也会自己兜底，这里显式给一份，行为更直白）
process.env.FCP_CONFIG_DIR = DIR;

const CONF = path.join(DIR, 'config.json');
const ICONS = path.join(DIR, 'icons');

function ensure() {
  fs.mkdirSync(ICONS, { recursive: true });
  if (!fs.existsSync(CONF)) {
    fs.writeFileSync(CONF, JSON.stringify(realConfig(), null, 2));
  }
}

/** 读真实配置当模板（**只读**，读不到就返回空对象）。 */
function realConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'config.json'), 'utf-8')); }
  catch (e) { return {}; }
}

/** 把 fixture 落进沙箱 —— 这是探针唯一允许写配置的入口。 */
function seed(cfg) {
  fs.mkdirSync(ICONS, { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2));
}

/** 清空沙箱配置，下一次读会重新用真实配置种一份。 */
function reset() {
  try { fs.unlinkSync(CONF); } catch (e) { /* 本来就不在 */ }
}

ensure();

module.exports = { DIR, CONF, ICONS, REAL_DIR, realConfig, seed, reset, ensure };
