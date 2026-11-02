#!/usr/bin/env node
/* ============================================================================
 * FClassPal · WearOS APK 构建（v2.6.4）
 *
 * 与 mobile/tools/build-apk.js 同套路（找 JDK/SDK → 跑 gradlew → 收产物），
 * 但目标工程是 wearos/（纯原生 Java，无 Capacitor、无 WebView）。
 *
 * 用法：
 *   node mobile/tools/build-wear.js release      # 出 dist/FClassPal-<ver>-wearos.apk
 *   node mobile/tools/build-wear.js debug        # 出 debug 包（自己装来试）
 *
 * 注意：
 *   · 版本号只认 **wearos/app/build.gradle**（手表是独立 App，版本跟桌面同号，
 *     versionCode = major*10000+minor*100+patch，与手机壳规则一致）；
 *   · 绝不在本机弹任何窗口 —— gradle 全程命令行；
 *   · 依赖为零，所以第一次构建也只需 AGP（本机 gradle 缓存里已有）。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WEAR = path.join(ROOT, 'wearos');
const DIST = path.join(ROOT, 'dist');

function log(m) { process.stdout.write('[wear] ' + m + '\n'); }
function die(m) { process.stderr.write('[wear] 失败：' + m + '\n'); process.exit(1); }

function findJdk() {
  const env = process.env.JAVA_HOME;
  if (env && fs.existsSync(path.join(env, 'bin', 'java.exe'))) return env;
  if (env && fs.existsSync(path.join(env, 'bin', 'java'))) return env;
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', 'android-toolchain');
  if (!fs.existsSync(base)) return null;
  /* 优先 17：AGP 8.x 官方推荐；21 也能跑，但 17 更稳 */
  const cands = fs.readdirSync(base).filter((d) => /^jdk-?(17|21)/.test(d)).sort();
  for (const d of cands) {
    const p = path.join(base, d);
    if (fs.existsSync(path.join(p, 'bin', 'java.exe')) || fs.existsSync(path.join(p, 'bin', 'java'))) return p;
  }
  return null;
}

function findSdk() {
  if (process.env.ANDROID_HOME && fs.existsSync(process.env.ANDROID_HOME)) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT && fs.existsSync(process.env.ANDROID_SDK_ROOT)) return process.env.ANDROID_SDK_ROOT;
  const p = path.join(process.env.USERPROFILE || process.env.HOME || '', 'android-toolchain', 'sdk');
  return fs.existsSync(p) ? p : null;
}

function version() {
  const g = fs.readFileSync(path.join(WEAR, 'app', 'build.gradle'), 'utf8');
  const m = /versionName\s+'([^']+)'/.exec(g);
  return m ? m[1] : '0.0.0';
}

function main() {
  const mode = (process.argv[2] || 'release').toLowerCase();
  const jdk = findJdk();
  const sdk = findSdk();
  if (!jdk) die('找不到 JDK 17/21（设 JAVA_HOME，或放到 %USERPROFILE%\\android-toolchain\\jdk-17*）');
  if (!sdk) die('找不到 Android SDK（设 ANDROID_HOME，或放到 %USERPROFILE%\\android-toolchain\\sdk）');
  log('JAVA_HOME=' + jdk);
  log('ANDROID_HOME=' + sdk);

  const isWin = process.platform === 'win32';
  const gradlew = path.join(WEAR, isWin ? 'gradlew.bat' : 'gradlew');
  const task = mode === 'debug' ? 'assembleDebug' : 'assembleRelease';

  const env = Object.assign({}, process.env, {
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    /* ★ 必须置空：本机装了 safe-delete 垫片，经 NODE_OPTIONS 注入到所有 node 进程，
     *   gradle 的 node 子进程会被它带崩（一秒静默退出）。 */
    NODE_OPTIONS: ''
  });
  delete env.NODE_OPTIONS;

  log('gradle ' + task + ' …');
  const r = spawnSync(gradlew, [task, '--no-daemon', '--console=plain', '-q'], {
    cwd: WEAR, env, stdio: 'inherit', shell: isWin
  });
  if (r.status !== 0) die('gradle 退出码 ' + r.status);

  const apkName = mode === 'debug' ? 'app-debug.apk' : 'app-release.apk';
  const out = path.join(WEAR, 'app', 'build', 'outputs', 'apk', mode, apkName);
  if (!fs.existsSync(out)) die('没找到产物：' + out);
  fs.mkdirSync(DIST, { recursive: true });
  const dest = path.join(DIST, 'FClassPal-' + version() + '-wearos' + (mode === 'debug' ? '-debug' : '') + '.apk');
  fs.copyFileSync(out, dest);
  const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
  log('完成：' + dest + '  (' + size + ' MB)');
}

main();
