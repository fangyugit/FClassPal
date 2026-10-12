# FClassPal 安卓版（Capacitor 壳）

v2.4.5 起，除了 Windows 便携 exe，还提供一个真 `.apk`。做法是**复用桌面的整套渲染层**
（`renderer/` 一行不改），用一个 Capacitor 壳把它装进安卓 WebView，并注入一个与
Electron `preload.js` 同名的 `window.widgetAPI` 桥。

```
renderer/                 桌面版界面（唯一一份，两边共用）
mobile/
  web/mobile-bridge.js    安卓版 window.widgetAPI（34 个方法 + 手机端适配）
  web/mobile.css          手机布局覆盖（全屏、安全区、隐藏桌面专有行）
  tools/assemble-web.js   renderer/ + web/ -> www/（含注入与自检）
  tools/apply-android-overlay.js   原生工程定制（图标/主题/插件/版本号/签名注入）
  tools/build-apk.js      出 APK（自动找 JDK/SDK、自动换 gradle 镜像）
  android-overlay/        对 android/ 模板的覆盖层（Java 插件、清单、主题、图标）
  android/                `npx cap add android` 生成（不进版本库，可随时重建）
  www/                    装配产物（不进版本库）
```

## 能力对照

| 能力 | 桌面（Electron） | 安卓（Capacitor） |
| --- | --- | --- |
| 快捷方式：网页 | 系统浏览器打开 | 系统浏览器打开 |
| 快捷方式：应用 | 打开 exe | **选择已安装应用**（原生列表）、显示真实应用图标、按名称启动 |
| 快捷方式：文件/文件夹 | 打开 | 不支持（安卓没有本地路径语义），编辑弹窗里已禁用并标注 |
| 玻璃底材 | Windows 壁纸 | **安卓系统壁纸**（公开 API，无需存储权限） |
| 动态取色 | Monet 对壁纸聚类 | Android 12+ 系统动态色（Material You，同源）；拿不到退回手动主色 |
| 明暗模式 | light / dark / **auto（nativeTheme）** | light / dark / **auto（Configuration.uiMode）** |
| 主题 / 圆角 / 透明度 / 图标外观 | 十套主题全量 | 十套主题全量（圆角弧度除外：全屏没有可调空间） |
| 自定义背景图 | 本地文件 | 本机选图（转 data URL 存 WebView 存储，单图上限 1.5MB） |
| U 盘弹出 | 全套 | 无（安卓无此概念） |
| 实时屏幕模糊 | desktopCapturer | **v2.4.6 悬浮窗模式可用**（MediaProjection 录屏授权，原生采集推帧） |
| 窗口模式 | 无边框小窗 | **v2.4.6 全屏 / 悬浮窗两档**（设置面板「窗口模式」；悬浮窗拖标题栏移动、＋/− 调大小，窗外触摸穿透） |
| 托盘 / 置底 / 开机自启 / 锁定 | 有 | 无（隐藏对应设置行） |

桌面与安卓的配置不互通（键名、路径、壁纸本来就不可移植），各自独立保存。

## 从零构建 APK

前置：**JDK 21**（Capacitor 8 的 `compileOptions` 写死 `JavaVersion.VERSION_21`，JDK 17 会报
「无效的源发行版：21」）、Android SDK（`platforms;android-36` + `build-tools;36.0.0`）。
两者放到 `%USERPROFILE%\android-toolchain\{jdk-…,sdk}` 或设 `JAVA_HOME` / `ANDROID_HOME`。

```bash
cd mobile
npm install                # @capacitor/core|cli|android 固定 8.5.3
npx cap add android        # 只需一次；重新生成后跑下一步即可复原全部定制
node tools/apply-android-overlay.js
node tools/build-apk.js debug
```

产物：`dist/FClassPal-<version>-android-debug.apk`（debug 签名，装上就能跑）。

v2.4.6 起支持正式签名 release：把密钥信息放进 `_signing/signing.properties`
（`storeFile` / `storePassword` / `keyAlias` / `keyPassword`，密钥文件同目录；
该目录已 gitignore，绝不入库），`apply-android-overlay.js` 会自动把
`signingConfig` 注入 `app/build.gradle`，然后：

```bash
node tools/build-apk.js release   # 产物 dist/FClassPal-<version>-android.apk（已签名）
```

没有 `_signing/signing.properties` 时 release 照常构建，只是产物未签名。

本机 hosts 把 `services.gradle.org` 钉在 127.0.0.1 时，`build-apk.js` 会自动改用
腾讯镜像（`mirrors.cloud.tencent.com/gradle/`）下载 Gradle 发行包，无需手动处理。

## 架构要点（为什么 renderer/ 一行不改）

- `renderer/app.js` 顶层只看 `window.widgetAPI` 在不在：不在才走浏览器预览 mock。
  `mobile-bridge.js` 在 `app.js` **之前**同步注入同名对象，于是走的是真机路径。
- 桥接层的方法签名与 `preload.js` 逐个对齐；安卓没有的能力一律给"安全值"
  （空列表 / `null` / `{success:false}`），绝不抛异常让界面白屏。
- 手机端布局适配全部挂在 `html.mobile` 作用域下（本项目铁律：body 状态标记类
  不允许出现裸 `.类名` 规则，所以标记挂在 `<html>` 上）。
- 桌面专有设置行（置底/自启/锁定/实时模糊/圆角）由桥接层打 `data-mobile-hide`
  标记后用一条 CSS 隐藏，不依赖 `:has()`，老 WebView 也能用。
- 原生能力收在 `PalBridgePlugin`（`android-overlay/.../PalBridgePlugin.java`）：
  壁纸、系统动态色、深色开关、应用列表/图标/启动、Toast、退后台、
  窗口模式（`setWindowMode`/`moveWindow`/`setBounds`）、
  录屏实时模糊（`startRealtime`/`stopRealtime` + `RealtimeCapture` +
  `ScreenCaptureService` 前台服务）。
  每个方法失败都 `resolve` 而不是 `reject`，界面层按"拿不到就走兜底"处理。

## 实时屏幕模糊（v2.4.6）的工作方式

- 渲染层 `startRealtimeBackdrop()` 发现桥上有 `onRealtimeFrame` 就走**外部帧模式**：
  原生 `MediaProjection` 采集 → `ImageReader` 取帧 → 裁出采样矩形 → JPEG（长边 360、
  q70，~10fps）→ Base64 → `realtimeFrame` 事件 → 渲染层解码画进 `#deskCanvas`。
- **采样矩形不是本窗口自己**：安卓没有桌面版 `setContentProtection` 的等价物——
  不排除自己会形成"玻璃套玻璃"的递归，用 `FLAG_SECURE` 排除自己采到的又是纯黑。
  所以取**与本窗口同尺寸、不与自己相交的邻域矩形**（优先正上/正下/正左/正右）：
  玻璃折射的是身旁正在动的真实画面，视觉上与"透出壁纸"高度一致，且永不递归。
- 悬浮窗已大到找不到这种矩形（≈全屏）时，原生返回 `reason=fullscreen`，
  渲染层自动退回静态壁纸底材（与采集失败的降级同一条路径）。
- Android 14+ 硬性要求：采集前必须有 `foregroundServiceType="mediaProjection"`
  的前台服务在跑（`ScreenCaptureService`），且 `createVirtualDisplay` 前先注册
  `MediaProjection.Callback`。状态栏会有一条"正在采集"的常驻通知，属系统行为。
- 授权令牌是一次性的：每次开启实时模糊都会弹一次系统授权框；拒绝则安静退回壁纸。
