# 管家助手 GuanJia

> Windows 桌面快捷方式小组件：无边框液态玻璃 UI · 十套彼此独立的设计系统主题 · 触控优先 · 全部操作走右键/长按菜单

![平台](https://img.shields.io/badge/platform-Windows%2010%2F11-blue) ![Electron](https://img.shields.io/badge/Electron-31-47848F) ![测试](https://img.shields.io/badge/tests-485%20assertions-brightgreen) ![版本](https://img.shields.io/badge/version-2.2.3-orange) ![许可](https://img.shields.io/badge/license-MIT-lightgrey)

**管家助手**是一个常驻桌面的启动器小部件：把常用的应用、文件、文件夹和网页钉在桌面一角，顺手管理 U 盘的弹出。它没有任务栏图标、没有可见按钮——右键或长按唤醒菜单，其余时间安静地贴在桌面上。

## 十套主题，十套设计系统

十套主题**不是同一套壳换色**——每套都有自己的形状语言、表面处理、按钮样式、圆角半径、模糊强度和按压动效：

| 主题 | 设计语言 | 配色 |
|---|---|---|
| `glass` 液态玻璃 | 四层玻璃结构 + SVG 位移贴图折射 | 跟随壁纸（Monet） |
| `md3` Material You | Material Design 3，ripple 按压 | 跟随壁纸（Monet） |
| `fluent` Fluent | Reveal 光斑、8px 小圆角 | 跟随壁纸（Monet） |
| `miuix` MIUIX | HyperOS 缓动 + Sink 下沉按压 | 官方固定色 `#3482FF` |
| `harmony` 鸿蒙 | 「沉浸光感」边缘流光环 | 官方固定色 `#0A59F7` |
| `kitty` | 凯蒂猫贴图 ×10 处 | `#E8548A` |
| `dog` | 玉桂狗贴图 ×6 处 | `#4FA8E8` |
| `kuromi` | 库洛米贴图 ×7 处，邪气侧倾按压 | `#8E5BC8` + 骷髅粉 |
| `melody` | 美乐蒂贴图 ×7 处，软糯缩放 | `#EC6FA8` |
| `sanrio` | 三丽鸥混合，9 处表面轮换四家角色 | 粉 / 紫 / 蓝合体 |

| glass | md3 | fluent | miuix | harmony |
|---|---|---|---|---|
| ![glass](docs/screenshots/glass.png) | ![md3](docs/screenshots/md3.png) | ![fluent](docs/screenshots/fluent.png) | ![miuix](docs/screenshots/miuix.png) | ![harmony](docs/screenshots/harmony.png) |

| kitty | dog | kuromi | melody | sanrio |
|---|---|---|---|---|
| ![kitty](docs/screenshots/kitty.png) | ![dog](docs/screenshots/dog.png) | ![kuromi](docs/screenshots/kuromi.png) | ![melody](docs/screenshots/melody.png) | ![sanrio](docs/screenshots/sanrio.png) |

液态玻璃的折射效果（左：无折射；右：standard 模式位移贴图，边缘 3× 放大）：

| 无折射 | 折射后 | 边缘 3× |
|---|---|---|
| ![before](docs/screenshots/glass-refraction-before.png) | ![after](docs/screenshots/glass-refraction-after.png) | ![edge](docs/screenshots/glass-refraction-edge-3x.png) |

## ✨ 关于本项目：大量使用 vibe coding

**这个应用几乎全部代码都是 vibe coding 出来的。**

整个项目从第一行代码到 v2.2.3，都是在与 AI 助手（WorkBuddy）的自然语言来回中完成的：用中文描述想要的样子和行为 → AI 动手实现 → 真机验证 → 口头反馈进入下一轮。人负责提需求、挑毛病、验收；AI 负责写代码、改样式、修 bug、跑测试、打包 exe。

几个真实发生的 vibe coding 片段：

- **「U 盘还是弹不出来，是不是需要管理员权限？」** → AI 重查 Windows 头文件（`cfgmgr32.h` / `Cfg.h`），发现自己之前把两处错误码表**写反了**（`51 = CR_ACCESS_DENIED` 被标成"设备正忙"、`PNP_VETO 9 = InsufficientPower` 被标成"权限不足"），于是纠正错误码、新增免管理员的卷级 IOCTL 弹出层、再加一个 UAC「管理员重试」按钮。
- **「触摸拖动会闪屏，鼠标拖动没问题」** → AI 逐帧排查出五个独立成因（第二触点重置基准、`pointercancel` 立刻结束拖动、亚像素抖动、离群采样、拖动中长按菜单弹出），一次全部修掉。
- **「毛玻璃怎么没了」** → 真相是 `backdrop-filter` 里写了 `url(#id)`，整条声明被浏览器静默作废——模糊和折射一起消失，且控制台毫无报错。
- **「六套主题怎么长得像同一个皮肤」** → 用户一句"应该是单独的，不要基于 md3"，推倒重来，每套主题改造成自足的设计系统。

连**回归测试也是 vibe coding 的一部分**：485 项断言全部由 AI 自己编写、自己维护，用来守卫自己写过的每一个坑（比如「主题规则绝不能改写定位元素，否则右键菜单会整个消失」这类只有踩过才知道的陷阱，都有对应的守卫断言）。

工作流很简单：

```
你：这个按钮圆角再小一点，然后主题切换做成下拉栏
AI：改 CSS token + 注册表 → 跑 485 项断言 → 重新打包 exe → 交付
```

## 功能

- **快捷方式管理**：应用（.exe）/ 文件 / 文件夹 / 网页四种类型；exe 自动提取图标，也可自选图片或字符；支持分组
- **U 盘管理**：自动列出即插 U 盘，一键打开；安全弹出采用五层降级策略（设备节点 → 卷级 IOCTL → Shell 动词 → WMI 卸载 → mountvol），每层都校验盘符真的消失，全失败时给出一键「管理员重试」
- **窗口控制**：透明度、圆角弧度（8–40px）、尺寸、置底、锁定位置、开机自启、隐藏到托盘、隐藏任务栏图标
- **壁纸取色**：Material You 官方算法（`QuantizerCelebi` 聚类 → `Score` 打分 → `SchemeTonalSpot` 派生），也支持手动指定主色走同一条派生链路
- **触控优先**：Pointer Events 全链路，长按 = 右键，触摸屏上不闪不抖

## 技术要点

- **四层玻璃结构**：底材层 → warp 层（只挂 `filter` 与 `backdrop-filter`）→ veil 层（白纱/描边/投影）→ 内容层。折射用预烘焙的 256×256 SVG 位移贴图 + `feDisplacementMap`（standard 模式，借鉴 [liquid-glass-react](https://github.com/rdev/liquid-glass-react)）
- **壁纸取色**：`@material/material-color-utilities` 是 ESM 包，而 Electron 的 asar 不支持 ESM 解析，所以用 esbuild 预打成单文件 CJS（`vendor/monet.js`）
- **窗口圆角**：`transparent: true` + 每像素 alpha（不用 Mica——它与 transparent 互斥，会毁掉圆角且 `backdrop-filter` 采不到）
- **拖动**：Pointer Events + `screenX/screenY` 算位移 + rAF 合并 + 主进程 `setPosition`；拖动期间主进程暂停回推 bounds，避免自激振荡
- **U 盘弹出**：`CM_Get_Parent` 上溯到 USB 父设备节点；卷级走 `FSCTL_LOCK_VOLUME` → `IOCTL_STORAGE_MEDIA_REMOVAL` → `FSCTL_DISMOUNT_VOLUME` → `IOCTL_STORAGE_EJECT_MEDIA`，可移动卷免管理员

## 测试（485 项断言，四层验证）

| 层 | 命令 | 数量 | 说明 |
|---|---|---|---|
| 源码层 | `node smoke-test.js` | 243 | jsdom 跑 renderer 逻辑 |
| 打包层 | `node _check.js` | 166 | 从 `dist/win-unpacked/resources/app.asar` 解包逐项断言 |
| 取色层 | `node _rt/_palettecheck.js` | 50 | 真 `vendor/monet.js` 产出的 palette 喂真 `renderer/app.js` |
| 运行时 | `electron _rt/_monetcheck.js` | 19 | 真 Electron + 合成壁纸验 Monet |
| 拖动落盘 | `electron _rt/_dragcheck.js` | 7 | 真 Electron 验 saveBounds |

全部绿了才交付 exe。

## 下载

免安装便携版（Windows x64，约 94MB）：**[到 Releases 下载](https://github.com/fangyugit/FclassPal/releases/latest)**

## 运行与构建

```bash
npm install

# 开发运行
npm start

# 打包 Windows 便携版（产物：dist/管家助手-<version>.exe）
npm run build:portable

# 跑回归测试
node smoke-test.js
node _check.js            # 需先打包
node _rt/_palettecheck.js
```

## 目录结构

```
FclassPal/
├── main.js              # Electron 主进程：窗口 / IPC / U 盘弹出 / 壁纸同步
├── preload.js           # 上下文隔离桥
├── renderer/
│   ├── index.html       # 无边框 UI：主界面 + 右键菜单 + 设置面板 + 弹窗
│   ├── style.css        # 十套主题（每套是一份独立设计系统）
│   ├── app.js           # 交互逻辑：拖动 / 菜单 / 主题 / 取色应用
│   └── lg-displacement-map.js   # 预烘焙折射位移贴图（MIT © 2025 MAX ROVENSKY）
│   └── theme/           # 角色主题贴图素材
├── vendor/monet.js      # esbuild 预打包的 Material You 取色（CJS）
├── smoke-test.js        # 源码层回归（243 项）
├── _check.js            # 打包层回归（166 项）
├── _rt/                 # 运行时验证与素材管线脚本
├── tools/               # 托盘图标生成
└── docs/                # 截图
```

## 说明与限制

- 仅支持 Windows 10/11（依赖 DWM 模糊、WMI、Cfgmgr32）
- 开启「实时桌面模糊」后，系统截图/录屏会看不到本窗口（Windows 采集排除机制所致）
- `renderer/theme/` 中的三丽鸥角色图片版权归 © Sanrio 及原权利方所有，仅供学习与个人使用，请勿商用
- 液态玻璃的位移贴图来自 [liquid-glass-react](https://github.com/rdev/liquid-glass-react)（MIT）

## License

[MIT](LICENSE) © OrionYU (fangyugit)
