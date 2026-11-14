/* FClassPal · WearOS 应用图标（v2.6.5A）
 *
 * 手表端原来只有文字卡，认应用全靠读名字。这里补上图标：
 *   · 内存 LRU（48 张）+ 磁盘缓存（cacheDir/icons/<pkg>_<px>.png），
 *     二次打开分组不再重新解码 50 个 APK 的图标；
 *   · 网页条目没有包名，画一块「首字色块」当图（颜色由名字哈希定，同一个
 *     条目每次都是同一个色，不会闪来闪去）；
 *   · 取不到图标（包被卸载 / 权限变更）也落回首字色块，绝不留空框。
 *
 * 调用方都是后台线程（渲染 50 个图标要 200ms 级），结果回主线程才 setImageBitmap。 */
package com.fclasspal.wear;

import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;

import java.io.File;
import java.io.FileOutputStream;
import java.util.LinkedHashMap;
import java.util.Map;

final class AppIcons {

    private static final int MAX_MEM = 48;
    private static final LinkedHashMap<String, Bitmap> MEM =
        new LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Bitmap> e) {
                return size() > MAX_MEM;
            }
        };

    private AppIcons() {}

    /** 图标：先查内存 → 磁盘 → 向系统要。永远非空。 */
    static Bitmap of(Context ctx, String pkg, int px, String fallbackText, String bgColor) {
        if (px < 8) px = 8;
        String key = (pkg == null || pkg.isEmpty() ? "#" + fallbackText : pkg) + "@" + px;
        synchronized (MEM) {
            Bitmap hit = MEM.get(key);
            if (hit != null) return hit;
        }
        Bitmap bmp = null;
        if (pkg != null && !pkg.isEmpty()) {
            bmp = fromDisk(ctx, pkg, px);
            if (bmp == null) {
                bmp = fromSystem(ctx, pkg, px);
                if (bmp != null) toDisk(ctx, pkg, px, bmp);
            }
        }
        if (bmp == null) bmp = letterTile(fallbackText, px, bgColor);
        synchronized (MEM) { MEM.put(key, bmp); }
        return bmp;
    }

    /* ---------- 系统 / 磁盘 ---------- */
    private static Bitmap fromSystem(Context ctx, String pkg, int px) {
        try {
            PackageManager pm = ctx.getPackageManager();
            Drawable d = pm.getApplicationIcon(pkg);
            return drawToBitmap(d, px);
        } catch (Exception e) {
            return null;
        }
    }

    static Bitmap drawToBitmap(Drawable d, int px) {
        if (d == null) return null;
        Bitmap out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        d.setBounds(0, 0, px, px);
        d.draw(c);
        return out;
    }

    private static File cacheFile(Context ctx, String pkg, int px) {
        File dir = new File(ctx.getCacheDir(), "icons");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, safe(pkg) + "_" + px + ".png");
    }

    private static String safe(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length() && b.length() < 64; i++) {
            char c = s.charAt(i);
            b.append((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' ? c : '_');
        }
        return b.toString();
    }

    private static Bitmap fromDisk(Context ctx, String pkg, int px) {
        try {
            File f = cacheFile(ctx, pkg, px);
            if (!f.exists()) return null;
            return BitmapFactory.decodeFile(f.getAbsolutePath());
        } catch (Exception e) {
            return null;
        }
    }

    private static void toDisk(Context ctx, String pkg, int px, Bitmap bmp) {
        FileOutputStream os = null;
        try {
            os = new FileOutputStream(cacheFile(ctx, pkg, px));
            bmp.compress(Bitmap.CompressFormat.PNG, 100, os);
        } catch (Exception ignored) {
            /* 缓存写不进去不影响显示 */
        } finally {
            if (os != null) try { os.close(); } catch (Exception ignored) {}
        }
    }

    /* ---------- 首字色块 ---------- */
    static Bitmap letterTile(String text, int px, String bgColor) {
        Bitmap out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        int base;
        try { base = Color.parseColor(bgColor); } catch (Exception e) { base = 0xFF2F3846; }
        /* 名字哈希微调明度：同一分组里几个网页条目不会糊成一片同色 */
        float[] hsv = new float[3];
        Color.colorToHSV(base, hsv);
        int h = text == null ? 0 : Math.abs(text.hashCode());
        hsv[1] = Math.min(1f, hsv[1] * (0.75f + (h % 40) / 100f));
        hsv[2] = Math.max(0.28f, Math.min(0.72f, hsv[2] * (0.85f + (h / 40 % 30) / 100f)));
        p.setColor(Color.HSVToColor(hsv));
        float r = px * 0.30f;
        c.drawRoundRect(new RectF(0, 0, px, px), r, r, p);

        String ch = (text == null || text.isEmpty()) ? "?" : text.substring(0, 1);
        Paint t = new Paint(Paint.ANTI_ALIAS_FLAG);
        t.setColor(0xFFFFFFFF);
        t.setTextSize(px * 0.52f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextAlign(Paint.Align.CENTER);
        Paint.FontMetrics fm = t.getFontMetrics();
        c.drawText(ch, px / 2f, px / 2f - (fm.ascent + fm.descent) / 2f, t);
        return out;
    }
}
