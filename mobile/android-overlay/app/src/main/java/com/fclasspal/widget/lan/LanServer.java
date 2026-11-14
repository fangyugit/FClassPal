/* FClassPal · 安卓壳的局域网服务端（v2.6.6）——「被连接」
 *
 * 把桌面版 lan-server.js 那套协议在手机上重做一份，于是：
 *   · WearOS 手表可以像连电脑一样连**手机**，在手表上点一下让手机打开某个应用；
 *   · 另一台装了 FClassPal 的手机（或同一套协议的设备）也能连上来。
 *
 * 与桌面版的协议逐字对齐（对手表来说，主机是电脑还是手机完全看不出来）：
 *   UDP 47822  FCP_DISCOVER → {"type":"fcp-here","name":...,"port":...}
 *   GET  /fcp/ping     免鉴权
 *   POST /fcp/pair     {"code":"123456","device":"..."} → {token, deviceId}
 *   GET  /fcp/state    Bearer token
 *   POST /fcp/action   Bearer token，body 里带 action 等字段
 *   POST /fcp/unpair   Bearer token
 *
 * 为什么不用 NanoHTTPD / Ktor：手表和手机两端都守着「零第三方依赖」，
 * 这里只有 5 个路由、请求体是几十字节的 JSON，一个 ServerSocket 手写
 * HTTP/1.1 比引一个库更可控（也省 300KB 安装包）。
 *
 * ★ 状态与动作都在 WebView 那边：这台手机的分组/图标是渲染层的 config，
 *   原生只当搬运工 —— state() 拿 JS 推上来的快照，action() 阻塞等 JS 回结果
 *   （带超时，JS 崩了也不会把 HTTP 线程拖死）。
 * ★ 配对设备必须自己持久化（SharedPreferences，由调用方接 devicesChanged）：
 *   桌面版当初把设备存在会被整份覆盖的 config.json 里，导致"配对几分钟就失效"，
 *   同一个坑别在手机上再踩一次。 */
package com.fclasspal.widget.lan;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class LanServer {

    public static final int DEFAULT_PORT = 47820;
    private static final int DISCOVERY_PORT = LanDiscovery.DISCOVERY_PORT;
    private static final String APP_TAG = "FClassPal";
    private static final String API = "/fcp";
    private static final int MAX_BODY = 64 * 1024;
    private static final long PAIR_WINDOW = 60 * 1000L;
    private static final int PAIR_MAX_FAIL = 8;

    /** 宿主（PalBridgePlugin）提供的东西。除了 devicesChanged 都可能被任意线程调用。 */
    public interface Ctx {
        String name();
        String version();
        String pairCode();
        JSONObject state();
        /** 阻塞式：把动作丢给 WebView 执行并等结果（实现方负责超时）。 */
        JSONObject action(JSONObject body, String deviceName);
        void devicesChanged(JSONArray devices);
    }

    private final Ctx ctx;
    private final JSONArray devices;                 // [{id,name,ip,token,last}]
    private final Map<String, long[]> pairFails = new HashMap<String, long[]>();
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final AtomicInteger seq = new AtomicInteger(0);

    private ServerSocket server;
    private Thread acceptThread;
    private Thread udpThread;
    private java.net.DatagramSocket udp;
    private volatile int port = 0;

    public LanServer(Ctx ctx, JSONArray stored) {
        this.ctx = ctx;
        this.devices = stored == null ? new JSONArray() : stored;
    }

    public synchronized boolean running() { return server != null; }
    public int port() { return port; }

    public synchronized JSONArray devices() {
        JSONArray copy = new JSONArray();
        for (int i = 0; i < devices.length(); i++) {
            JSONObject d = devices.optJSONObject(i);
            if (d == null) continue;
            try {
                JSONObject safe = new JSONObject();
                safe.put("id", d.optString("id"));
                safe.put("name", d.optString("name"));
                safe.put("ip", d.optString("ip"));
                safe.put("last", d.optLong("last"));
                copy.put(safe);                       // token 绝不出这个类
            } catch (JSONException ignored) {}
        }
        return copy;
    }

    public synchronized JSONObject info() {
        JSONObject o = new JSONObject();
        try {
            o.put("running", running());
            o.put("port", port);
            o.put("name", ctx.name());
            JSONArray addrs = new JSONArray();
            for (String a : localAddresses()) addrs.put(a);
            o.put("addresses", addrs);
            o.put("devices", devices());
        } catch (JSONException ignored) {}
        return o;
    }

    /* ---------- 起停 ---------- */
    public synchronized JSONObject start() throws IOException {
        if (server != null) return info();
        pairFails.clear();
        IOException last = null;
        for (int p = DEFAULT_PORT; p < DEFAULT_PORT + 5; p++) {
            try {
                server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(InetAddress.getByName("0.0.0.0"), p), 16);
                port = p;
                last = null;
                break;
            } catch (IOException e) {
                last = e;
                server = null;
            }
        }
        if (server == null) throw last == null ? new IOException("bind-failed") : last;

        final ServerSocket ss = server;
        acceptThread = new Thread(() -> {
            while (true) {
                Socket s;
                try {
                    s = ss.accept();
                } catch (IOException e) {
                    break;                            // close() 之后必然走这里
                }
                try { pool.execute(() -> handle(s)); } catch (Exception ignored) { closeQuietly(s); }
            }
        }, "fcp-lan-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        startDiscovery();
        return info();
    }

    public synchronized void stop() {
        stopDiscovery();
        if (server != null) {
            try { server.close(); } catch (IOException ignored) {}
            server = null;
        }
        port = 0;
        pairFails.clear();
    }

    public synchronized void removeDevice(String id) {
        for (int i = 0; i < devices.length(); i++) {
            JSONObject d = devices.optJSONObject(i);
            if (d != null && id.equals(d.optString("id"))) {
                devices.remove(i);
                break;
            }
        }
        ctx.devicesChanged(devices);
    }

    /* ---------- 设备登记 ---------- */
    private JSONObject register(String name, String ip) {
        String token = randomToken();
        JSONObject dev = new JSONObject();
        try {
            dev.put("id", "m" + Long.toString(System.currentTimeMillis(), 36) + seq.incrementAndGet());
            dev.put("name", name);
            dev.put("ip", ip);
            dev.put("token", token);
            dev.put("last", System.currentTimeMillis());
            synchronized (this) {
                devices.put(dev);
                ctx.devicesChanged(devices);
            }
        } catch (JSONException ignored) {}
        return dev;
    }

    private JSONObject byToken(String token) {
        if (token == null || token.isEmpty()) return null;
        synchronized (this) {
            for (int i = 0; i < devices.length(); i++) {
                JSONObject d = devices.optJSONObject(i);
                if (d != null && token.equals(d.optString("token"))) return d;
            }
        }
        return null;
    }

    private static String randomToken() {
        java.security.SecureRandom r = new java.security.SecureRandom();
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 16; i++) b.append(Integer.toHexString(r.nextInt(16)));
        return b.toString();
    }

    /* ---------- UDP 发现 ---------- */
    private void startDiscovery() {
        try {
            udp = new java.net.DatagramSocket(null);
            udp.setReuseAddress(true);
            udp.bind(new InetSocketAddress(DISCOVERY_PORT));
            udp.setBroadcast(true);
        } catch (Exception e) {
            udp = null;
            return;                                   // 端口被占：手动输 IP 也能用
        }
        udpThread = new Thread(() -> {
            byte[] buf = new byte[1024];
            while (true) {
                try {
                    java.net.DatagramPacket in = new java.net.DatagramPacket(buf, buf.length);
                    udp.receive(in);
                    String text = new String(in.getData(), 0, in.getLength(), "UTF-8");
                    if (!text.contains(APP_TAG) && !text.contains("FCP_DISCOVER")) continue;
                    JSONObject reply = new JSONObject();
                    reply.put("app", APP_TAG);
                    reply.put("type", "fcp-here");
                    reply.put("name", ctx.name());
                    reply.put("port", port);
                    reply.put("version", ctx.version());
                    reply.put("needCode", true);
                    byte[] out = reply.toString().getBytes("UTF-8");
                    udp.send(new java.net.DatagramPacket(out, out.length,
                        in.getAddress(), in.getPort()));
                } catch (Exception e) {
                    if (udp == null || udp.isClosed()) break;
                }
            }
        }, "fcp-lan-udp");
        udpThread.setDaemon(true);
        udpThread.start();
    }

    private void stopDiscovery() {
        if (udp != null) {
            try { udp.close(); } catch (Exception ignored) {}
            udp = null;
        }
    }

    /* ---------- 一个连接 ---------- */
    private void handle(Socket s) {
        try {
            s.setSoTimeout(8000);
            InputStream in = s.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int b;
            while ((b = in.read()) >= 0) {
                head.write(b);
                int n = head.size();
                if (n >= 4) {
                    byte[] h = head.toByteArray();
                    if (h[n - 4] == '\r' && h[n - 3] == '\n' && h[n - 2] == '\r' && h[n - 1] == '\n') break;
                }
                if (n > 16 * 1024) break;
            }
            String headStr = new String(head.toByteArray(), "UTF-8");
            String[] lines = headStr.split("\r\n");
            if (lines.length == 0) { respond(s, 400, err("bad-request")); return; }

            String[] first = lines[0].split(" ");
            if (first.length < 2) { respond(s, 400, err("bad-request")); return; }
            String method = first[0];
            String rawPath = first[1];

            int contentLength = 0;
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c <= 0) continue;
                String k = lines[i].substring(0, c).trim().toLowerCase();
                String v = lines[i].substring(c + 1).trim();
                if (k.equals("content-length")) {
                    try { contentLength = Integer.parseInt(v); } catch (Exception ignored) {}
                }
            }
            if (contentLength > MAX_BODY) { respond(s, 413, err("too-large")); return; }
            String bodyStr = "";
            if (contentLength > 0) {
                byte[] body = new byte[contentLength];
                int read = 0;
                while (read < contentLength) {
                    int n = in.read(body, read, contentLength - read);
                    if (n < 0) break;
                    read += n;
                }
                bodyStr = new String(body, 0, read, "UTF-8");
            }

            String path = rawPath;
            int q = path.indexOf('?');
            String query = "";
            if (q >= 0) { query = path.substring(q + 1); path = path.substring(0, q); }
            while (path.endsWith("/") && path.length() > 1) path = path.substring(0, path.length() - 1);
            String ip = s.getInetAddress() == null ? "" : s.getInetAddress().getHostAddress();

            JSONObject body = null;
            if (bodyStr.length() > 0) {
                try { body = new JSONObject(bodyStr); } catch (JSONException e) { body = null; }
            }

            /* --- OPTIONS：WebView 里想直连时的预检，一律放行 --- */
            if ("OPTIONS".equals(method)) { respond(s, 200, new JSONObject()); return; }

            /* --- 免鉴权 --- */
            if (path.equals(API + "/ping")) {
                JSONObject o = new JSONObject();
                o.put("app", APP_TAG);
                o.put("ok", true);
                o.put("needCode", true);
                o.put("name", ctx.name());
                o.put("version", ctx.version());
                o.put("port", port);
                respond(s, 200, o);
                return;
            }
            if (path.equals(API + "/pair") && "POST".equals(method)) {
                if (pairBlocked(ip)) { respond(s, 429, err("too-many-tries")); return; }
                if (body == null || body.optString("code", "").isEmpty()) {
                    respond(s, 400, err("bad-request"));
                    return;
                }
                String expect = String.valueOf(ctx.pairCode() == null ? "" : ctx.pairCode());
                String got = body.optString("code", "").replaceAll("\\D", "");
                if (expect.isEmpty() || !got.equals(expect)) {
                    notePairFail(ip);
                    respond(s, 403, err("bad-code"));
                    return;
                }
                pairFails.remove(ip);
                String dn = body.optString("device", "设备");
                if (dn.length() > 40) dn = dn.substring(0, 40);
                JSONObject dev = register(dn, ip);
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("token", dev.optString("token"));
                o.put("deviceId", dev.optString("id"));
                o.put("name", ctx.name());
                o.put("version", ctx.version());
                respond(s, 200, o);
                return;
            }

            /* --- 以下都要 token --- */
            String token = bearer(headStr, body, query);
            JSONObject dev = byToken(token);
            if (dev == null) { respond(s, 401, err("unauthorized")); return; }
            try { dev.put("last", System.currentTimeMillis()); } catch (JSONException ignored) {}

            if (path.equals(API + "/state")) {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("state", ctx.state());
                o.put("version", ctx.version());
                respond(s, 200, o);
                return;
            }
            if (path.equals(API + "/action") && "POST".equals(method)) {
                if (body == null || body.optString("action", "").isEmpty()) {
                    respond(s, 400, err("bad-request"));
                    return;
                }
                JSONObject result;
                try {
                    result = ctx.action(body, dev.optString("name"));
                } catch (Exception e) {
                    respond(s, 500, err("action-failed"));
                    return;
                }
                JSONObject o = result == null ? new JSONObject() : result;
                o.put("ok", true);
                o.put("state", ctx.state());
                o.put("version", ctx.version());
                respond(s, 200, o);
                return;
            }
            if (path.equals(API + "/unpair") && "POST".equals(method)) {
                removeDevice(dev.optString("id"));
                respond(s, 200, new JSONObject().put("ok", true));
                return;
            }
            respond(s, 404, err("not-found"));
        } catch (Exception e) {
            try { respond(s, 500, err("server-error")); } catch (Exception ignored) {}
        } finally {
            closeQuietly(s);
        }
    }

    private static JSONObject err(String code) {
        JSONObject o = new JSONObject();
        try { o.put("ok", false); o.put("error", code); } catch (JSONException ignored) {}
        return o;
    }

    private static void respond(Socket s, int code, JSONObject obj) throws IOException {
        byte[] body = obj.toString().getBytes("UTF-8");
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(code).append(" ").append(reason(code)).append("\r\n");
        head.append("Content-Type: application/json; charset=utf-8\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n");
        head.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        head.append("Connection: close\r\n\r\n");
        OutputStream os = s.getOutputStream();
        os.write(head.toString().getBytes("UTF-8"));
        os.write(body);
        os.flush();
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 413: return "Payload Too Large";
            case 429: return "Too Many Requests";
            default: return "Internal Server Error";
        }
    }

    private static String bearer(String headStr, JSONObject body, String query) {
        String[] lines = headStr.split("\r\n");
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            if (!lines[i].substring(0, c).trim().toLowerCase().equals("authorization")) continue;
            String v = lines[i].substring(c + 1).trim();
            if (v.toLowerCase().startsWith("bearer ")) return v.substring(7).trim();
        }
        if (body != null && body.optString("token", "").length() > 0) return body.optString("token");
        if (query != null && !query.isEmpty()) {
            for (String kv : query.split("&")) {
                int e = kv.indexOf('=');
                if (e > 0 && kv.substring(0, e).equals("token")) return kv.substring(e + 1);
            }
        }
        return "";
    }

    /* ---------- 错码限速 ---------- */
    private boolean pairBlocked(String ip) {
        synchronized (pairFails) {
            long[] rec = pairFails.get(ip);
            return rec != null && rec[2] > System.currentTimeMillis();
        }
    }

    private void notePairFail(String ip) {
        synchronized (pairFails) {
            long now = System.currentTimeMillis();
            long[] rec = pairFails.get(ip);
            if (rec == null || now - rec[1] > PAIR_WINDOW) rec = new long[]{0, now, 0};
            rec[0]++;
            if (rec[0] >= PAIR_MAX_FAIL) rec[2] = now + PAIR_WINDOW;
            pairFails.put(ip, rec);
        }
    }

    /* ---------- 本机地址 ---------- */
    public static List<String> localAddresses() {
        List<String> out = new ArrayList<String>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (Enumeration<InetAddress> a = ni.getInetAddresses(); a.hasMoreElements(); ) {
                    InetAddress ia = a.nextElement();
                    if (ia instanceof java.net.Inet4Address) out.add(ia.getHostAddress());
                }
            }
        } catch (Exception ignored) {}
        Collections.sort(out);
        return out;
    }

    private static void closeQuietly(Socket s) {
        if (s != null) { try { s.close(); } catch (IOException ignored) {} }
    }
}
