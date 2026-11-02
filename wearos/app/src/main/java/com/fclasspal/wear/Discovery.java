/* FClassPal · WearOS 端"自动发现电脑"（v2.6.4）
 *
 * 手表不知道电脑 IP 时，往局域网广播一条 FCP_DISCOVER，桌面端（lan-server.js）
 * 收到后回 {"type":"fcp-here","name":...,"port":...}，我们把来源地址当作电脑 IP。
 * 除了 255.255.255.255，还会往每个网卡的子网广播地址各发一次 —— 有些路由
 * 不转发全局广播，但会转子网广播。 */
package com.fclasspal.wear;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.util.Enumeration;

final class Discovery {

    private static final int DISCOVERY_PORT = 47822;
    private static final String PROBE = "FCP_DISCOVER";

    private Discovery() {}

    /** 阻塞搜索，找到就返回 {ip, port, name, version}，超时返回 null。 */
    static JSONObject find(int waitMs) {
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(400);
            byte[] msg = PROBE.getBytes("UTF-8");

            broadcastTo(sock, msg, "255.255.255.255");
            /* 每块网卡的子网广播地址 */
            try {
                Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
                while (nis != null && nis.hasMoreElements()) {
                    NetworkInterface ni = nis.nextElement();
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                        InetAddress b = ia.getBroadcast();
                        if (b != null) broadcastTo(sock, msg, b.getHostAddress());
                    }
                }
            } catch (Exception ignored) { /* 拿不到网卡就用全局广播兜底 */ }

            long deadline = System.currentTimeMillis() + waitMs;
            byte[] buf = new byte[2048];
            while (System.currentTimeMillis() < deadline) {
                DatagramPacket in = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(in);
                } catch (SocketTimeoutException te) {
                    continue;
                }
                String raw = new String(in.getData(), 0, in.getLength(), "UTF-8");
                try {
                    JSONObject jo = new JSONObject(raw);
                    if ("fcp-here".equals(jo.optString("type"))) {
                        jo.put("ip", in.getAddress().getHostAddress());
                        return jo;
                    }
                } catch (JSONException ignored) { /* 不是我们的包 */ }
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (sock != null) sock.close();
        }
        return null;
    }

    private static void broadcastTo(DatagramSocket sock, byte[] msg, String addr) {
        try {
            DatagramPacket out = new DatagramPacket(msg, msg.length,
                InetAddress.getByName(addr), DISCOVERY_PORT);
            sock.send(out);
        } catch (Exception ignored) { /* 某一块网卡发不出去不影响其它 */ }
    }
}
