/* 生成托盘图标 PNG（32x32），输出 base64，供 main.js 内嵌使用。
 * 设计：蓝色圆角方块 + 白色 3x3 圆点网格（应用格子意象） */
const zlib = require('zlib');
const fs = require('fs');

const W = 32, H = 32;

// ---- CRC32 ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

// ---- 像素绘制 ----
const px = Buffer.alloc(W * H * 4, 0); // RGBA, 全透明
function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

const BG = [47, 107, 255];   // #2f6bff
const DOT = [255, 255, 255];

// 圆角矩形背景（半径 7）
const RAD = 7;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let inside;
    const cx = Math.min(Math.max(x, RAD), W - 1 - RAD);
    const cy = Math.min(Math.max(y, RAD), H - 1 - RAD);
    const dx = x - cx, dy = y - cy;
    inside = dx * dx + dy * dy <= RAD * RAD;
    // 主体区域直接判定
    if (x >= RAD && x <= W - 1 - RAD) inside = true;
    else if (y >= RAD && y <= H - 1 - RAD) inside = true;
    if (inside) setPx(x, y, BG[0], BG[1], BG[2], 255);
  }
}

// 3x3 圆点网格（半径 2.2），圆心间隔 8，起始偏移 8
const DOT_R = 2.2;
for (let gy = 0; gy < 3; gy++) {
  for (let gx = 0; gx < 3; gx++) {
    const ox = 8 + gx * 8;
    const oy = 8 + gy * 8;
    for (let y = Math.floor(oy - DOT_R); y <= Math.ceil(oy + DOT_R); y++) {
      for (let x = Math.floor(ox - DOT_R); x <= Math.ceil(ox + DOT_R); x++) {
        const d = Math.sqrt((x + 0.5 - ox) ** 2 + (y + 0.5 - oy) ** 2);
        if (d <= DOT_R) setPx(x, y, DOT[0], DOT[1], DOT[2], 255);
      }
    }
  }
}

// ---- 组装 PNG ----
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

// 每行前置 filter byte 0
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const b64 = png.toString('base64');
fs.writeFileSync('_tray_icon.b64', b64);
console.log('PNG 字节数:', png.length);
console.log('base64 长度:', b64.length);
