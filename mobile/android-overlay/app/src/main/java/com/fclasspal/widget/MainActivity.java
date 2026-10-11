package com.fclasspal.widget;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * FClassPal 安卓壳入口。
 *
 * 唯一要做的事是把 PalBridgePlugin 注册进 Capacitor 桥——mobile-bridge.js 里
 * window.widgetAPI 的原生部分全部落在这个插件上。注册必须发生在 super.onCreate
 * 之前（Capacitor 在 onCreate 里初始化桥并扫描已注册的插件）。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PalBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
