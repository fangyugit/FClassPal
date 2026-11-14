/* ====== liquid glass 主题的透镜位移场（v2.6.5 新增，id = liquidglass）======
 *
 * 与旧「玻璃」主题的贴图（lg-displacement-map.js）是两种东西，别混：
 *
 *   旧贴图  liquid-glass-react 的预烘焙 256×256 图，R 只随 u、B 只随 v 线性变化，
 *           本质是"中心不动、越靠边位移越大"的**整体均匀缩放**场 —— 观感是整个
 *           背景被收缩到 0.855×，中心也在动，谈不上"只有边缘在折射"。
 *   这张场  按元素**真实像素尺寸**现算的圆角矩形 SDF 场：中心严格 0，位移只
 *           发生在离边框 BAND 像素以内的环带里，方向沿边框法线**指向内侧**。
 *           于是边缘一圈是"被压进去的背景"，中心一个像素都不动 —— 这才是
 *           苹果 NSGlassEffectView 那种"玻璃边框把背景折进来"的透镜感。
 *
 * 通道约定（滤镜 #liquidGlass2 按这个读，改一个必须改另一个）：
 *   R  位移场 X：128 = 不位移，128±127 映射到 ±(amp) 像素（滤镜 scale = 2*amp）
 *   G  位移场 Y：同上
 *   B  边缘遮罩：0 = 环带外（保留原图），255 = 贴上折射带
 *   A  恒 255 —— **必须是 255**。SVG 滤镜工作在预乘色空间里，若用 alpha 当遮罩
 *      （liquid-glass-react 的原始写法就是把遮罩做在 alpha 上），中心 alpha→0 会
 *      把 R/G 一起乘成 0，位移量直接变成 -0.5*scale，整块背景被平移出去。
 *      v2.6.5 之前旧滤镜的"中心保持干净"这一段其实是空操作，根因就在这里。
 *
 * 为什么方向取**内侧**而不是外侧：位移是"取源坐标"的偏移量，朝外意味着边框内侧
 * 几个像素要去采样玻璃外面的像素（那里没有内容）→ 边框一圈透明。朝内则永远在
 * 自己的盒子里采样，任何尺寸、任何圆角都安全。视觉上两者都是"边框把背景折了一道"。
 */
(function (root) {
  'use strict';

  /* 默认参数（app.js 调 field 时可以不传，改这里就全站生效）
   * BAND 环带宽度：超过它就没有折射。22px 在 300~900px 的窗口上都还算"边框"，
   *   再宽就从"玻璃边"变成"玻璃中间糊了一圈"。
   * AMP 最大位移：环带正中间的那一圈位移最大，两端归零（sin 曲线），所以边框
   *   最外一行与环带内边界都是连续的，不会出现接缝。 */
  var BAND = 22;
  var AMP = 15;
  /* 贴图采样上限：位移场是缓变的，480 已经够细；再大只是白烧 CPU。
   * 低于 24 会让极窄窗口（拉到底只有几十像素）贴图比内容还粗。 */
  var MAX_TEX = 480;
  var MIN_TEX = 24;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* 圆角矩形有符号距离场：内部为负、边界为 0、外部为正。 */
  function sdRoundRect(x, y, w, h, r) {
    var hw = w / 2;
    var hh = h / 2;
    var qx = Math.abs(x - hw) - (hw - r);
    var qy = Math.abs(y - hh) - (hh - r);
    var ax = qx > 0 ? qx : 0;
    var ay = qy > 0 ? qy : 0;
    var m = qx > qy ? qx : qy;
    return Math.sqrt(ax * ax + ay * ay) + (m < 0 ? m : 0) - r;
  }

  /**
   * 生成位移场。
   * @param {number} w 元素 CSS 宽度（px）
   * @param {number} h 元素 CSS 高度（px）
   * @param {number} radius 圆角半径（px）
   * @param {object} [opts] {band, amp, maxTex}
   * @returns {{width:number,height:number,data:Uint8ClampedArray,band:number,amp:number}}
   */
  function field(w, h, radius, opts) {
    var o = opts || {};
    w = Math.max(1, Math.round(w || 1));
    h = Math.max(1, Math.round(h || 1));
    var band = o.band > 0 ? o.band : BAND;
    var amp = o.amp > 0 ? o.amp : AMP;
    var maxTex = o.maxTex || MAX_TEX;

    /* 贴图长宽比 = 元素长宽比（滤镜里 feImage 用 preserveAspectRatio="none"
     * 铺满整个盒子），否则环带在宽扁窗口上会被横向拉长。 */
    var scale = Math.min(1, maxTex / Math.max(w, h));
    var tw = Math.max(MIN_TEX, Math.round(w * scale));
    var th = Math.max(MIN_TEX, Math.round(h * scale));

    /* 圆角不可能超过短边的一半；超过就按胶囊算（border-radius:999px 的情况）。 */
    var r = clamp(radius || 0, 0, Math.min(w, h) / 2);
    /* 边框附近的 SDF 在圆角处是斜的，数值求梯度要用小步长。0.5px 足够稳。 */
    var e = 0.5;

    var data = new Uint8ClampedArray(tw * th * 4);
    for (var j = 0; j < th; j++) {
      var y = ((j + 0.5) / th) * h;
      for (var i = 0; i < tw; i++) {
        var x = ((i + 0.5) / tw) * w;
        var k = (j * tw + i) * 4;
        /* 到边框的距离：SDF 内部为负，取反就是"离边框多远"，边框上 = 0 */
        var d = -sdRoundRect(x, y, w, h, r);
        var t = 1 - d / band;
        if (t <= 0) {
          /* 环带之外：零位移 + 零遮罩 = 完全不参与折射 */
          data[k] = 128; data[k + 1] = 128; data[k + 2] = 0; data[k + 3] = 255;
          continue;
        }
        if (t > 1) t = 1;
        /* sin 曲线：环带内边界 t=0 与边框 t=1 两端位移都归零，中间最大 */
        var wave = Math.sin(Math.PI * t);
        /* 边框外侧 1px 硬归零（3px 内渐入）。通道是 8 位的，128 这个"零位"其实
         * 对应 +0.06px 的常数偏置（scale/255 的量化误差）；最外一行像素带着这点
         * 偏置去采样就会落到盒子外面，被当成透明 → 边框一圈浅色发丝。留 1px 死区
         * 之后，最外一行位移严格为 0，这点偏置只作用在盒子内部，看不见。 */
        var dead = d < 1 ? 0 : d < 3 ? (d - 1) / 2 : 1;
        wave *= dead;
        /* SDF 梯度指向外侧，取负得到**内侧**法线 */
        var gx = sdRoundRect(x + e, y, w, h, r) - sdRoundRect(x - e, y, w, h, r);
        var gy = sdRoundRect(x, y + e, w, h, r) - sdRoundRect(x, y - e, w, h, r);
        var gl = Math.sqrt(gx * gx + gy * gy) || 1;
        var nx = -gx / gl;
        var ny = -gy / gl;
        /* 通道 = 0.5 + 方向 * wave/2 → 滤镜 scale 取 2*amp 时正好是 方向*amp*wave 像素 */
        data[k] = 128 + 127 * nx * wave;
        data[k + 1] = 128 + 127 * ny * wave;
        data[k + 2] = 255 * t;
        data[k + 3] = 255;
      }
    }
    return { width: tw, height: th, data: data, band: band, amp: amp };
  }

  /** 把位移场编码成 PNG data URL（走 canvas，浏览器里才有）。 */
  function toDataURL(f) {
    if (typeof document === 'undefined' || !document.createElement) return '';
    var cv = document.createElement('canvas');
    cv.width = f.width;
    cv.height = f.height;
    var ctx = cv.getContext('2d');
    if (!ctx) return '';
    var img = ctx.createImageData(f.width, f.height);
    img.data.set(f.data);
    ctx.putImageData(img, 0, 0);
    try {
      return cv.toDataURL('image/png');
    } catch (err) {
      return '';                 /* 被 CSP / 隐私模式挡住就当不支持 */
    }
  }

  root.LG2_LENS = {
    field: field,
    toDataURL: toDataURL,
    BAND: BAND,
    AMP: AMP
  };
})(typeof window !== 'undefined' ? window : globalThis);
