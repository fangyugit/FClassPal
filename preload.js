const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  openTarget: (item) => ipcRenderer.invoke('open-target', item),
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectApp: () => ipcRenderer.invoke('select-app'),
  // 选择文件夹（目录）。Windows 的 openFile 对话框选不到目录，必须独立通道
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  // 自定义图标：选择本地图片，返回 { path, url }
  selectImage: () => ipcRenderer.invoke('select-image'),  // 从 exe / 文件提取系统图标，返回 { path, url } 或 { error }
  getFileIcon: (filePath) => ipcRenderer.invoke('get-file-icon', filePath),
  // 图标主色（v2.4.2）：传图标路径数组（file:// URL 或本地路径），
  // 回 { [path]: '#rrggbb' | null }。给图标边框「自动取色」用。
  getIconColors: (paths) => ipcRenderer.invoke('get-icon-colors', paths),
  // 自定义背景图（v2.4.0）：选图返回 { url, path, luminance }，启动时按配置回读
  pickBackground: () => ipcRenderer.invoke('pick-background'),
  loadBackground: () => ipcRenderer.invoke('load-background'),
  // 运行环境信息（是否支持 mica 毛玻璃等）
  getEnv: () => ipcRenderer.invoke('get-env'),
  // 桌面壁纸基底（渲染层折射用）：{ url, w, h, x, y, palette } 或 null
  getWallpaper: () => ipcRenderer.invoke('get-wallpaper'),
  // 换壁纸时主进程推来的新壁纸信息（含 palette），渲染层据此重画基底与配色
  onWallpaperChanged: (callback) => {
    const handler = (_e, info) => callback(info);
    ipcRenderer.on('wallpaper-changed', handler);
    return () => ipcRenderer.removeListener('wallpaper-changed', handler);
  },

  // 实时玻璃底材：让主进程放行屏幕采集并把本窗口从采集中排除，
  // 返回窗口所在显示器的几何信息 { x, y, w, h, scaleFactor, id }（失败返回 null）。
  // 真正的 getDisplayMedia 必须在渲染进程里调，所以这两个是"准备/收尾"。
  startRealtime: () => ipcRenderer.invoke('realtime-start'),
  stopRealtime: () => ipcRenderer.invoke('realtime-stop'),
  getDisplayInfo: () => ipcRenderer.invoke('get-display-info'),

  // U 盘
  getUsbDrives: () => ipcRenderer.invoke('get-usb-drives'),
  openDrive: (letter) => ipcRenderer.invoke('open-drive', letter),
  ejectDrive: (letter) => ipcRenderer.invoke('eject-drive', letter),
  // 普通用户态弹不出来时的一次性提权重试（会弹 UAC）
  ejectDriveElevated: (letter) => ipcRenderer.invoke('eject-drive-elevated', letter),
  // U 盘列表变化（插入/拔出）时回调，参数为驱动数组
  onUsbChange: (callback) => {
    const handler = (_e, drives) => callback(drives);
    ipcRenderer.on('usb-changed', handler);
    return () => ipcRenderer.removeListener('usb-changed', handler);
  },
  // 窗口被系统原生拖拽移动后，主进程回推真实 bounds
  onBoundsChanged: (callback) => {
    const handler = (_e, bounds) => callback(bounds);
    ipcRenderer.on('bounds-changed', handler);
    return () => ipcRenderer.removeListener('bounds-changed', handler);
  },

  // 窗口控制
  hideWindow: () => ipcRenderer.send('window-hide'),
  close: () => ipcRenderer.send('window-close'),
  // 置底开关（true = 始终位于其他窗口之下）
  setKeepBottom: (v) => ipcRenderer.send('set-keep-bottom', v),
  setBounds: (bounds) => ipcRenderer.invoke('set-bounds', bounds),
  // 触摸/鼠标统一拖动：fire-and-forget，主进程直接 setPosition
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  // 拖拽状态：true 期间主进程不回推 bounds、不重排 Z 序（防拖动闪跳）
  setDragging: (v) => ipcRenderer.send('set-dragging', !!v),
  // MD3 配色（手动选主色时不必重算整套壁纸坐标）
  getPalette: (patch) => ipcRenderer.invoke('get-palette', patch),
  // 开机自启动开关，返回 { success, enabled? , error? }
  setAutoLaunch: (v) => ipcRenderer.invoke('set-auto-launch', v),
  // 锁定位置（禁止拖动/缩放）
  setLocked: (v) => ipcRenderer.invoke('set-locked', v),
  // 托盘菜单动作（'add' | 'settings'）
  onTrayAction: (callback) => {
    const handler = (_e, action) => callback(action);
    ipcRenderer.on('tray-action', handler);
    return () => ipcRenderer.removeListener('tray-action', handler);
  },

  // 关于界面：应用版本号 + 打开 GitHub 仓库（主进程有域名白名单）
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
