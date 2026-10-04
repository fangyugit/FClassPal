/**
 * @license Apache-2.0, © 2021 Google LLC — 见文末 LICENSE 段落
 * material-color-utilities 入口：只导出管家助手用到的那几个符号，
 * 由 esbuild 打成单个 CommonJS 文件，避免在 asar 里走 ESM 动态 import
 * （asar 不支持 ESM 解析，import() 会失败）。
 */
export {
  QuantizerCelebi,
  Score,
  Hct,
  TonalPalette,
  MaterialDynamicColors,
  SchemeContent,
  SchemeTonalSpot,
  SchemeVibrant,
  SchemeNeutral,
  SchemeExpressive,
  argbFromRgb,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities';
