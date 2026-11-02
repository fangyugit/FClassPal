/* FClassPal · WearOS 的极简 HTTP 客户端（v2.6.4）
 * 只用 java.net + org.json（framework 自带），不引 OkHttp/Retrofit —— 手表端
 * 依赖越少越好装、越好审。所有方法同步阻塞，调用方（MainActivity）放到
 * 后台线程里跑。 */
package com.fclasspal.wear;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

final class Api {

    private Api() {}

    static JSONObject request(String method, String ip, int port, String path,
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
            try { out.put("status", code); } catch (JSONException e) { /* 不会发生 */ }
            return out;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readAll(InputStream is) throws IOException {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[2048];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return new String(bos.toByteArray(), "UTF-8");
    }
}
