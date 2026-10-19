package com.visualcast.player.server;

import android.content.Context;
import com.visualcast.player.utils.StorageHelper;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class IoTEngine {
    private final File configFile;
    private JSONObject config = new JSONObject();
    private boolean isMacroRunning = false;
    private int currentMacroStep = 0;
    private int totalMacroSteps = 0;
    private String currentStepTitle = "";
    private final List<String> macroLogs = new ArrayList<>();

    public IoTEngine(Context context) {
        this.configFile = new File(StorageHelper.getConfigDir(context), "iot_config.json");
        loadConfig();
    }

    public synchronized void loadConfig() {
        if (!configFile.exists()) {
            config = new JSONObject();
            return;
        }
        try (FileInputStream fis = new FileInputStream(configFile)) {
            byte[] data = new byte[(int) configFile.length()];
            fis.read(data);
            config = new JSONObject(new String(data, StandardCharsets.UTF_8));
        } catch (Exception e) {
            config = new JSONObject();
        }
    }

    public synchronized void saveConfig(JSONObject newConfig) {
        if (newConfig != null) this.config = newConfig;
        try (FileOutputStream fos = new FileOutputStream(configFile)) {
            fos.write(this.config.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public JSONObject getConfig() {
        return config;
    }

    public JSONObject getDevice(String devId) {
        JSONArray arr = config.optJSONArray("devices");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject d = arr.optJSONObject(i);
                if (d != null && devId.equals(d.optString("id"))) {
                    return d;
                }
            }
        }
        return null;
    }

    /**
     * 发送单步设备指令 (支持 TCP, UDP, HTTP; Hex / ASCII)
     */
    public JSONObject sendDeviceCommand(String devId, String cmdType, String customCmd) {
        JSONObject res = new JSONObject();
        try {
            JSONObject dev = getDevice(devId);
            if (dev == null && (customCmd == null || customCmd.isEmpty())) {
                res.put("status", "error");
                res.put("message", "未找到设备 " + devId);
                return res;
            }

            String devType = dev != null ? dev.optString("type", "TCP").toUpperCase() : "TCP";
            String host = dev != null ? dev.optString("host", "127.0.0.1") : "127.0.0.1";
            int port = dev != null ? dev.optInt("port", 4001) : 4001;
            String protocol = dev != null ? dev.optString("protocol", "hex").toLowerCase() : "hex";

            String rawCmd = customCmd;
            if (rawCmd == null || rawCmd.isEmpty()) {
                JSONObject cmds = dev != null ? dev.optJSONObject("commands") : null;
                if (cmds != null) {
                    rawCmd = cmds.optString(cmdType, "");
                }
                if (rawCmd == null || rawCmd.isEmpty()) {
                    rawCmd = dev != null ? dev.optString(cmdType + "_cmd", "") : "";
                }
                if (rawCmd == null || rawCmd.isEmpty()) {
                    rawCmd = dev != null ? dev.optString("on".equalsIgnoreCase(cmdType) ? "on_cmd" : "off_cmd", "") : "";
                }
            }

            if (rawCmd == null || rawCmd.trim().isEmpty()) {
                res.put("status", "error");
                res.put("message", "设备指令内容为空");
                return res;
            }

            byte[] payload;
            if ("hex".equalsIgnoreCase(protocol)) {
                String cleaned = rawCmd.replaceAll("[\\s,xX]", "");
                payload = hexStringToByteArray(cleaned);
            } else {
                payload = rawCmd.getBytes(StandardCharsets.UTF_8);
            }

            if ("TCP".equalsIgnoreCase(devType)) {
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress(host, port), 2000);
                    s.setSoTimeout(2000);
                    OutputStream os = s.getOutputStream();
                    os.write(payload);
                    os.flush();
                }
                res.put("status", "ok");
                res.put("message", "TCP 指令发送成功 -> " + host + ":" + port);
                return res;
            } else if ("UDP".equalsIgnoreCase(devType)) {
                try (DatagramSocket ds = new DatagramSocket()) {
                    ds.setSoTimeout(2000);
                    if (host.endsWith(".255") || "255.255.255.255".equals(host)) {
                        ds.setBroadcast(true);
                    }
                    InetAddress addr = InetAddress.getByName(host);
                    DatagramPacket packet = new DatagramPacket(payload, payload.length, addr, port);
                    ds.send(packet);
                }
                res.put("status", "ok");
                res.put("message", "UDP 数据包已发送 -> " + host + ":" + port);
                return res;
            } else if ("HTTP".equalsIgnoreCase(devType)) {
                String urlStr = rawCmd.startsWith("http") ? rawCmd : "http://" + host + ":" + port + rawCmd;
                URL url = new URL(urlStr);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                conn.setRequestMethod("GET");
                conn.connect();
                int code = conn.getResponseCode();
                res.put("status", "ok");
                res.put("message", "HTTP 请求成功: " + code);
                return res;
            } else {
                res.put("status", "error");
                res.put("message", "不支持的设备协议: " + devType);
                return res;
            }

        } catch (Exception e) {
            try {
                res.put("status", "warning");
                res.put("message", "设备通讯异常: " + e.getMessage());
            } catch (Exception ignored) {}
            return res;
        }
    }

    private static byte[] hexStringToByteArray(String s) {
        int len = s.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(s.charAt(i), 16) << 4)
                    + Character.digit(s.charAt(i + 1), 16));
        }
        return data;
    }

    public synchronized JSONObject getMacroStatus() {
        JSONObject obj = new JSONObject();
        try {
            obj.put("is_running", isMacroRunning);
            obj.put("current_step", currentMacroStep);
            obj.put("total_steps", totalMacroSteps);
            obj.put("current_step_title", currentStepTitle);
            JSONArray arr = new JSONArray();
            for (String log : macroLogs) arr.put(log);
            obj.put("logs", arr);
        } catch (Exception ignored) {}
        return obj;
    }

    public synchronized JSONObject runMacroAsync(String macroId) {
        JSONObject res = new JSONObject();
        try {
            if (isMacroRunning) {
                res.put("status", "error");
                res.put("message", "已有宏流程正在执行中");
                return res;
            }
            JSONObject macros = config.optJSONObject("macros");
            JSONObject m = macros != null ? macros.optJSONObject(macroId) : null;
            if (m == null) {
                res.put("status", "error");
                res.put("message", "未找到宏序列: " + macroId);
                return res;
            }

            final String macroName = m.optString("name", macroId);
            final JSONArray steps = m.optJSONArray("steps");
            if (steps == null || steps.length() == 0) {
                res.put("status", "error");
                res.put("message", "宏序列步骤为空");
                return res;
            }

            new Thread(() -> {
                synchronized (IoTEngine.this) {
                    isMacroRunning = true;
                    currentMacroStep = 0;
                    totalMacroSteps = steps.length();
                    macroLogs.clear();
                    macroLogs.add("宏序列 [" + macroName + "] 启动");
                }

                for (int i = 0; i < steps.length(); i++) {
                    JSONObject step = steps.optJSONObject(i);
                    if (step == null) continue;
                    int delay = step.optInt("delay", 0);
                    String title = step.optString("title", "步骤 " + (i + 1));
                    synchronized (IoTEngine.this) {
                        currentMacroStep = i + 1;
                        currentStepTitle = title;
                    }

                    if (delay > 0) {
                        try { Thread.sleep(delay * 1000L); } catch (InterruptedException ignored) {}
                    }

                    if (step.has("device_id")) {
                        String devId = step.optString("device_id");
                        String cmd = step.optString("cmd", "on");
                        JSONObject cmdRet = sendDeviceCommand(devId, cmd, null);
                        synchronized (IoTEngine.this) {
                            macroLogs.add("执行: " + title + " -> " + cmdRet.optString("message", ""));
                        }
                    }
                }

                synchronized (IoTEngine.this) {
                    isMacroRunning = false;
                    macroLogs.add("宏序列 [" + macroName + "] 执行完成");
                }
            }).start();

            res.put("status", "ok");
            res.put("message", "宏流程 [" + macroName + "] 已开始异步执行");
        } catch (Exception e) {
            try {
                res.put("status", "error");
                res.put("message", e.getMessage());
            } catch (Exception ignored) {}
        }
        return res;
    }

    // ==================== 展馆物联网自定义中转中继与转发 ====================

    public synchronized JSONArray getForwarders() {
        JSONArray arr = config.optJSONArray("forwarders");
        if (arr == null) {
            arr = new JSONArray();
            try {
                config.put("forwarders", arr);
            } catch (Exception ignored) {}
        }
        return arr;
    }

    public synchronized JSONObject saveForwarder(JSONObject fwd) {
        JSONObject res = new JSONObject();
        try {
            JSONArray arr = getForwarders();
            String id = fwd.optString("id");
            if (id == null || id.trim().isEmpty()) {
                id = "fwd_" + System.currentTimeMillis();
                fwd.put("id", id);
            }
            boolean found = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item != null && id.equals(item.optString("id"))) {
                    arr.put(i, fwd);
                    found = true;
                    break;
                }
            }
            if (!found) {
                arr.put(fwd);
            }
            saveConfig(config);
            res.put("status", "ok");
            res.put("message", "中转规则 [" + fwd.optString("name") + "] 已保存");
            res.put("id", id);
            res.put("forwarders", arr);
        } catch (Exception e) {
            try {
                res.put("status", "error");
                res.put("message", e.getMessage());
            } catch (Exception ignored) {}
        }
        return res;
    }

    public synchronized JSONObject deleteForwarder(String fwdId) {
        JSONObject res = new JSONObject();
        try {
            JSONArray arr = getForwarders();
            JSONArray newArr = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item != null && !fwdId.equals(item.optString("id"))) {
                    newArr.put(item);
                }
            }
            config.put("forwarders", newArr);
            saveConfig(config);
            res.put("status", "ok");
            res.put("message", "中转规则已删除");
            res.put("forwarders", newArr);
        } catch (Exception e) {
            try {
                res.put("status", "error");
                res.put("message", e.getMessage());
            } catch (Exception ignored) {}
        }
        return res;
    }

    public synchronized JSONObject toggleForwarder(String fwdId, boolean enabled) {
        JSONObject res = new JSONObject();
        try {
            JSONArray arr = getForwarders();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item != null && fwdId.equals(item.optString("id"))) {
                    item.put("enabled", enabled);
                    break;
                }
            }
            saveConfig(config);
            res.put("status", "ok");
            res.put("message", "中转规则已" + (enabled ? "启用" : "禁用"));
            res.put("forwarders", arr);
        } catch (Exception e) {
            try {
                res.put("status", "error");
                res.put("message", e.getMessage());
            } catch (Exception ignored) {}
        }
        return res;
    }

    public JSONObject testForwarder(String fwdId) {
        JSONArray arr = getForwarders();
        JSONObject targetFwd = null;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject item = arr.optJSONObject(i);
            if (item != null && fwdId.equals(item.optString("id"))) {
                targetFwd = item;
                break;
            }
        }
        if (targetFwd == null) {
            JSONObject res = new JSONObject();
            try {
                res.put("status", "error");
                res.put("message", "未找到指定中转规则: " + fwdId);
            } catch (Exception ignored) {}
            return res;
        }
        return executeSingleForward(targetFwd, "MANUAL_TEST");
    }

    public void processForwarding(String rawCmd, String protocol) {
        if (rawCmd == null || rawCmd.trim().isEmpty()) return;
        final String cleanCmd = rawCmd.trim();
        JSONArray arr = getForwarders();
        for (int i = 0; i < arr.length(); i++) {
            final JSONObject fwd = arr.optJSONObject(i);
            if (fwd == null || !fwd.optBoolean("enabled", true)) continue;

            String matchProto = fwd.optString("match_protocol", "ALL").toUpperCase();
            if (!"ALL".equals(matchProto) && !matchProto.equalsIgnoreCase(protocol)) continue;

            String matchType = fwd.optString("match_type", "CONTAINS").toUpperCase();
            String matchCmd = fwd.optString("match_cmd", "").trim();
            if (matchCmd.isEmpty()) continue;

            boolean matched = false;
            if ("EXACT".equals(matchType)) {
                matched = cleanCmd.equalsIgnoreCase(matchCmd);
            } else if ("STARTSWITH".equals(matchType)) {
                matched = cleanCmd.toUpperCase().startsWith(matchCmd.toUpperCase());
            } else { // CONTAINS or HEX
                matched = cleanCmd.toUpperCase().contains(matchCmd.toUpperCase());
            }

            if (matched) {
                int delayMs = fwd.optInt("delay_ms", 0);
                new Thread(() -> {
                    if (delayMs > 0) {
                        try { Thread.sleep(delayMs); } catch (InterruptedException ignored) {}
                    }
                    executeSingleForward(fwd, cleanCmd);
                }).start();
            }
        }
    }

    private JSONObject executeSingleForward(JSONObject fwd, String rawMatched) {
        JSONObject res = new JSONObject();
        try {
            String proto = fwd.optString("target_protocol", "TCP").toUpperCase();
            String host = fwd.optString("target_host", "127.0.0.1").trim();
            int port = fwd.optInt("target_port", 4001);
            String fmt = fwd.optString("target_data_format", "TEXT").toUpperCase();
            String cmdTpl = fwd.optString("target_cmd", "");
            String finalCmd = cmdTpl.contains("{{RAW}}") ? cmdTpl.replace("{{RAW}}", rawMatched) : (cmdTpl.isEmpty() ? rawMatched : cmdTpl);

            byte[] payload;
            if ("HEX".equals(fmt)) {
                String cleanHex = finalCmd.replace(" ", "").replace("0x", "").replace(",", "");
                int len = cleanHex.length();
                payload = new byte[len / 2];
                for (int i = 0; i < len; i += 2) {
                    payload[i / 2] = (byte) ((Character.digit(cleanHex.charAt(i), 16) << 4)
                            + Character.digit(cleanHex.charAt(i + 1), 16));
                }
            } else {
                String unescaped = finalCmd.replace("\\r", "\r").replace("\\n", "\n").replace("\\t", "\t");
                payload = unescaped.getBytes(StandardCharsets.UTF_8);
            }

            if ("TCP".equals(proto)) {
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress(host, port), 2500);
                    s.getOutputStream().write(payload);
                    s.getOutputStream().flush();
                }
                res.put("status", "ok");
                res.put("message", "TCP 转发成功 -> " + host + ":" + port);
            } else if ("UDP".equals(proto)) {
                try (DatagramSocket s = new DatagramSocket()) {
                    s.setSoTimeout(2000);
                    DatagramPacket packet = new DatagramPacket(payload, payload.length, InetAddress.getByName(host), port);
                    s.send(packet);
                }
                res.put("status", "ok");
                res.put("message", "UDP 转发成功 -> " + host + ":" + port);
            } else if ("HTTP".equals(proto)) {
                String urlStr = finalCmd.startsWith("http") ? finalCmd : ("http://" + host + ":" + port + finalCmd);
                URL url = new URL(urlStr);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                conn.setRequestMethod("GET");
                int code = conn.getResponseCode();
                res.put("status", "ok");
                res.put("message", "HTTP 转发成功: HTTP " + code);
            } else {
                res.put("status", "ok");
                res.put("message", "已模拟触发: " + proto);
            }
        } catch (Exception e) {
            try {
                res.put("status", "error");
                res.put("message", "转发异常: " + e.getMessage());
            } catch (Exception ignored) {}
        }
        return res;
    }
}
