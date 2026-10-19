package com.visualcast.player.server;

import android.content.Context;
import android.util.Log;
import com.visualcast.player.utils.NetworkUtils;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.MulticastSocket;
import java.nio.charset.StandardCharsets;

/**
 * VisualCast Android 原生 DLNA / SSDP 1900 局域网设备发现引擎
 * 负责响应手机/电脑对大屏 MediaRenderer 的 M-SEARCH 搜索与周期 NOTIFY 广播
 */
public class NativeCastServer {
    private static final String TAG = "NativeCastServer";
    private static final String SSDP_ADDR = "239.255.255.250";
    private static final int SSDP_PORT = 1900;

    private final Context context;
    private final int httpPort;
    private volatile String deviceName;
    private volatile boolean running = false;
    private MulticastSocket multicastSocket;
    private Thread listenerThread;
    private Thread broadcastThread;

    public NativeCastServer(Context context, int httpPort, String initialDeviceName) {
        this.context = context;
        this.httpPort = httpPort;
        this.deviceName = (initialDeviceName != null && !initialDeviceName.trim().isEmpty())
                ? initialDeviceName.trim() : "VisualCast 展厅大屏";
    }

    public synchronized void setDeviceName(String newName) {
        if (newName != null && !newName.trim().isEmpty()) {
            this.deviceName = newName.trim();
            // 立即触发一次活跃广播
            triggerAliveNotify();
        }
    }

    public String getDeviceName() {
        return this.deviceName;
    }

    public synchronized void start() {
        if (running) return;
        running = true;

        listenerThread = new Thread(this::runMulticastListener, "SSDP-Listener");
        listenerThread.setDaemon(true);
        listenerThread.start();

        broadcastThread = new Thread(this::runPeriodicBroadcast, "SSDP-Broadcast");
        broadcastThread.setDaemon(true);
        broadcastThread.start();

        Log.i(TAG, "NativeCastServer DLNA/SSDP 引擎已启动 (广播设备名: " + deviceName + ")");
    }

    public synchronized void stop() {
        running = false;
        if (multicastSocket != null) {
            try {
                multicastSocket.close();
            } catch (Exception ignored) {}
            multicastSocket = null;
        }
        if (listenerThread != null) {
            listenerThread.interrupt();
            listenerThread = null;
        }
        if (broadcastThread != null) {
            broadcastThread.interrupt();
            broadcastThread = null;
        }
        Log.i(TAG, "NativeCastServer 已停止");
    }

    private void runMulticastListener() {
        try {
            multicastSocket = new MulticastSocket(SSDP_PORT);
            multicastSocket.setReuseAddress(true);
            InetAddress group = InetAddress.getByName(SSDP_ADDR);
            multicastSocket.joinGroup(group);

            byte[] buf = new byte[2048];
            while (running) {
                try {
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    multicastSocket.receive(packet);

                    String msg = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                    String lower = msg.toLowerCase();

                    if (lower.contains("m-search") &&
                            (lower.contains("mediarenderer") || lower.contains("ssdp:all")
                                    || lower.contains("rootdevice") || lower.contains("avtransport"))) {
                        sendSearchResponse(packet.getAddress(), packet.getPort(), lower.contains("rootdevice"));
                    }
                } catch (Exception e) {
                    if (!running) break;
                    Thread.sleep(50);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "SSDP 组播监听初始化或运行异常: " + e.getMessage());
        }
    }

    private void sendSearchResponse(InetAddress targetAddr, int targetPort, boolean wantRootDevice) {
        try {
            String ip = NetworkUtils.getLocalIpAddress();
            String loc = "http://" + ip + ":" + httpPort + "/dlna/desc.xml";

            String st = wantRootDevice ? "upnp:rootdevice" : "urn:schemas-upnp-org:device:MediaRenderer:1";
            String usn = wantRootDevice ? "uuid:visualcast-screen-renderer-3000::upnp:rootdevice"
                    : "uuid:visualcast-screen-renderer-3000::urn:schemas-upnp-org:device:MediaRenderer:1";

            String resp = "HTTP/1.1 200 OK\r\n" +
                    "CACHE-CONTROL: max-age=1800\r\n" +
                    "EXT:\r\n" +
                    "LOCATION: " + loc + "\r\n" +
                    "SERVER: Android/10.0 UPnP/1.0 VisualCast/3.0\r\n" +
                    "ST: " + st + "\r\n" +
                    "USN: " + usn + "\r\n" +
                    "\r\n";

            byte[] bytes = resp.getBytes(StandardCharsets.UTF_8);
            DatagramPacket out = new DatagramPacket(bytes, bytes.length, targetAddr, targetPort);
            if (multicastSocket != null && !multicastSocket.isClosed()) {
                multicastSocket.send(out);
            } else {
                DatagramSocket ds = new DatagramSocket();
                ds.send(out);
                ds.close();
            }
        } catch (Exception ignored) {}
    }

    private void runPeriodicBroadcast() {
        while (running) {
            triggerAliveNotify();
            try {
                Thread.sleep(10000);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    private void triggerAliveNotify() {
        try {
            String ip = NetworkUtils.getLocalIpAddress();
            String loc = "http://" + ip + ":" + httpPort + "/dlna/desc.xml";

            String notifyMsg = "NOTIFY * HTTP/1.1\r\n" +
                    "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n" +
                    "CACHE-CONTROL: max-age=1800\r\n" +
                    "LOCATION: " + loc + "\r\n" +
                    "NT: urn:schemas-upnp-org:device:MediaRenderer:1\r\n" +
                    "NTS: ssdp:alive\r\n" +
                    "SERVER: Android/10.0 UPnP/1.0 VisualCast/3.0\r\n" +
                    "USN: uuid:visualcast-screen-renderer-3000::urn:schemas-upnp-org:device:MediaRenderer:1\r\n" +
                    "\r\n";

            byte[] bytes = notifyMsg.getBytes(StandardCharsets.UTF_8);
            InetAddress group = InetAddress.getByName(SSDP_ADDR);
            DatagramPacket packet = new DatagramPacket(bytes, bytes.length, group, SSDP_PORT);

            DatagramSocket socket = new DatagramSocket();
            socket.send(packet);
            socket.close();
        } catch (Exception ignored) {}
    }
}
