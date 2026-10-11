package com.fclasspal.widget;

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
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

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
