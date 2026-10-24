package com.visualcast.player.server;

import android.content.Context;
import android.util.Log;
import com.visualcast.player.MainActivity;
import com.visualcast.player.utils.SystemHelper;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 展厅外部智能中控通信与指令调度中枢 (TCP 8000 & UDP 8001)
 * 全面兼容快思聪 (Crestron)、AMX、华为、快捷等主流工控中控主机
 * 内嵌协议拦截并联动展馆环境 IoT 协议中转分发器
 */
public class CentralControlServer {
    private static final String TAG = "VisualCastCentral";
    private final Context context;
    private final IoTEngine iotEngine;
    private final int tcpPort;
    private final int udpPort;

    private volatile boolean isRunning = false;
    private ServerSocket tcpServerSocket;
    private DatagramSocket udpSocket;
    private Thread tcpThread;
    private Thread udpThread;

    public CentralControlServer(Context context, IoTEngine iotEngine, int tcpPort, int udpPort) {
        this.context = context;
        this.iotEngine = iotEngine;
        this.tcpPort = tcpPort;
        this.udpPort = udpPort;
    }

    public synchronized void start() {
        if (isRunning) return;
        isRunning = true;

        // 1. 启动 TCP 8000 长/短连接监听线程
        tcpThread = new Thread(() -> {
            try {
                tcpServerSocket = new ServerSocket(tcpPort, 50, InetAddress.getByName("0.0.0.0"));
                Log.i(TAG, "外部硬件中控 TCP 服务已在端口 " + tcpPort + " 启动");
                while (isRunning && !tcpServerSocket.isClosed()) {
                    try {
                        Socket client = tcpServerSocket.accept();
                        client.setSoTimeout(10000); // 10秒读超时
                        new Thread(() -> handleTcpClient(client), "VC-CentralTcpWorker").start();
                    } catch (Exception e) {
                        if (!isRunning) break;
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "TCP 中控服务启动异常: " + e.getMessage());
            }
        }, "VC-CentralTcpServer");
        tcpThread.start();

        // 2. 启动 UDP 8001 数据报无连接监听线程
        udpThread = new Thread(() -> {
            try {
                udpSocket = new DatagramSocket(udpPort, InetAddress.getByName("0.0.0.0"));
                Log.i(TAG, "外部硬件中控 UDP 服务已在端口 " + udpPort + " 启动");
                byte[] buf = new byte[2048];
                while (isRunning && !udpSocket.isClosed()) {
                    try {
                        DatagramPacket packet = new DatagramPacket(buf, buf.length);
                        udpSocket.receive(packet);
                        String rawCmd = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8).trim();
                        if (!rawCmd.isEmpty()) {
                            String sourceAddr = packet.getAddress().getHostAddress() + ":" + packet.getPort();
                            // 展馆物联网自定义中转拦截分发
                            if (iotEngine != null) {
                                try {
                                    iotEngine.processForwarding(rawCmd, "UDP");
                                } catch (Exception ignored) {}
                            }
                            dispatchCentralCommand(rawCmd);
                        }
                    } catch (Exception e) {
                        if (!isRunning) break;
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "UDP 中控服务启动异常: " + e.getMessage());
            }
        }, "VC-CentralUdpServer");
        udpThread.start();
    }

    private void handleTcpClient(Socket client) {
        try (Socket s = client;
             java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
             OutputStream out = s.getOutputStream()) {

            String line;
            while (isRunning && !s.isClosed() && (line = reader.readLine()) != null) {
                String rawCmd = line.trim();
                if (rawCmd.isEmpty()) continue;

                // 展馆物联网自定义中转拦截分发
                if (iotEngine != null) {
                    try {
                        iotEngine.processForwarding(rawCmd, "TCP");
                    } catch (Exception ignored) {}
                }
                String reply = dispatchCentralCommandWithReply(rawCmd);
                out.write((reply + "\r\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (Exception ignored) {}
    }

    /**
     * 将外部中控命令映射分发为播控核心动作与系统级行为
     */
    public void dispatchCentralCommand(String rawCmd) {
        dispatchCentralCommandWithReply(rawCmd);
    }

    public String dispatchCentralCommandWithReply(String rawCmd) {
        if (rawCmd == null || rawCmd.trim().isEmpty()) return "OK";
        String clean = rawCmd.trim();
        String c = clean.toUpperCase(Locale.ROOT);
        Log.i(TAG, "收到外部中控指令: " + clean);

        MainActivity act = MainActivity.getInstance();

        try {
            // 0. 状态查询指令 (返回当前播控引擎状态 JSON)
            if ("STATUS".equals(c) || "GET_STATUS".equals(c) || "STATE".equals(c)) {
                if (HttpRouter.getInstance() != null) {
                    return HttpRouter.getInstance().getPlayerStatusJsonObject().toString();
                }
                return "{\"status\":\"ok\"}";
            }

            // 1. 基础播放控制
            if ("PLAY".equals(c) || "RESUME".equals(c)) {
                if (act != null) act.dispatchCommandToWeb("PLAY", new JSONObject());
                if (HttpRouter.getInstance() != null) HttpRouter.getInstance().pushCommand("PLAY", new JSONObject());
            } else if ("PAUSE".equals(c)) {
                if (act != null) act.dispatchCommandToWeb("PAUSE", new JSONObject());
                if (HttpRouter.getInstance() != null) HttpRouter.getInstance().pushCommand("PAUSE", new JSONObject());
            } else if ("STOP".equals(c)) {
                if (act != null) {
                    act.bringToFrontAndCloseDoc();
                    act.dispatchCommandToWeb("PAUSE", new JSONObject());
                }
                if (HttpRouter.getInstance() != null) HttpRouter.getInstance().pushCommand("PAUSE", new JSONObject());
            } else if ("NEXT".equals(c)) {
                if (act != null) act.dispatchCommandToWeb("NEXT", new JSONObject());
                if (HttpRouter.getInstance() != null) HttpRouter.getInstance().pushCommand("NEXT", new JSONObject());
            } else if ("PREV".equals(c)) {
                if (act != null) act.dispatchCommandToWeb("PREV", new JSONObject());
                if (HttpRouter.getInstance() != null) HttpRouter.getInstance().pushCommand("PREV", new JSONObject());

            // 1.1 文档/幻灯片上一页、下一页与退出
            } else if ("DOC_NEXT".equals(c) || "PPT_NEXT".equals(c) || "PAGE_DOWN".equals(c)) {
                SystemHelper.controlWPSPresentation(context, "next");
                if (act != null) act.dispatchCommandToWeb("DOC_NEXT", new JSONObject());
            } else if ("DOC_PREV".equals(c) || "PPT_PREV".equals(c) || "PAGE_UP".equals(c)) {
                SystemHelper.controlWPSPresentation(context, "prev");
                if (act != null) act.dispatchCommandToWeb("DOC_PREV", new JSONObject());
            } else if ("DOC_EXIT".equals(c) || "PPT_CLOSE".equals(c) || "CLOSE_PPT".equals(c)) {
                if (act != null) act.bringToFrontAndCloseDoc();

            // 2. 画面黑场与静帧控制
            } else if ("BLACK_ON".equals(c) || "BLACKOUT_ON".equals(c) || "BLACKOUT".equals(c)
                    || "BLACKOUT:ON".equals(c) || "BLACKOUT:1".equals(c) || "BLACK:1".equals(c) || "BLACK:ON".equals(c)) {
                JSONObject p = new JSONObject();
                p.put("blackout", true);
                HttpRouter.updateBlackoutState(true);
                if (act != null) act.dispatchCommandToWeb("BLACKOUT", p);
            } else if ("BLACK_OFF".equals(c) || "BLACKOUT_OFF".equals(c)
                    || "BLACKOUT:OFF".equals(c) || "BLACKOUT:0".equals(c) || "BLACK:0".equals(c) || "BLACK:OFF".equals(c)) {
                JSONObject p = new JSONObject();
                p.put("blackout", false);
                HttpRouter.updateBlackoutState(false);
                if (act != null) act.dispatchCommandToWeb("BLACKOUT", p);
            } else if ("FREEZE_ON".equals(c) || "FREEZE".equals(c) || "FREEZE:ON".equals(c) || "FREEZE:1".equals(c)) {
                JSONObject p = new JSONObject();
                p.put("freeze", true);
                if (act != null) act.dispatchCommandToWeb("FREEZE", p);
            } else if ("FREEZE_OFF".equals(c) || "FREEZE:OFF".equals(c) || "FREEZE:0".equals(c)) {
                JSONObject p = new JSONObject();
                p.put("freeze", false);
                if (act != null) act.dispatchCommandToWeb("FREEZE", p);

            // 3. 音量与静音控制
            } else if ("VOL_UP".equals(c)) {
                SystemHelper.adjustVolume(context, "up");
            } else if ("VOL_DOWN".equals(c)) {
                SystemHelper.adjustVolume(context, "down");
            } else if (c.startsWith("VOL:") || c.startsWith("VOL_SET:")) {
                try {
                    String valStr = clean.split(":", 2)[1].trim();
                    int vol = Integer.parseInt(valStr);
                    vol = Math.max(0, Math.min(100, vol));
                    JSONObject p = new JSONObject();
                    p.put("volume", vol);
                    if (act != null) act.dispatchCommandToWeb("VOLUME", p);
                } catch (Exception ignored) {}
            } else if ("MUTE".equals(c) || "MUTE_ON".equals(c)) {
                JSONObject p = new JSONObject();
                p.put("muted", true);
                if (act != null) act.dispatchCommandToWeb("MUTE", p);
            } else if ("UNMUTE".equals(c) || "MUTE_OFF".equals(c)) {
                JSONObject p = new JSONObject();
                p.put("muted", false);
                if (act != null) act.dispatchCommandToWeb("MUTE", p);

            // 4. 指定媒体点播与待机回退
            } else if ("IDLE".equals(c) || "STANDBY".equals(c) || "RETURN_STANDBY".equals(c) || "HOME".equals(c)) {
                if (act != null) {
                    act.bringToFrontAndCloseDoc();
                    act.dispatchCommandToWeb("RETURN_TO_STANDBY", new JSONObject());
                }
            } else if (c.startsWith("PLAY_ID:") || c.startsWith("PLAY_NAME:") || c.startsWith("SWITCH:") || c.startsWith("LOAD:") || (c.startsWith("PLAY:") && c.length() > 5)) {
                String mediaName = clean.split(":", 2)[1].trim();
                if (!mediaName.isEmpty()) {
                    JSONObject p = new JSONObject();
                    p.put("media", mediaName);
                    p.put("name", mediaName);
                    if (act != null) act.dispatchCommandToWeb("PLAY_MEDIA", p);
                }
            } else if (c.startsWith("SWITCH_INDEX:") || c.startsWith("PLAY_INDEX:")) {
                try {
                    int idx = Integer.parseInt(clean.split(":", 2)[1].trim());
                    JSONObject p = new JSONObject();
                    p.put("index", idx);
                    if (act != null) act.dispatchCommandToWeb("SWITCH_INDEX", p);
                } catch (Exception ignored) {}
            } else if (c.startsWith("LOOP_MODE:") || c.startsWith("LOOP:")) {
                String loopMode = clean.split(":", 2)[1].trim().toUpperCase();
                if (!loopMode.isEmpty()) {
                    JSONObject p = new JSONObject();
                    p.put("loop_mode", loopMode);
                    if (act != null) act.dispatchCommandToWeb("SET_LOOP_MODE", p);
                    if (HttpRouter.getInstance() != null) {
                        HttpRouter.getInstance().setLoopMode(loopMode);
                    }
                }

            // 5. 展馆开闭馆与休眠唤醒
            } else if ("WAKEUP".equals(c) || "POWER_ON".equals(c) || "POWERON".equals(c) || "BOOT".equals(c) || "OPEN_HALL".equals(c)) {
                HttpRouter.setGlobalSleepMode(false);
                if (act != null) {
                    act.triggerSleepTransition(false);
                }
            } else if ("SLEEP".equals(c) || "POWER_OFF".equals(c) || "POWEROFF".equals(c) || "CLOSE_HALL".equals(c)) {
                // 按需求：待机、唤醒、定时功能已删除，大屏24小时常亮放映，旁路休眠操作
                Log.i(TAG, "收到外部中控休眠指令，已按需求旁路，商显大屏保持常亮放映");

            // 6. 外部第三方应用拉起
            } else if (c.startsWith("LAUNCH_APP:") || c.startsWith("LAUNCH:")) {
                String appName = clean.split(":", 2)[1].trim();
                if (!appName.isEmpty()) {
                    SystemHelper.launchExternalApp(context, appName);
                }

            // 7. 硬件重启与关机 (针对 Android 主板)
            } else if ("REBOOT".equals(c) || "SYSTEM_RESTART".equals(c)) {
                if (act != null) {
                    act.runOnUiThread(act::recreate);
                }
            } else if ("SHUTDOWN".equals(c)) {
                HttpRouter.setGlobalSleepMode(true);
                if (act != null) {
                    act.triggerSleepTransition(true);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "中控指令执行异常: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
        return "OK";
    }

    public synchronized void stop() {
        isRunning = false;
        if (tcpServerSocket != null) {
            try { tcpServerSocket.close(); } catch (Exception ignored) {}
            tcpServerSocket = null;
        }
        if (udpSocket != null) {
            try { udpSocket.close(); } catch (Exception ignored) {}
            udpSocket = null;
        }
        if (tcpThread != null) {
            tcpThread.interrupt();
            tcpThread = null;
        }
        if (udpThread != null) {
            udpThread.interrupt();
            udpThread = null;
        }
        Log.i(TAG, "外部硬件中控服务已安全停止");
    }
}
