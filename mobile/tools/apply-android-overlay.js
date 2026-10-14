#!/usr/bin/env node
/* ============================================================================
 * FClassPal 安卓壳 · 原生工程定制（把 android-overlay/ 应用到 android/）
 *
 * android/ 由 `npx cap add android` 生成，是模板的样子（蓝色启动图、版本号 1.0、
 * 没有 PalBridge 插件）。本脚本把 mobile/android-overlay/ 里准备好的文件盖上去，
 * 再做三件模板改不出来的事：
 *   ① versionName / versionCode 从 ../package.json 同步（单一版本源）
 *   ② 删掉模板自带的 ExampleUnitTest / ExampleInstrumentedTest
 *      （它们断言包名是 com.getcapacitor.app，跑测试必红，而且不是我们的代码）
 *   ③ 打印改动清单，让人能一眼核对
 *
 * 幂等：跑多少次结果都一样；`npx cap add android` 重新生成后再跑一次即可复原全部定制。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'android-overlay');
const DST = path.join(ROOT, 'android');

function log(m) { process.stdout.write('[overlay] ' + m + '\n'); }
function die(m) { process.stderr.write('[overlay] 失败：' + m + '\n'); process.exit(1); }

function copyTree(from, to) {
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) n += copyTree(s, d);
    else if (entry.isFile()) { fs.copyFileSync(s, d); n += 1; }
  }
  return n;
}

function main() {
  if (!fs.existsSync(path.join(DST, 'app', 'build.gradle'))) {
    die('android/ 还没生成，先跑：npx cap add android');
  }

  // ① 盖上定制文件（Java 插件 / 清单 / 主题 / 图标 / 颜色）
  const n = copyTree(SRC, DST);
  log('应用 overlay：' + n + ' 个文件');

  // ② 版本号从 package.json 同步（versionCode = major*10000 + minor*100 + patch）
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'package.json'), 'utf8'));
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version || '');
  if (!m) die('package.json 的 version 不是 x.y.z 形式：' + pkg.version);
  const code = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  const gradlePath = path.join(DST, 'app', 'build.gradle');
  let g = fs.readFileSync(gradlePath, 'utf8');
  const before = g;
  g = g.replace(/versionCode\s+\d+/, 'versionCode ' + code);
  g = g.replace(/versionName\s+"[^"]*"/, 'versionName "' + pkg.version + '"');
  if (!/versionCode\s+\d+/.test(g) || !/versionName\s+"[^"]*"/.test(g)) {
    die('app/build.gradle 里找不到 versionCode / versionName');
  }
  if (g !== before) fs.writeFileSync(gradlePath, g);
  log('版本号：versionCode=' + code + ' versionName=' + pkg.version);

  // ②b release 签名（v2.4.6）：../../_signing/signing.properties 存在才注入。
  //    密钥和密码都在 gitignore 的 _signing/ 里，公开仓库永远看不到；
  //    文件不存在（CI / 别的机器）就跳过，build 出未签名 release，不影响构建。
  const signMarker = 'fclasspal-signing';
  const signPropsPath = path.join(ROOT, '..', '_signing', 'signing.properties');
  if (fs.existsSync(signPropsPath) && !g.includes(signMarker)) {
    let g2 = fs.readFileSync(gradlePath, 'utf8');
    g2 += `\n// >>> ${signMarker}（apply-android-overlay.js 注入，勿手改）\n` +
      `// 密钥信息在 _signing/signing.properties（gitignore），没有这个文件就保持未签名。\n` +
      `def fcpSignFile = rootProject.file('../../_signing/signing.properties')\n` +
      `if (fcpSignFile.exists()) {\n` +
      `    def fcpSignProps = new Properties()\n` +
      `    fcpSignProps.load(new FileInputStream(fcpSignFile))\n` +
      `    android {\n` +
      `        signingConfigs {\n` +
      `            release {\n` +
      `                storeFile new File(fcpSignFile.getParentFile(), fcpSignProps['storeFile'])\n` +
      `                storePassword fcpSignProps['storePassword']\n` +
      `                keyAlias fcpSignProps['keyAlias']\n` +
      `                keyPassword fcpSignProps['keyPassword']\n` +
      `            }\n` +
      `        }\n` +
      `        buildTypes {\n` +
      `            release {\n` +
      `                signingConfig signingConfigs.release\n` +
      `            }\n` +
      `        }\n` +
      `    }\n` +
      `}\n`;
    fs.writeFileSync(gradlePath, g2);
    log('release 签名：已注入（' + path.relative(ROOT, signPropsPath) + '）');
  } else if (!fs.existsSync(signPropsPath)) {
    log('release 签名：未配置（找不到 _signing/signing.properties），release 包将未签名');
  }

  // ③ 删模板示例测试（断言的是 Capacitor 自己的包名，留着必红）
  const junk = [
    path.join(DST, 'app', 'src', 'test', 'java', 'com', 'getcapacitor', 'myapp'),
    path.join(DST, 'app', 'src', 'androidTest', 'java', 'com', 'getcapacitor', 'myapp')
  ];
  junk.forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else fs.unlinkSync(p);
      }
      fs.rmdirSync(d);
    };
    walk(dir);
    log('删除模板示例测试：' + path.relative(DST, dir));
  });

  log('完成。下一步：node tools/build-apk.js debug');
}

main();
