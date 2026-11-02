/* ============================================================================
 * FClassPal · WearOS 壳（v2.6.4）
 *
 * ⚠ 与 mobile/ 的手表端不同：WearOS **没有 WebView**（系统根本不带，
 *   Android System WebView 也没法在手表上跑），所以这里不能像安卓手机版那样
 *   把 renderer/ 塞进去。整套界面用原生 Java + framework 视图手写，
 *   不引 AndroidX、不引 Compose —— 依赖为零，构建只需要 AGP 本身。
 *
 * 功能对齐（"功能尽量实现"）：
 *   · 配对电脑：UDP 广播自动发现 + 手输 IP/6 位码，配对后 token 长存
 *   · 看分组 / 看图标（含文件夹，可进二级）
 *   · 点一下 = 让电脑打开这个快捷方式
 *   · 长按 = 编辑：改名 / 上移 / 下移 / 删除（条目与分组都支持）
 *   · 圆屏方屏自适应（isScreenRound 决定圆角与左右留白）
 *   · MD3 风格：深色 surface、容器色卡片、主色高亮、pill 圆角
 *
 * 轮询而不是长连接：WearOS 上写原生 WebSocket 客户端要自己实现握手/掩码/
 * 分片，出错面太大；HTTP 轮询在教室这种"改一下看一眼"的场景完全够用。
 * ==========================================================================*/
package com.fclasspal.wear;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    /* ---------- MD3 深色配色（手表就适合深底亮字） ---------- */
    private static final String C_BG = "#0D1014";
    private static final String C_SURFACE = "#1B1F26";
    private static final String C_SURFACE_HI = "#242A33";
    private static final String C_PRIMARY = "#A8C7FA";
    private static final String C_ON = "#E3E6EB";
    private static final String C_ON_VAR = "#9AA0AA";
    private static final String C_DANGER = "#F2B8B5";
    private static final String C_OK = "#7ADFA0";

    private static final int TAB_PAIR = 0;
    private static final int TAB_GROUPS = 1;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private boolean round;
    private int tab = TAB_GROUPS;
    private String openGroupId = null;     // 非空 = 正在看某个分组里的条目
    private JSONObject state;              // 最近一次拿到的快照
    private String statusText = "";
    private boolean netBusy = false;

    private LinearLayout col;
    private EditText ipInput;
    private EditText codeInput;
    private Runnable pollTask;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        round = getResources().getConfiguration().isScreenRound();
        prefs = getSharedPreferences("fclasspal_wear", MODE_PRIVATE);

        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.parseColor(C_BG));
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int hpad = dp(round ? 22 : 12);
        col.setPadding(hpad, dp(8), hpad, dp(16));
        sv.addView(col, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        frame.addView(sv, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(frame);

        if (isPaired()) {
            tab = TAB_GROUPS;
            refresh(true);
        } else {
            tab = TAB_PAIR;
            render();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        startPoll();
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopPoll();
    }

    /* 手表一直开着屏会烧电；只在可见时按 5s 轮询一次 */
    private void startPoll() {
        stopPoll();
        if (!isPaired()) return;
        pollTask = new Runnable() {
            @Override public void run() {
                refresh(false);
                ui.postDelayed(this, 5000);
            }
        };
        ui.postDelayed(pollTask, 5000);
    }

    private void stopPoll() {
        if (pollTask != null) { ui.removeCallbacks(pollTask); pollTask = null; }
    }

    /* ---------- 配置存取 ---------- */
    private boolean isPaired() {
        return prefs.getString("token", "").length() > 8 && prefs.getString("ip", "").length() > 0;
    }
    private String ip() { return prefs.getString("ip", ""); }
    private int port() { return prefs.getInt("port", 47820); }
    private String token() { return prefs.getString("token", ""); }
    private String pcName() { return prefs.getString("pcName", "电脑"); }

    private void savePair(String ip, int port, String token, String name) {
        prefs.edit()
            .putString("ip", ip)
            .putInt("port", port)
            .putString("token", token)
            .putString("pcName", name == null ? "电脑" : name)
            .apply();
    }

    /* ---------- 小工具 ---------- */
    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
            getResources().getDisplayMetrics());
    }

    private GradientDrawable bg(String color, float radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.parseColor(color));
        d.setCornerRadius(dp(radiusDp));
        return d;
    }

    private RippleDrawable ripple(GradientDrawable base) {
        return new RippleDrawable(ColorStateList.valueOf(Color.parseColor("#33FFFFFF")), base, null);
    }

    private TextView text(String s, int sizeSp, String color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(Color.parseColor(color));
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private void gap(int dp) {
        View v = new View(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(dp));
        col.addView(v, lp);
    }

    /* 一行卡片：标题 + 副标题，可点可长按 */
    private void card(String title, String sub, View.OnClickListener click,
                      View.OnLongClickListener longClick) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(9), dp(14), dp(9));
        box.setBackground(ripple(bg(C_SURFACE, round ? 24 : 16)));

        TextView t = text(title, 15, C_ON, true);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        box.addView(t);
        if (sub != null && sub.length() > 0) {
            TextView s = text(sub, 11, C_ON_VAR, false);
            s.setSingleLine(true);
            s.setEllipsize(TextUtils.TruncateAt.END);
            box.addView(s);
        }
        if (click != null) { box.setOnClickListener(click); box.setClickable(true); }
        if (longClick != null) { box.setOnLongClickListener(longClick); }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(8);
        col.addView(box, lp);
    }

    /* 胶囊按钮 */
    private TextView chip(String label, String color, View.OnClickListener click) {
        TextView b = text(label, 12, "#10131A", true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(14), dp(7), dp(14), dp(7));
        b.setBackground(ripple(bg(color, 20)));
        b.setOnClickListener(click);
        return b;
    }

    private LinearLayout chipRow() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(10);
        r.setLayoutParams(lp);
        return r;
    }

    private void addChip(LinearLayout row, TextView chip) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(8);
        row.addView(chip, lp);
    }

    /* ---------- 渲染 ---------- */
    private void render() {
        col.removeAllViews();
        ipInput = null;
        codeInput = null;

        /* 顶部：应用名 + 状态（MD3 的 "label + supporting text"） */
        TextView title = text(tab == TAB_PAIR ? "配对电脑" : "FClassPal", 17, C_ON, true);
        title.setGravity(Gravity.CENTER);
        col.addView(title);
        String sub = statusText;
        if (sub.isEmpty()) {
            sub = tab == TAB_PAIR
                ? "在电脑上开到 WearOS 手表，念 6 位码"
                : (isPaired() ? pcName() : "未配对");
        }
        TextView st = text(sub, 11, C_ON_VAR, false);
        st.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams stlp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stlp.bottomMargin = dp(10);
        col.addView(st, stlp);

        if (tab == TAB_PAIR) { renderPair(); return; }
        if (openGroupId == null) renderGroups(); else renderItems();
    }

    private void renderPair() {
        TextView hint = text("电脑端：设置 → WearOS 手表 → 打开「局域网连接」，"
            + "屏幕上是 6 位配对码。手表与电脑要连同一个 Wi-Fi。", 11, C_ON_VAR, false);
        hint.setLineSpacing(dp(2), 1f);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.bottomMargin = dp(10);
        col.addView(hint, hlp);

        ipInput = new EditText(this);
        ipInput.setHint("电脑 IP，例如 192.168.1.20");
        ipInput.setSingleLine(true);
        ipInput.setInputType(InputType.TYPE_CLASS_TEXT);
        ipInput.setTextColor(Color.parseColor(C_ON));
        ipInput.setHintTextColor(Color.parseColor(C_ON_VAR));
        ipInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        ipInput.setBackground(ripple(bg(C_SURFACE, 14)));
        ipInput.setPadding(dp(12), dp(9), dp(12), dp(9));
        ipInput.setText(ip());
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ilp.bottomMargin = dp(8);
        col.addView(ipInput, ilp);

        codeInput = new EditText(this);
        codeInput.setHint("6 位配对码");
        codeInput.setSingleLine(true);
        codeInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        codeInput.setTextColor(Color.parseColor(C_ON));
        codeInput.setHintTextColor(Color.parseColor(C_ON_VAR));
        codeInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        codeInput.setBackground(ripple(bg(C_SURFACE, 14)));
        codeInput.setPadding(dp(12), dp(9), dp(12), dp(9));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.bottomMargin = dp(10);
        col.addView(codeInput, clp);

        LinearLayout row = chipRow();
        addChip(row, chip("自动发现", C_PRIMARY, new View.OnClickListener() {
            @Override public void onClick(View v) { doDiscover(); }
        }));
        addChip(row, chip("连接", C_PRIMARY, new View.OnClickListener() {
            @Override public void onClick(View v) { doPair(); }
        }));
        col.addView(row);
    }

    private void renderGroups() {
        LinearLayout row = chipRow();
        addChip(row, chip("刷新", C_PRIMARY, new View.OnClickListener() {
            @Override public void onClick(View v) { refresh(true); }
        }));
        addChip(row, chip("换电脑", C_SURFACE_HI, new View.OnClickListener() {
            @Override public void onClick(View v) { confirmUnpair(); }
        }));
        col.addView(row);

        JSONArray groups = state == null ? null : state.optJSONArray("groups");
        if (groups == null || groups.length() == 0) {
            TextView t = text(netBusy ? "正在读取…" : "电脑上还没有分组\n先在电脑端加几个快捷方式",
                12, C_ON_VAR, false);
            t.setGravity(Gravity.CENTER);
            t.setLineSpacing(dp(3), 1f);
            col.addView(t);
            return;
        }
        for (int i = 0; i < groups.length(); i++) {
            final JSONObject g = groups.optJSONObject(i);
            if (g == null) continue;
            final String gid = g.optString("id");
            final String gname = g.optString("name", "分组");
            JSONArray items = g.optJSONArray("items");
            final int n = items == null ? 0 : items.length();
            card(gname, n + " 个快捷方式",
                new View.OnClickListener() {
                    @Override public void onClick(View v) { openGroupId = gid; render(); }
                },
                new View.OnLongClickListener() {
                    @Override public boolean onLongClick(View v) {
                        groupMenu(gid, gname);
                        return true;
                    }
                });
        }
    }

    private void renderItems() {
        JSONObject g = findGroup(openGroupId);
        String gname = g == null ? "分组" : g.optString("name", "分组");

        LinearLayout row = chipRow();
        addChip(row, chip("返回", C_SURFACE_HI, new View.OnClickListener() {
            @Override public void onClick(View v) { openGroupId = null; render(); }
        }));
        addChip(row, chip("刷新", C_PRIMARY, new View.OnClickListener() {
            @Override public void onClick(View v) { refresh(true); }
        }));
        col.addView(row);

        TextView head = text(gname, 13, C_PRIMARY, true);
        head.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.bottomMargin = dp(8);
        col.addView(head, hlp);

        JSONArray items = g == null ? null : g.optJSONArray("items");
        if (items == null || items.length() == 0) {
            TextView t = text("这个分组是空的", 12, C_ON_VAR, false);
            t.setGravity(Gravity.CENTER);
            col.addView(t);
            return;
        }
        /* 文件夹不做二级页面（手表屏幕太小，来回跳很烦），直接把子项摊平展示：
         * 文件夹本身一行（长按可改名/删），子项各占一行并带「↳」前缀，点一下照常打开。 */
        for (int i = 0; i < items.length(); i++) {
            final JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            final String id = it.optString("id");
            String kind = it.optString("kind", "app");
            JSONArray kids = it.optJSONArray("items");
            final boolean folder = "folder".equals(kind);
            String label = folder ? "文件夹" : ("web".equals(kind) ? "网页" : "应用");
            if (folder && kids != null) label += " · " + kids.length() + " 项";
            card(it.optString("name", "未命名"), label + (folder ? " · 长按可改名" : " · 点一下在电脑上打开"),
                folder ? null : new View.OnClickListener() {
                    @Override public void onClick(View v) { launchItem(id); }
                },
                new View.OnLongClickListener() {
                    @Override public boolean onLongClick(View v) {
                        itemMenu(id, it.optString("name", ""));
                        return true;
                    }
                });
            if (folder && kids != null) {
                for (int k = 0; k < kids.length(); k++) {
                    final JSONObject c = kids.optJSONObject(k);
                    if (c == null) continue;
                    final String cid = c.optString("id");
                    String ck = c.optString("kind", "app");
                    card("↳ " + c.optString("name", "未命名"),
                        ("web".equals(ck) ? "网页" : "应用") + " · 点一下在电脑上打开",
                        new View.OnClickListener() {
                            @Override public void onClick(View v) { launchItem(cid); }
                        },
                        new View.OnLongClickListener() {
                            @Override public boolean onLongClick(View v) {
                                itemMenu(cid, c.optString("name", ""));
                                return true;
                            }
                        });
                }
            }
        }
    }

    private JSONObject findGroup(String gid) {
        JSONArray groups = state == null ? null : state.optJSONArray("groups");
        if (groups == null) return null;
        for (int i = 0; i < groups.length(); i++) {
            JSONObject g = groups.optJSONObject(i);
            if (g != null && gid.equals(g.optString("id"))) return g;
        }
        return null;
    }

    /* ---------- 网络动作 ---------- */
    private void setStatus(String s) {
        statusText = s == null ? "" : s;
        render();
    }

    private void refresh(final boolean manual) {
        if (!isPaired() || netBusy) return;
        netBusy = true;
        final String ip = ip(), tok = token();
        final int port = port();
        new Thread(new Runnable() {
            @Override public void run() {
                String err = null;
                JSONObject st = null;
                try {
                    JSONObject r = Api.request("GET", ip, port, "/fcp/state", null, tok, 4000);
                    if (r.optBoolean("ok")) st = r.optJSONObject("state");
                    else if (r.optInt("status") == 401) err = "配对已失效，请重新配对";
                    else err = "连接失败（" + r.optString("error", "?") + "）";
                } catch (Exception e) {
                    err = "连不上 " + ip + ":" + port;
                }
                final JSONObject fst = st;
                final String ferr = err;
                ui.post(new Runnable() {
                    @Override public void run() {
                        netBusy = false;
                        if (fst != null) { state = fst; statusText = "已连接 " + pcName(); }
                        else if (ferr != null) statusText = ferr;
                        if (manual && ferr != null) toast(ferr);
                        if (ferr != null && ferr.contains("失效")) {
                            prefs.edit().putString("token", "").apply();
                            tab = TAB_PAIR;
                        }
                        render();
                    }
                });
            }
        }).start();
    }

    private void doDiscover() {
        statusText = "正在搜索局域网里的电脑…";
        render();
        new Thread(new Runnable() {
            @Override public void run() {
                final JSONObject found = Discovery.find(2500);
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (found == null) {
                            statusText = "没搜到。确认电脑开着「局域网连接」、同一 Wi-Fi";
                            render();
                            return;
                        }
                        String fip = found.optString("ip", "");
                        int fport = found.optInt("port", 47820);
                        statusText = "找到 " + found.optString("name", "电脑") + "（" + fip + "）";
                        prefs.edit().putInt("port", fport).apply();
                        render();
                        if (ipInput != null) ipInput.setText(fip);
                        toast("已填入 IP，输 6 位码即可");
                    }
                });
            }
        }).start();
    }

    private void doPair() {
        final String ip = ipInput == null ? "" : ipInput.getText().toString().trim();
        final String code = codeInput == null ? "" : codeInput.getText().toString().replaceAll("\\D", "");
        if (ip.length() < 7) { toast("先填电脑 IP"); return; }
        if (code.length() != 6) { toast("配对码是 6 位数字"); return; }
        statusText = "正在配对…";
        render();
        new Thread(new Runnable() {
            @Override public void run() {
                String err = null;
                JSONObject r = null;
                try {
                    JSONObject body = new JSONObject();
                    body.put("code", code);
                    body.put("device", android.os.Build.MODEL == null ? "WearOS" : android.os.Build.MODEL);
                    r = Api.request("POST", ip, port(), "/fcp/pair", body, null, 6000);
                } catch (Exception e) {
                    err = "连不上 " + ip;
                }
                final JSONObject fr = r;
                final String ferr = err;
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (ferr != null) { statusText = ferr; render(); toast(ferr); return; }
                        if (fr == null || !fr.optBoolean("ok")) {
                            String why = fr == null ? "无响应" : fr.optString("error", "配对失败");
                            if ("bad-code".equals(why)) why = "配对码不对";
                            else if ("too-many-tries".equals(why)) why = "试太多次了，等一分钟";
                            statusText = why;
                            render();
                            toast(why);
                            return;
                        }
                        savePair(ip, fr.optInt("port", port()), fr.optString("token", ""),
                            fr.optString("name", "电脑"));
                        tab = TAB_GROUPS;
                        statusText = "已连接 " + pcName();
                        render();
                        refresh(true);
                    }
                });
            }
        }).start();
    }

    private void launchItem(final String id) {
        if (netBusy) return;
        netBusy = true;
        toast("正在打开…");
        final String ip = ip(), tok = token();
        final int port = port();
        new Thread(new Runnable() {
            @Override public void run() {
                String msg = null;
                try {
                    JSONObject body = new JSONObject();
                    body.put("action", "launch");
                    body.put("itemId", id);
                    JSONObject r = Api.request("POST", ip, port, "/fcp/action", body, tok, 6000);
                    msg = r.optBoolean("ok") ? r.optString("message", "已通知电脑")
                        : "失败：" + r.optString("error", "?");
                    JSONObject st = r.optJSONObject("state");
                    if (st != null) state = st;
                } catch (Exception e) {
                    msg = "连不上电脑";
                }
                final String fm = msg;
                ui.post(new Runnable() {
                    @Override public void run() { netBusy = false; toast(fm); render(); }
                });
            }
        }).start();
    }

    private void sendAction(JSONObject body, final String okMsg) {
        if (netBusy) { toast("等一下，上一个还在路上"); return; }
        netBusy = true;
        final String ip = ip(), tok = token();
        final int port = port();
        new Thread(new Runnable() {
            @Override public void run() {
                String msg;
                try {
                    JSONObject r = Api.request("POST", ip, port, "/fcp/action", body, tok, 6000);
                    msg = r.optBoolean("ok") ? okMsg : ("失败：" + r.optString("error", "?"));
                    JSONObject st = r.optJSONObject("state");
                    if (st != null) state = st;
                } catch (Exception e) {
                    msg = "连不上电脑";
                }
                final String fm = msg;
                ui.post(new Runnable() {
                    @Override public void run() { netBusy = false; toast(fm); render(); }
                });
            }
        }).start();
    }

    /* ---------- 编辑菜单 ---------- */
    private void itemMenu(final String id, final String name) {
        new AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(new String[]{"改名", "上移", "下移", "删除"}, new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int which) {
                    if (which == 0) renameDialog("renameItem", "itemId", id, name);
                    else if (which == 1) moveItem(id, "up");
                    else if (which == 2) moveItem(id, "down");
                    else confirmDeleteItem(id, name);
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void groupMenu(final String gid, final String name) {
        new AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(new String[]{"分组改名", "分组上移", "分组下移"}, new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int which) {
                    if (which == 0) renameDialog("renameGroup", "groupId", gid, name);
                    else moveGroup(gid, which == 1 ? "up" : "down");
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void renameDialog(final String action, final String idKey, final String id, String cur) {
        final EditText et = new EditText(this);
        et.setText(cur);
        et.setSingleLine(true);
        et.setSelection(et.getText().length());
        et.setTextColor(Color.parseColor(C_ON));
        et.setInputType(InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(this)
            .setTitle("新名字")
            .setView(et)
            .setPositiveButton("保存", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) {
                    String v = et.getText().toString().trim();
                    if (v.isEmpty()) { toast("名字不能为空"); return; }
                    try {
                        JSONObject body = new JSONObject();
                        body.put("action", action);
                        body.put(idKey, id);
                        body.put("name", v);
                        sendAction(body, "已改名");
                    } catch (JSONException e) { toast("改名失败"); }
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void moveItem(String id, String dir) {
        try {
            JSONObject body = new JSONObject();
            body.put("action", "moveItem");
            body.put("itemId", id);
            body.put("dir", dir);
            sendAction(body, "顺序已调整");
        } catch (JSONException e) { toast("调整失败"); }
    }

    private void moveGroup(String gid, String dir) {
        try {
            JSONObject body = new JSONObject();
            body.put("action", "moveGroup");
            body.put("groupId", gid);
            body.put("dir", dir);
            sendAction(body, "分组顺序已调整");
        } catch (JSONException e) { toast("调整失败"); }
    }

    private void confirmDeleteItem(final String id, String name) {
        new AlertDialog.Builder(this)
            .setTitle("删除「" + name + "」？")
            .setMessage("电脑上这个快捷方式也会被删掉")
            .setPositiveButton("删除", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) {
                    try {
                        JSONObject body = new JSONObject();
                        body.put("action", "deleteItem");
                        body.put("itemId", id);
                        sendAction(body, "已删除");
                    } catch (JSONException e) { toast("删除失败"); }
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void confirmUnpair() {
        new AlertDialog.Builder(this)
            .setTitle("换一台电脑？")
            .setMessage("会清掉这台手表的配对信息，电脑那边要在设置里重新给码")
            .setPositiveButton("重新配对", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) {
                    prefs.edit().putString("token", "").apply();
                    state = null;
                    statusText = "";
                    tab = TAB_PAIR;
                    render();
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void toast(String s) {
        if (s == null || s.length() == 0) return;
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }
}
