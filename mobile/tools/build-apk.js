#!/usr/bin/env node
/* ============================================================================
 * FClassPal 安卓壳 · 出 APK
 *
 * 用法：
 *   node tools/build-apk.js            # debug 包（用 debug 签名，装上就能跑）
 *   node tools/build-apk.js release    # release 包（未签名，需要自己配签名再装）
 *
 * 环境自动探测（都不用手动配，有环境变量就用环境变量）：
 *   JAVA_HOME     优先 %USERPROFILE%\android-toolchain\jdk-21*（Capacitor 8 要 Java 21）
 *   ANDROID_HOME  找 %USERPROFILE%\android-toolchain\sdk
 * 产物：desktop-widget/dist/FClassPal-<version>-android-<mode>.apk
 * ==========================================================================*/
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const DIST = path.resolve(ROOT, '..', 'dist');
const MODE = (process.argv[2] || 'debug').toLowerCase();
const GRADLEW = path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

function log(m) { process.stdout.write('[apk] ' + m + '\n'); }
function die(m) { process.stderr.write('[apk] 失败：' + m + '\n'); process.exit(1); }

function findJdk() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const base = path.join(os.homedir(), 'android-toolchain');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => /^jdk-/.test(d) && fs.statSync(path.join(base, d)).isDirectory());
  if (!dirs.length) return null;
  // Capacitor 8 的 compileOptions 是 Java 21（capacitor.build.gradle 生成时写死），
  // JDK 17 会报"无效的源发行版：21"，所以多个 JDK 时优先 21
  const jdk21 = dirs.filter((d) => /^jdk-21/.test(d)).sort().pop();
  return path.join(base, jdk21 || dirs.sort().pop());
}

function findSdk() {
  if (process.env.ANDROID_HOME && fs.existsSync(process.env.ANDROID_HOME)) return process.env.ANDROID_HOME;
  const p = path.join(os.homedir(), 'android-toolchain', 'sdk');
  return fs.existsSync(p) ? p : null;
}

/* gradle 发行包可达性探测 + 自动换镜像。
 * 本机 hosts 把 services.gradle.org 钉到 127.0.0.1（Java 走系统解析，报
 * Connection refused），腾讯镜像没有这问题。做法：探一下 wrapper 里配的地址，
 * 连不上就改写到腾讯镜像（只影响 android/ 这个本地工程，CI 上原地址是通的）。 */
const TENCENT_GRADLE = 'https://mirrors.cloud.tencent.com/gradle/';

/* 可达性探测要**跟随重定向**：services.gradle.org 本身通，但它 307 跳到的
 * downloads.gradle-dn.com 在本机 hosts 里被钉死（Java 端表现为 Connection refused），
 * 只探第一跳会得出"可用"的假阳性。跟随最多 4 跳，最后一跳 2xx/3xx 才算通。 */
function probe(url, timeoutMs, hops) {
  const left = hops == null ? 4 : hops;
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = require('https').get(u, { timeout: timeoutMs }, (res) => {
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          const next = new URL(res.headers.location, u).toString();
          resolve(probe(next, timeoutMs, left - 1));
          return;
        }
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch (e) { resolve(false); }
  });
}

function ensureGradleDist() {
  const propPath = path.join(ANDROID, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!fs.existsSync(propPath)) die('找不到 ' + propPath);
  let text = fs.readFileSync(propPath, 'utf8');
  const m = /distributionUrl=(.*)/.exec(text);
  if (!m) die('gradle-wrapper.properties 里没有 distributionUrl');
  // properties 文件里冒号是转义写法 https\://...，探测前先还原成普通 URL。
  // 只把"反斜杠+冒号"还原成冒号（别动斜杠，动了会变成 https:/// 三个斜杠，
  // new URL 出来 host 为空，https.get 落到 localhost，探测就假阳性了）。
  const url = m[1].replace(/\\:/g, ':');
  // 必须把整条 Promise 返回给 main 的 await，否则探测还没跑完 gradle 就启动了
  return probe(url, 6000).then((ok) => {
    if (ok) { log('gradle 发行包可用：' + url); return; }
    const ver = /gradle-([\d.]+)(-\w+)?\.zip/.exec(url);
    if (!ver) { log('gradle 地址不可达但版本无法解析，按原样重试：' + url); return; }
    const mirror = TENCENT_GRADLE + 'gradle-' + ver[1] + (ver[2] || '-bin') + '.zip';
    return probe(mirror, 8000).then((good) => {
      if (!good) die('gradle 发行包原地址与腾讯镜像都不可达：' + url);
      text = text.replace(/distributionUrl=.*/, 'distributionUrl=' + mirror.replace(/:/g, '\\:'));
      fs.writeFileSync(propPath, text);
      log('原地址不可达，已换腾讯镜像：' + mirror);
    });
  });
}

async function main() {
  if (!fs.existsSync(GRADLEW)) die('android/ 还没生成，先跑：npx cap add android && node tools/apply-android-overlay.js');
  if (MODE !== 'debug' && MODE !== 'release') die('用法：node tools/build-apk.js [debug|release]');

  const jdk = findJdk();
  const sdk = findSdk();
  if (!jdk) die('找不到 JDK 17。装好后设 JAVA_HOME，或放到 %USERPROFILE%\\android-toolchain\\jdk-17...');
  if (!sdk) die('找不到 Android SDK。装好后设 ANDROID_HOME，或放到 %USERPROFILE%\\android-toolchain\\sdk');
  log('JAVA_HOME=' + jdk);
  log('ANDROID_HOME=' + sdk);

  await ensureGradleDist();

  const t0 = Date.now();
  const task = MODE === 'debug' ? 'assembleDebug' : 'assembleRelease';
  const r = spawnSync(GRADLEW, [task, '--console=plain', '-x', 'lint'], {
    cwd: ANDROID,
    stdio: 'inherit',
    shell: true,
    env: Object.assign({}, process.env, {
      JAVA_HOME: jdk,
      ANDROID_HOME: sdk,
      // 本机 hosts 把一堆域名钉到 127.0.0.1，gradle 走代理反而更容易挂；直连即可
      JAVA_TOOL_OPTIONS: '-Dhttp.nonProxyHosts="*"'
    })
  });
  if (r.status !== 0) die('gradle ' + task + ' 失败（exit ' + r.status + '），上面有完整日志');

  // 找产物（Capacitor 无 flavor，路径固定）
  const outDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', MODE);
  if (!fs.existsSync(outDir)) die('找不到输出目录 ' + outDir);
  const apks = fs.readdirSync(outDir).filter((f) => f.endsWith('.apk'));
  if (!apks.length) die('输出目录里没有 .apk：' + outDir);
  const built = path.join(outDir, apks[0]);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(DIST, { recursive: true });
  // v2.4.6 起 release 走 FYAPP 签名（_signing/signing.properties），产物名不再带 debug
  const outName = MODE === 'release'
    ? 'FClassPal-' + pkg.version + '-android.apk'
    : 'FClassPal-' + pkg.version + '-android-debug.apk';
  const out = path.join(DIST, outName);
  fs.copyFileSync(built, out);
  const sec = Math.round((Date.now() - t0) / 1000);
  log('完成（' + sec + 's）：' + out + '  ' + fs.statSync(out).size + ' B');
  if (MODE === 'release' && /unsigned/.test(apks[0])) {
    log('注意：release 包未签名（app-release-unsigned），直接安装会被系统拒绝。');
    log('配置 _signing/signing.properties 后重跑，或先用 debug 包。');
  }
}

main().catch((e) => die(String(e && e.message || e)));
