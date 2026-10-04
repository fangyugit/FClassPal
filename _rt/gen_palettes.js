/* 用出货的 vendor/monet.js（CJS bundle）在纯 Node 下生成真实调色板，
 * 供浏览器探针使用——这样探针里跑的是真算法输出，而不是手编的假色值。 */
const fs = require('fs');
const path = require('path');
const monet = require(path.join(__dirname, '..', 'vendor', 'monet.js'));

const ROLES = [
  ['primary', 'primary'], ['onPrimary', 'onPrimary'],
  ['primaryContainer', 'primaryContainer'], ['onPrimaryContainer', 'onPrimaryContainer'],
  ['secondary', 'secondary'], ['onSecondary', 'onSecondary'],
  ['secondaryContainer', 'secondaryContainer'], ['onSecondaryContainer', 'onSecondaryContainer'],
  ['tertiary', 'tertiary'], ['onTertiary', 'onTertiary'],
  ['tertiaryContainer', 'tertiaryContainer'], ['onTertiaryContainer', 'onTertiaryContainer'],
  ['surface', 'surface'], ['surfaceDim', 'surfaceDim'],
  ['surfaceContainer', 'surfaceContainer'], ['surfaceContainerHigh', 'surfaceContainerHigh'],
  ['onSurface', 'onSurface'], ['onSurfaceVariant', 'onSurfaceVariant'],
  ['outline', 'outline'], ['outlineVariant', 'outlineVariant'],
  ['error', 'error'], ['onError', 'onError']
];

function palette(hex) {
  const hct = monet.Hct.fromInt(monet.argbFromHex(hex));
  const scheme = new monet.SchemeTonalSpot(hct, false, 0);
  const mdc = new monet.MaterialDynamicColors();
  const out = {};
  ROLES.forEach(([key, method]) => { out[key] = monet.hexFromArgb(mdc[method]().getArgb(scheme)); });
  out.dynamic = false;
  out.source = monet.hexFromArgb(hct.toInt());
  return out;
}

const colors = ['#6750A4', '#0B57D0', '#00696E', '#3F7D4E', '#F26100', '#C2185B', '#7D5260', '#4A6572', '#F2A0BE'];
const out = {};
colors.forEach((c) => { out[c] = palette(c); });
fs.writeFileSync(path.join(__dirname, 'palettes.json'), JSON.stringify(out, null, 2));
console.log('colors:', colors.length);
console.log('#6750A4 primary =', out['#6750A4'].primary, '| surface =', out['#6750A4'].surface);
console.log('#F2A0BE primary =', out['#F2A0BE'].primary, '| surface =', out['#F2A0BE'].surface);
