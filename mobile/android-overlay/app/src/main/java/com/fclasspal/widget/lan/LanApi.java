/* FClassPal · 安卓壳的局域网 HTTP 客户端（v2.6.6）
 *
 * 手机端要能「模拟 WearOS 去连电脑」，就沿用手表那套协议（/fcp/ping|pair|state|action）。
 * 为什么不直接在 WebView 里 fetch：Capacitor 的页面是 https://localhost 源，
 * 去请求 http://192.168.x.x 会被 WebView 的混合内容策略拦掉；而且 UDP 广播
 * （自动发现）在 JS 里根本没有 API。所以走原生，结果回传 JS。
 *
 * 同步阻塞，调用方（PalBridgePlugin）放到后台线程跑。 */
package com.fclasspal.widget.lan;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public final class LanApi {

    private LanApi() {}

    public static JSONObject request(String method, String ip, int port, String path,
                                     JSONObject body, String token, int timeoutMs) throws IOException {
        HttpURLConnection c = null;
        try {
            URL url = new URL("http://" + ip + ":" + port + path);
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setRequestMethod(method);
            c.setRequestProperty("Accept", "application/json");
            if (token != null && token.length() > 0) {
                c.setRequestProperty("Authorization", "Bearer " + token);
            }
            if (body != null) {
                byte[] payload = body.toString().getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                c.setFixedLengthStreamingMode(payload.length);
                OutputStream os = c.getOutputStream();
                os.write(payload);
                os.flush();
                os.close();
            }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String raw = readAll(is);
            JSONObject out;
            try {
                out = raw.length() == 0 ? new JSONObject() : new JSONObject(raw);
            } catch (JSONException e) {
                out = new JSONObject();
            }
            /* 与手表端同一个约定：HTTP 状态码塞回 body.status，JS 侧只认这个 */
            try { out.put("status", code); } catch (JSONException e) { /* 不会发生 */ }
            return out;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String readAll(InputStream is) throws IOException {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[2048];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return new String(bos.toByteArray(), "UTF-8");
    }
}
