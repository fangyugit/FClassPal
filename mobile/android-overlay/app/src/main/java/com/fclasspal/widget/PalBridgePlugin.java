package com.fclasspal.widget;

import android.app.Activity;
import android.app.WallpaperManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Point;
import android.graphics.Rect;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.content.ContentValues;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/* ============================================================================
 * FClassPal 安卓壳 · 原生桥（PalBridge）
 *
 * 桌面版这些能力在主进程的 main.js 里（nativeTheme / shell.openExternal /
 * desktopCapturer / PowerShell 弹 U 盘）。安卓侧只保留手机上真正成立的那几件：
 *
 *   getInfo            版本号 / Android 版本 / SDK / 机型（关于界面 + 环境判定）
 *   getAppearance      系统深色开关（读 Configuration.uiMode，比 WebView 的
 *                      prefers-color-scheme 可靠）
 *   systemAccent       Android 12+ 的系统动态色（Material You，来自壁纸）
 *   wallpaper          系统壁纸（玻璃底材，对应桌面版的"只模糊壁纸"）
 *   openUrl            外链走系统浏览器
 *   listApps/pickApp   已安装的桌面应用（安卓侧的"选择应用"，对应桌面版选 exe）
 *   appIcon            应用图标（对应桌面版从 exe 提取图标）
 *   launchApp          按包名或按名称启动
 *   toast / minimize / exitApp
 *
 * 调用约定：全部返回 JSObject，字段语义与 preload.js 保持一致；失败一律
 * resolve({...成功标记:false}) 而不是 reject —— 界面层（mobile-bridge.js）
 * 已经按"拿不到就走兜底"写，一路 reject 会把 console 刷满却没人在意。
 * ==========================================================================*/

@CapacitorPlugin(name = "PalBridge", permissions = {})
public class PalBridgePlugin extends Plugin {

    /* --------------------------------------------------- 悬浮窗 / 实时采集状态 */

    /** 系统录屏授权对话框的 requestCode（ActivityResult 回调里认这个号）。 */
    private static final int REQ_CAPTURE = 51517;

    /** SAF 选择 .fcpc/.fcpt 包（v2.5.0 导入用）。 */
    private static final int REQ_PICK_PACK = 51518;

    /** 当前窗口模式：fullscreen（铺满）| float（悬浮小窗，对应桌面版）。 */
    private volatile String windowMode = "fullscreen";

    /** 本窗口当前矩形（物理像素）。悬浮窗模式随 lp 同步；全屏模式即整屏。 */
    private final Rect winRectPx = new Rect();

    /** 录屏授权令牌（一次性；停止采集/被拒后清空，下次重新弹授权）。 */
    private Intent consentData;
    private int consentCode;
    /** 授权对话框还挂着时的补跑标记：结果回来接着 start。 */
    private boolean pendingStart;
    private RealtimeCapture capture;

    /* --------------------------------------------------------------- 基本信息 */

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject out = new JSObject();
        Context ctx = getContext();
        try {
            out.put("packageName", ctx.getPackageName());
            out.put("versionName", ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0).versionName);
        } catch (Exception e) {
            out.put("packageName", "");
            out.put("versionName", "");
        }
        out.put("androidRelease", Build.VERSION.RELEASE);
        out.put("sdkInt", Build.VERSION.SDK_INT);
        out.put("model", Build.MODEL == null ? "" : Build.MODEL);
        out.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        call.resolve(out);
    }

    /* --------------------------------------------------------- 系统深色 / 主色 */

    @PluginMethod
    public void getAppearance(PluginCall call) {
        JSObject out = new JSObject();
        out.put("isDark", isSystemDark());
        out.put("forced", false);
        call.resolve(out);
    }

    private boolean isSystemDark() {
        int mode = getContext().getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * 系统动态色（Android 12 / API 31 起由系统按壁纸算好，就是 Material You 的源色）。
     * 拿不到（旧系统、ROM 没实现）返回 color = null，界面层会退回用户配置的主色。
     */
    @PluginMethod
    public void systemAccent(PluginCall call) {
        JSObject out = new JSObject();
        out.put("color", null);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                int id = getContext().getResources().getIdentifier(
                        "system_accent1_500", "color", "android");
                if (id > 0) {
                    int c = getContext().getColor(id);
                    out.put("color", String.format("#%02X%02X%02X",
                            (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF));
                }
            } catch (Exception ignored) {
                // 有些 ROM 把这个资源藏起来了，拿不到就算了
            }
        }
        call.resolve(out);
    }

    /* ------------------------------------------------------------- 系统壁纸 */

    /**
     * 系统壁纸 -> JPEG data URL。
     * 桌面版拿壁纸当玻璃底材（"只模糊壁纸"），安卓对应物就是这张图。原图动辄
     * 4000px 宽，过桥前压到 maxWidth（默认 900）并 JPEG q78，通常 100KB 上下。
     * 读壁纸不需要存储权限（getDrawable 是公开 API），个别 ROM 会抛
     * SecurityException，这里吞掉返回 dataUrl=null，界面退回内置渐变基底。
     */
    @PluginMethod
    public void wallpaper(final PluginCall call) {
        final int maxW = call.getInt("maxWidth", 900);
        final Context ctx = getContext().getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                JSObject out = new JSObject();
                out.put("dataUrl", null);
                try {
                    WallpaperManager wm = WallpaperManager.getInstance(ctx);
                    Drawable d = null;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                        d = wm.getDrawable();
                    }
                    if (d == null) d = wm.getBuiltInDrawable();
                    if (d == null) { call.resolve(out); return; }

                    int w = d.getIntrinsicWidth() > 0 ? d.getIntrinsicWidth() : 1080;
                    int h = d.getIntrinsicHeight() > 0 ? d.getIntrinsicHeight() : 1920;
                    float scale = Math.min(1f, maxW / (float) w);
                    int tw = Math.max(1, Math.round(w * scale));
                    int th = Math.max(1, Math.round(h * scale));

                    Bitmap bmp = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888);
                    Canvas c = new Canvas(bmp);
                    d.setBounds(0, 0, tw, th);
                    d.draw(c);

                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, 78, bos);
                    bmp.recycle();

                    String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                    out.put("dataUrl", "data:image/jpeg;base64," + b64);
                    out.put("width", tw);
                    out.put("height", th);
                    out.put("bytes", bos.size());
                } catch (Throwable t) {
                    // 拿不到就保持 null：界面层会退回 CSS 渐变基底，不影响可用性
                }
                call.resolve(out);
            }
        }).start();
    }

    /* ------------------------------------------------- 窗口模式（全屏 / 悬浮窗）
     * 桌面版是一个无边框小窗浮在桌面上；安卓默认全屏 Activity。悬浮窗模式的做法
     * 是把 Activity 窗口本身缩小（WindowManager.LayoutParams 设 width/height/x/y），
     * 加 FLAG_NOT_TOUCH_MODAL 让窗口外的触摸穿透到底下的桌面 —— 视觉与操作都
     * 和桌面版一致。窗口外能看见什么就显示什么（壁纸 / 其他应用），正好喂给
     * 玻璃当底材。 */

    /** 查询当前模式与窗口矩形（诊断/回显用）。 */
    @PluginMethod
    public void getWindowMode(PluginCall call) {
        JSObject out = new JSObject();
        out.put("mode", windowMode);
        out.put("x", dp(winRectPx.left));
        out.put("y", dp(winRectPx.top));
        out.put("width", dp(winRectPx.width()));
        out.put("height", dp(winRectPx.height()));
        out.put("realtime", capture != null && capture.isRunning());
        call.resolve(out);
    }

    @PluginMethod
    public void setWindowMode(final PluginCall call) {
        JSObject data = new JSObject();
        data.put("mode", call.getString("mode"));
        data.put("x", call.getInt("x"));
        data.put("y", call.getInt("y"));
        data.put("width", call.getInt("width"));
        data.put("height", call.getInt("height"));
        data.put("overlay", call.getBoolean("overlay"));
        setWindowModeData(data, call);
    }

    /** setWindowMode 的实际入口（供 setBounds 复用；data 里必须带 mode）。 */
    private void setWindowModeData(final JSObject data, final PluginCall call) {
        final String mode = "float".equals(data.optString("mode", "")) ? "float" : "fullscreen";
        final Integer xDp = boxedInt(data, "x"), yDp = boxedInt(data, "y");
        final Integer wDp = boxedInt(data, "width"), hDp = boxedInt(data, "height");
        final Activity act = getActivity();
        JSObject out = new JSObject();
        if (act == null) {
            out.put("applied", false);
            out.put("error", "no-activity");
            call.resolve(out);
            return;
        }
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                JSObject o = new JSObject();
                try {
                    Window w = act.getWindow();
                    WindowManager.LayoutParams lp = w.getAttributes();
                    DisplayMetrics dm = act.getResources().getDisplayMetrics();
                    Point size = realDisplaySize(act);
                    if ("float".equals(mode)) {
                        int dw = size.x, dh = size.y;
                        int ww = dpPx(wDp != null && wDp > 0 ? wDp : 360, dm);
                        int hh = dpPx(hDp != null && hDp > 0 ? hDp : 560, dm);
                        ww = Math.max(dpPx(220, dm), Math.min(ww, (int) (dw * 0.85f)));
                        hh = Math.max(dpPx(320, dm), Math.min(hh, (int) (dh * 0.85f)));
                        int m = dpPx(16, dm);
                        int xpx = (xDp != null && xDp >= 0) ? dpPx(xDp, dm)
                                : Math.max(m, dw - ww - m);                 // 默认右下角
                        int ypx = (yDp != null && yDp >= 0) ? dpPx(yDp, dm)
                                : Math.max(m, Math.round((dh - hh) * 0.62f));
                        lp.width = ww;
                        lp.height = hh;
                        lp.gravity = Gravity.TOP | Gravity.START;
                        lp.x = Math.max(0, Math.min(xpx, dw - ww));
                        lp.y = Math.max(0, Math.min(ypx, dh - hh));
                        lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
                        lp.dimAmount = 0f;
                        w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                        // v2.5.0：用户授予了「显示在其他应用上层」后，把窗口升级成真正的
                        // 系统悬浮层（TYPE_APPLICATION_OVERLAY）。部分 ROM 不允许 Activity
                        // 窗口改类型 —— 失败就静默留在应用内悬浮，不影响使用。
                        if (data.optBoolean("overlay", false) && canOverlay()) {
                            try {
                                lp.type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
                            } catch (Throwable ignored) {
                            }
                        }
                    } else {
                        lp.width = WindowManager.LayoutParams.MATCH_PARENT;
                        lp.height = WindowManager.LayoutParams.MATCH_PARENT;
                        lp.gravity = Gravity.CENTER;
                        lp.x = 0;
                        lp.y = 0;
                        lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
                    }
                    w.setAttributes(lp);
                    windowMode = mode;
                    if ("float".equals(mode)) {
                        winRectPx.set(lp.x, lp.y, lp.x + lp.width, lp.y + lp.height);
                    } else {
                        winRectPx.set(0, 0, size.x, size.y);
                    }
                    if (capture != null) capture.setWindowRect(new Rect(winRectPx));
                    o.put("applied", true);
                } catch (Throwable t) {
                    o.put("applied", false);
                    o.put("error", String.valueOf(t.getMessage()));
                }
                o.put("mode", windowMode);
                o.put("overlayGranted", canOverlay());
                call.resolve(o);
            }
        });
    }

    /** 拖动标题栏 → 移动悬浮窗（渲染层高频调用，只改 lp.x/y）。 */
    @PluginMethod
    public void moveWindow(final PluginCall call) {
        final Double xD = call.getDouble("x"), yD = call.getDouble("y");
        JSObject out = new JSObject();
        if (!"float".equals(windowMode) || xD == null || yD == null) {
            out.put("applied", false);
            call.resolve(out);
            return;
        }
        final Activity act = getActivity();
        if (act == null) {
            out.put("applied", false);
            call.resolve(out);
            return;
        }
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Activity a = getActivity();
                    if (a == null) return;
                    Window w = a.getWindow();
                    WindowManager.LayoutParams lp = w.getAttributes();
                    Point size = realDisplaySize(a);
                    lp.x = Math.max(0, Math.min(dpPx(xD.floatValue(),
                            a.getResources().getDisplayMetrics()), size.x - lp.width));
                    lp.y = Math.max(0, Math.min(dpPx(yD.floatValue(),
                            a.getResources().getDisplayMetrics()), size.y - lp.height));
                    w.setAttributes(lp);
                    winRectPx.set(lp.x, lp.y, lp.x + lp.width, lp.y + lp.height);
                    if (capture != null) capture.setWindowRect(new Rect(winRectPx));
                } catch (Throwable ignored) {
                }
            }
        });
        out.put("applied", true);
        call.resolve(out);
    }

    /** 悬浮窗权限（v2.5.0）：浮在其它应用上层需要「显示在其他应用上层」授权。 */
    private boolean canOverlay() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                return Settings.canDrawOverlays(getContext());
            } catch (Throwable t) {
                return false;
            }
        }
        return true;
    }

    @PluginMethod
    public void overlayGranted(final PluginCall call) {
        JSObject o = new JSObject();
        o.put("granted", canOverlay());
        call.resolve(o);
    }

    @PluginMethod
    public void requestOverlay(final PluginCall call) {
        Activity act = getActivity();
        if (act != null) {
            try {
                act.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + act.getPackageName())));
            } catch (Throwable t) {
                try {
                    act.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION));
                } catch (Throwable ignored) {
                }
            }
        }
        call.resolve();
    }

    /* ------------------------------------------------ 配置包/主题包导入导出（v2.5.0）
     * 桌面版是系统另存为/打开对话框；安卓走 MediaStore（下载/FClassPal/）+ SAF。
     * 包体本身由渲染层拼装（base64 进出），原生只负责落盘和选文件。 */

    @PluginMethod
    public void savePack(final PluginCall call) {
        String name = call.getString("name", "");
        String b64 = call.getString("base64", "");
        JSObject o = new JSObject();
        o.put("saved", false);
        byte[] bytes;
        try {
            bytes = Base64.decode(b64 == null ? "" : b64, Base64.DEFAULT);
        } catch (Throwable t) {
            o.put("error", "bad-data");
            call.resolve(o);
            return;
        }
        if (name == null || name.trim().isEmpty()) name = "FClassPal-export.fcpc";
        final String fname = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        final Context ctx = getContext().getApplicationContext();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, fname);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/FClassPal");
                Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri != null) {
                    OutputStream os = ctx.getContentResolver().openOutputStream(uri);
                    os.write(bytes);
                    os.close();
                    o.put("saved", true);
                    o.put("path", "下载/FClassPal/" + fname);
                }
            } else {
                // 旧设备没有 MediaStore.Downloads：写应用专属外部目录（免存储权限）
                File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = ctx.getFilesDir();
                File out = new File(new File(dir, "FClassPal"), fname);
                out.getParentFile().mkdirs();
                FileOutputStream fos = new FileOutputStream(out);
                fos.write(bytes);
                fos.close();
                o.put("saved", true);
                o.put("path", out.getAbsolutePath());
            }
        } catch (Throwable t) {
            o.put("saved", false);
            o.put("error", String.valueOf(t.getMessage()));
        }
        call.resolve(o);
    }

    /** 打 SAF 选择器；结果通过 packPicked 事件回（带 base64 或 canceled）。 */
    @PluginMethod
    public void pickPack(final PluginCall call) {
        JSObject o = new JSObject();
        Activity act = getActivity();
        if (act == null) {
            o.put("started", false);
            call.resolve(o);
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            act.startActivityForResult(i, REQ_PICK_PACK);
            o.put("started", true);
        } catch (Throwable t) {
            o.put("started", false);
            o.put("error", String.valueOf(t.getMessage()));
        }
        call.resolve(o);
    }

    /** 渲染层的窗口尺寸/位置同步（桌面 set-bounds 的对应物；悬浮窗模式生效）。
     *  注意必须保持当前模式 —— 渲染层传的 bounds 里没有 mode 字段，直接转给
     *  setWindowMode 会被默认值"fullscreen"打回全屏。 */
    @PluginMethod
    public void setBounds(PluginCall call) {
        JSObject data = new JSObject();
        data.put("mode", windowMode);   // 保持现状
        data.put("x", call.getInt("x"));
        data.put("y", call.getInt("y"));
        data.put("width", call.getInt("width"));
        data.put("height", call.getInt("height"));
        setWindowModeData(data, call);
    }

    /* ---------------------------------------------- 实时屏幕采集（录屏权限模糊）
     * 对应桌面版 getDisplayMedia 实时底材。安卓 WebView 没有这东西，采集在原生
     * RealtimeCapture 里做，帧通过 realtimeFrame 事件推给渲染层。
     * 交互：首次调用弹系统授权对话框 → handleOnActivityResult 接结果自动续跑。 */

    @PluginMethod
    public void startRealtime(final PluginCall call) {
        JSObject out = new JSObject();
        out.put("ok", false);
        final Activity act = getActivity();
        if (act == null) {
            out.put("reason", "no-activity");
            call.resolve(out);
            return;
        }
        if (capture != null && capture.isRunning()) {
            out.put("ok", true);
            call.resolve(out);
            return;
        }
        if (capture == null) {
            capture = new RealtimeCapture(getContext().getApplicationContext());
            capture.setListener(new RealtimeCapture.Listener() {
                @Override
                public void onFrame(JSObject frame) {
                    notifyListeners("realtimeFrame", frame);
                }

                @Override
                public void onEnded(String reason) {
                    JSObject o = new JSObject();
                    o.put("ended", true);
                    o.put("reason", reason);
                    notifyListeners("realtimeEnded", o);
                }
            });
        }
        capture.setPaused(false);
        if (consentData != null) {
            // 有有效令牌：后台线程直接起采集（start 里要等前台服务，别占调用线程）
            final RealtimeCapture c = capture;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    Rect r = new Rect(winRectPx);
                    String err = c.start(consentData, consentCode, r, 100);
                    if (err != null) {
                        // ★ 令牌失效/服务起不来必须喊一嗓子：以前这里静默失败，
                        // 渲染层拿着 ok:true 永远停在「等待录屏授权」——这就是
                        // "给了录屏权限还一直卡在动态录屏授权"的真凶。
                        consentData = null;
                        JSObject o = new JSObject();
                        o.put("ended", true);
                        o.put("reason", captureErrorText(err));
                        notifyListeners("realtimeEnded", o);
                    }
                }
            }).start();
            out.put("ok", true);   // 采集中/即将采集，帧随后推
            call.resolve(out);
            return;
        }
        // 没有令牌：弹系统授权对话框，结果回来在 handleOnActivityResult 续跑
        pendingStart = true;
        try {
            MediaProjectionManager mpm = (MediaProjectionManager)
                    getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            act.startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
            out.put("reason", "consent");   // 渲染层收到它就挂起等帧，不算失败
        } catch (Throwable t) {
            pendingStart = false;
            out.put("reason", "error");
        }
        call.resolve(out);
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_PACK) {
            /* v2.5.0：SAF 选中的 .fcpc/.fcpt 读成 base64 推给渲染层 */
            JSObject o = new JSObject();
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
                o.put("canceled", true);
                notifyListeners("packPicked", o);
                return;
            }
            try {
                Uri uri = data.getData();
                InputStream is = getContext().getContentResolver().openInputStream(uri);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                is.close();
                String name = "import.fcpc";
                try {
                    android.database.Cursor c = getContext().getContentResolver().query(uri, null, null, null, null);
                    if (c != null) {
                        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (c.moveToFirst() && idx >= 0 && c.getString(idx) != null) name = c.getString(idx);
                        c.close();
                    }
                } catch (Throwable ignored) {
                }
                o.put("canceled", false);
                o.put("name", name);
                o.put("base64", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            } catch (Throwable t) {
                o.put("canceled", true);
                o.put("error", String.valueOf(t.getMessage()));
            }
            notifyListeners("packPicked", o);
            return;
        }
        if (requestCode != REQ_CAPTURE) return;
        if (resultCode != Activity.RESULT_OK || data == null) {
            pendingStart = false;
            consentData = null;
            JSObject o = new JSObject();
            o.put("ended", true);
            o.put("reason", "未授予录屏权限");
            notifyListeners("realtimeEnded", o);
            return;
        }
        consentData = data;
        consentCode = resultCode;
        if (pendingStart && capture != null) {
            pendingStart = false;
            final RealtimeCapture c = capture;
            final Intent token = data;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    Rect r = new Rect(winRectPx);
                    String err = c.start(token, consentCode, r, 100);
                    if (err != null) {
                        consentData = null;
                        JSObject o = new JSObject();
                        o.put("ended", true);
                        o.put("reason", captureErrorText(err));
                        notifyListeners("realtimeEnded", o);
                    }
                }
            }).start();
        }
    }

    /** 采集启动失败 → 用户看得懂的一句话（渲染层直接显示，然后退回静态壁纸） */
    private static String captureErrorText(String err) {
        if ("fullscreen".equals(err)) return "窗口太大，退回壁纸底材";
        if ("fgs-denied".equals(err)) return "系统不允许启动屏幕采集服务（回到应用前台再开一次）";
        if ("fgs-timeout".equals(err)) return "屏幕采集服务启动超时";
        if ("denied".equals(err)) return "录屏授权已失效，请重新开启";
        return "采集启动失败";
    }

    @PluginMethod
    public void stopRealtime(PluginCall call) {
        if (capture != null) capture.stop();
        consentData = null;      // 录屏令牌是一次性的，下次开启重新弹授权
        JSObject out = new JSObject();
        out.put("stopped", true);
        call.resolve(out);
    }

    /* -------------------------------------------------------- 生命周期钩子 */

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (capture != null) capture.setPaused(true);   // 退后台暂停推帧（省电）
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (capture != null) capture.setPaused(false);
    }

    @Override
    protected void handleOnDestroy() {
        if (capture != null) capture.stop();
        super.handleOnDestroy();
    }

    /* -------------------------------------------------- 几何/单位小工具 */

    /** 屏幕物理尺寸（像素）。 */
    private Point realDisplaySize(Activity act) {
        Point p = new Point(1080, 1920);
        try {
            WindowManager wm = (WindowManager) act.getSystemService(Context.WINDOW_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Rect b = wm.getCurrentWindowMetrics().getBounds();
                p.set(b.width(), b.height());
            } else {
                wm.getDefaultDisplay().getRealSize(p);
            }
        } catch (Throwable ignored) {
        }
        return p;
    }

    /** 桌面逻辑像素 -> 物理像素（渲染层 config 的 x/y/width/height 都是逻辑像素）。 */
    private int dpPx(float dp, DisplayMetrics dm) {
        return Math.max(1, Math.round(dp * dm.density));
    }

    /** 物理像素 -> 桌面逻辑像素。 */
    private int dp(int px) {
        try {
            return Math.round(px / getActivity().getResources().getDisplayMetrics().density);
        } catch (Throwable t) {
            return px;
        }
    }

    /** JSONObject.getInt 是检查异常接口，包一层：缺键/类型不对都返回 null。 */
    private static Integer boxedInt(com.getcapacitor.JSObject o, String key) {
        if (o == null || !o.has(key)) return null;
        try {
            return o.getInt(key);
        } catch (Exception e) {
            return null;
        }
    }

    /* --------------------------------------------------------------- 外链 */

    @PluginMethod
    public void openUrl(PluginCall call) {
        JSObject out = new JSObject();
        String url = call.getString("url", "");
        if (url == null || url.trim().isEmpty()) {
            out.put("opened", false);
            call.resolve(out);
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            out.put("opened", true);
        } catch (Exception e) {
            out.put("opened", false);
            out.put("error", String.valueOf(e.getMessage()));
        }
        call.resolve(out);
    }

    /* --------------------------------------------------- 已安装应用（列表/选择） */

    private List<ResolveInfo> queryLaunchable() {
        PackageManager pm = getContext().getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN, null);
        main.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = pm.queryIntentActivities(main, 0);
        // 用应用名排序，用户找起来快
        Collections.sort(list, new Comparator<ResolveInfo>() {
            @Override
            public int compare(ResolveInfo a, ResolveInfo b) {
                return String.valueOf(a.loadLabel(getContext().getPackageManager()))
                        .compareToIgnoreCase(String.valueOf(b.loadLabel(getContext().getPackageManager())));
            }
        });
        return list;
    }

    private JSArray appsToJson(List<ResolveInfo> list, int limit) {
        JSArray arr = new JSArray();
        PackageManager pm = getContext().getPackageManager();
        int n = 0;
        for (ResolveInfo ri : list) {
            if (limit > 0 && n >= limit) break;
            JSObject o = new JSObject();
            String label = String.valueOf(ri.loadLabel(pm));
            o.put("label", label);
            o.put("pkg", ri.activityInfo != null ? ri.activityInfo.packageName : "");
            o.put("activity", ri.activityInfo != null ? ri.activityInfo.name : "");
            arr.put(o);
            n += 1;
        }
        return arr;
    }

    @PluginMethod
    public void listApps(PluginCall call) {
        JSObject out = new JSObject();
        try {
            out.put("apps", appsToJson(queryLaunchable(), 0));
        } catch (Exception e) {
            out.put("apps", new JSArray());
        }
        call.resolve(out);
    }

    /**
     * 弹出"选择应用"对话框（对应桌面版选 exe 的对话框）。
     * 结果给 label + pkg：label 回填到"名称"输入框（好看），pkg 才是启动依据。
     * 这是唯一必须在主线程弹窗的方法；对话框回调里才 resolve，取消则 label=null。
     */
    @PluginMethod
    public void pickApp(final PluginCall call) {
        if (getActivity() == null) {
            call.resolve(new JSObject().put("label", null));
            return;
        }
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    final List<ResolveInfo> list = queryLaunchable();
                    final PackageManager pm = getContext().getPackageManager();
                    final String[] labels = new String[list.size()];
                    for (int i = 0; i < list.size(); i++) labels[i] = String.valueOf(list.get(i).loadLabel(pm));

                    new AlertDialog.Builder(getActivity())
                            .setTitle("选择应用")
                            .setItems(labels, new android.content.DialogInterface.OnClickListener() {
                                @Override
                                public void onClick(android.content.DialogInterface d, int which) {
                                    ResolveInfo ri = list.get(which);
                                    JSObject o = new JSObject();
                                    o.put("label", labels[which]);
                                    o.put("pkg", ri.activityInfo != null ? ri.activityInfo.packageName : "");
                                    o.put("activity", ri.activityInfo != null ? ri.activityInfo.name : "");
                                    call.resolve(o);
                                }
                            })
                            .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                                @Override
                                public void onCancel(android.content.DialogInterface d) {
                                    call.resolve(new JSObject().put("label", null));
                                }
                            })
                            .show();
                } catch (Exception e) {
                    call.resolve(new JSObject().put("label", null));
                }
            }
        });
    }

    /** 按包名或按应用名找一个可启动的 Activity。 */
    private ResolveInfo resolveApp(String pkg, String label) {
        PackageManager pm = getContext().getPackageManager();
        List<ResolveInfo> list = queryLaunchable();
        if (pkg != null && !pkg.isEmpty()) {
            for (ResolveInfo ri : list) {
                if (ri.activityInfo != null && pkg.equals(ri.activityInfo.packageName)) return ri;
            }
            // 有包名但它不在 launcher 列表里（比如被隐藏了）：直接问包管理器
            Intent direct = pm.getLaunchIntentForPackage(pkg);
            if (direct != null) {
                return pm.resolveActivity(direct, 0);
            }
            return null;
        }
        if (label != null && !label.isEmpty()) {
            for (ResolveInfo ri : list) {
                if (label.equals(String.valueOf(ri.loadLabel(pm)))) return ri;
            }
        }
        return null;
    }

    @PluginMethod
    public void launchApp(PluginCall call) {
        JSObject out = new JSObject();
        out.put("launched", false);
        String pkg = call.getString("pkg", "");
        String label = call.getString("label", "");
        try {
            ResolveInfo ri = resolveApp(pkg, label);
            Intent intent = null;
            if (ri != null && ri.activityInfo != null) {
                intent = new Intent(Intent.ACTION_MAIN);
                intent.addCategory(Intent.CATEGORY_LAUNCHER);
                intent.setComponent(new ComponentName(ri.activityInfo.packageName, ri.activityInfo.name));
            } else if (pkg != null && !pkg.isEmpty()) {
                intent = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
            }
            if (intent == null) {
                out.put("error", "未找到可启动的应用");
                call.resolve(out);
                return;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            out.put("launched", true);
        } catch (Exception e) {
            out.put("error", String.valueOf(e.getMessage()));
        }
        call.resolve(out);
    }

    /**
     * 应用图标 -> PNG data URL（108px，保留 alpha）。
     * 对应桌面版的"从 exe 提取图标"；给的图直接进 item.iconPath，会被持久化，
     * 所以尺寸压到 108px（约 6-14KB base64），几十个快捷方式也撑得住 localStorage。
     */
    @PluginMethod
    public void appIcon(final PluginCall call) {
        final String pkg = call.getString("pkg", "");
        final String label = call.getString("label", "");
        final PackageManager pm = getContext().getPackageManager();
        new Thread(new Runnable() {
            @Override
            public void run() {
                JSObject out = new JSObject();
                out.put("dataUrl", null);
                try {
                    ResolveInfo ri = resolveApp(pkg, label);
                    String targetPkg = (ri != null && ri.activityInfo != null)
                            ? ri.activityInfo.packageName : pkg;
                    if (targetPkg == null || targetPkg.isEmpty()) { call.resolve(out); return; }

                    Drawable d = pm.getApplicationIcon(targetPkg);
                    int size = 108;
                    Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
                    Canvas c = new Canvas(bmp);
                    d.setBounds(0, 0, size, size);
                    d.draw(c);

                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.PNG, 100, bos);
                    bmp.recycle();
                    out.put("dataUrl", "data:image/png;base64,"
                            + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
                    out.put("pkg", targetPkg);
                } catch (Throwable t) {
                    // 取不到图标就留 null，渲染层退回预设图标
                }
                call.resolve(out);
            }
        }).start();
    }

    /* ---------------------------------------------- 主题包（.fcpt，v2.5.2）
     * 桌面版主题包引擎在 themes.js（主进程），安卓没有主进程，这里用 Java 实现
     * 同一套最小能力：装（SAF 选包 → base64 进来）/ 删 / 列清单 / 投喂 CSS。
     *
     * 落盘位置：应用专属外部目录 getExternalFilesDir("themes")
     *   = /storage/emulated/0/Android/data/com.fclasspal.widget/files/themes/
     * 这个目录本应用可以自由读写（无需运行时权限），卸载应用即清空。
     * 清单里声明的 READ/WRITE_EXTERNAL_STORAGE 是给 SAF 之外的旧路径兜底。
     *
     * 安全校验对齐 themes.js：zip-slip / 路径越界 / 24MB / 400 条目 / id 规则
     * （[a-zA-Z][a-zA-Z0-9-]{1,23}，大小写敏感，内置 id 大小写变体也不许占）/
     * theme.css 必须真的包含 body.theme-<id>。 */

    private static final Pattern THEME_ID_RE = Pattern.compile("^[a-zA-Z][a-zA-Z0-9-]{1,23}$");
    private static final String[] THEME_BUILTIN_IDS = { "glass", "md3", "fluent", "miuix", "harmony" };
    private static final long THEME_MAX_BYTES = 24L * 1024 * 1024;
    private static final int THEME_MAX_ENTRIES = 400;

    /** 安卓随包附带的离线包在 APK assets 里（assemble-web 从本体 themes/ 复制）。 */
    private static final String ASSET_THEMES_DIR = "public/themes";

    private File themesRoot() {
        File base = getContext().getExternalFilesDir(null);
        if (base == null) base = getContext().getFilesDir();
        return new File(base, "themes");
    }

    private String themesRootPath() {
        try { return themesRoot().getCanonicalPath(); } catch (Throwable t) { return themesRoot().getAbsolutePath(); }
    }

    private static boolean isBuiltinThemeId(String id) {
        for (String b : THEME_BUILTIN_IDS) {
            if (b.equalsIgnoreCase(id)) return true;
        }
        return false;
    }

    /** 预览图 → data URL（超过 200KB 的先缩到 360px 宽 JPEG，省桥） */
    private String previewToDataUrl(File dir, String name) {
        try {
            if (name == null || name.isEmpty()) return null;
            File f = new File(dir, name);
            if (!f.exists() || !f.isFile()) return null;
            byte[] raw = readAll(new FileInputStream(f));
            if (raw.length > 200 * 1024) {
                android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
                int sample = 1;
                while (o.outWidth / sample > 360) sample *= 2;
                o = new android.graphics.BitmapFactory.Options();
                o.inSampleSize = sample;
                android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
                if (bmp == null) return null;
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, bos);
                bmp.recycle();
                return "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            }
            return "data:image/png;base64," + Base64.encodeToString(raw, Base64.NO_WRAP);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 包内 theme.css 的 url("assets/x") → data URL（WebView 按 https://localhost 起源，
     *  file:/// 相对路径与绝对路径都会被拦，直接内嵌最稳）。 */
    private String cssWithEmbeddedAssets(File dir, String css) {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("url\\(\\s*(['\"]?)assets/([^'\")]+)\\1\\s*\\)").matcher(css);
            StringBuffer sb = new StringBuffer();
            while (m.find()) {
                String rep = "none";
                try {
                    String rel = m.group(2);
                    if (rel.indexOf("..") < 0 && !rel.startsWith("/")) {
                        File f = new File(dir, "assets" + File.separator + rel.replace('/', File.separatorChar));
                        if (f.exists() && f.isFile()) {
                            byte[] b = readAll(new FileInputStream(f));
                            String mime = rel.toLowerCase().endsWith(".jpg") || rel.toLowerCase().endsWith(".jpeg")
                                    ? "image/jpeg" : "image/png";
                            rep = "url(\"data:" + mime + ";base64,"
                                    + Base64.encodeToString(b, Base64.NO_WRAP) + "\")";
                        }
                    }
                } catch (Throwable ignored) {
                }
                m.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(rep));
            }
            m.appendTail(sb);
            return sb.toString();
        } catch (Throwable t) {
            return css;
        }
    }

    /** 扫安装目录 → 渲染层 themeInventory 同形的清单（顺序由 JS 层按用户排序整理） */
    private JSObject themeInventoryData() {
        JSObject data = new JSObject();
        com.getcapacitor.JSArray cards = new com.getcapacitor.JSArray();
        com.getcapacitor.JSArray broken = new com.getcapacitor.JSArray();
        File root = themesRoot();
        File[] dirs = root.listFiles();
        if (dirs != null) {
            List<File> list = new ArrayList<File>(Arrays.asList(dirs));
            Collections.sort(list, new Comparator<File>() {
                @Override public int compare(File a, File b) { return a.getName().compareToIgnoreCase(b.getName()); }
            });
            for (File dir : list) {
                if (!dir.isDirectory()) continue;
                try {
                    File mf = new File(dir, "manifest.json");
                    File css = new File(dir, "theme.css");
                    if (!mf.isFile() || !css.isFile()) {
                        JSObject o = new JSObject();
                        o.put("id", dir.getName());
                        o.put("broken", "缺少 manifest.json 或 theme.css");
                        broken.put(o);
                        continue;
                    }
                    JSONObject j = new JSONObject(readAllText(new FileInputStream(mf)));
                    String id = j.optString("id", dir.getName()).trim();
                    if (!THEME_ID_RE.matcher(id).matches() || isBuiltinThemeId(id)) {
                        JSObject o = new JSObject();
                        o.put("id", dir.getName());
                        o.put("broken", "主题 id 不合法");
                        broken.put(o);
                        continue;
                    }
                    JSObject card = new JSObject();
                    card.put("id", id);
                    card.put("name", j.optString("name", id));
                    card.put("version", j.optString("version", "1.0.0"));
                    card.put("author", j.optString("author", "未署名"));
                    card.put("desc", j.optString("description", j.optString("desc", "")));
                    String acc = j.optString("accent", "");
                    card.put("accent", acc.matches("^#[0-9a-fA-F]{6}$") ? acc : "");
                    card.put("fixedPalette", !"false".equals(j.optString("fixedPalette", "true")));
                    card.put("builtin", false);
                    card.put("installed", true);
                    card.put("removable", true);
                    String previewUrl = previewToDataUrl(dir, j.optString("preview", ""));
                    if (previewUrl != null) card.put("previewUrl", previewUrl);
                    cards.put(card);
                } catch (Throwable t) {
                    try {
                        JSObject o = new JSObject();
                        o.put("id", dir.getName());
                        o.put("broken", String.valueOf(t.getMessage()));
                        broken.put(o);
                    } catch (Throwable ignored) {
                    }
                }
            }
        }
        data.put("spec", 1);
        data.put("themes", cards);
        data.put("broken", broken);
        data.put("bundled", bundledThemeList());
        data.put("hasBundled", true);
        data.put("themesDir", themesRootPath());
        JSObject out = new JSObject();
        out.put("success", true);
        out.put("data", data);
        return out;
    }

    /** APK assets 里随包附带的离线主题包清单（装进来后从 themes 清单里走） */
    private com.getcapacitor.JSArray bundledThemeList() {
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        try {
            String[] files = getContext().getAssets().list(ASSET_THEMES_DIR);
            if (files == null) return arr;
            Arrays.sort(files);
            for (String f : files) {
                if (!f.toLowerCase().endsWith(".fcpt")) continue;
                JSObject item = new JSObject();
                item.put("file", f);
                item.put("name", f.substring(0, f.length() - 5));
                item.put("id", "");
                item.put("desc", "");
                item.put("accent", "");
                item.put("version", "");
                item.put("author", "");
                try {
                    InputStream is = getContext().getAssets().open(ASSET_THEMES_DIR + "/" + f);
                    JSONObject j = zipFindManifest(is);
                    is.close();
                    if (j != null) {
                        item.put("id", j.optString("id", ""));
                        item.put("name", j.optString("name", item.getString("name")));
                        item.put("desc", j.optString("description", j.optString("desc", "")));
                        String acc = j.optString("accent", "");
                        item.put("accent", acc.matches("^#[0-9a-fA-F]{6}$") ? acc : "");
                        item.put("version", j.optString("version", ""));
                        item.put("author", j.optString("author", ""));
                    }
                } catch (Throwable ignored) {
                    item.put("broken", "包损坏");
                }
                arr.put(item);
            }
        } catch (Throwable ignored) {
        }
        return arr;
    }

    /** 顺序扫 zip 条目直到抓到 manifest.json（AssetManager 的流只能顺序读） */
    private JSONObject zipFindManifest(InputStream is) throws Exception {
        ZipInputStream zis = new ZipInputStream(is);
        ZipEntry e;
        while ((e = zis.getNextEntry()) != null) {
            String name = e.getName().replace('\\', '/');
            if (e.isDirectory()) continue;
            if (name.equals("manifest.json")) {
                return new JSONObject(readAllText(zis));
            }
            zis.closeEntry();
        }
        return null;
    }

    @PluginMethod
    public void themesList(PluginCall call) {
        try {
            call.resolve(themeInventoryData());
        } catch (Throwable t) {
            JSObject o = new JSObject();
            o.put("success", false);
            o.put("error", String.valueOf(t.getMessage()));
            call.resolve(o);
        }
    }

    /** 已安装主题包的 CSS（assets/ 引用改写成 data URL） */
    @PluginMethod
    public void themesCss(PluginCall call) {
        JSObject out = new JSObject();
        JSObject css = new JSObject();
        try {
            File root = themesRoot();
            File[] dirs = root.listFiles();
            if (dirs != null) {
                for (File dir : dirs) {
                    if (!dir.isDirectory()) continue;
                    try {
                        File mf = new File(dir, "manifest.json");
                        File cssF = new File(dir, "theme.css");
                        if (!mf.isFile() || !cssF.isFile()) continue;
                        JSONObject j = new JSONObject(readAllText(new FileInputStream(mf)));
                        String id = j.optString("id", dir.getName()).trim();
                        if (!THEME_ID_RE.matcher(id).matches() || isBuiltinThemeId(id)) continue;
                        css.put(id, cssWithEmbeddedAssets(dir, readAllText(new FileInputStream(cssF))));
                    } catch (Throwable ignored) {
                    }
                }
            }
            out.put("success", true);
            out.put("css", css);
        } catch (Throwable t) {
            out.put("success", false);
            out.put("error", String.valueOf(t.getMessage()));
            out.put("css", css);
        }
        call.resolve(out);
    }

    /** zip 字节 → 校验 → 落盘 themes/<id>/。返回 {installed, data} 或抛 fail */
    private JSObject themeInstallBytes(byte[] buf) throws Exception {
        if (buf.length > THEME_MAX_BYTES) throw new Exception("主题包太大（上限 24MB）");
        java.util.LinkedHashMap<String, byte[]> entries = new java.util.LinkedHashMap<String, byte[]>();
        ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(buf));
        ZipEntry e;
        while ((e = zis.getNextEntry()) != null) {
            String name = e.getName().replace('\\', '/');
            if (e.isDirectory()) { zis.closeEntry(); continue; }
            if (entries.size() >= THEME_MAX_ENTRIES) throw new Exception("主题包内文件过多（上限 400）");
            if (name.startsWith("/") || name.indexOf(':') == 1 || hasParentRef(name)) {
                throw new Exception("主题包里有非法路径：" + e.getName());
            }
            entries.put(name, readAll(zis));
            zis.closeEntry();
        }
        zis.close();
        byte[] mfRaw = entries.get("manifest.json");
        byte[] cssRaw = entries.get("theme.css");
        if (mfRaw == null || cssRaw == null) throw new Exception("包里没有 manifest.json / theme.css，不是主题包");
        JSONObject mf = new JSONObject(readAllText(new ByteArrayInputStream(mfRaw)));
        String id = mf.optString("id", "").trim();
        if (!THEME_ID_RE.matcher(id).matches()) throw new Exception("主题 id 不合法：" + id);
        if (isBuiltinThemeId(id)) throw new Exception("id「" + id + "」是本体内置主题，主题包不能占用");
        String cssText = readAllText(new ByteArrayInputStream(cssRaw));
        if (!Pattern.compile("body\\.theme-" + Pattern.quote(id) + "\\b").matcher(cssText).find()) {
            throw new Exception("theme.css 里没有 body.theme-" + id + " 规则，选择器必须带主题 id");
        }
        File dest = new File(themesRoot(), id);
        String rootAbs = themesRoot().getCanonicalPath();
        ArrayList<String[]> planned = new ArrayList<String[]>();   // [相对路径, ] → bytes 单独存
        ArrayList<byte[]> plannedBytes = new ArrayList<byte[]>();
        for (String name : entries.keySet()) {
            File target = new File(dest, name);
            if (!target.getCanonicalPath().startsWith(new File(rootAbs, id).getCanonicalPath() + File.separator)) {
                throw new Exception("主题包路径越界：" + name);
            }
            planned.add(new String[] { name });
            plannedBytes.add(entries.get(name));
        }
        // 先清旧装新（覆盖安装）；写一半失败会把目录整个删掉，不留幽灵包
        if (dest.exists()) deleteTree(dest);
        for (int i = 0; i < planned.size(); i++) {
            File target = new File(dest, planned.get(i)[0]);
            target.getParentFile().mkdirs();
            FileOutputStream fos = new FileOutputStream(target);
            fos.write(plannedBytes.get(i));
            fos.close();
        }
        JSObject installed = new JSObject();
        installed.put("id", id);
        installed.put("name", mf.optString("name", id));
        installed.put("version", mf.optString("version", "1.0.0"));
        JSObject out = new JSObject();
        out.put("success", true);
        out.put("installed", installed);
        JSObject inv = themeInventoryData();
        out.put("data", inv.get("data"));
        return out;
    }

    private static boolean hasParentRef(String name) {
        String[] parts = name.split("/");
        for (String p : parts) {
            if ("..".equals(p)) return true;
        }
        return false;
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    private static byte[] readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return bos.toByteArray();
    }

    private static String readAllText(InputStream is) throws Exception {
        return new String(readAll(is), "UTF-8");
    }

    /** 渲染层 themesInstall()：SAF 选包（packPicked 事件）→ base64 进来装 */
    @PluginMethod
    public void themeInstall(final PluginCall call) {
        JSObject out = new JSObject();
        out.put("success", false);
        try {
            String b64 = call.getString("base64", "");
            byte[] buf = Base64.decode(b64 == null ? "" : b64, Base64.DEFAULT);
            if (buf.length == 0) {
                out.put("error", "bad-data");
                call.resolve(out);
                return;
            }
            call.resolve(themeInstallBytes(buf));
        } catch (Throwable t) {
            out.put("error", String.valueOf(t.getMessage()));
            call.resolve(out);
        }
    }

    @PluginMethod
    public void themesRemove(PluginCall call) {
        JSObject out = new JSObject();
        out.put("success", false);
        try {
            String id = call.getString("id", "");
            if (!THEME_ID_RE.matcher(id).matches() || isBuiltinThemeId(id)) {
                out.put("error", "主题 id 不合法");
            } else {
                File dir = new File(themesRoot(), id);
                String rootAbs = themesRoot().getCanonicalPath();
                if (!dir.getCanonicalPath().startsWith(rootAbs + File.separator)) {
                    out.put("error", "路径越界");
                } else if (!dir.exists()) {
                    out.put("error", "主题没安装：" + id);
                } else {
                    deleteTree(dir);
                    out.put("success", true);
                }
            }
        } catch (Throwable t) {
            out.put("error", String.valueOf(t.getMessage()));
        }
        call.resolve(out);
    }

    /** 装随包离线包：file 只认 assets public/themes/ 下的纯文件名（.fcpt） */
    @PluginMethod
    public void themeInstallBundled(final PluginCall call) {
        JSObject out = new JSObject();
        out.put("success", false);
        try {
            String file = call.getString("file", "");
            String base = new File(file == null ? "" : file).getName();
            if (!base.toLowerCase().endsWith(".fcpt")) {
                out.put("error", "离线包路径不合法");
                call.resolve(out);
                return;
            }
            InputStream is = getContext().getAssets().open(ASSET_THEMES_DIR + "/" + base);
            byte[] buf = readAll(is);
            call.resolve(themeInstallBytes(buf));
        } catch (Throwable t) {
            out.put("error", "离线包不存在或损坏：" + String.valueOf(t.getMessage()));
            call.resolve(out);
        }
    }

    /* ------------------------------------------------------------ 杂项 */

    @PluginMethod
    public void toast(PluginCall call) {
        final String text = call.getString("text", "");
        if (getActivity() != null && text != null && !text.isEmpty()) {
            getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(getContext(), text, Toast.LENGTH_SHORT).show();
                }
            });
        }
        call.resolve();
    }

    /** 返回键的默认落点：退到后台而不是杀进程（小部件的常态是"一直在"）。 */
    @PluginMethod
    public void minimize(PluginCall call) {
        if (getActivity() != null) {
            getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    getActivity().moveTaskToBack(true);
                }
            });
        }
        call.resolve();
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        if (getActivity() != null) {
            getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    getActivity().finish();
                }
            });
        }
        call.resolve();
    }
}
