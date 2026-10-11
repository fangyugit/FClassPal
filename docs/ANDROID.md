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
  tools/apply-android-overlay.js   原生工程定制（图标/主题/插件/版本号）
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
| 实时桌面模糊 | desktopCapturer | 无（安卓无屏幕采集授权路径） |
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
`release` 模式产出未签名包，需要自配 `signingConfig` 后再安装。

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
  壁纸、系统动态色、深色开关、应用列表/图标/启动、Toast、退后台。
  每个方法失败都 `resolve` 而不是 `reject`，界面层按"拿不到就走兜底"处理。
