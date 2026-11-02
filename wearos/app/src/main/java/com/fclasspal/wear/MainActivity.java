/* ============================================================================
 * FClassPal · WearOS 壳（v2.6.4A）
 *
 * WearOS 没有 WebView（系统不带，Android System WebView 也跑不动），所以整套
 * 界面用原生 Java + framework 视图手写，不引 AndroidX / Compose，依赖为零。
 *
 * v2.6.4A 定位：**手表自己的独立启动器**，附带连接电脑的能力——
 *   ① 本机模式：把手表上装的应用 / 网页加进自己的分组，点一下直接在手表上启动；
 *      分组与条目都可以改名 / 排序 / 删除 / 新建，数据存在手表自己的 config.json。
 *   ② 主题：内置只有 MD3 一套；用户把主题 .json 放进手表存储的
 *      Android/data/com.fclasspal.wear/files/themes/ 目录即可换肤（也放配置）。
 *   ③ 配置导入：同目录里带 groups 字段的 .json 可以整份导入成本机分组。
 *   ④ 电脑模式：配对后看电脑的分组 / 条目，点一下在电脑上打开，长按编辑
 *      （改名 / 排序 / 删除，与之前一致）。
 *   ⑤ 电脑设置：配对后可以直接在手表上调电脑的透明度 / 窗口大小 / 布局 / 主题。
 *
 * 文案纪律：界面里**不放使用说明**，控件自身可读即可。
 *
 * 轮询而不是长连接：WearOS 写原生 WebSocket 客户端要自己实现握手/掩码/分片，
 * 出错面太大；HTTP 轮询在"改一下看一眼"的场景完全够用。
 * ==========================================================================*/
package com.fclasspal.wear;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
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

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    /* ---------- 配色：默认 MD3 深色；主题导入后整套可换 ---------- */
    private String cBg = "#0D1014";
    private String cSurface = "#1B1F26";
    private String cSurfaceHi = "#242A33";
    private String cPrimary = "#A8C7FA";
    private String cOn = "#E3E6EB";
    private String cOnVar = "#9AA0AA";
    private String cDanger = "#F2B8B5";
    private String cOk = "#7ADFA0";

    private static final int TAB_PAIR = 0;
    private static final int TAB_PC = 1;
    private static final int TAB_LOCAL = 2;

    /* 列表页 / 设置页 / 主题页（电脑与本机各一套，互不干扰） */
    private static final int VIEW_LIST = 0;
    private static final int VIEW_SETTINGS = 1;
    private static final int VIEW_THEMES = 2;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private boolean round;
    private int tab = TAB_LOCAL;
    private int pcView = VIEW_LIST;
    private int locView = VIEW_LIST;
    private String openGroupId = null;     // 非空 = 正在看某个分组里的条目
    private JSONObject state;              // 最近一次拿到的电脑快照
    private String statusText = "";
    private boolean netBusy = false;

    private JSONObject localConfig;        // 本机启动器数据 {groups:[...]}
    private String themeId = "md3";

    private LinearLayout col;
    private EditText ipInput;
    private EditText codeInput;
    private Runnable pollTask;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        round = getResources().getConfiguration().isScreenRound();
        prefs = getSharedPreferences("fclasspal_wear", MODE_PRIVATE);
        applyThemeColors();
        loadLocal();

        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.parseColor(cBg));
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

        tab = isPaired() ? TAB_PC : TAB_LOCAL;
        if (isPaired()) refresh(true); else render();
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

    /* ---------- 配对信息存取（token 长存，配对一次一直可用） ---------- */
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

    /* ---------- 主题 ---------- */
    private File themeDir() {
        File base = getExternalFilesDir(null);
        File f = new File(base == null ? getFilesDir() : base, "themes");
        if (!f.exists()) f.mkdirs();
        return f;
    }

    private static String readFile(File f) throws IOException {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            try { in.close(); } catch (IOException e) { /* 已关 */ }
        }
    }

    private static void writeFile(File f, String s) throws IOException {
        FileOutputStream out = new FileOutputStream(f);
        try { out.write(s.getBytes("UTF-8")); }
        finally { try { out.close(); } catch (IOException e) { /* 已关 */ } }
    }

    /* 颜色键取值：非法/缺失就保留默认 */
    private static String pick(JSONObject o, String key, String def) {
        String v = o.optString(key, "");
        if (v.length() == 0) return def;
        try { Color.parseColor(v); return v; } catch (IllegalArgumentException e) { return def; }
    }

    private void applyThemeColors() {
        cBg = "#0D1014"; cSurface = "#1B1F26"; cSurfaceHi = "#242A33"; cPrimary = "#A8C7FA";
        cOn = "#E3E6EB"; cOnVar = "#9AA0AA"; cDanger = "#F2B8B5"; cOk = "#7ADFA0";
        themeId = prefs.getString("themeId", "md3");
        if ("md3".equals(themeId)) return;
        File f = new File(themeDir(), themeId + ".json");
        if (!f.isFile()) { themeId = "md3"; return; }
        try {
            JSONObject o = new JSONObject(readFile(f));
            cBg = pick(o, "bg", cBg);
            cSurface = pick(o, "surface", cSurface);
            cSurfaceHi = pick(o, "surfaceHi", pick(o, "surface_hi", cSurfaceHi));
            cPrimary = pick(o, "primary", cPrimary);
            cOn = pick(o, "on", cOn);
            cOnVar = pick(o, "onVar", pick(o, "on_var", cOnVar));
            cDanger = pick(o, "danger", cDanger);
            cOk = pick(o, "ok", cOk);
        } catch (Exception e) {
            themeId = "md3";
        }
    }

    private String themeDisplayName(String id, File f) {
        try {
            JSONObject o = new JSONObject(readFile(f));
            String n = o.optString("name", "");
            if (n.length() > 0) return n;
        } catch (Exception e) { /* 名字拿不到就用文件名 */ }
        return id;
    }

    private void setThemeId(String id) {
        themeId = id;
        prefs.edit().putString("themeId", id).apply();
        applyThemeColors();
        View root = (View) col.getParent().getParent();
        root.setBackgroundColor(Color.parseColor(cBg));
        render();
    }

    /* ---------- 本机启动器数据 ---------- */
    private File localFile() { return new File(getFilesDir(), "config.json"); }

    private void loadLocal() {
        try {
            localConfig = new JSONObject(readFile(localFile()));
        } catch (Exception e) {
            localConfig = new JSONObject();
        }
        if (localConfig.optJSONArray("groups") == null) {
            try { localConfig.put("groups", new JSONArray()); } catch (JSONException e) { /* 不会发生 */ }
        }
    }

    private void saveLocal() {
        try { writeFile(localFile(), localConfig.toString()); }
        catch (Exception e) { toast("保存失败"); }
    }

    private JSONArray lGroups() { return localConfig.optJSONArray("groups"); }

    private JSONObject findLGroup(String gid) {
        JSONArray gs = lGroups();
        for (int i = 0; i < gs.length(); i++) {
            JSONObject g = gs.optJSONObject(i);
            if (g != null && gid.equals(g.optString("id"))) return g;
        }
        return null;
    }

    private static String newId() {
        return "l" + Long.toString(System.currentTimeMillis(), 36)
            + Integer.toString((int) (Math.random() * 1296), 36);
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

    /* 一行卡片：可带副标题（数据性文字，绝不放说明），可点可长按 */
    private void card(String title, String sub, View.OnClickListener click,
                      View.OnLongClickListener longClick) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(9), dp(14), dp(9));
        box.setBackground(ripple(bg(cSurface, round ? 24 : 16)));

        TextView t = text(title, 15, cOn, true);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        box.addView(t);
        if (sub != null && sub.length() > 0) {
            TextView s = text(sub, 11, cOnVar, false);
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

    private void centerNote(String s) {
        TextView t = text(s, 12, cOnVar, false);
        t.setGravity(Gravity.CENTER);
        t.setLineSpacing(dp(3), 1f);
        col.addView(t);
    }

    /* ---------- 渲染 ---------- */
    private void render() {
        col.removeAllViews();
        ipInput = null;
        codeInput = null;

        String title;
        if (tab == TAB_PAIR) title = "配对电脑";
        else if (tab == TAB_PC) title = pcView == VIEW_LIST ? (openGroupId == null ? "FClassPal" : groupName(state, openGroupId))
            : (pcView == VIEW_SETTINGS ? "电脑设置" : "电脑主题");
        else title = locView == VIEW_LIST ? (openGroupId == null ? "FClassPal" : lGroupName(openGroupId))
            : (locView == VIEW_SETTINGS ? "本机设置" : "本机主题");

        TextView tv = text(title, 17, cOn, true);
        tv.setGravity(Gravity.CENTER);
        col.addView(tv);

        String sub = statusText;
        if (sub.isEmpty() && tab == TAB_PC) sub = isPaired() ? "已连接 " + pcName() : "未连接";
        if (!sub.isEmpty()) {
            TextView st = text(sub, 11, cOnVar, false);
            st.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams stlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            stlp.bottomMargin = dp(10);
            col.addView(st, stlp);
        }

        if (tab == TAB_PAIR) { renderPair(); return; }

        /* 模式切换（chips 里当前模式用主色标出） */
        LinearLayout tabs = chipRow();
        if (isPaired()) {
            addChip(tabs, chip("电脑", tab == TAB_PC ? cPrimary : cSurfaceHi, v -> { switchTab(TAB_PC); }));
            addChip(tabs, chip("本机", tab == TAB_LOCAL ? cPrimary : cSurfaceHi, v -> { switchTab(TAB_LOCAL); }));
        } else {
            addChip(tabs, chip("本机", tab == TAB_LOCAL ? cPrimary : cSurfaceHi, v -> { switchTab(TAB_LOCAL); }));
            addChip(tabs, chip("配对电脑", tab == TAB_PAIR ? cPrimary : cSurfaceHi, v -> { switchTab(TAB_PAIR); }));
        }
        col.addView(tabs);

        if (tab == TAB_PC) {
            if (pcView == VIEW_LIST) { if (openGroupId == null) renderPcGroups(); else renderPcItems(); }
            else if (pcView == VIEW_SETTINGS) renderPcSettings();
            else renderPcThemes();
        } else {
            if (locView == VIEW_LIST) { if (openGroupId == null) renderLocalGroups(); else renderLocalItems(); }
            else if (locView == VIEW_SETTINGS) renderLocalSettings();
            else renderLocalThemes();
        }
    }

    private void switchTab(int t) {
        if (tab == t) return;
        tab = t;
        openGroupId = null;
        pcView = VIEW_LIST;
        locView = VIEW_LIST;
        statusText = "";
        if (t == TAB_PC && isPaired()) refresh(false); else render();
    }

    private String groupName(JSONObject st, String gid) {
        JSONArray gs = st == null ? null : st.optJSONArray("groups");
        if (gs != null) {
            for (int i = 0; i < gs.length(); i++) {
                JSONObject g = gs.optJSONObject(i);
                if (g != null && gid.equals(g.optString("id"))) return g.optString("name", "分组");
            }
        }
        return "分组";
    }

    private String lGroupName(String gid) {
        JSONObject g = findLGroup(gid);
        return g == null ? "分组" : g.optString("name", "分组");
    }

    /* ---------- 配对页 ---------- */
    private void renderPair() {
        ipInput = new EditText(this);
        ipInput.setHint("电脑 IP");
        ipInput.setSingleLine(true);
        ipInput.setInputType(InputType.TYPE_CLASS_TEXT);
        ipInput.setTextColor(Color.parseColor(cOn));
        ipInput.setHintTextColor(Color.parseColor(cOnVar));
        ipInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        ipInput.setBackground(ripple(bg(cSurface, 14)));
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
        codeInput.setTextColor(Color.parseColor(cOn));
        codeInput.setHintTextColor(Color.parseColor(cOnVar));
        codeInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        codeInput.setBackground(ripple(bg(cSurface, 14)));
        codeInput.setPadding(dp(12), dp(9), dp(12), dp(9));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.bottomMargin = dp(10);
        col.addView(codeInput, clp);

        LinearLayout row = chipRow();
        addChip(row, chip("自动发现", cPrimary, v -> doDiscover()));
        addChip(row, chip("连接", cPrimary, v -> doPair()));
        col.addView(row);
    }

    /* ---------- 电脑：分组 / 条目 ---------- */
    private void renderPcGroups() {
        LinearLayout row = chipRow();
        addChip(row, chip("刷新", cPrimary, v -> refresh(true)));
        addChip(row, chip("设置", cSurfaceHi, v -> { pcView = VIEW_SETTINGS; render(); }));
        col.addView(row);

        JSONArray groups = state == null ? null : state.optJSONArray("groups");
        if (groups == null || groups.length() == 0) {
            centerNote(netBusy ? "正在读取…" : "电脑上还没有分组");
            return;
        }
        for (int i = 0; i < groups.length(); i++) {
            final JSONObject g = groups.optJSONObject(i);
            if (g == null) continue;
            final String gid = g.optString("id");
            final String gname = g.optString("name", "分组");
            JSONArray items = g.optJSONArray("items");
            final int n = items == null ? 0 : items.length();
            card(gname, n + " 项",
                v -> { openGroupId = gid; render(); },
                v -> { groupMenu(gid, gname); return true; });
        }
    }

    private void renderPcItems() {
        JSONObject g = findGroup(openGroupId);
        LinearLayout row = chipRow();
        addChip(row, chip("返回", cSurfaceHi, v -> { openGroupId = null; render(); }));
        addChip(row, chip("刷新", cPrimary, v -> refresh(true)));
        col.addView(row);

        JSONArray items = g == null ? null : g.optJSONArray("items");
        if (items == null || items.length() == 0) {
            centerNote("空的");
            return;
        }
        /* 文件夹不做二级页面：直接摊平，子项带「↳」前缀，照常点开、长按编辑 */
        for (int i = 0; i < items.length(); i++) {
            final JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            final String id = it.optString("id");
            boolean folder = "folder".equals(it.optString("kind", "app"));
            card((folder ? "▸ " : "") + it.optString("name", "未命名"), null,
                folder ? null : v -> launchPcItem(id),
                v -> { itemMenu(id, it.optString("name", "")); return true; });
            JSONArray kids = it.optJSONArray("items");
            if (folder && kids != null) {
                for (int k = 0; k < kids.length(); k++) {
                    final JSONObject c = kids.optJSONObject(k);
                    if (c == null) continue;
                    final String cid = c.optString("id");
                    card("↳ " + c.optString("name", "未命名"), null,
                        v -> launchPcItem(cid),
                        v -> { itemMenu(cid, c.optString("name", "")); return true; });
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

    /* ---------- 电脑设置（远程） ---------- */
    private double pcOpacity() { return state == null ? 0.55 : state.optDouble("opacity", 0.55); }

    private void renderPcSettings() {
        LinearLayout row = chipRow();
        addChip(row, chip("返回", cSurfaceHi, v -> { pcView = VIEW_LIST; openGroupId = null; render(); }));
        addChip(row, chip("刷新", cPrimary, v -> refresh(true)));
        col.addView(row);

        /* 透明度：− / 当前 / ＋，步进 10% */
        LinearLayout op = chipRow();
        addChip(op, chip("−", cSurfaceHi, v -> setSetting("opacity", Math.max(0.2, pcOpacity() - 0.1))));
        TextView opv = text(Math.round(pcOpacity() * 100) + "%", 14, cOn, true);
        opv.setPadding(dp(6), 0, dp(6), 0);
        op.addView(opv);
        addChip(op, chip("＋", cSurfaceHi, v -> setSetting("opacity", Math.min(1, pcOpacity() + 0.1))));
        TextView opl = text("透明度", 12, cOnVar, false);
        opl.setPadding(dp(10), 0, 0, 0);
        op.addView(opl);
        col.addView(op);

        /* 窗口大小：− / 当前 / ＋ */
        LinearLayout sz = chipRow();
        addChip(sz, chip("−", cSurfaceHi, v -> setSetting("size", -40, true)));
        String dim = (state == null ? "" : state.optInt("winW", 0) + "×" + state.optInt("winH", 0));
        TextView szv = text(dim, 14, cOn, true);
        szv.setPadding(dp(6), 0, dp(6), 0);
        sz.addView(szv);
        addChip(sz, chip("＋", cSurfaceHi, v -> setSetting("size", 40, true)));
        TextView szl = text("窗口", 12, cOnVar, false);
        szl.setPadding(dp(10), 0, 0, 0);
        sz.addView(szl);
        col.addView(sz);

        /* 布局：网格 / 自由 */
        boolean free = state != null && "free".equals(state.optString("layout"));
        LinearLayout lo = chipRow();
        addChip(lo, chip("网格", free ? cSurfaceHi : cPrimary, v -> setSetting("layout", "grid")));
        addChip(lo, chip("自由", free ? cPrimary : cSurfaceHi, v -> setSetting("layout", "free")));
        TextView lol = text("布局", 12, cOnVar, false);
        lol.setPadding(dp(10), 0, 0, 0);
        lo.addView(lol);
        col.addView(lo);

        String cur = state == null ? "" : state.optString("theme", "");
        String curName = cur;
        JSONArray th = state == null ? null : state.optJSONArray("themes");
        if (th != null) {
            for (int i = 0; i < th.length(); i++) {
                JSONObject t = th.optJSONObject(i);
                if (t != null && cur.equals(t.optString("id"))) curName = t.optString("name", cur);
            }
        }
        card("主题", curName, v -> { pcView = VIEW_THEMES; render(); }, null);

        card("重新配对", pcName(), v -> confirmUnpair(), null);
    }

    private void renderPcThemes() {
        LinearLayout row = chipRow();
        addChip(row, chip("返回", cSurfaceHi, v -> { pcView = VIEW_SETTINGS; render(); }));
        col.addView(row);

        String cur = state == null ? "" : state.optString("theme", "");
        JSONArray th = state == null ? null : state.optJSONArray("themes");
        if (th == null || th.length() == 0) { centerNote("正在读取…"); return; }
        for (int i = 0; i < th.length(); i++) {
            final JSONObject t = th.optJSONObject(i);
            if (t == null) continue;
            final String id = t.optString("id");
            String name = t.optString("name", id);
            final boolean curOne = id.equals(cur);
            card((curOne ? "● " : "") + name, null,
                v -> {
                    if (!curOne) setSetting("theme", id);
                    else toast("当前主题");
                }, null);
        }
    }

    /* ---------- 本机启动器 ---------- */
    private void renderLocalGroups() {
        LinearLayout row = chipRow();
        addChip(row, chip("设置", cSurfaceHi, v -> { locView = VIEW_SETTINGS; render(); }));
        addChip(row, chip("＋分组", cPrimary, v -> inputDialog("分组名", "", name -> {
            if (name.isEmpty()) { toast("名字不能为空"); return; }
            try {
                JSONObject g = new JSONObject();
                g.put("id", newId());
                g.put("name", name);
                g.put("items", new JSONArray());
                lGroups().put(g);
                saveLocal();
                render();
            } catch (JSONException e) { toast("创建失败"); }
        })));
        col.addView(row);

        JSONArray gs = lGroups();
        if (gs.length() == 0) { centerNote("还没有分组"); return; }
        for (int i = 0; i < gs.length(); i++) {
            final JSONObject g = gs.optJSONObject(i);
            if (g == null) continue;
            final String gid = g.optString("id");
            final String gname = g.optString("name", "分组");
            JSONArray items = g.optJSONArray("items");
            final int n = items == null ? 0 : items.length();
            card(gname, n + " 项",
                v -> { openGroupId = gid; render(); },
                v -> { lGroupMenu(gid, gname); return true; });
        }
    }

    private void renderLocalItems() {
        JSONObject g = findLGroup(openGroupId);
        LinearLayout row = chipRow();
        addChip(row, chip("返回", cSurfaceHi, v -> { openGroupId = null; render(); }));
        addChip(row, chip("＋应用", cPrimary, v -> showAppPicker()));
        addChip(row, chip("＋网页", cPrimary, v -> addWebDialog()));
        col.addView(row);

        JSONArray items = g == null ? null : g.optJSONArray("items");
        if (items == null || items.length() == 0) { centerNote("空的"); return; }
        for (int i = 0; i < items.length(); i++) {
            final JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            final String id = it.optString("id");
            String sub = "web".equals(it.optString("kind", "app")) ? "网页" : "";
            card(it.optString("name", "未命名"), sub,
                v -> launchLocalItem(it),
                v -> { lItemMenu(id, it.optString("name", "")); return true; });
        }
    }

    private void renderLocalSettings() {
        LinearLayout row = chipRow();
        addChip(row, chip("返回", cSurfaceHi, v -> { locView = VIEW_LIST; openGroupId = null; render(); }));
        col.addView(row);

        card("主题", "md3".equals(themeId) ? "内置 MD3" : themeId, v -> { locView = VIEW_THEMES; render(); }, null);
        card("导入配置", null, v -> importConfigDialog(), null);
    }

    private void renderLocalThemes() {
        LinearLayout row = chipRow();
        addChip(row, chip("返回", cSurfaceHi, v -> { locView = VIEW_SETTINGS; render(); }));
        col.addView(row);

        card(("md3".equals(themeId) ? "● " : "") + "内置 MD3", null,
            v -> { if (!"md3".equals(themeId)) setThemeId("md3"); else toast("当前主题"); }, null);

        File[] files = themeDir().listFiles((d, n) -> n.endsWith(".json"));
        if (files != null) {
            java.util.Arrays.sort(files);
            for (final File f : files) {
                final String id = f.getName().substring(0, f.getName().length() - 5);
                /* 带 groups 字段的是配置文件，不进主题列表 */
                boolean isConfig = false;
                try { isConfig = new JSONObject(readFile(f)).optJSONArray("groups") != null; }
                catch (Exception e) { isConfig = false; }
                if (isConfig) continue;
                final boolean curOne = id.equals(themeId);
                card((curOne ? "● " : "") + themeDisplayName(id, f), null,
                    v -> { if (!curOne) setThemeId(id); else toast("当前主题"); }, null);
            }
        }
    }

    /* 主题/配置导入目录里挑一个带 groups 的 .json 整份导入 */
    private void importConfigDialog() {
        File[] files = themeDir().listFiles((d, n) -> n.endsWith(".json"));
        final List<File> configs = new ArrayList<File>();
        final List<String> names = new ArrayList<String>();
        if (files != null) {
            java.util.Arrays.sort(files);
            for (File f : files) {
                try {
                    if (new JSONObject(readFile(f)).optJSONArray("groups") != null) {
                        configs.add(f);
                        names.add(f.getName().substring(0, f.getName().length() - 5));
                    }
                } catch (Exception e) { /* 坏文件跳过 */ }
            }
        }
        if (configs.isEmpty()) { toast("目录里没有可导入的配置"); return; }
        new AlertDialog.Builder(this)
            .setTitle("导入配置")
            .setItems(names.toArray(new String[0]), (d, w) -> {
                final File f = configs.get(w);
                new AlertDialog.Builder(this)
                    .setTitle("导入「" + names.get(w) + "」？")
                    .setMessage("会替换本机全部分组")
                    .setPositiveButton("导入", (d2, w2) -> {
                        try {
                            JSONObject o = new JSONObject(readFile(f));
                            JSONArray gs = o.optJSONArray("groups");
                            if (gs == null) { toast("格式不对"); return; }
                            localConfig.put("groups", gs);
                            saveLocal();
                            render();
                            toast("已导入");
                        } catch (Exception e) { toast("导入失败"); }
                    })
                    .setNegativeButton("取消", null)
                    .show();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    /* ---------- 本机启动 ---------- */
    private void launchLocalItem(JSONObject it) {
        String kind = it.optString("kind", "app");
        try {
            Intent i;
            if ("web".equals(kind)) {
                i = new Intent(Intent.ACTION_VIEW, Uri.parse(it.optString("uri", "")));
            } else {
                i = getPackageManager().getLaunchIntentForPackage(it.optString("pkg", ""));
            }
            if (i == null) { toast("打不开：应用不存在"); return; }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            toast("打不开");
        }
    }

    /* 加手表上已装的应用（列表选择） */
    private void showAppPicker() {
        PackageManager pm = getPackageManager();
        Intent qi = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> all = pm.queryIntentActivities(qi, 0);
        final List<String> labels = new ArrayList<String>();
        final List<String> pkgs = new ArrayList<String>();
        for (ResolveInfo ri : all) {
            if (ri == null || ri.activityInfo == null) continue;
            if (getPackageName().equals(ri.activityInfo.packageName)) continue;   // 别把自己加进去
            labels.add(String.valueOf(ri.loadLabel(pm)));
            pkgs.add(ri.activityInfo.packageName);
        }
        if (labels.isEmpty()) { toast("没有可选的应用"); return; }
        /* 标签和应用包名绑在一起按名字排序，选第几个就是第几个 */
        Integer[] order = new Integer[labels.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        java.util.Arrays.sort(order, (a, b) -> labels.get(a).compareToIgnoreCase(labels.get(b)));
        final String[] shown = new String[order.length];
        final String[] pkgs2 = new String[order.length];
        for (int i = 0; i < order.length; i++) { shown[i] = labels.get(order[i]); pkgs2[i] = pkgs.get(order[i]); }
        new AlertDialog.Builder(this)
            .setTitle("添加应用")
            .setItems(shown, (d, w) -> addLocalItem(shown[w], "app", pkgs2[w], null))
            .setNegativeButton("取消", null)
            .show();
    }

    private void addWebDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        final EditText name = new EditText(this);
        name.setHint("名字");
        name.setSingleLine(true);
        name.setTextColor(Color.parseColor(cOn));
        name.setHintTextColor(Color.parseColor(cOnVar));
        final EditText url = new EditText(this);
        url.setHint("网址 https://…");
        url.setSingleLine(true);
        url.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        url.setTextColor(Color.parseColor(cOn));
        url.setHintTextColor(Color.parseColor(cOnVar));
        box.addView(name);
        box.addView(url);
        new AlertDialog.Builder(this)
            .setTitle("添加网页")
            .setView(box)
            .setPositiveButton("添加", (d, w) -> {
                String n = name.getText().toString().trim();
                String u = url.getText().toString().trim();
                if (n.isEmpty() || u.isEmpty()) { toast("名字和网址都要填"); return; }
                if (!u.contains("://")) u = "https://" + u;
                addLocalItem(n, "web", null, u);
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void addLocalItem(String name, String kind, String pkg, String uri) {
        JSONObject g = findLGroup(openGroupId);
        if (g == null) { toast("先选一个分组"); return; }
        try {
            JSONObject it = new JSONObject();
            it.put("id", newId());
            it.put("name", name);
            it.put("kind", kind);
            if (pkg != null) it.put("pkg", pkg);
            if (uri != null) it.put("uri", uri);
            JSONArray arr = g.optJSONArray("items");
            if (arr == null) { arr = new JSONArray(); g.put("items", arr); }
            arr.put(it);
            saveLocal();
            render();
        } catch (JSONException e) { toast("添加失败"); }
    }

    /* ---------- 输入对话框 ---------- */
    private interface NameCb { void run(String name); }

    private void inputDialog(String title, String cur, NameCb cb) {
        final EditText et = new EditText(this);
        et.setText(cur);
        et.setSingleLine(true);
        et.setSelection(et.getText().length());
        et.setTextColor(Color.parseColor(cOn));
        et.setInputType(InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setView(et)
            .setPositiveButton("确定", (d, w) -> cb.run(et.getText().toString().trim()))
            .setNegativeButton("取消", null)
            .show();
    }

    /* ---------- 网络动作（电脑模式） ---------- */
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
                        if (fst != null) { state = fst; statusText = ""; }
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
        statusText = "正在搜索…";
        render();
        new Thread(new Runnable() {
            @Override public void run() {
                final JSONObject found = Discovery.find(2500);
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (found == null) {
                            statusText = "没搜到电脑";
                            render();
                            return;
                        }
                        String fip = found.optString("ip", "");
                        int fport = found.optInt("port", 47820);
                        statusText = "找到 " + found.optString("name", "电脑") + "（" + fip + "）";
                        prefs.edit().putInt("port", fport).apply();
                        render();
                        if (ipInput != null) ipInput.setText(fip);
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
                        tab = TAB_PC;
                        pcView = VIEW_LIST;
                        statusText = "";
                        render();
                        refresh(true);
                    }
                });
            }
        }).start();
    }

    private void launchPcItem(final String id) {
        if (netBusy) return;
        netBusy = true;
        final String ip = ip(), tok = token();
        final int port = port();
        new Thread(new Runnable() {
            @Override public void run() {
                String msg;
                try {
                    JSONObject body = new JSONObject();
                    body.put("action", "launch");
                    body.put("itemId", id);
                    JSONObject r = Api.request("POST", ip, port, "/fcp/action", body, tok, 6000);
                    msg = r.optBoolean("ok") ? r.optString("message", "已打开")
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
        if (netBusy) { toast("等一下"); return; }
        netBusy = true;
        final String ip = ip(), tok = token();
        final int port = port();
        new Thread(new Runnable() {
            @Override public void run() {
                String msg;
                try {
                    JSONObject r = Api.request("POST", ip, port, "/fcp/action", body, tok, 6000);
                    msg = r.optBoolean("ok") ? (r.optString("message", okMsg))
                        : ("失败：" + r.optString("error", "?"));
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

    /* 远程设置：电脑端渲染层 handleWearAction 的 set 分支执行 */
    private void setSetting(String key, Object value) { setSetting(key, value, false); }

    private void setSetting(String key, Object value, boolean isDelta) {
        try {
            JSONObject b = new JSONObject();
            b.put("action", "set");
            b.put("key", key);
            if (isDelta) b.put("delta", ((Number) value).intValue());
            else if (value instanceof Double) b.put("value", (Double) value);
            else b.put("value", String.valueOf(value));
            sendAction(b, "已调整");
        } catch (JSONException e) { /* 组包失败，忽略 */ }
    }

    /* ---------- 编辑菜单（电脑 / 本机各一套） ---------- */
    private void itemMenu(final String id, final String name) {
        new AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(new String[]{"改名", "上移", "下移", "删除"}, (d, w) -> {
                if (w == 0) renameDialog("renameItem", "itemId", id, name);
                else if (w == 1) movePc(id, "moveItem", "itemId", "up");
                else if (w == 2) movePc(id, "moveItem", "itemId", "down");
                else confirmDeletePcItem(id, name);
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void groupMenu(final String gid, final String name) {
        new AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(new String[]{"分组改名", "分组上移", "分组下移"}, (d, w) -> {
                if (w == 0) renameDialog("renameGroup", "groupId", gid, name);
                else movePc(gid, "moveGroup", "groupId", w == 1 ? "up" : "down");
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void renameDialog(final String action, final String idKey, final String id, String cur) {
        inputDialog("新名字", cur, name -> {
            if (name.isEmpty()) { toast("名字不能为空"); return; }
            try {
                JSONObject body = new JSONObject();
                body.put("action", action);
                body.put(idKey, id);
                body.put("name", name);
                sendAction(body, "已改名");
            } catch (JSONException e) { toast("改名失败"); }
        });
    }

    private void movePc(String id, String action, String idKey, String dir) {
        try {
            JSONObject body = new JSONObject();
            body.put("action", action);
            body.put(idKey, id);
            body.put("dir", dir);
            sendAction(body, "顺序已调整");
        } catch (JSONException e) { toast("调整失败"); }
    }

    private void confirmDeletePcItem(final String id, String name) {
        new AlertDialog.Builder(this)
            .setTitle("删除「" + name + "」？")
            .setMessage("电脑上的这个快捷方式也会被删掉")
            .setPositiveButton("删除", (d, w) -> {
                try {
                    JSONObject body = new JSONObject();
                    body.put("action", "deleteItem");
                    body.put("itemId", id);
                    sendAction(body, "已删除");
                } catch (JSONException e) { toast("删除失败"); }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void lItemMenu(final String id, final String name) {
        new AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(new String[]{"改名", "上移", "下移", "删除"}, (d, w) -> {
                if (w == 0) {
                    inputDialog("新名字", name, nm -> {
                        if (nm.isEmpty()) { toast("名字不能为空"); return; }
                        JSONObject it = findLItem(id);
                        if (it == null) return;
                        try { it.put("name", nm); } catch (JSONException e) { return; }
                        saveLocal();
                        render();
                    });
                } else if (w == 3) {
                    new AlertDialog.Builder(this)
                        .setTitle("删除「" + name + "」？")
                        .setPositiveButton("删除", (d2, w2) -> { removeLItem(id); render(); })
                        .setNegativeButton("取消", null)
                        .show();
                } else {
                    moveLItem(id, w == 1 ? "up" : "down");
                    render();
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void lGroupMenu(final String gid, final String name) {
        new AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(new String[]{"分组改名", "分组上移", "分组下移", "删除分组"}, (d, w) -> {
                if (w == 0) {
                    inputDialog("新名字", name, nm -> {
                        if (nm.isEmpty()) { toast("名字不能为空"); return; }
                        JSONObject g = findLGroup(gid);
                        if (g == null) return;
                        try { g.put("name", nm); } catch (JSONException e) { return; }
                        saveLocal();
                        render();
                    });
                } else if (w == 3) {
                    JSONArray gs = lGroups();
                    if (gs.length() <= 1) { toast("最后一个分组不能删"); return; }
                    new AlertDialog.Builder(this)
                        .setTitle("删除「" + name + "」？")
                        .setMessage("里面的条目也会一起删掉")
                        .setPositiveButton("删除", (d2, w2) -> {
                            JSONArray keep = new JSONArray();
                            for (int i = 0; i < gs.length(); i++) {
                                JSONObject g = gs.optJSONObject(i);
                                if (g != null && !gid.equals(g.optString("id"))) keep.put(g);
                            }
                            try { localConfig.put("groups", keep); } catch (JSONException e) { return; }
                            if (gid.equals(openGroupId)) openGroupId = null;
                            saveLocal();
                            render();
                        })
                        .setNegativeButton("取消", null)
                        .show();
                } else {
                    moveLGroup(gid, w == 1 ? "up" : "down");
                    render();
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private JSONObject findLItem(String id) {
        JSONArray gs = lGroups();
        for (int i = 0; i < gs.length(); i++) {
            JSONObject g = gs.optJSONObject(i);
            if (g == null) continue;
            JSONArray items = g.optJSONArray("items");
            if (items == null) continue;
            for (int k = 0; k < items.length(); k++) {
                JSONObject it = items.optJSONObject(k);
                if (it != null && id.equals(it.optString("id"))) return it;
            }
        }
        return null;
    }

    /* 返回 [分组里的 items 数组, 下标]；找不到返回 null */
    private Object[] locateLItem(String id) {
        JSONArray gs = lGroups();
        for (int i = 0; i < gs.length(); i++) {
            JSONObject g = gs.optJSONObject(i);
            if (g == null) continue;
            JSONArray items = g.optJSONArray("items");
            if (items == null) continue;
            for (int k = 0; k < items.length(); k++) {
                JSONObject it = items.optJSONObject(k);
                if (it != null && id.equals(it.optString("id"))) return new Object[]{items, k};
            }
        }
        return null;
    }

    private void moveLItem(String id, String dir) {
        Object[] loc = locateLItem(id);
        if (loc == null) return;
        JSONArray arr = (JSONArray) loc[0];
        int i = ((Integer) loc[1]).intValue();
        int to = "up".equals(dir) ? i - 1 : i + 1;
        if (to < 0 || to >= arr.length()) return;
        JSONObject moved = arr.optJSONObject(i);
        if (moved == null) return;
        try { arr.remove(i); arr.put(to, moved); } catch (JSONException e) { return; }
        saveLocal();
    }

    private void removeLItem(String id) {
        Object[] loc = locateLItem(id);
        if (loc == null) return;
        JSONArray arr = (JSONArray) loc[0];
        arr.remove(((Integer) loc[1]).intValue());
        saveLocal();
    }

    private void moveLGroup(String gid, String dir) {
        JSONArray gs = lGroups();
        int i = -1;
        for (int k = 0; k < gs.length(); k++) {
            JSONObject g = gs.optJSONObject(k);
            if (g != null && gid.equals(g.optString("id"))) { i = k; break; }
        }
        if (i < 0) return;
        int to = "up".equals(dir) ? i - 1 : i + 1;
        if (to < 0 || to >= gs.length()) return;
        JSONObject moved = gs.optJSONObject(i);
        if (moved == null) return;
        try { gs.remove(i); gs.put(to, moved); } catch (JSONException e) { return; }
        saveLocal();
    }

    private void confirmUnpair() {
        new AlertDialog.Builder(this)
            .setTitle("重新配对？")
            .setMessage("会清掉手表上存的配对信息")
            .setPositiveButton("确定", (d, w) -> {
                prefs.edit().putString("token", "").apply();
                state = null;
                statusText = "";
                tab = TAB_PAIR;
                render();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void toast(String s) {
        if (s == null || s.length() == 0) return;
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }
}
