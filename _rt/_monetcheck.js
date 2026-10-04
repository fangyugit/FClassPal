/* Monet 取色的功能验证（临时脚本，不随包）
 * 用真 Electron 的 nativeImage 读合成壁纸，再从 main.js 里把真实函数抽出来执行，
 * 保证测的是主进程那份代码本身，不是复制品。
 * 跑法（必须去掉环境里的 ELECTRON_RUN_AS_NODE=1，否则 require('electron') 是字符串）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe _rt/_monetcheck.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const monet = require(path.join(ROOT, 'vendor', 'monet.js'));

/* ---------- 极简 PNG 编码器（只要能喂给 nativeImage 就够） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** rgba: Buffer(w*h*4, RGBA 顺序) */
function writePng(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  return file;
}

/* ---------- 从 main.js 抽出真实函数（避免测到复制品） ---------- */
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
function grab(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('main.js 里找不到：' + sig);
  if (src[i - 1] !== '\n' && i !== src.indexOf('const ' + sig.slice(6))) { /* 允许任意位置 */ }
  if (src[i] === 'f') {                       // function xxx(…) { … }
    let depth = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
    }
    throw new Error('括号没配对：' + sig);
  }
  return src.slice(i, src.indexOf('];', i) + 2);   // const XX = [ … ];
}
const MD3_ROLE_MAP = new Function('return ' + grab('const MD3_ROLE_MAP').replace('const MD3_ROLE_MAP = ', '').replace(/;\s*$/, ''))();
const mod = new Function(
  'nativeImage', 'monet', 'MD3_ROLE_MAP', 'MD3_BASELINE', 'MONET_MAX_DIM', 'MONET_CLUSTERS',
  [grab('function monetRoles'), grab('function monetSchemePalette'),
   grab('function monetSourceFromFile'), grab('function monetSourceFromHex'),
   'return { monetRoles, monetSchemePalette, monetSourceFromFile, monetSourceFromHex };'].join('\n')
)(nativeImage, monet, MD3_ROLE_MAP, '#6750a4', 72, 48);

/* ---------- 合成壁纸 ---------- */
function flat(w, h, r, g, b) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255; }
  return { w, h, buf };
}
const tmp = path.join(ROOT, '_rt', '_monet');
if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });

const cases = [
  ['橙色为主 + 少量蓝边', writePng(path.join(tmp, 'warm.png'), 240, 160, (() => {
    const im = flat(240, 160, 242, 97, 0);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 240; x++) { const i = (y * 240 + x) * 4; im.buf[i] = 30; im.buf[i + 1] = 90; im.buf[i + 2] = 200; }
    return im.buf;
  })())],
  ['纯蓝', writePng(path.join(tmp, 'blue.png'), 200, 200, flat(200, 200, 11, 87, 208).buf)],
  ['森林绿', writePng(path.join(tmp, 'green.png'), 200, 200, flat(200, 200, 30, 110, 60).buf)],
  ['中灰（应退基线）', writePng(path.join(tmp, 'grey.png'), 200, 200, flat(200, 200, 128, 128, 128).buf)],
  ['纯白（应退基线）', writePng(path.join(tmp, 'white.png'), 200, 200, flat(200, 200, 255, 255, 255).buf)]
];

let pass = 0, fail = 0;
function assert(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

app.whenReady().then(() => {
  console.log('[Monet 真实链路]');
  for (const [label, file] of cases) {
    const hct = mod.monetSourceFromFile(file);
    const p = hct ? mod.monetSchemePalette(hct, true) : null;
    if (!p) {
      const isAchromatic = /灰|白|灰白/.test(label);
      console.log(`  ${label}:  Monte 认为没有可用的彩色 source → 退回基线`);
      assert(label + ' 灰/白壁纸不产出 dynamic palette', isAchromatic);
      continue;
    }
    const hue = monet.Hct.fromInt(monet.argbFromHex(p.source)).hue.toFixed(1);
    console.log(`  ${label}: source=${p.source} hue=${hue} primary=${p.primary} container=${p.primaryContainer} onPrimaryContainer=${p.onPrimaryContainer}`);
    assert(label + ' 产出了 22 个以上角色且都是合法 hex',
      Object.keys(p).length >= 23 && Object.values(p).every((v) => typeof v !== 'string' || /^(#|true|false)/.test(v)));
    assert(label + ' primary 一定比 primaryContainer 深（tonal 层级正确）',
      monet.Hct.fromInt(monet.argbFromHex(p.primary)).tone < monet.Hct.fromInt(monet.argbFromHex(p.primaryContainer)).tone);
    assert(label + ' onPrimary 是白色（primary tone 40 配白字）',
      monet.Hct.fromInt(monet.argbFromHex(p.onPrimary)).tone > 90);
    assert(label + ' surface 是高亮浅色<｜hy_place▁holder▁no▁813｜>', monet.Hct.fromInt(monet.argbFromHex(p.surface)).tone > 95);
    assert(label + ' dynamic=true', p.dynamic === true);
  }

  console.log('[手动指定主色]');
  const manualHct = mod.monetSourceFromHex('#F26100');
  const mp = mod.monetSchemePalette(manualHct, false);
  assert('手动色 #F26100 能派生完整套装', !!mp && !!mp.primary && mp.dynamic === false);
  console.log('  #F26100 → primary=' + mp.primary + ' container=' + mp.primaryContainer + ' tertiary=' + mp.tertiary);

  const bad = mod.monetSourceFromHex('不是颜色');
  assert('非法 hex 不炸，返回 null', bad === null);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  app.exit(fail ? 1 : 0);
});
