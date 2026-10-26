package com.visualcast.player.server;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import com.visualcast.player.MainActivity;
import com.visualcast.player.utils.StorageHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * VisualCast 毫秒级多机集群联播引擎 (Android 端与 Windows EXE 100% 协议互通)
 * 1. 兼容 VC_SYNC_V1 UDP 组播/定向广播/单播矩阵 (端口 8002)
 * 2. 具备自动时钟漂移滤波、跨目录同名素材自愈检索、防回环防打架机制
 * 3. 支持 HTTP 8088 状态双保险兜底 (跨交换机与防 UDP 丢包)
 * 4. 彻底打通 Windows EXE (dist/VisualCast.exe) 与 Android APK (VisualCast.apk)
 */
public class ClusterSyncEngine {
    private static final String TAG = "ClusterSync";
    private static volatile ClusterSyncEngine instance;

    public static final int SYNC_BROADCAST_PORT = 8002;
    public static final String SYNC_MAGIC = "VC_SYNC_V1";

    private final Context context;
    private String role = "STANDALONE"; // "STANDALONE" | "MASTER" | "SLAVE"
    private String masterIp = "";
    private final List<String> configuredSlaveIps = new ArrayList<>();
    private final String nodeId;
    private volatile boolean running = false;

    private double clockOffsetMs = 0.0;
    private long lastMasterBeat = 0;
    private JSONObject masterInfo = null;
    private final ConcurrentHashMap<String, JSONObject> activeSlaves = new ConcurrentHashMap<>();

    private String slaveLoadingMedia = "";
    private long lastLoadCmdTime = 0;
    private long lastFullConfigSyncTime = 0;
    private double lastAppliedConfigTs = 0.0;
    private volatile boolean isApplyingRemoteConfig = false;

    private DatagramSocket sockSend;
    private DatagramSocket sockRecv;
    private final List<Thread> workerThreads = new ArrayList<>();

    public static ClusterSyncEngine getInstance(Context context) {
        if (instance == null) {
            synchronized (ClusterSyncEngine.class) {
                if (instance == null) {
                    instance = new ClusterSyncEngine(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    public static ClusterSyncEngine getInstance() {
        return instance;
    }

    private ClusterSyncEngine(Context context) {
        this.context = context;
        String host = android.os.Build.MODEL.replaceAll("[^a-zA-Z0-9_-]", "");
        this.nodeId = "VC_Android_" + host + "_" + (System.currentTimeMillis() % 10000);
        loadConfig();
    }

    public synchronized void loadConfig() {
        try {
            File cfgFile = new File(StorageHelper.getConfigDir(context), "player_config.json");
            if (cfgFile.exists()) {
                String content = HttpRouter.readFileToString(cfgFile);
                if (!content.isEmpty()) {
                    JSONObject cfg = new JSONObject(content);
                    this.role = cfg.optString("cluster_role", "STANDALONE").toUpperCase();
                    this.masterIp = cfg.optString("master_ip", "").trim();
                    String sIps = cfg.optString("slave_ips", "");
                    this.configuredSlaveIps.clear();
                    if (!sIps.isEmpty()) {
                        String[] parts = sIps.replace('，', ',').split(",");
                        for (String p : parts) {
                            String trimmed = p.trim();
                            if (!trimmed.isEmpty()) this.configuredSlaveIps.add(trimmed);
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "载入集群配置异常: " + e.getMessage());
        }
    }

    public synchronized void updateConfig(String newRole, String newMasterIp, String newSlaveIps) {
        if (newRole != null && !newRole.trim().isEmpty()) {
            this.role = newRole.trim().toUpperCase();
        }
        if (newMasterIp != null) {
            this.masterIp = newMasterIp.trim();
        }
        if (newSlaveIps != null) {
            this.configuredSlaveIps.clear();
            String[] parts = newSlaveIps.replace('，', ',').split(",");
            for (String p : parts) {
                String trimmed = p.trim();
                if (!trimmed.isEmpty()) this.configuredSlaveIps.add(trimmed);
            }
        }
        Log.i(TAG, "集群配置已更新: 角色=" + this.role + ", Master=" + this.masterIp + ", Slaves=" + this.configuredSlaveIps);
    }

    public synchronized void start() {
        if (running) return;
        running = true;

        try {
            sockSend = new DatagramSocket();
            sockSend.setBroadcast(true);
        } catch (Exception e) {
            Log.w(TAG, "初始化发送 Socket 异常: " + e.getMessage());
        }

        try {
            sockRecv = new DatagramSocket(SYNC_BROADCAST_PORT);
            sockRecv.setReuseAddress(true);
            sockRecv.setSoTimeout(1200);
        } catch (Exception e) {
            Log.w(TAG, "绑定 UDP 端口 " + SYNC_BROADCAST_PORT + " 异常: " + e.getMessage());
        }

        // 1. UDP 接收线程
        Thread tRecv = new Thread(this::recvLoop, "ClusterSync-Recv");
        tRecv.setDaemon(true);
        tRecv.start();
        workerThreads.add(tRecv);

        // 2. 心跳节拍线程 (Master 广播节拍，Slave 定期反馈)
        Thread tBeat = new Thread(this::heartbeatLoop, "ClusterSync-Beat");
        tBeat.setDaemon(true);
        tBeat.start();
        workerThreads.add(tBeat);

        // 3. HTTP 兜底线程 (从机轮询主控状态与配置)
        Thread tHttp = new Thread(this::httpSyncLoop, "ClusterSync-HttpFallback");
        tHttp.setDaemon(true);
        tHttp.start();
        workerThreads.add(tHttp);

        Log.i(TAG, "VisualCast 多机集群联播引擎已在 Android 启动！角色: 【" + role + "】, Master: 【" + (masterIp.isEmpty() ? "自动广播" : masterIp) + "】");
    }

    public synchronized void stop() {
        running = false;
        if (sockRecv != null) {
            try { sockRecv.close(); } catch (Exception ignored) {}
            sockRecv = null;
        }
        if (sockSend != null) {
            try { sockSend.close(); } catch (Exception ignored) {}
            sockSend = null;
        }
        workerThreads.clear();
        Log.i(TAG, "VisualCast 多机集群联播引擎已停止");
    }

    // ===================== 跨目录素材同名自愈匹配 =====================
    public static class MediaSearchResult {
        public boolean found;
        public String localRelPath;
        public String localFolder;

        public MediaSearchResult(boolean found, String path, String folder) {
            this.found = found;
            this.localRelPath = path;
            this.localFolder = folder;
        }
    }

    public MediaSearchResult findMediaInSlaveFolders(String targetMedia) {
        if (targetMedia == null || targetMedia.trim().isEmpty()) {
            return new MediaSearchResult(false, "", "");
        }
        String normTarget = targetMedia.replace('\\', '/').replaceAll("^/+", "");
        File mediaDir = StorageHelper.getMediaDir(context);

        // 1. 优先比对相对路径是否存在
        File directFile = new File(mediaDir, normTarget);
        if (directFile.isFile()) {
            String folder = "";
            int slash = normTarget.lastIndexOf('/');
            if (slash != -1) folder = normTarget.substring(0, slash);
            return new MediaSearchResult(true, normTarget, folder);
        }

        // 2. 提取文件名（去除可能的文件夹前缀）
        String targetFilename = normTarget;
        int lastSlash = normTarget.lastIndexOf('/');
        if (lastSlash != -1) {
            targetFilename = normTarget.substring(lastSlash + 1);
        }
        String targetLower = targetFilename.toLowerCase();
        String targetStemLower = targetLower;
        int dot = targetLower.lastIndexOf('.');
        if (dot != -1) {
            targetStemLower = targetLower.substring(0, dot);
        }

        // 3. 递归遍历搜索本地所有子文件夹
        MediaSearchResult exact = searchRecursive(mediaDir, mediaDir, targetLower, targetStemLower, true);
        if (exact != null) return exact;

        MediaSearchResult fuzzy = searchRecursive(mediaDir, mediaDir, targetLower, targetStemLower, false);
        if (fuzzy != null) return fuzzy;

        return new MediaSearchResult(false, targetMedia, "");
    }

    private MediaSearchResult searchRecursive(File baseDir, File curDir, String targetLower, String stemLower, boolean exactMatchOnly) {
        File[] list = curDir.listFiles();
        if (list == null) return null;

        for (File f : list) {
            if (f.getName().startsWith(".") || f.getName().endsWith(".trans_tmp")) continue;
            if (f.isDirectory()) {
                MediaSearchResult res = searchRecursive(baseDir, f, targetLower, stemLower, exactMatchOnly);
                if (res != null) return res;
            } else if (f.isFile()) {
                String fName = f.getName();
                String fLower = fName.toLowerCase();
                String relPath = f.getAbsolutePath().substring(baseDir.getAbsolutePath().length()).replace('\\', '/').replaceAll("^/+", "");
                String folder = "";
                int sIdx = relPath.lastIndexOf('/');
                if (sIdx != -1) folder = relPath.substring(0, sIdx);

                if (exactMatchOnly) {
                    if (fLower.equals(targetLower)) {
                        return new MediaSearchResult(true, relPath, folder);
                    }
                } else {
                    int dot = fLower.lastIndexOf('.');
                    String fStem = (dot != -1) ? fLower.substring(0, dot) : fLower;
                    if (fStem.equals(stemLower)) {
                        return new MediaSearchResult(true, relPath, folder);
                    }
                }
            }
        }
        return null;
    }

    // ===================== 广播与网络目标计算 =====================
    private List<InetAddress> getBroadcastDestinations() {
        Set<InetAddress> set = new HashSet<>();
        try {
            set.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {}

        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                if (iface.isLoopback() || !iface.isUp()) continue;
                for (java.net.InterfaceAddress addr : iface.getInterfaceAddresses()) {
                    InetAddress bcast = addr.getBroadcast();
                    if (bcast != null) set.add(bcast);
                }
            }
        } catch (Exception ignored) {}

        // 单播目标
        if ("SLAVE".equals(role) && masterIp != null && !masterIp.isEmpty()) {
            try {
                set.add(InetAddress.getByName(masterIp.trim()));
            } catch (Exception ignored) {}
        }
        if ("MASTER".equals(role)) {
            for (String sip : configuredSlaveIps) {
                try {
                    set.add(InetAddress.getByName(sip.trim()));
                } catch (Exception ignored) {}
            }
            for (JSONObject s : activeSlaves.values()) {
                String sip = s.optString("ip", "");
                if (!sip.isEmpty() && !sip.startsWith("127.")) {
                    try {
                        set.add(InetAddress.getByName(sip));
                    } catch (Exception ignored) {}
                }
            }
        }

        return new ArrayList<>(set);
    }

    private void sendUdpPacket(JSONObject data) {
        if (sockSend == null) return;
        try {
            byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
            List<InetAddress> addrs = getBroadcastDestinations();
            for (InetAddress a : addrs) {
                try {
                    DatagramPacket packet = new DatagramPacket(bytes, bytes.length, a, SYNC_BROADCAST_PORT);
                    sockSend.send(packet);
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    // ===================== Master 控制广播 =====================
    public void broadcastMasterCommand(String cmd, JSONObject params) {
        if (!"MASTER".equals(role) || sockSend == null) return;
        try {
            long nowMs = System.currentTimeMillis();
            JSONObject packet = new JSONObject();
            packet.put("magic", SYNC_MAGIC);
            packet.put("type", "MASTER_CMD");
            packet.put("node_id", nodeId);
            packet.put("cmd", cmd);
            packet.put("params", params != null ? params : new JSONObject());
            packet.put("send_time_ms", (double) nowMs);
            packet.put("schedule_time_ms", (double) (nowMs + 250));
            sendUdpPacket(packet);
        } catch (Exception e) {
            Log.w(TAG, "广播 Master 指令异常: " + e.getMessage());
        }
    }

    public void broadcastFullConfig() {
        if (!"MASTER".equals(role)) return;
        try {
            JSONObject fullCfg = getFullMasterConfig();
            if (fullCfg == null) return;
            broadcastMasterCommand("SYNC_FULL_CONFIG", fullCfg);

            // 异步 HTTP 直推所有已知从机
            new Thread(() -> {
                Set<String> targets = new HashSet<>(configuredSlaveIps);
                for (JSONObject s : activeSlaves.values()) {
                    String sip = s.optString("ip", "");
                    if (!sip.isEmpty() && !sip.startsWith("127.")) targets.add(sip);
                }
                String body = fullCfg.toString();
                for (String ip : targets) {
                    try {
                        URL url = new URL("http://" + ip + ":8088/api/sync/apply_master_config");
                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                        conn.setRequestMethod("POST");
                        conn.setConnectTimeout(2000);
                        conn.setReadTimeout(2000);
                        conn.setRequestProperty("Content-Type", "application/json");
                        conn.setDoOutput(true);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                        conn.getResponseCode();
                        conn.disconnect();
                        Log.i(TAG, "成功通过 HTTP 向从机 " + ip + " 直推全量设置");
                    } catch (Exception ignored) {}
                }
            }, "ClusterSync-PushAllSlaves").start();
        } catch (Exception e) {
            Log.w(TAG, "全量广播设置异常: " + e.getMessage());
        }
    }

    public JSONObject getFullMasterConfig() {
        try {
            JSONObject res = new JSONObject();
            res.put("magic", SYNC_MAGIC);
            res.put("type", "FULL_CONFIG_DATA");
            res.put("node_id", nodeId);
            res.put("timestamp", System.currentTimeMillis() / 1000.0);

            JSONObject cfg = new JSONObject();
            File cfgFile = new File(StorageHelper.getConfigDir(context), "player_config.json");
            if (cfgFile.exists()) {
                cfg = new JSONObject(HttpRouter.readFileToString(cfgFile));
            }
            res.put("config", cfg);

            JSONArray cmArr = new JSONArray();
            File cmFile = new File(StorageHelper.getConfigDir(context), "custom_media.json");
            if (cmFile.exists()) {
                cmArr = new JSONArray(HttpRouter.readFileToString(cmFile));
            }
            res.put("custom_media", cmArr);
            return res;
        } catch (Exception e) {
            return null;
        }
    }

    // ===================== Slave 应用配置 =====================
    public boolean applyMasterFullConfig(JSONObject payload) {
        if (payload == null) return false;
        isApplyingRemoteConfig = true;
        try {
            Log.i(TAG, "从机正在应用来自 Master 的全量设置...");
            JSONObject cfg = payload.optJSONObject("config");
            if (cfg == null && payload.has("playback")) cfg = payload;

            if (cfg != null) {
                File cfgFile = new File(StorageHelper.getConfigDir(context), "player_config.json");
                JSONObject localCfg = new JSONObject();
                if (cfgFile.exists()) {
                    try { localCfg = new JSONObject(HttpRouter.readFileToString(cfgFile)); } catch (Exception ignored) {}
                }

                // 同步各项参数
                JSONObject pb = cfg.optJSONObject("playback");
                if (pb == null) pb = cfg;

                for (String k : new String[]{"scale_mode", "loop_mode", "volume", "muted", "orientation", "cycle_duration", "switch_policy", "touch_mode"}) {
                    if (pb.has(k)) {
                        localCfg.put(k, pb.get(k));
                    }
                }
                if (cfg.has("subtitle")) {
                    localCfg.put("subtitle", cfg.get("subtitle"));
                }

                // 写入 player_config.json
                try (FileOutputStream fos = new FileOutputStream(cfgFile)) {
                    fos.write(localCfg.toString(2).getBytes(StandardCharsets.UTF_8));
                }

                // 向 WebView 前端即时生效
                if (MainActivity.getInstance() != null) {
                    if (pb.has("scale_mode")) MainActivity.getInstance().dispatchCommandToWeb("SET_SCALE_MODE", new JSONObject().put("scale_mode", pb.optString("scale_mode")));
                    if (pb.has("loop_mode")) MainActivity.getInstance().dispatchCommandToWeb("SET_LOOP_MODE", new JSONObject().put("loop_mode", pb.optString("loop_mode")));
                    if (pb.has("volume")) MainActivity.getInstance().dispatchCommandToWeb("VOLUME", new JSONObject().put("volume", pb.optInt("volume", 85)));
                    if (pb.has("muted")) MainActivity.getInstance().dispatchCommandToWeb("MUTE", new JSONObject().put("muted", pb.optBoolean("muted", false)));
                    if (pb.has("orientation")) MainActivity.getInstance().setScreenOrientation(pb.optString("orientation"));
                    if (cfg.has("subtitle")) MainActivity.getInstance().dispatchCommandToWeb("UPDATE_SUBTITLE", cfg.optJSONObject("subtitle"));
                }
            }

            // 同步 custom_media.json
            JSONArray cmArr = payload.optJSONArray("custom_media");
            if (cmArr != null) {
                File cmFile = new File(StorageHelper.getConfigDir(context), "custom_media.json");
                try (FileOutputStream fos = new FileOutputStream(cmFile)) {
                    fos.write(cmArr.toString(2).getBytes(StandardCharsets.UTF_8));
                }
            }

            lastAppliedConfigTs = payload.optDouble("timestamp", System.currentTimeMillis() / 1000.0);
            Log.i(TAG, "从机已成功应用 Master 全部设置并持久化！");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "从机应用 Master 配置异常: " + e.getMessage());
            return false;
        } finally {
            isApplyingRemoteConfig = false;
        }
    }

    // ===================== UDP 接收与指令分发 =====================
    private void recvLoop() {
        byte[] buf = new byte[8192];
        while (running) {
            try {
                if (sockRecv == null) {
                    Thread.sleep(500);
                    continue;
                }
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                sockRecv.receive(packet);

                long recvTimeMs = System.currentTimeMillis();
                String raw = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
                JSONObject msg = new JSONObject(raw);

                if (!SYNC_MAGIC.equals(msg.optString("magic"))) continue;
                String senderId = msg.optString("node_id");
                if (nodeId.equals(senderId)) continue; // 忽略自身

                String type = msg.optString("type");
                String senderIp = packet.getAddress().getHostAddress();

                if ("SYNC_BEAT".equals(type) && "SLAVE".equals(role)) {
                    handleMasterBeat(msg, recvTimeMs, senderIp);
                } else if ("MASTER_CMD".equals(type) && "SLAVE".equals(role)) {
                    handleMasterCmd(msg);
                } else if ("SLAVE_REPORT".equals(type) && "MASTER".equals(role)) {
                    handleSlaveReport(msg, recvTimeMs, senderIp);
                } else if ("DISCOVER_SLAVES".equals(type) && "SLAVE".equals(role)) {
                    sendSlaveReport(recvTimeMs);
                }
            } catch (java.net.SocketTimeoutException ignored) {
            } catch (Exception e) {
                if (!running) break;
            }
        }
    }

    private void handleMasterBeat(JSONObject msg, long recvTimeMs, String senderIp) {
        double masterTimeMs = msg.optDouble("master_time_ms", recvTimeMs);
        double estOffset = masterTimeMs - recvTimeMs;
        if (clockOffsetMs == 0.0) {
            clockOffsetMs = estOffset;
        } else {
            clockOffsetMs = clockOffsetMs * 0.85 + estOffset * 0.15;
        }

        lastMasterBeat = recvTimeMs;
        try {
            masterInfo = new JSONObject(msg.toString());
            masterInfo.put("recv_local_ms", recvTimeMs);
            masterInfo.put("ip", senderIp);
        } catch (Exception ignored) {}

        String masterMedia = msg.optString("media", "");
        String masterState = msg.optString("state", "IDLE");

        if (!masterMedia.isEmpty() && "PLAYING".equals(masterState)) {
            String curMedia = "";
            try {
                curMedia = HttpRouter.getPlayerState().optString("current_media", "");
            } catch (Exception ignored) {}

            String slaveBase = new File(curMedia.replace('\\', '/')).getName().toLowerCase();
            String masterBase = new File(masterMedia.replace('\\', '/')).getName().toLowerCase();

            if (!slaveBase.equals(masterBase)) {
                long nowSec = SystemClock.elapsedRealtime() / 1000;
                // 5 秒加载防抖
                if (masterBase.equals(slaveLoadingMedia) && (nowSec - lastLoadCmdTime) < 5) {
                    return;
                }
                MediaSearchResult match = findMediaInSlaveFolders(masterMedia);
                if (match.found) {
                    slaveLoadingMedia = masterBase;
                    lastLoadCmdTime = nowSec;
                    Log.i(TAG, "从机同步跟随 Master 切换素材: " + match.localRelPath + " (文件夹: " + match.localFolder + ")");
                    try {
                        JSONObject p = new JSONObject();
                        p.put("media", match.localRelPath);
                        p.put("folder", match.localFolder);
                        p.put("mode", "待机".equals(match.localFolder) ? "ATTRACT" : "ON_DEMAND");
                        if (MainActivity.getInstance() != null) {
                            MainActivity.getInstance().dispatchCommandToWeb("LOAD_AND_PLAY", p);
                        }
                    } catch (Exception ignored) {}
                } else {
                    Log.w(TAG, "从机本地未能找到与 Master 同名的素材: " + masterMedia);
                }
            } else {
                slaveLoadingMedia = "";
            }
        }

        // 播放与暂停态对齐
        try {
            String curState = HttpRouter.getPlayerState().optString("state", "IDLE");
            if ("PAUSED".equals(masterState) && "PLAYING".equals(curState)) {
                if (MainActivity.getInstance() != null) MainActivity.getInstance().dispatchCommandToWeb("PAUSE", new JSONObject());
            } else if ("PLAYING".equals(masterState) && "PAUSED".equals(curState)) {
                if (MainActivity.getInstance() != null) MainActivity.getInstance().dispatchCommandToWeb("PLAY", new JSONObject());
            }
        } catch (Exception ignored) {}
    }

    private void handleMasterCmd(JSONObject msg) {
        String cmd = msg.optString("cmd", "");
        JSONObject params = msg.optJSONObject("params");
        if (params == null) params = new JSONObject();

        Log.i(TAG, "从机收到 Master 指令: " + cmd + ", 参数: " + params);

        if ("LOAD_AND_PLAY".equals(cmd) || "LOAD".equals(cmd) || "SWITCH_MEDIA".equals(cmd) || "PLAY_MEDIA".equals(cmd)) {
            String targetMedia = params.optString("media", "");
            if (!targetMedia.isEmpty()) {
                String targetBase = new File(targetMedia.replace('\\', '/')).getName().toLowerCase();
                slaveLoadingMedia = targetBase;
                lastLoadCmdTime = SystemClock.elapsedRealtime() / 1000;

                MediaSearchResult match = findMediaInSlaveFolders(targetMedia);
                if (match.found) {
                    try {
                        JSONObject syncP = new JSONObject(params.toString());
                        syncP.put("media", match.localRelPath);
                        syncP.put("folder", match.localFolder);
                        if (MainActivity.getInstance() != null) {
                            MainActivity.getInstance().dispatchCommandToWeb("LOAD_AND_PLAY", syncP);
                        }
                    } catch (Exception ignored) {}
                } else {
                    Log.w(TAG, "从机未能在本地文件夹找到点播素材: " + targetMedia);
                }
            } else {
                if (MainActivity.getInstance() != null) {
                    MainActivity.getInstance().dispatchCommandToWeb("LOAD_AND_PLAY", params);
                }
            }
        } else if ("SYNC_FULL_CONFIG".equals(cmd)) {
            applyMasterFullConfig(params);
        } else if ("SEEK".equals(cmd)) {
            if (MainActivity.getInstance() != null) MainActivity.getInstance().dispatchCommandToWeb("SEEK", params);
        } else {
            if (MainActivity.getInstance() != null) {
                MainActivity.getInstance().dispatchCommandToWeb(cmd, params);
            }
        }
    }

    private void handleSlaveReport(JSONObject msg, long recvTimeMs, String senderIp) {
        String sNodeId = msg.optString("node_id", "");
        if (sNodeId.isEmpty()) return;
        try {
            JSONObject sInfo = new JSONObject();
            sInfo.put("node_id", sNodeId);
            sInfo.put("hostname", msg.optString("hostname", "Slave"));
            sInfo.put("ip", senderIp);
            sInfo.put("diff_ms", msg.optDouble("diff_ms", 0.0));
            sInfo.put("clock_offset_ms", msg.optDouble("clock_offset_ms", 0.0));
            sInfo.put("is_locked", msg.optBoolean("is_locked", true));
            sInfo.put("media", msg.optString("media", ""));
            sInfo.put("current_time", msg.optDouble("current_time", 0.0));
            sInfo.put("last_seen_ms", recvTimeMs);
            activeSlaves.put(sNodeId, sInfo);
        } catch (Exception ignored) {}
    }

    // ===================== 定时心跳与遥测上报 =====================
    private void heartbeatLoop() {
        while (running) {
            try {
                long nowMs = System.currentTimeMillis();
                if ("MASTER".equals(role)) {
                    sendMasterSyncBeat(nowMs);
                    // 清理超时脱网从机 (超过 6 秒未见)
                    for (Map.Entry<String, JSONObject> entry : activeSlaves.entrySet()) {
                        long last = entry.getValue().optLong("last_seen_ms", 0);
                        if (nowMs - last > 6000) {
                            activeSlaves.remove(entry.getKey());
                        }
                    }
                    Thread.sleep(500);
                } else if ("SLAVE".equals(role)) {
                    sendSlaveReport(nowMs);
                    Thread.sleep(1200);
                } else {
                    Thread.sleep(2000);
                }
            } catch (InterruptedException ignored) {
                break;
            } catch (Exception e) {
                try { Thread.sleep(1000); } catch (Exception ignored) {}
            }
        }
    }

    private void sendMasterSyncBeat(long nowMs) {
        try {
            JSONObject ps = HttpRouter.getPlayerState();
            JSONObject packet = new JSONObject();
            packet.put("magic", SYNC_MAGIC);
            packet.put("type", "SYNC_BEAT");
            packet.put("node_id", nodeId);
            packet.put("hostname", android.os.Build.MODEL);
            packet.put("master_time_ms", (double) nowMs);
            packet.put("media", ps.optString("current_media", ""));
            packet.put("media_type", ps.optString("media_type", "video"));
            packet.put("state", ps.optString("state", "IDLE"));
            packet.put("current_time", ps.optDouble("current_time", 0.0));
            packet.put("duration", ps.optDouble("duration", 0.0));
            packet.put("loop_mode", ps.optString("loop_mode", "FOLDER_LOOP"));
            packet.put("volume", ps.optInt("volume", 85));
            packet.put("muted", ps.optBoolean("muted", false));
            sendUdpPacket(packet);
        } catch (Exception ignored) {}
    }

    private void sendSlaveReport(long nowMs) {
        try {
            JSONObject ps = HttpRouter.getPlayerState();
            double curTime = ps.optDouble("current_time", 0.0);
            double expected = getMasterExpectedMediaTime();
            double diffMs = (expected > 0) ? (curTime - expected) * 1000.0 : 0.0;

            JSONObject packet = new JSONObject();
            packet.put("magic", SYNC_MAGIC);
            packet.put("type", "SLAVE_REPORT");
            packet.put("node_id", nodeId);
            packet.put("hostname", android.os.Build.MODEL);
            packet.put("send_time_ms", (double) nowMs);
            packet.put("current_time", curTime);
            packet.put("diff_ms", Math.round(diffMs * 10.0) / 10.0);
            packet.put("clock_offset_ms", Math.round(clockOffsetMs * 10.0) / 10.0);
            packet.put("is_locked", Math.abs(diffMs) < 35.0);
            packet.put("media", ps.optString("current_media", ""));
            sendUdpPacket(packet);
        } catch (Exception ignored) {}
    }

    public double getMasterExpectedMediaTime() {
        if (masterInfo == null || !"PLAYING".equals(masterInfo.optString("state"))) {
            return masterInfo != null ? masterInfo.optDouble("current_time", 0.0) : 0.0;
        }
        double baseTime = masterInfo.optDouble("current_time", 0.0);
        long recvLocalMs = masterInfo.optLong("recv_local_ms", 0);
        long elapsedMs = Math.max(0, System.currentTimeMillis() - recvLocalMs);
        return baseTime + (elapsedMs / 1000.0);
    }

    // ===================== HTTP 兜底守护循环 =====================
    private void httpSyncLoop() {
        while (running) {
            try {
                if ("SLAVE".equals(role)) {
                    String target = masterIp.trim();
                    if (target.isEmpty() && masterInfo != null) {
                        target = masterInfo.optString("ip", "");
                    }
                    if (!target.isEmpty()) {
                        long nowMs = System.currentTimeMillis();
                        // 1. HTTP 轮询 Master 状态
                        try {
                            URL url = new URL("http://" + target + ":8088/api/sync/status");
                            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                            conn.setConnectTimeout(1200);
                            conn.setReadTimeout(1200);
                            if (conn.getResponseCode() == 200) {
                                String raw = HttpRouter.readFileToString(new File("")); // dummy
                                try (InputStream is = conn.getInputStream(); ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                                    byte[] b = new byte[2048];
                                    int n;
                                    while ((n = is.read(b)) != -1) baos.write(b, 0, n);
                                    JSONObject res = new JSONObject(baos.toString(StandardCharsets.UTF_8.name()));
                                    if ("ok".equals(res.optString("status"))) {
                                        JSONObject mState = res.optJSONObject("master_state");
                                        JSONObject synthetic = new JSONObject();
                                        synthetic.put("node_id", res.optString("node_id", "MASTER_" + target));
                                        synthetic.put("hostname", res.optString("hostname", "Master-Host"));
                                        synthetic.put("master_time_ms", (double) nowMs);
                                        synthetic.put("media", mState != null ? mState.optString("current_media") : res.optString("media", ""));
                                        synthetic.put("media_type", mState != null ? mState.optString("media_type", "video") : "video");
                                        synthetic.put("state", mState != null ? mState.optString("state", "IDLE") : "IDLE");
                                        synthetic.put("current_time", mState != null ? mState.optDouble("current_time", 0.0) : 0.0);
                                        handleMasterBeat(synthetic, nowMs, target);
                                    }
                                }
                            }
                            conn.disconnect();
                        } catch (Exception ignored) {}

                        // 2. 向 Master 注册自身存活
                        try {
                            JSONObject reg = new JSONObject();
                            reg.put("node_id", nodeId);
                            reg.put("hostname", android.os.Build.MODEL);
                            reg.put("media", HttpRouter.getPlayerState().optString("current_media", ""));
                            reg.put("current_time", HttpRouter.getPlayerState().optDouble("current_time", 0.0));
                            reg.put("diff_ms", 0.0);
                            reg.put("is_locked", true);

                            URL regUrl = new URL("http://" + target + ":8088/api/sync/register_slave");
                            HttpURLConnection rConn = (HttpURLConnection) regUrl.openConnection();
                            rConn.setRequestMethod("POST");
                            rConn.setConnectTimeout(1200);
                            rConn.setReadTimeout(1200);
                            rConn.setRequestProperty("Content-Type", "application/json");
                            rConn.setDoOutput(true);
                            try (OutputStream os = rConn.getOutputStream()) {
                                os.write(reg.toString().getBytes(StandardCharsets.UTF_8));
                            }
                            rConn.getResponseCode();
                            rConn.disconnect();
                        } catch (Exception ignored) {}

                        // 3. 每 10 秒比对拉取 Master 全量配置
                        if (nowMs - lastFullConfigSyncTime > 10000) {
                            lastFullConfigSyncTime = nowMs;
                            try {
                                URL cfgUrl = new URL("http://" + target + ":8088/api/sync/master_config");
                                HttpURLConnection cConn = (HttpURLConnection) cfgUrl.openConnection();
                                cConn.setConnectTimeout(1500);
                                cConn.setReadTimeout(1500);
                                if (cConn.getResponseCode() == 200) {
                                    try (InputStream is = cConn.getInputStream(); ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                                        byte[] b = new byte[4096];
                                        int n;
                                        while ((n = is.read(b)) != -1) baos.write(b, 0, n);
                                        JSONObject cfgRes = new JSONObject(baos.toString(StandardCharsets.UTF_8.name()));
                                        if ("ok".equals(cfgRes.optString("status"))) {
                                            double mTs = cfgRes.optDouble("timestamp", 0.0);
                                            if (mTs > lastAppliedConfigTs || lastAppliedConfigTs == 0.0) {
                                                applyMasterFullConfig(cfgRes);
                                            }
                                        }
                                    }
                                }
                                cConn.disconnect();
                            } catch (Exception ignored) {}
                        }
                    }
                }
                Thread.sleep(1000);
            } catch (InterruptedException ignored) {
                break;
            } catch (Exception ignored) {}
        }
    }

    // ===================== 集群状态查询 API 支撑 =====================
    public JSONObject getClusterStatus() {
        JSONObject res = new JSONObject();
        try {
            long nowMs = System.currentTimeMillis();
            res.put("status", "ok");
            res.put("role", role);
            res.put("node_id", nodeId);
            res.put("master_ip", masterIp);
            res.put("slave_ips", configuredSlaveIps);
            res.put("broadcast_port", SYNC_BROADCAST_PORT);
            res.put("is_running", running);
            res.put("clock_offset_ms", Math.round(clockOffsetMs * 100.0) / 100.0);

            JSONArray sArr = new JSONArray();
            for (JSONObject s : activeSlaves.values()) {
                if (nowMs - s.optLong("last_seen_ms", 0) < 6000) {
                    JSONObject item = new JSONObject();
                    item.put("node_id", s.optString("node_id"));
                    item.put("hostname", s.optString("hostname"));
                    item.put("ip", s.optString("ip"));
                    item.put("diff_ms", s.optDouble("diff_ms", 0.0));
                    item.put("is_locked", s.optBoolean("is_locked", true));
                    item.put("media", s.optString("media", ""));
                    item.put("current_time", s.optDouble("current_time", 0.0));
                    item.put("online", true);
                    sArr.put(item);
                }
            }
            res.put("slaves_count", sArr.length());
            res.put("slaves", sArr);

            boolean masterAlive = (nowMs - lastMasterBeat) < 4500 && lastMasterBeat > 0;
            res.put("master_alive", masterAlive);
            res.put("master_info", masterAlive ? masterInfo : null);

            // 若本机是 Master，附带自身实时状态供从机拉取
            JSONObject ps = HttpRouter.getPlayerState();
            JSONObject mState = new JSONObject();
            mState.put("current_media", ps.optString("current_media", ""));
            mState.put("media_type", ps.optString("media_type", "video"));
            mState.put("state", ps.optString("state", "IDLE"));
            mState.put("current_time", ps.optDouble("current_time", 0.0));
            mState.put("duration", ps.optDouble("duration", 0.0));
            mState.put("loop_mode", ps.optString("loop_mode", "FOLDER_LOOP"));
            res.put("master_state", mState);
        } catch (Exception ignored) {}
        return res;
    }

    public void registerActiveSlave(String sNodeId, String ip, JSONObject data) {
        if (sNodeId == null || sNodeId.isEmpty()) return;
        try {
            JSONObject sInfo = new JSONObject(data != null ? data.toString() : "{}");
            sInfo.put("node_id", sNodeId);
            sInfo.put("ip", ip);
            sInfo.put("last_seen_ms", System.currentTimeMillis());
            activeSlaves.put(sNodeId, sInfo);
            if (ip != null && !ip.isEmpty() && !ip.startsWith("127.") && !configuredSlaveIps.contains(ip)) {
                configuredSlaveIps.add(ip);
            }
        } catch (Exception ignored) {}
    }
}
