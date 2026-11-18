package com.fclasspal.widget;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * FClassPal 安卓壳入口。
 *
 * 把 PalBridgePlugin 注册进 Capacitor 桥——mobile-bridge.js 里
 * window.widgetAPI 的原生部分全部落在这个插件上。注册必须发生在 super.onCreate
 * 之前（Capacitor 在 onCreate 里初始化桥并扫描已注册的插件）。
 *
 * v2.6.9b：WearOS 版界面融合进来（源码从独立手表工程 wearos/ 移植，包名
 * com.fclasspal.wear 原样保留）。没有 WebView 的设备（精简 ROM / 老盒子，
 * Capacitor 根本起不来）在这里自动落到 wear 界面；有 WebView 的设备也可以
 * 从设置里手动打开（PalBridgePlugin.openWearUi）。独立手表 APK 不受影响。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        if (!hasWebView()) {
            // WebView 缺失：Capacitor 界面必然起不来，直接进纯 Java 的 wear 界面
            startActivity(new Intent(this, com.fclasspal.wear.MainActivity.class));
            finish();
            return;
        }
        registerPlugin(PalBridgePlugin.class);
        installSplashTheme();
        super.onCreate(savedInstanceState);
        hideActionBar();
    }

    /**
     * v2.6.8-fix3：把启动屏主题换回 NoActionBar。
     *
     * Activity 挂的是 AppTheme.NoActionBarLaunch（父主题 Theme.SplashScreen），
     * 只有 androidx 的 installSplashScreen() 被调用过，postSplashScreenTheme
     * 才会把主题换成 NoActionBar。Capacitor 本体不带 splash 插件时没人调它，
     * 主题就停在启动屏那份；个别 ROM 上那份会带出 ActionBar —— 用户看到的
     * 就是「页面顶部出现原生标题条」。必须早于 super.onCreate 调用（官方要求）。
     * 反射调用：没有 splash 库的老壳子也不至于因此崩。
     */
    private void installSplashTheme() {
        try {
            Class<?> cls = Class.forName("androidx.core.splashscreen.SplashScreen");
            cls.getMethod("installSplashScreen", android.app.Activity.class).invoke(null, this);
        } catch (Throwable ignored) {
        }
    }

    /** 兜底：万一主题仍有 ActionBar（改主题、换 ROM），代码里也把它按掉。 */
    private void hideActionBar() {
        try {
            if (getSupportActionBar() != null) getSupportActionBar().hide();
        } catch (Throwable ignored) {
        }
    }

    /** 真机探测：new 一个 WebView 再销毁。缺 provider 的 ROM 会在这里抛异常。 */
    private boolean hasWebView() {
        try {
            WebView wv = new WebView(this);
            wv.destroy();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
