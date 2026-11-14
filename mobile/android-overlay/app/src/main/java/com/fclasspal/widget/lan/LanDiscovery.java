/* FClassPal · 安卓壳的「自动发现」广播（v2.6.6）
 *
 * 与手表端 Discovery 同一套：往 255.255.255.255 与每块网卡的子网广播地址各发
 * 一条 FCP_DISCOVER，谁回 fcp-here 就是谁。电脑（lan-server.js）会回，
 * 另一台开了「被连接」的手机也会回 —— 手机之间因此也能互连。
 *
 * 注意：Android 11+ 需要 Manifest 里的 ACCESS_WIFI_STATE / CHANGE_WIFI_MULTICAST_STATE，
 * 并在部分机型上要求 WifiManager 的 multicast lock 才收得到广播回包；这里不做
 * mDNS/MulticastLock 的额外包装，收不到就让用户手输 IP（设置里一直留着那个输入框）。 */
package com.fclasspal.widget.lan;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;

public final class LanDiscovery {

    public static final int DISCOVERY_PORT = 47822;
    private static final String PROBE = "FCP_DISCOVER";

    private LanDiscovery() {}

    /** 阻塞搜索，返回所有应答（可能多台：一台电脑 + 一台手机），超时返回空表。 */
    public static List<JSONObject> findAll(int waitMs) {
        List<JSONObject> out = new ArrayList<JSONObject>();
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(400);
            byte[] msg = PROBE.getBytes("UTF-8");

            broadcastTo(sock, msg, "255.255.255.255");
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
                    if (!"fcp-here".equals(jo.optString("type"))) continue;
                    String ip = in.getAddress().getHostAddress();
                    /* 同一个 IP 只留一条（广播可能重复到达） */
                    boolean dup = false;
                    for (JSONObject got : out) if (ip.equals(got.optString("ip"))) { dup = true; break; }
                    if (dup) continue;
                    jo.put("ip", ip);
                    out.add(jo);
                } catch (JSONException ignored) { /* 不是我们的包 */ }
            }
        } catch (Exception e) {
            return out;
        } finally {
            if (sock != null) sock.close();
        }
        return out;
    }

    private static void broadcastTo(DatagramSocket sock, byte[] msg, String addr) {
        try {
            DatagramPacket out = new DatagramPacket(msg, msg.length,
                InetAddress.getByName(addr), DISCOVERY_PORT);
            sock.send(out);
        } catch (Exception ignored) { /* 某一块网卡发不出去不影响其它 */ }
    }
}
