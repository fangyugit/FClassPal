package com.fclasspal.widget;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/* ============================================================================
 * FClassPal 安卓壳 · 屏幕采集前台服务
 *
 * Android 14（API 34）起硬性要求：调 MediaProjectionManager.getMediaProjection()
 * 之前，必须已经有一个 foregroundServiceType="mediaProjection" 的前台服务在跑，
 * 否则直接 SecurityException。这个服务本身一行采集逻辑都没有（采集循环在
 * RealtimeCapture 里，归属 PalBridgePlugin），它唯一的职责是"举着这条常驻通知"
 * 满足系统要求 —— 状态栏上那条"正在采集屏幕内容"也是给用户的知情提示，合理。
 * ==========================================================================*/
public class ScreenCaptureService extends Service {

    private static final String CH_ID = "fclasspal_capture";
    private static final int NOTI_ID = 0x5A17;

    /** 插件侧轮询这个标记：startForegroundService 是异步的，服务真正跑起来才能
     *  去拿 MediaProjection。onCreate 里置位，onDestroy 里清掉。 */
    public static volatile boolean ready = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CH_ID, "屏幕采集", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("悬浮窗实时模糊需要采集屏幕内容");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CH_ID)
                : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("FClassPal")
                .setContentText("悬浮窗正在实时采集屏幕用于毛玻璃")
                .setOngoing(true);
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTI_ID, n);
        }
        ready = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ready = true;
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        ready = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        super.onDestroy();
    }
}
