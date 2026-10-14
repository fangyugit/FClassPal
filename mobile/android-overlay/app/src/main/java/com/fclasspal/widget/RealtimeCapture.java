package com.fclasspal.widget;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Base64;
import android.view.WindowManager;

import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/* ============================================================================
 * FClassPal 安卓壳 · MediaProjection 实时屏幕采集（悬浮窗的实时毛玻璃底材）
 *
 * 对应桌面版的 getDisplayMedia 实时底材。安卓 WebView 没有 getDisplayMedia，
 * 所以采集完全在原生侧做：录屏 → ImageReader 取帧 → 裁出采样矩形 → JPEG
 * → Base64 → notifyListeners 推给渲染层画进 #deskCanvas。
 *
 * ★ 采样矩形为什么不是本窗口自己：
 *   桌面版用 setContentProtection(true) 把自己从采集中排除，玻璃里看到的就
 *   是"窗口底下"的真实内容。安卓没有这个等价物 —— 不设 FLAG_SECURE 时采到
 *   的自己会形成反馈回路（玻璃套玻璃无限嵌套）；设了 FLAG_SECURE 采到的又是
 *   一块纯黑。所以这里取"与本窗口同尺寸、不与本窗口相交的邻域矩形"（优先
 *   正上/正下/正左/正右，再四个角）：玻璃折射的是身旁正在动的真实画面，视觉
 *   上与"透出壁纸"高度一致（桌面壁纸是连续的），而且永不递归。
 *   悬浮窗已经大到找不到这样的矩形（≈全屏）时返回 reason=fullscreen，渲染层
 *   自动退回静态壁纸底材 —— 和桌面版采集失败时的降级路径同一条。
 *
 * Android 14+ 要求：采集前必须有 mediaProjection 类型的前台服务（见
 * ScreenCaptureService），且 createVirtualDisplay 前必须先注册 Callback。
 *
 * 性能预算：采集长边压到 CAP_EDGE(360px)（底材只做模糊，精度够了），JPEG q70
 * 约 10-20KB/帧，默认 10fps → 桥上 ~200KB/s，中端机可承受。
 * ==========================================================================*/
public class RealtimeCapture {

    /** dataUrl 帧与结束通知的出口（PalBridgePlugin 实现，负责 notifyListeners） */
    interface Listener {
        void onFrame(JSObject frame);

        void onEnded(String reason);
    }

    /** 采集面长边（px）。悬浮窗底材是模糊背景，360 足够；小了省电省桥。 */
    private static final int CAP_EDGE = 360;
    private static final int JPEG_Q = 70;

    private final Context app;
    private Listener listener;
    private MediaProjection projection;
    private VirtualDisplay vdisplay;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler handler;
    private volatile boolean running;
    private volatile boolean paused;              // Activity 退后台时暂停推帧（省电）
    private long lastPushMs;
    private int intervalMs = 100;                 // ~10fps

    private int dispW, dispH;                     // 屏幕物理尺寸
    private int capW, capH;                       // 采集面尺寸（屏幕 / scale）
    private final Rect winRect = new Rect();      // 本窗口矩形（物理像素）
    private final Rect srcRect = new Rect();      // 实际采样矩形（物理像素）

    public RealtimeCapture(Context appContext) {
        this.app = appContext.getApplicationContext();
    }

    public boolean isRunning() {
        return running;
    }

    public void setListener(Listener l) {
        listener = l;
    }

    /** 悬浮窗被拖动/缩放后由插件同步过来：采样矩形跟着重算。 */
    public void setWindowRect(Rect r) {
        if (r == null || r.width() <= 0 || r.height() <= 0) return;
        winRect.set(r);
        computeSrcRect();
    }

    public void setPaused(boolean p) {
        paused = p;
    }

    /**
     * 申请采集。consentData/resultCode 来自系统录屏授权对话框的结果。
     *
     * @return null=成功；否则返回失败原因（fullscreen / fgs-timeout / denied / error）
     */
    public String start(Intent consentData, int resultCode, Rect windowRectPx, int interval) {
        if (running) return null;
        if (windowRectPx == null || windowRectPx.width() <= 0 || windowRectPx.height() <= 0) {
            return "fullscreen";
        }
        Point size = realDisplaySize();
        dispW = size.x;
        dispH = size.y;
        winRect.set(windowRectPx);
        if (!computeSrcRect()) return "fullscreen";   // 找不到不与自己相交的邻域 ≈ 全屏
        if (interval > 0) intervalMs = interval;

        // ① 先起前台服务（Android 14+ 的硬性前置条件），最多等 4s。
        //    悬浮窗模式（窗口类型被改成 TYPE_APPLICATION_OVERLAY）下部分 ROM
        //    把应用当成"在后台"，startForegroundService 会直接抛异常 ——
        //    必须接住并报告，否则调用线程带异常死掉、UI 永远卡在授权等待。
        Intent svc = new Intent(app, ScreenCaptureService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(svc);
            } else {
                app.startService(svc);
            }
        } catch (Throwable t) {
            return "fgs-denied";
        }
        long deadline = SystemClock.uptimeMillis() + 4000;
        while (!ScreenCaptureService.ready && SystemClock.uptimeMillis() < deadline) {
            try {
                Thread.sleep(60);
            } catch (InterruptedException e) {
                break;
            }
        }
        if (!ScreenCaptureService.ready) {
            try { app.stopService(new Intent(app, ScreenCaptureService.class)); } catch (Throwable ignored) { }
            return "fgs-timeout";
        }

        // ② 拿 MediaProjection
        MediaProjectionManager mpm = (MediaProjectionManager)
                app.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        try {
            projection = mpm.getMediaProjection(resultCode, consentData);
        } catch (Throwable t) {
            try { app.stopService(new Intent(app, ScreenCaptureService.class)); } catch (Throwable ignored) { }
            return "denied";
        }
        if (projection == null) {
            try { app.stopService(new Intent(app, ScreenCaptureService.class)); } catch (Throwable ignored) { }
            return "denied";
        }

        // ③ 采集线程 + 回调（API 34 起必须先注册回调再 createVirtualDisplay）
        thread = new HandlerThread("fcp-capture");
        thread.start();
        handler = new Handler(thread.getLooper());
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                teardown();
                if (listener != null) listener.onEnded("系统停止了屏幕采集");
            }
        }, handler);

        // ④ 采集面：屏幕等比缩到长边 CAP_EDGE
        int edge = Math.max(dispW, dispH);
        int scale = Math.max(1, Math.round(edge / (float) CAP_EDGE));
        capW = Math.max(1, Math.round(dispW / (float) scale));
        capH = Math.max(1, Math.round(dispH / (float) scale));
        int dpi = app.getResources().getDisplayMetrics().densityDpi;

        reader = ImageReader.newInstance(capW, capH, PixelFormat.RGBA_8888, 3);
        reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
            @Override
            public void onImageAvailable(ImageReader r) {
                Image img = null;
                try {
                    img = r.acquireLatestImage();
                } catch (Throwable ignored) {
                }
                if (img == null) return;
                try {
                    handleImage(img);
                } catch (Throwable ignored) {
                    // 丢一帧不要紧，下一帧就回来了
                } finally {
                    try {
                        img.close();
                    } catch (Throwable ignored) {
                    }
                }
            }
        }, handler);

        try {
            vdisplay = projection.createVirtualDisplay("fcp-rt",
                    capW, capH, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, handler);
        } catch (Throwable t) {
            teardown();
            return "error";
        }
        running = true;
        lastPushMs = 0;
        return null;
    }

    public void stop() {
        if (!running && projection == null) return;
        teardown();
        if (listener != null) listener.onEnded("已关闭");
    }

    /* ------------------------------------------------------------ 内部实现 */

    private Point realDisplaySize() {
        Point p = new Point(1080, 1920);
        try {
            WindowManager wm = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
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

    /** 找一个与 winRect 同尺寸、不与之相交的邻域矩形；找不到返回 false（≈全屏）。 */
    private boolean computeSrcRect() {
        int w = winRect.width(), h = winRect.height();
        if (w <= 0 || h <= 0 || w >= dispW || h >= dispH) return false;
        int[] dxs = {0, 0, -w, w, -w, w, -w, w};
        int[] dys = {-h, h, 0, 0, -h, -h, h, h};
        for (int i = 0; i < dxs.length; i++) {
            int x = winRect.left + dxs[i];
            int y = winRect.top + dys[i];
            x = Math.max(0, Math.min(x, dispW - w));
            y = Math.max(0, Math.min(y, dispH - h));
            Rect r = new Rect(x, y, x + w, y + h);
            if (!Rect.intersects(r, winRect)) {
                srcRect.set(r);
                return true;
            }
        }
        return false;
    }

    /** RGBA 帧 → 裁采样矩形 → JPEG dataUrl → 出口。节流在拿到帧之后做。 */
    private void handleImage(Image img) {
        long now = SystemClock.uptimeMillis();
        if (!running || paused || now - lastPushMs < intervalMs) return;

        Image.Plane pl = img.getPlanes()[0];
        int w = img.getWidth(), h = img.getHeight();
        int rowStride = pl.getRowStride(), pxStride = pl.getPixelStride();
        Bitmap full;
        ByteBuffer bb = pl.getBuffer();
        bb.rewind();
        try {
            int padW = rowStride / pxStride;          // 行尾有对齐填充时宽一点
            if (padW == w) {
                full = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                full.copyPixelsFromBuffer(bb);
            } else {
                Bitmap padded = Bitmap.createBitmap(padW, h, Bitmap.Config.ARGB_8888);
                padded.copyPixelsFromBuffer(bb);
                full = Bitmap.createBitmap(padded, 0, 0, w, h);   // 裁掉右侧填充列
            }
        } catch (Throwable t) {
            return;
        }

        // 采样矩形 → 采集面坐标（等比缩放）
        float k = capW / (float) Math.max(1, dispW);
        int sx = Math.max(0, Math.min(capW - 1, Math.round(srcRect.left * k)));
        int sy = Math.max(0, Math.min(capH - 1, Math.round(srcRect.top * k)));
        int sw = Math.max(1, Math.min(capW - sx, Math.round(srcRect.width() * k)));
        int sh = Math.max(1, Math.min(capH - sy, Math.round(srcRect.height() * k)));
        Bitmap crop;
        try {
            crop = Bitmap.createBitmap(full, sx, sy, sw, sh);
        } catch (Throwable t) {
            full.recycle();
            return;
        }
        lastPushMs = now;

        if (listener != null) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            crop.compress(Bitmap.CompressFormat.JPEG, JPEG_Q, bos);
            JSObject f = new JSObject();
            f.put("dataUrl", "data:image/jpeg;base64,"
                    + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            f.put("w", crop.getWidth());
            f.put("h", crop.getHeight());
            listener.onFrame(f);
        }
        if (crop != full) crop.recycle();
        full.recycle();
    }

    private void teardown() {
        running = false;
        final MediaProjection p = projection;
        final VirtualDisplay vd = vdisplay;
        final ImageReader ir = reader;
        final HandlerThread ht = thread;
        projection = null;
        vdisplay = null;
        reader = null;
        thread = null;
        handler = null;
        Runnable clean = new Runnable() {
            @Override
            public void run() {
                try {
                    if (ir != null) ir.close();
                } catch (Throwable ignored) {
                }
                try {
                    if (vd != null) vd.release();
                } catch (Throwable ignored) {
                }
                try {
                    if (p != null) p.stop();
                } catch (Throwable ignored) {
                }
            }
        };
        if (ht != null) {
            new Handler(ht.getLooper()).post(clean);
            ht.quitSafely();
        } else {
            clean.run();
        }
        try {
            app.stopService(new Intent(app, ScreenCaptureService.class));
        } catch (Throwable ignored) {
        }
    }
}
