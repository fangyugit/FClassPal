/* 由 _check.js 生成源码版的 _check_src.js。
 *
 * 为什么需要它：`_check.js` 是从 **打包产物**（app.asar）里读文件的"打包层"检查，
 * 新断言必须在**构建之前**就能预跑一遍，否则要等 1~2 分钟的打包 + 修断言 + 再打包。
 * 源码版只把「读文件的方式」换掉，断言逻辑一字不改。
 *
 * 用法：
 *   node _mksrccheck.js && node _check_src.js
 *
 * 三处替换：
 *   1. extractFile(asar, 'x')            → fs.readFileSync('x','utf-8')
 *   2. 'renderer\\theme\\kitty\\' + f    → 'renderer/theme/kitty/' + f
 *      ★ asar 的 extractFile 对**多级子目录只认反斜杠**（正斜杠会报 not found），
 *        所以 _check.js 里这类路径是反斜杠写的；源码版要换回正斜杠。
 *   3. 删掉只给 asar 用的 asar 常量与 require。
 *
 * 注意：源码版与打包版**计数不完全可比**。「产物: 便携 exe 已生成」这类断言在
 * 构建前必然是红的（还算正常），而依赖 asar 目录列举的断言在源码版无从校验 ——
 * 判断标准是"除这些之外全绿"。
 */
const fs = require('fs');

let s = fs.readFileSync('_check.js', 'utf8');
const src = s;

s = s.replace(/extractFile\(asar,\s*'([^']+)'\)/g, (m, p) => "fs.readFileSync('" + p + "','utf-8')");
/* 拼串形式（主题贴图逐个读）：extractFile(asar, 'renderer\\theme\\kitty\\' + f)
 * ★ 注意顺序：这条必须能处理「引号后面还跟着 + f」的形态，
 *   上面那条 `'([^']+)'\)` 要求引号后紧跟右括号，对拼串形式根本不匹配。
 *   早先漏了这条，源码版就一直在报四项贴图资产失败（看着像产品问题，其实是改写没做全）。 */
s = s.replace(/extractFile\(asar,\s*'((?:[^'\\]|\\\\)+)'\s*\+\s*([A-Za-z_$][\w$]*)\)/g,
  (m, p, v) => "fs.readFileSync('" + p.replace(/\\\\/g, '/') + "' + " + v + ",'utf-8')");
// 剩余（单级目录）的反斜杠也统一换成正斜杠
s = s.replace(/fs\.readFileSync\('((?:[^'\\]|\\\\)+)','utf-8'\)/g, (m, p) =>
  "fs.readFileSync('" + p.replace(/\\\\/g, '/') + "','utf-8')");
s = s.replace(/^const asar = path\.join\([^\n]*\n/m, '');
s = s.replace(/^const \{ extractFile \} = require\('@electron\/asar'\);\n/m, '');
s += '\n// ── 本文件由 _mksrccheck.js 从 _check.js 自动生成，请勿手工编辑 ──\n';

fs.writeFileSync('_check_src.js', s);
const n = (src.match(/extractFile\(asar/g) || []).length;
console.log('已生成 _check_src.js（替换 ' + n + ' 处文件读取）');
