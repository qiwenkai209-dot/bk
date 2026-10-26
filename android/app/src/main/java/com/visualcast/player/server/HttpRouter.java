package com.visualcast.player.server;

import android.content.Context;
import android.os.Build;
import com.visualcast.player.MainActivity;
import com.visualcast.player.utils.NetworkUtils;
import com.visualcast.player.utils.StorageHelper;
import com.visualcast.player.utils.SystemHelper;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class HttpRouter {
    private final Context context;
    private final AuthManager authManager;
    private final IoTEngine iotEngine;

    public static volatile HttpRouter instance;

    // 播放状态机内存缓存
    private final List<JSONObject> pendingCommands = new ArrayList<>();
    private JSONObject playerState = new JSONObject();
    private String latestEchoFrame = "";
    private volatile byte[] latestEchoJpegBytes = null;
    private long latestEchoFrameTime = 0;
    private long latestEchoTime = 0;
    public static volatile double lastPlayerHeartbeat = 0;
    public static volatile double lastNativeHeartbeat = 0;
    private JSONObject playerConfig = new JSONObject();
    private final File playerConfigFile;
    private final File customMediaFile;
    private final com.visualcast.player.license.LicenseGuard licenseGuard;

    public static HttpRouter getInstance() {
        return instance;
    }

    public static JSONObject getPlayerState() {
        if (instance != null && instance.playerState != null) {
            return instance.playerState;
        }
        return new JSONObject();
    }

    public static void setGlobalSleepMode(boolean sleep) {
        if (instance != null) {
            synchronized (instance) {
                try {
                    instance.playerConfig.put("sleep_mode", sleep);
                    instance.savePlayerConfig();
                    instance.playerState.put("is_sleeping", sleep);
                    instance.playerState.put("blackout", sleep);
                    if (sleep) {
                        instance.playerState.put("state", "STOPPED");
                        instance.playerState.remove("current_media");
                        instance.pushCommand("STOP", new JSONObject());
                        JSONObject b = new JSONObject();
                        b.put("blackout", true);
                        instance.pushCommand("BLACKOUT", b);
                        instance.pushCommand("SLEEP", new JSONObject());
                    } else {
                        instance.playerState.put("state", "PLAYING");
                        JSONObject b = new JSONObject();
                        b.put("blackout", false);
                        instance.pushCommand("BLACKOUT", b);
                        instance.pushCommand("RETURN_TO_STANDBY", new JSONObject());
                        instance.pushCommand("WAKEUP", new JSONObject());
                    }
                } catch (Exception ignored) {}
            }
        }
    }

    public static void updateBlackoutState(boolean blackout) {
        if (instance != null) {
            synchronized (instance) {
                try {
                    instance.playerState.put("blackout", blackout);
                } catch (Exception ignored) {}
            }
        }
    }

    public static void recordNativeHeartbeat() {
        lastNativeHeartbeat = System.currentTimeMillis() / 1000.0;
    }

    public static String getCastDeviceName(Context context) {
        try {
            File cfg = new File(StorageHelper.getConfigDir(context), "player_config.json");
            if (cfg.exists()) {
                try (FileInputStream fis = new FileInputStream(cfg)) {
                    byte[] b = new byte[(int) cfg.length()];
                    fis.read(b);
                    JSONObject json = new JSONObject(new String(b, StandardCharsets.UTF_8));
                    String name = json.optString("cast_device_name", "");
                    if (!name.trim().isEmpty()) return name.trim();
                }
            }
        } catch (Exception ignored) {}
        return "VisualCast 展厅大屏";
    }

    public HttpRouter(Context context, AuthManager authManager, IoTEngine iotEngine) {
        instance = this;
        this.context = context;
        this.authManager = authManager;
        this.iotEngine = iotEngine;
        lastPlayerHeartbeat = System.currentTimeMillis() / 1000.0;
        lastNativeHeartbeat = lastPlayerHeartbeat;
        this.playerConfigFile = new File(StorageHelper.getConfigDir(context), "player_config.json");
        this.customMediaFile = new File(StorageHelper.getConfigDir(context), "custom_media.json");
        this.licenseGuard = new com.visualcast.player.license.LicenseGuard(context);
        loadPlayerConfig();
    }

    private void loadPlayerConfig() {
        if (playerConfigFile.exists()) {
            try (FileInputStream fis = new FileInputStream(playerConfigFile)) {
                byte[] b = new byte[(int) playerConfigFile.length()];
                fis.read(b);
                playerConfig = new JSONObject(new String(b, StandardCharsets.UTF_8));
            } catch (Exception ignored) {}
        }
        // 冷启动开机初始化：严禁继承关机前的 sleep_mode 状态，必须强制亮屏开播待机素材
        try {
            playerConfig.put("sleep_mode", false);
        } catch (Exception ignored) {}
    }

    private void savePlayerConfig() {
        try (FileOutputStream fos = new FileOutputStream(playerConfigFile)) {
            fos.write(playerConfig.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }

    private boolean checkAuth(HttpRequest req) {
        if (!authManager.isEnabled()) return true;
        String token = req.getCookie("vc_token");
        if (token == null) {
            String authHeader = req.getHeader("authorization");
            if (authHeader != null && authHeader.toLowerCase().startsWith("bearer ")) {
                token = authHeader.substring(7).trim();
            } else {
                token = req.getHeader("x-admin-token");
            }
        }
        return authManager.validateToken(token);
    }

    public HttpResponse handle(HttpRequest req) {
        String path = req.getPath();
        String method = req.getMethod();

        try {
            // 0. 全局 OPTIONS 跨域预检请求极速响应
            if ("OPTIONS".equalsIgnoreCase(method)) {
                HttpResponse res = HttpResponse.text("OK");
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
                res.setHeader("Access-Control-Allow-Headers", "*");
                return res;
            }

            // 0.1 商业授权查询与激活接口 (真实校验：首次未激活显示未授权，双击输入激活码)
            if ("/api/system/license".equals(path) || "/api/license/status".equals(path) || "/api/license/apply".equals(path) || "/api/license".equals(path)) {
                if ("POST".equals(method)) {
                    JSONObject b = new JSONObject(req.getBodyText());
                    String codeStr = b.optString("code", b.optString("license_key", ""));
                    boolean success = licenseGuard.activate(codeStr);
                    JSONObject res = new JSONObject();
                    res.put("status", success ? "success" : "error");
                    res.put("message", success ? "商业授权激活成功！" : "激活码无效或已被核销");
                    return HttpResponse.json(res.toString());
                } else {
                    com.visualcast.player.license.LicenseGuard.Status ls = licenseGuard.checkLicense();
                    JSONObject res = new JSONObject();
                    res.put("status", "success");
                    res.put("is_valid", ls.isValid);
                    res.put("status_code", ls.statusCode);
                    res.put("details", ls.details);
                    return HttpResponse.json(res.toString());
                }
            }

            // 1. 静态资源路由映射
            if ("/".equals(path) || "/admin".equals(path)) {
                return serveAsset("static/admin.html", "text/html; charset=utf-8");
            }
            if ("/player".equals(path)) {
                return serveAsset("static/player.html", "text/html; charset=utf-8");
            }
            if ("/license".equals(path)) {
                return serveAsset("static/license.html", "text/html; charset=utf-8");
            }
            if ("/remote".equals(path)) {
                return serveAsset("static/remote.html", "text/html; charset=utf-8");
            }
            if ("/fleet".equals(path)) {
                return serveAsset("static/fleet.html", "text/html; charset=utf-8");
            }
            if ("/control".equals(path)) {
                return serveAsset("static/control.html", "text/html; charset=utf-8");
            }
            if ("/cast".equals(path)) {
                return serveAsset("static/cast.html", "text/html; charset=utf-8");
            }
            if (path.startsWith("/static/")) {
                String sub = path.substring("/static/".length());
                return serveAsset("static/" + sub, guessMime(sub));
            }
            if (path.startsWith("/assets/")) {
                String sub = path.substring("/assets/".length());
                return serveAsset("assets/" + sub, guessMime(sub));
            }
            if (path.startsWith("/media/")) {
                String sub = path.substring("/media/".length());
                File mediaDir = StorageHelper.getMediaDir(context);
                File f = new File(mediaDir, sub);
                if (!f.exists()) {
                    try {
                        String dec = java.net.URLDecoder.decode(sub, "UTF-8");
                        File fDec = new File(mediaDir, dec);
                        if (fDec.exists()) f = fDec;
                    } catch (Exception ignored) {}
                }
                if (f.exists() && f.isFile()) {
                    String range = req.getHeader("range");
                    return HttpResponse.fileRange(f, range, guessMime(f.getName()));
                } else {
                    if (sub.endsWith("default_standby.jpg") || sub.equals("default_standby.jpg")) {
                        return serveAsset("static/default_standby.jpg", "image/jpeg");
                    }
                    return HttpResponse.error(404, "素材文件不存在: " + sub);
                }
            }

            // 2. 鉴权相关 API
            if ("/api/auth/status".equals(path)) {
                String token = req.getCookie("vc_token");
                if (token == null || token.isEmpty()) {
                    String authHeader = req.getHeader("authorization");
                    if (authHeader != null && authHeader.toLowerCase().startsWith("bearer ")) {
                        token = authHeader.substring(7).trim();
                    } else {
                        token = req.getHeader("x-admin-token");
                    }
                }
                boolean isAuthed = authManager.validateToken(token);
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("authenticated", isAuthed);
                res.put("auth_enabled", authManager.isEnabled());
                return HttpResponse.json(res.toString());
            }
            if ("/api/auth/login".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String pwd = b.optString("password", "");
                if (authManager.verifyPassword(pwd)) {
                    String token = authManager.createSession();
                    HttpResponse res = HttpResponse.json("{\"status\":\"ok\",\"token\":\"" + token + "\"}");
                    res.setCookie("vc_token", token, 7 * 86400);
                    return res;
                } else {
                    return HttpResponse.error(401, "密码错误，请重新输入");
                }
            }
            if ("/api/auth/logout".equals(path) && "POST".equals(method)) {
                String token = req.getCookie("vc_token");
                if (token == null || token.isEmpty()) {
                    String authHeader = req.getHeader("authorization");
                    if (authHeader != null && authHeader.toLowerCase().startsWith("bearer ")) {
                        token = authHeader.substring(7).trim();
                    }
                }
                if (token != null && !token.isEmpty()) {
                    authManager.revokeSession(token);
                }
                HttpResponse res = HttpResponse.json("{\"status\":\"ok\",\"message\":\"已安全退出后台\"}");
                res.setCookie("vc_token", "", 0);
                return res;
            }
            if ("/api/auth/change_password".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权登录");
                JSONObject b = new JSONObject(req.getBodyText());
                String oldPwd = b.optString("old_password", "");
                String newPwd = b.optString("new_password", "");
                if (authManager.changePassword(oldPwd, newPwd)) {
                    HttpResponse res = HttpResponse.json("{\"status\":\"ok\",\"message\":\"密码修改成功\"}");
                    res.setCookie("vc_token", "", 0);
                    return res;
                } else {
                    return HttpResponse.error(400, "原密码错误或新密码不合法");
                }
            }

            // 3. 大屏端状态查询与指令轮询 (白名单免密通道)
            if ("/api/player/status".equals(path) || "/api/player/state/get".equals(path)) {
                return HttpResponse.json(getPlayerStatusJsonObject().toString());
            }

            if ("/api/player/command".equals(path)) {
                if ("POST".equals(method)) {
                    JSONObject b = new JSONObject(req.getBodyText());
                    String cmd = b.optString("command", "").toUpperCase();
                    JSONObject params = b.optJSONObject("params") != null ? b.optJSONObject("params") : new JSONObject();
                    pushCommand(cmd, params);
                    if ("SHUTDOWN".equals(cmd) || "POWEROFF".equals(cmd) || "SLEEP".equals(cmd)) {
                        playerConfig.put("sleep_mode", true);
                        savePlayerConfig();
                        updateBlackoutState(true);
                        try {
                            playerState.put("blackout", true);
                            playerState.put("is_sleeping", true);
                            playerState.put("state", "STOPPED");
                            playerState.remove("current_media");
                        } catch (Exception ignored) {}
                    } else if ("POWERON".equals(cmd) || "BOOT".equals(cmd) || "WAKEUP".equals(cmd)) {
                        playerConfig.put("sleep_mode", false);
                        savePlayerConfig();
                        updateBlackoutState(false);
                        try {
                            playerState.put("blackout", false);
                            playerState.put("is_sleeping", false);
                            playerState.put("state", "PLAYING");
                        } catch (Exception ignored) {}
                    } else if ("PLAY_MEDIA".equals(cmd) || "LOAD_AND_PLAY".equals(cmd) || "PLAY".equals(cmd)
                            || "SWITCH_MEDIA".equals(cmd) || "PLAY_FOLDER".equals(cmd)
                            || "NEXT".equals(cmd) || "PREV".equals(cmd) || "DOC_NEXT".equals(cmd) || "DOC_PREV".equals(cmd)
                            || "RETURN_TO_STANDBY".equals(cmd) || "RETURN_TO_IDLE".equals(cmd) || "REFRESH_LIBRARY_AND_PLAY".equals(cmd)) {
                        // 点播或恢复播放：仅解除休眠与黑场，绝不触发全量triggerSleepTransition杜绝将当前点播素材强制冲回待机！
                        playerConfig.put("sleep_mode", false);
                        savePlayerConfig();
                        updateBlackoutState(false);
                        String mName = params.optString("media", params.optString("name", ""));
                        if (!mName.isEmpty()) {
                            try {
                                playerState.put("current_media", mName);
                                playerState.put("state", "PLAYING");
                            } catch (Exception ignored) {}
                        } else {
                            try {
                                playerState.put("state", "PLAYING");
                            } catch (Exception ignored) {}
                        }
                    } else if ("PAUSE".equals(cmd)) {
                        try {
                            playerState.put("state", "PAUSED");
                        } catch (Exception ignored) {}
                    } else if ("STOP".equals(cmd)) {
                        // Stop playback: set state to STOPPED and clear current media
                        try {
                            playerState.put("state", "STOPPED");
                            playerState.remove("current_media");
                        } catch (Exception ignored) {}
                    } else if ("BLACKOUT".equals(cmd)) {
                        boolean bOut = params.optBoolean("blackout", true);
                        updateBlackoutState(bOut);
                        try {
                            playerState.put("blackout", bOut);
                        } catch (Exception ignored) {}
                    }
                    if ("VOLUME".equals(cmd) || "SET_VOLUME".equals(cmd)) {
                        int v = params.optInt("volume", 85);
                        playerConfig.put("volume", v);
                        savePlayerConfig();
                    }
                    if ("MUTE".equals(cmd)) {
                        boolean m = params.optBoolean("muted", false);
                        playerConfig.put("muted", m);
                        savePlayerConfig();
                    }
                    if ("SET_ORIENTATION".equals(cmd)) {
                        String ori = params.optString("orientation", "landscape");
                        playerConfig.put("orientation", ori);
                        savePlayerConfig();
                        if (com.visualcast.player.MainActivity.instance != null) {
                            com.visualcast.player.MainActivity.instance.setScreenOrientation(ori);
                        }
                    }
                    if ("SET_LOOP_MODE".equals(cmd)) {
                        String lm = params.optString("loop_mode", "FOLDER_LOOP");
                        String cf = params.optString("folder", "");
                        playerConfig.put("loop_mode", lm);
                        if (!cf.isEmpty()) playerConfig.put("current_folder", cf);
                        savePlayerConfig();
                    }
                    if ("SET_SCALE_MODE".equals(cmd)) {
                        String sm = params.optString("scale_mode", "fill");
                        playerConfig.put("scale_mode", sm);
                        savePlayerConfig();
                    }
                    if ("SET_TOUCH_MODE".equals(cmd)) {
                        boolean tm = params.optBoolean("touch_mode", false);
                        playerConfig.put("touch_mode", tm);
                        savePlayerConfig();
                    }
                    return HttpResponse.json("{\"status\":\"ok\"}");
                } else {
                    synchronized (pendingCommands) {
                        JSONArray arr = new JSONArray();
                        for (JSONObject cmd : pendingCommands) arr.put(cmd);
                        pendingCommands.clear();
                        JSONObject res = new JSONObject();
                        res.put("status", "ok");
                        res.put("commands", arr);
                        return HttpResponse.json(res.toString());
                    }
                }
            }
            if ("/api/player/sync".equals(path) && "POST".equals(method)) {
                try {
                    playerState = new JSONObject(req.getBodyText());
                } catch (Exception ignored) {}
                lastPlayerHeartbeat = System.currentTimeMillis() / 1000.0;
                recordNativeHeartbeat();
                synchronized (pendingCommands) {
                    JSONArray arr = new JSONArray();
                    for (JSONObject cmd : pendingCommands) arr.put(cmd);
                    pendingCommands.clear();
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("commands", arr);
                    res.put("orientation", playerConfig.optString("orientation", "landscape"));
                    res.put("scale_mode", playerConfig.optString("scale_mode", "fill"));
                    res.put("loop_mode", playerConfig.optString("loop_mode", "FOLDER_LOOP"));
                    res.put("current_folder", playerConfig.optString("current_folder", ""));
                    res.put("volume", playerConfig.optInt("volume", 85));
                    res.put("muted", playerConfig.optBoolean("muted", false));
                    res.put("touch_mode", playerConfig.optBoolean("touch_mode", false));
                    res.put("cast_active", playerConfig.optBoolean("cast_active", false));
                    res.put("cast_device_name", playerConfig.optString("cast_device_name", "VisualCast 展厅大屏"));
                    res.put("sleep_mode", false);
                    res.put("subtitle", playerConfig.optJSONObject("subtitle") != null ? playerConfig.optJSONObject("subtitle") : new JSONObject());
                    boolean needEcho = (System.currentTimeMillis() - latestEchoTime < 8000) || ScreenStreamEngine.getInstance(context).hasActiveClients();
                    res.put("need_echo", needEcho);
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/player/pull".equals(path)) {
                synchronized (pendingCommands) {
                    JSONArray arr = new JSONArray();
                    for (JSONObject cmd : pendingCommands) arr.put(cmd);
                    pendingCommands.clear();
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("commands", arr);
                    boolean needEchoPull = (System.currentTimeMillis() - latestEchoTime < 8000) || ScreenStreamEngine.getInstance(context).hasActiveClients();
                    res.put("need_echo", needEchoPull);
                    res.put("fullscreen", true);
                    res.put("mode", playerState.optString("mode", "ATTRACT"));
                    res.put("idle_media", playerConfig.optJSONObject("playback") != null ? playerConfig.optJSONObject("playback").optString("idle_media", "demo_show.mp4") : "demo_show.mp4");
                    res.put("idle_timeout", playerConfig.optJSONObject("playback") != null ? playerConfig.optJSONObject("playback").optInt("idle_timeout", 60) : 60);
                    res.put("scale_mode", playerConfig.optString("scale_mode", "fill"));
                    res.put("loop", playerState.optBoolean("loop", true));
                    res.put("loop_mode", playerConfig.optString("loop_mode", "FOLDER_LOOP"));
                    res.put("current_folder", playerConfig.optString("current_folder", ""));
                    res.put("subtitle", playerConfig.optJSONObject("subtitle") != null ? playerConfig.optJSONObject("subtitle") : new JSONObject());
                    res.put("orientation", playerConfig.optString("orientation", "landscape"));
                    res.put("touch_mode", playerConfig.optBoolean("touch_mode", false));
                    res.put("sleep_mode", false);
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/player/report".equals(path) && "POST".equals(method)) {
                try {
                    playerState = new JSONObject(req.getBodyText());
                } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\"}");
            }
            if ("/api/player/return_to_standby".equals(path) || "/api/player/return_idle".equals(path)) {
                if (MainActivity.instance != null && MainActivity.isExternalDocActive) {
                    MainActivity.instance.bringToFrontAndCloseDoc();
                }
                pushCommand("RETURN_TO_STANDBY", new JSONObject());
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已返回待机轮播\"}");
            }
            if ("/api/player/state".equals(path)) {
                if ("POST".equals(method)) {
                    playerState = new JSONObject(req.getBodyText());
                    return HttpResponse.json("{\"status\":\"ok\"}");
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("state", playerState);
                    res.put("config", playerConfig);
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/player/echo".equals(path) || "/api/player/echo_frame".equals(path)) {
                if ("POST".equals(method)) {
                    JSONObject b = new JSONObject(req.getBodyText());
                    String frame = b.optString("frame", "");
                    latestEchoFrame = frame;
                    latestEchoFrameTime = System.currentTimeMillis();
                    if (frame.startsWith("data:image/")) {
                        try {
                            int comma = frame.indexOf(",");
                            if (comma != -1) {
                                String base64Data = frame.substring(comma + 1);
                                latestEchoJpegBytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
                                if (latestEchoJpegBytes != null && latestEchoJpegBytes.length > 0) {
                                    ScreenStreamEngine.getInstance(context).updatePlayerFrame(latestEchoJpegBytes);
                                }
                            }
                        } catch (Exception ignored) {}
                    }
                    return HttpResponse.json("{\"status\":\"ok\"}");
                } else {
                    long now = System.currentTimeMillis();
                    latestEchoTime = now;
                    byte[] snapshot = ScreenStreamEngine.getInstance(context).getLatestSnapshot();
                    String frameToReturn = "";
                    if (snapshot != null && snapshot.length > 0) {
                        frameToReturn = "data:image/jpeg;base64," + android.util.Base64.encodeToString(snapshot, android.util.Base64.NO_WRAP);
                    } else if (latestEchoFrame != null) {
                        frameToReturn = latestEchoFrame;
                    }
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("frame", frameToReturn);
                    res.put("timestamp", now / 1000.0);
                    res.put("is_live", true);
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/stream/live.jpg".equals(path)) {
                byte[] snapshot = ScreenStreamEngine.getInstance(context).getLatestSnapshot();
                HttpResponse res = HttpResponse.bytes(snapshot, "image/jpeg");
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                res.setHeader("Pragma", "no-cache");
                return res;
            }
            if ("/api/stream/live.mjpeg".equals(path)) {
                int reqFps = 15;
                try {
                    String fpsStr = req.getQuery("fps");
                    if (fpsStr != null && !fpsStr.trim().isEmpty()) {
                        reqFps = Integer.parseInt(fpsStr.trim());
                    }
                } catch (Exception ignored) {}
                latestEchoTime = System.currentTimeMillis();
                final int finalFps = reqFps;
                return HttpResponse.mjpegStream((out) -> {
                    ScreenStreamEngine.getInstance(context).writeMjpegStream(out, finalFps);
                });
            }
            if ("/api/player/active_media".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("current_media", playerConfig.optJSONObject("playback") != null ? playerConfig.optJSONObject("playback").optString("current_media", "") : "");
                return HttpResponse.json(res.toString());
            }

            // ===== [按 VisualCast.exe 标准补全接口] =====
            // 1. 按键模拟与远程映射 (同时直达 WebView 与前台外部 WPS 放映程序)
            if (("/api/player/send_key".equals(path) || "/api/player/keystroke".equals(path)) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String k = b.optString("key", b.optString("action", ""));
                pushCommand("SEND_KEY", b);
                SystemHelper.controlWPSPresentation(context, k);
                return HttpResponse.json("{\"status\":\"ok\"}");
            }

            // 2. 全屏/运维模式切换 (退至后台并弹出恢复悬浮胶囊)
            if ("/api/player/toggle_fullscreen".equals(path) && "POST".equals(method)) {
                pushCommand("TOGGLE_FULLSCREEN", new JSONObject());
                if (com.visualcast.player.MainActivity.instance != null) {
                    com.visualcast.player.MainActivity.instance.runOnUiThread(() -> {
                        com.visualcast.player.MainActivity.instance.moveTaskToBack(true);
                        com.visualcast.player.utils.FloatingBallHelper.showReturnBall(context);
                    });
                }
                return HttpResponse.json("{\"status\":\"ok\",\"fullscreen\":false}");
            }

            // 2.1 恢复置顶全屏模式 (穿透 Android 10+ 后台启动限制瞬间拉回大屏)
            if (("/api/player/set_topmost".equals(path) || "/api/system/return_to_player".equals(path)) && "POST".equals(method)) {
                com.visualcast.player.utils.FloatingBallHelper.hideReturnBall();
                SystemHelper.bringVisualCastToFront(context);
                pushCommand("RESTORE_FULLSCREEN", new JSONObject());
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"VisualCast 已成功置顶并恢复前台全屏\"}");
            }

            // 3. 触控模式切换
            if ("/api/player/touch_mode".equals(path)) {
                boolean touch = playerConfig.optBoolean("touch_mode", false);
                if ("POST".equals(method)) {
                    try {
                        JSONObject b = new JSONObject(req.getBodyText());
                        if (b.has("touch_mode")) {
                            touch = b.optBoolean("touch_mode");
                        } else if (b.has("enabled")) {
                            touch = b.optBoolean("enabled");
                        } else {
                            touch = !touch;
                        }
                    } catch (Exception ignored) {
                        touch = !touch;
                    }
                    playerConfig.put("touch_mode", touch);
                    savePlayerConfig();
                    JSONObject cmdParams = new JSONObject();
                    cmdParams.put("touch_mode", touch);
                    pushCommand("SET_TOUCH_MODE", cmdParams);
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("SET_TOUCH_MODE", cmdParams);
                    }
                }
                return HttpResponse.json("{\"status\":\"ok\",\"touch_mode\":" + touch + "}");
            }

            // 4. 待机配置获取与保存
            if ("/api/player/idle_config".equals(path)) {
                if ("POST".equals(method)) {
                    try {
                        JSONObject b = new JSONObject(req.getBodyText());
                        String im = b.optString("idle_media", "");
                        int it = b.optInt("idle_timeout", 60);
                        if (!im.isEmpty()) playerConfig.put("idle_media", im);
                        if (it > 0) playerConfig.put("idle_timeout", it);
                        savePlayerConfig();
                    } catch (Exception ignored) {}
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"待机配置已更新\"}");
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("idle_media", playerConfig.optString("idle_media", "demo_show.mp4"));
                    res.put("idle_timeout", playerConfig.optInt("idle_timeout", 60));
                    res.put("mode", playerState.optString("mode", "ATTRACT"));
                    return HttpResponse.json(res.toString());
                }
            }

            // 5. U 盘插拔状态查询与全量同步
            if ("/api/system/usb_status".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("connected", com.visualcast.player.utils.UsbMountReceiver.isUsbMounted);
                res.put("last_sync_time", com.visualcast.player.utils.UsbMountReceiver.lastSyncTime);
                res.put("synced_count", com.visualcast.player.utils.UsbMountReceiver.syncedCount);
                return HttpResponse.json(res.toString());
            }
            if ("/api/system/usb_sync_now".equals(path) && "POST".equals(method)) {
                com.visualcast.player.utils.UsbMountReceiver.triggerManualScan(context);
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已触发 U 盘全量增量同步\"}");
            }

            // 6. 真实屏幕分辨率与显示器参数
            if ("/api/system/monitors".equals(path)) {
                int[] resSize = getRealScreenResolution(context);
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                JSONArray arr = new JSONArray();
                JSONObject m = new JSONObject();
                m.put("index", 0);
                m.put("name", "商显大屏主显示器 (Android)");
                m.put("width", resSize[0]);
                m.put("height", resSize[1]);
                m.put("is_primary", true);
                arr.put(m);
                res.put("monitors", arr);
                return HttpResponse.json(res.toString());
            }

            // 7. 局域网在线大屏设备中枢 (Fleet)
            if ("/api/devices/list".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                JSONArray arr = new JSONArray();
                JSONObject dev = new JSONObject();
                dev.put("ip", com.visualcast.player.utils.NetworkUtils.getLocalIpAddress());
                dev.put("name", "VisualCast Android 展厅大屏");
                dev.put("online", true);
                dev.put("port", 8088);
                dev.put("platform", "android");
                dev.put("is_self", true);
                arr.put(dev);
                res.put("devices", arr);
                return HttpResponse.json(res.toString());
            }
            if ("/api/devices/scan".equals(path)) {
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"局域网大屏设备探测完成\"}");
            }

            // 8. 自定义流媒体与网页展项 (custom_media)

            // 10. 无线投屏控制接口与 DLNA / UPnP 协议端点
            if ("/api/cast/info".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                JSONObject nc = new JSONObject();
                nc.put("enabled", true);
                nc.put("device_name", playerConfig.optString("cast_device_name", "VisualCast 展厅大屏"));
                nc.put("is_active", playerConfig.optBoolean("cast_active", false));
                nc.put("sender_ip", "");
                res.put("native_cast", nc);
                return HttpResponse.json(res.toString());
            }
            if ("/api/cast/trigger".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String action = b.optString("action", "open");
                boolean isActive = !"close".equalsIgnoreCase(action);
                playerConfig.put("cast_active", isActive);
                savePlayerConfig();

                String devName = playerConfig.optString("cast_device_name", "VisualCast 展厅大屏");
                JSONObject cmdParams = new JSONObject();
                cmdParams.put("action", action);
                cmdParams.put("device_name", devName);

                if (isActive) {
                    pushCommand("SHOW_CAST_BOARD", cmdParams);
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("SHOW_CAST_BOARD", cmdParams);
                    }
                } else {
                    pushCommand("HIDE_CAST_BOARD", new JSONObject());
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("HIDE_CAST_BOARD", new JSONObject());
                    }
                }

                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("message", isActive ? "大屏已弹出无线投屏连接看板" : "已关闭投屏并恢复放映");
                JSONObject info = new JSONObject();
                JSONObject nc = new JSONObject();
                nc.put("device_name", devName);
                nc.put("is_active", isActive);
                info.put("native_cast", nc);
                res.put("info", info);
                return HttpResponse.json(res.toString());
            }
            if ("/api/cast/set_device_name".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String devName = b.optString("device_name", "VisualCast 展厅大屏");
                playerConfig.put("cast_device_name", devName);
                savePlayerConfig();
                if (com.visualcast.player.MainActivity.instance != null && com.visualcast.player.MainActivity.instance.getNativeCastServer() != null) {
                    com.visualcast.player.MainActivity.instance.getNativeCastServer().setDeviceName(devName);
                }
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"投屏设备名称已更新\"}");
            }

            // ===== [DLNA / UPnP MediaRenderer 原生投屏协议端点] =====
            if ("/dlna/desc.xml".equals(path)) {
                String ip = NetworkUtils.getLocalIpAddress();
                String devName = playerConfig.optString("cast_device_name", "VisualCast 展厅大屏");
                String descXml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                        "<root xmlns=\"urn:schemas-upnp-org:device-1-0\">\n" +
                        "  <specVersion><major>1</major><minor>0</minor></specVersion>\n" +
                        "  <device>\n" +
                        "    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>\n" +
                        "    <friendlyName>" + devName + "</friendlyName>\n" +
                        "    <manufacturer>VisualCast</manufacturer>\n" +
                        "    <manufacturerURL>http://" + ip + ":8088</manufacturerURL>\n" +
                        "    <modelDescription>VisualCast Pro Intelligent Screen</modelDescription>\n" +
                        "    <modelName>VisualCast MediaRenderer</modelName>\n" +
                        "    <modelNumber>3.0</modelNumber>\n" +
                        "    <UDN>uuid:visualcast-screen-renderer-3000</UDN>\n" +
                        "    <serviceList>\n" +
                        "      <service>\n" +
                        "        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\n" +
                        "        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>\n" +
                        "        <SCPDURL>/dlna/avt_scpd.xml</SCPDURL>\n" +
                        "        <controlURL>/dlna/avt_control</controlURL>\n" +
                        "        <eventSubURL>/dlna/avt_event</eventSubURL>\n" +
                        "      </service>\n" +
                        "      <service>\n" +
                        "        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>\n" +
                        "        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>\n" +
                        "        <SCPDURL>/dlna/rc_scpd.xml</SCPDURL>\n" +
                        "        <controlURL>/dlna/rc_control</controlURL>\n" +
                        "        <eventSubURL>/dlna/rc_event</eventSubURL>\n" +
                        "      </service>\n" +
                        "    </serviceList>\n" +
                        "  </device>\n" +
                        "</root>";
                return HttpResponse.xml(descXml);
            }
            if ("/dlna/avt_scpd.xml".equals(path)) {
                String scpd = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                        "<scpd xmlns=\"urn:schemas-upnp-org:service-1-0\">\n" +
                        "  <specVersion><major>1</major><minor>0</minor></specVersion>\n" +
                        "  <actionList>\n" +
                        "    <action><name>SetAVTransportURI</name></action>\n" +
                        "    <action><name>Play</name></action>\n" +
                        "    <action><name>Pause</name></action>\n" +
                        "    <action><name>Stop</name></action>\n" +
                        "    <action><name>GetTransportInfo</name></action>\n" +
                        "    <action><name>GetPositionInfo</name></action>\n" +
                        "  </actionList>\n" +
                        "  <serviceStateTable>\n" +
                        "    <stateVariable sendEvents=\"no\"><name>TransportState</name><dataType>string</dataType></stateVariable>\n" +
                        "  </serviceStateTable>\n" +
                        "</scpd>";
                return HttpResponse.xml(scpd);
            }
            if ("/dlna/rc_scpd.xml".equals(path)) {
                String scpd = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                        "<scpd xmlns=\"urn:schemas-upnp-org:service-1-0\">\n" +
                        "  <specVersion><major>1</major><minor>0</minor></specVersion>\n" +
                        "  <actionList>\n" +
                        "    <action><name>GetVolume</name></action>\n" +
                        "    <action><name>SetVolume</name></action>\n" +
                        "  </actionList>\n" +
                        "  <serviceStateTable>\n" +
                        "    <stateVariable sendEvents=\"no\"><name>Volume</name><dataType>ui2</dataType></stateVariable>\n" +
                        "  </serviceStateTable>\n" +
                        "</scpd>";
                return HttpResponse.xml(scpd);
            }
            if ("/dlna/avt_control".equals(path) && "POST".equals(method)) {
                String soap = req.getBodyText();
                String resAction = "Response";
                String body = "";
                if (soap.contains("SetAVTransportURI")) {
                    resAction = "SetAVTransportURIResponse";
                    int start = soap.indexOf("<CurrentURI>");
                    int end = soap.indexOf("</CurrentURI>");
                    if (start > 0 && end > start) {
                        String mediaUrl = soap.substring(start + 12, end).trim();
                        if (mediaUrl.contains("&amp;")) mediaUrl = mediaUrl.replace("&amp;", "&");
                        try {
                            JSONObject p = new JSONObject();
                            p.put("media", mediaUrl);
                            p.put("mode", "ON_DEMAND");
                            JSONObject item = new JSONObject();
                            item.put("name", "无线投屏");
                            item.put("url", mediaUrl);
                            item.put("type", "video");
                            p.put("media_item", item);
                            if (com.visualcast.player.MainActivity.instance != null) {
                                com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("HIDE_CAST_BOARD", new JSONObject());
                                com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("LOAD_AND_PLAY", p);
                            }
                            pushCommand("HIDE_CAST_BOARD", new JSONObject());
                            pushCommand("LOAD_AND_PLAY", p);
                        } catch (Exception ignored) {}
                    }
                } else if (soap.contains("Play")) {
                    resAction = "PlayResponse";
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("PLAY", new JSONObject());
                    }
                } else if (soap.contains("Pause")) {
                    resAction = "PauseResponse";
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("PAUSE", new JSONObject());
                    }
                } else if (soap.contains("Stop")) {
                    resAction = "StopResponse";
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("PAUSE", new JSONObject());
                    }
                } else if (soap.contains("GetTransportInfo")) {
                    resAction = "GetTransportInfoResponse";
                    body = "<CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>";
                } else if (soap.contains("GetPositionInfo")) {
                    resAction = "GetPositionInfoResponse";
                    body = "<Track>1</Track><TrackDuration>00:10:00</TrackDuration><RelTime>00:01:00</RelTime><AbsTime>00:01:00</AbsTime>";
                }
                String respXml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">\n" +
                        "  <s:Body>\n" +
                        "    <u:" + resAction + " xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">" + body + "</u:" + resAction + ">\n" +
                        "  </s:Body>\n" +
                        "</s:Envelope>";
                return HttpResponse.xml(respXml);
            }
            if ("/dlna/rc_control".equals(path) && "POST".equals(method)) {
                String respXml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">\n" +
                        "  <s:Body><u:Response xmlns:u=\"urn:schemas-upnp-org:service:RenderingControl:1\"><CurrentVolume>80</CurrentVolume></u:Response></s:Body>\n" +
                        "</s:Envelope>";
                return HttpResponse.xml(respXml);
            }

            // 11. 多机集群联播接口 (对接 ClusterSyncEngine，打通 Windows EXE 与 Android APK)
            if ("/api/sync/role".equals(path) || "/api/sync/status".equals(path) || "/api/cluster/status".equals(path)) {
                if ("POST".equals(method)) {
                    try {
                        JSONObject b = new JSONObject(req.getBodyText());
                        String newRole = b.optString("role", playerConfig.optString("cluster_role", "STANDALONE")).toUpperCase();
                        playerConfig.put("cluster_role", newRole);
                        String mIp = b.has("master_ip") ? b.optString("master_ip", "") : playerConfig.optString("master_ip", "");
                        String sIps = b.has("slave_ips") ? b.optString("slave_ips", "") : playerConfig.optString("slave_ips", "");
                        playerConfig.put("master_ip", mIp);
                        playerConfig.put("slave_ips", sIps);
                        savePlayerConfig();

                        ClusterSyncEngine.getInstance(context).updateConfig(newRole, mIp, sIps);
                    } catch (Exception ignored) {}
                }
                JSONObject res = ClusterSyncEngine.getInstance(context).getClusterStatus();
                res.put("is_master", "MASTER".equals(res.optString("role", "STANDALONE")));
                return HttpResponse.json(res.toString());
            }
            if ("/api/sync/config".equals(path) && "POST".equals(method)) {
                try {
                    JSONObject b = new JSONObject(req.getBodyText());
                    String r = b.has("role") ? b.optString("role", "STANDALONE").toUpperCase() : playerConfig.optString("cluster_role", "STANDALONE");
                    String mIp = b.has("master_ip") ? b.optString("master_ip", "") : playerConfig.optString("master_ip", "");
                    String sIps = b.has("slave_ips") ? b.optString("slave_ips", "") : playerConfig.optString("slave_ips", "");

                    playerConfig.put("cluster_role", r);
                    playerConfig.put("master_ip", mIp);
                    playerConfig.put("slave_ips", sIps);
                    savePlayerConfig();

                    ClusterSyncEngine.getInstance(context).updateConfig(r, mIp, sIps);
                } catch (Exception ignored) {}
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("role", playerConfig.optString("cluster_role", "STANDALONE"));
                res.put("message", "集群参数已永久固化");
                return HttpResponse.json(res.toString());
            }
            if ("/api/sync/register_slave".equals(path) && "POST".equals(method)) {
                try {
                    JSONObject b = new JSONObject(req.getBodyText());
                    String sNodeId = b.optString("node_id", "");
                    String clientIp = b.optString("ip", "");
                    if (clientIp.isEmpty()) {
                        String xff = req.getHeader("x-forwarded-for");
                        clientIp = (xff != null) ? xff : "";
                    }
                    ClusterSyncEngine.getInstance(context).registerActiveSlave(sNodeId, clientIp, b);
                } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\"}");
            }
            if ("/api/sync/master_config".equals(path) && "GET".equals(method)) {
                JSONObject fullCfg = ClusterSyncEngine.getInstance(context).getFullMasterConfig();
                if (fullCfg == null) fullCfg = new JSONObject();
                fullCfg.put("status", "ok");
                return HttpResponse.json(fullCfg.toString());
            }
            if ("/api/sync/apply_master_config".equals(path) && "POST".equals(method)) {
                try {
                    JSONObject b = new JSONObject(req.getBodyText());
                    boolean ok = ClusterSyncEngine.getInstance(context).applyMasterFullConfig(b);
                    return HttpResponse.json(ok ? "{\"status\":\"ok\"}" : "{\"status\":\"error\"}");
                } catch (Exception e) {
                    return HttpResponse.error(500, e.getMessage());
                }
            }
            if ("/api/sync/broadcast_full_config".equals(path) && "POST".equals(method)) {
                ClusterSyncEngine.getInstance(context).broadcastFullConfig();
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已向全网从机广播同步所有设置\"}");
            }
            if ("/api/sync/config".equals(path) || "/api/sync/nodes".equals(path) || "/api/slaves".equals(path)) {
                return HttpResponse.json(ClusterSyncEngine.getInstance(context).getClusterStatus().toString());
            }

            if ("/api/media/custom".equals(path)) {
                File f = new File(StorageHelper.getConfigDir(context), "custom_media.json");
                if ("POST".equals(method)) {
                    try {
                        JSONObject b = new JSONObject(req.getBodyText());
                        String name = b.optString("name", "自定义网页").trim();
                        String url = b.optString("url", b.optString("target", "")).trim();
                        String type = b.optString("type", "web");

                        JSONArray arr = new JSONArray();
                        if (f.exists()) {
                            try { arr = new JSONArray(readFileToString(f)); } catch(Exception ignored) {}
                        }
                        arr.put(b);
                        writeStringToFile(f, arr.toString());

                        // 在 media/网页_流码/ 下生成实体 .txt 文件
                        File webFolder = new File(StorageHelper.getMediaDir(context), "网页_流码");
                        if (!webFolder.exists()) webFolder.mkdirs();
                        File txtFile = new File(webFolder, name + ".txt");
                        writeStringToFile(txtFile, url);
                    } catch (Exception ignored) {}
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"网页流码已成功添加并存入素材库\"}");
                } else {
                    JSONArray arr = new JSONArray();
                    if (f.exists()) {
                        try { arr = new JSONArray(readFileToString(f)); } catch(Exception ignored) {}
                    }
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("items", arr);
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/media/custom/delete".equals(path) && "POST".equals(method)) {
                try {
                    JSONObject b = new JSONObject(req.getBodyText());
                    String delName = b.optString("name", "");
                    File f = new File(StorageHelper.getConfigDir(context), "custom_media.json");
                    if (f.exists()) {
                        JSONArray arr = new JSONArray(readFileToString(f));
                        JSONArray newArr = new JSONArray();
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject item = arr.getJSONObject(i);
                            if (!delName.equals(item.optString("name", ""))) {
                                newArr.put(item);
                            }
                        }
                        writeStringToFile(f, newArr.toString());
                    }
                    File webFolder = new File(StorageHelper.getMediaDir(context), "网页_流码");
                    File txtFile = new File(webFolder, delName + ".txt");
                    if (txtFile.exists()) txtFile.delete();
                } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"自定义素材已删除\"}");
            }
            if ("/api/system/open_media_dir".equals(path)) {
                File mediaDir = StorageHelper.getMediaDir(context);
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("path", mediaDir.getAbsolutePath());
                res.put("message", "本地素材存储目录: " + mediaDir.getAbsolutePath());
                return HttpResponse.json(res.toString());
            }
            if ("/api/system/restart".equals(path) && "POST".equals(method)) {
                if (com.visualcast.player.MainActivity.instance != null) {
                    com.visualcast.player.MainActivity.instance.runOnUiThread(() -> {
                        com.visualcast.player.MainActivity.instance.recreate();
                    });
                }
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"播控视窗已重启\"}");
            }
            if ("/api/system/shutdown".equals(path) && "POST".equals(method)) {
                // 按钮保留，按要求彻底删除实际关机与休眠功能，商显大屏保持常亮放映
                playerConfig.put("sleep_mode", false);
                savePlayerConfig();
                updateBlackoutState(false);
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏常亮放映中（关机功能已删除）\"}");
            }

            if (("/api/system/sleep".equals(path) || "/api/system/standby".equals(path)) && "POST".equals(method)) {
                setGlobalSleepMode(true);
                MainActivity act = MainActivity.getInstance();
                if (act != null) {
                    act.triggerSleepTransition(true);
                }
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏已待机 (开启黑场，停止放映)\"}");
            }

            if (("/api/system/boot".equals(path) || "/api/system/power_on".equals(path) || "/api/system/wakeup".equals(path)) && "POST".equals(method)) {
                setGlobalSleepMode(false);
                playerConfig.put("muted", false);
                MainActivity act = MainActivity.getInstance();
                if (act != null) {
                    act.triggerSleepTransition(false);
                }
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏已唤醒 (播放待机素材，解除黑场与静音)\"}");
            }

            if ("/api/player/window_mode".equals(path)) {
                if ("POST".equals(method)) {
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.runOnUiThread(() -> {
                            try {
                                com.visualcast.player.MainActivity.instance.moveTaskToBack(true);
                                com.visualcast.player.utils.FloatingBallHelper.showReturnBall(context);
                            } catch (Exception ignored) {}
                        });
                    }
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏已退至后台，悬浮胶囊已就绪\"}");
                }
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("fullscreen", true);
                res.put("mode", "FULLSCREEN");
                return HttpResponse.json(res.toString());
            }

            // 4. 播控动作指令下发
            if (("/api/player/play".equals(path) || "/api/player/play_media".equals(path) || "/api/player/load_and_play".equals(path)) && "POST".equals(method)) {
                JSONObject b = new JSONObject();
                try {
                    String body = req.getBodyText();
                    if (body != null && !body.trim().isEmpty()) {
                        b = new JSONObject(body);
                    }
                } catch (Exception ignored) {}
                playerConfig.put("sleep_mode", false);
                savePlayerConfig();
                updateBlackoutState(false);
                String mediaName = b.optString("name", b.optString("media", ""));
                if (mediaName.isEmpty() && "/api/player/play".equals(path)) {
                    pushCommand("PLAY", new JSONObject());
                    try { playerState.put("state", "PLAYING"); } catch (Exception ignored) {}
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"播放指令已下发\"}");
                }
                String lower = mediaName.toLowerCase();
                if (lower.endsWith(".ppt") || lower.endsWith(".pptx") || lower.endsWith(".pps") || lower.endsWith(".ppsx")) {
                    // 方案 C：使用 Android 端 WPS Office 全屏放映 PPT / 幻灯片
                    File pptFile = findMediaFile(StorageHelper.getMediaDir(context), mediaName);
                    if (pptFile != null && pptFile.exists()) {
                        boolean launched = com.visualcast.player.utils.SystemHelper.launchWPSPresentation(context, pptFile);
                        if (launched) {
                            return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已通过 WPS Office 启动全屏幻灯片放映\"}");
                        }
                    }
                } else {
                    // 切播非 PPT 素材：如果当前在外部文档放映，先关闭文档并拉回前台
                    if (MainActivity.instance != null && MainActivity.isExternalDocActive) {
                        MainActivity.instance.bringToFrontAndCloseDoc();
                    }
                }
                pushCommand("PLAY_MEDIA", b);
                try {
                    playerState.put("state", "PLAYING");
                    if (!mediaName.isEmpty()) playerState.put("current_media", mediaName);
                } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"切播指令已下发\"}");
            }
            if ("/api/player/open_ppt".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String filename = b.optString("file", b.optString("name", ""));
                File pptFile = findMediaFile(StorageHelper.getMediaDir(context), filename);
                if (pptFile != null && pptFile.exists()) {
                    boolean ok = com.visualcast.player.utils.SystemHelper.launchWPSPresentation(context, pptFile);
                    if (ok) {
                        return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已成功启动幻灯片放映\"}");
                    } else {
                        return HttpResponse.json("{\"status\":\"error\",\"message\":\"未能调起放映：未检测到金山 WPS Office 或兼容幻灯片软件\"}");
                    }
                } else {
                    return HttpResponse.json("{\"status\":\"error\",\"message\":\"未找到指定课件文件: " + filename + "\"}");
                }
            }
            if ("/api/player/close_ppt".equals(path) && "POST".equals(method)) {
                com.visualcast.player.utils.FloatingBallHelper.hideReturnBall();
                com.visualcast.player.utils.SystemHelper.controlWPSPresentation(context, "close");
                pushCommand("DOC_EXIT", new JSONObject());
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已成功退出文档放映并切回 VisualCast 主播控视窗\"}");
            }
            if ("/api/player/stop".equals(path) && "POST".equals(method)) {
                pushCommand("STOP", new JSONObject());
                try { playerState.put("state", "STOPPED"); playerState.remove("current_media"); } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"停止指令已下发，切至图片素材文件夹第一张图片\"}");
            }
            if ("/api/player/pause".equals(path) && "POST".equals(method)) {
                pushCommand("PAUSE", new JSONObject());
                try { playerState.put("state", "PAUSED"); } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"暂停指令已下发\"}");
            }
            if ("/api/player/resume".equals(path) && "POST".equals(method)) {
                pushCommand("PLAY", new JSONObject());
                try { playerState.put("state", "PLAYING"); } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"恢复播放指令已下发\"}");
            }
            if ("/api/player/next".equals(path) && "POST".equals(method)) {
                pushCommand("NEXT", new JSONObject());
                try { playerState.put("state", "PLAYING"); } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"下一曲指令已下发\"}");
            }
            if (("/api/player/prev".equals(path) || "/api/player/previous".equals(path)) && "POST".equals(method)) {
                pushCommand("PREV", new JSONObject());
                try { playerState.put("state", "PLAYING"); } catch (Exception ignored) {}
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"上一曲指令已下发\"}");
            }
            if (("/api/player/toggle".equals(path) || "/api/player/toggle_play".equals(path)) && "POST".equals(method)) {
                pushCommand("TOGGLE_PLAY", new JSONObject());
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"播放/暂停切换指令已下发\"}");
            }
            if ("/api/player/seek".equals(path) && "POST".equals(method)) {
                pushCommand("SEEK", new JSONObject(req.getBodyText()));
                return HttpResponse.json("{\"status\":\"ok\"}");
            }
            if ("/api/player/blackout".equals(path) && "POST".equals(method)) {
                // 黑场功能按需求删除，商显大屏始终常亮放映
                updateBlackoutState(false);
                return HttpResponse.json("{\"status\":\"ok\",\"blackout\":false,\"message\":\"常亮放映中（黑场功能已删除）\"}");
            }
            if (("/api/player/sleep".equals(path) || "/api/player/power_off".equals(path) || "/api/player/poweroff".equals(path)) && "POST".equals(method)) {
                // 按钮保留，按要求彻底删除实际待机黑场与停止播放，保持常亮放映
                playerConfig.put("sleep_mode", false);
                savePlayerConfig();
                updateBlackoutState(false);
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏常亮放映中（待机功能已删除）\"}");
            }
            if (("/api/player/wake".equals(path) || "/api/player/wakeup".equals(path) || "/api/player/power_on".equals(path) || "/api/player/poweron".equals(path)) && "POST".equals(method)) {
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"唤醒功能已删除，大屏保持常亮放映中\"}");
            }
            if ("/api/player/loop_mode".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String lm = b.optString("loop_mode", "FOLDER_LOOP");
                String cf = b.optString("folder", "");
                playerConfig.put("loop_mode", lm);
                if (!cf.isEmpty()) playerConfig.put("current_folder", cf);
                savePlayerConfig();
                pushCommand("SET_LOOP_MODE", b);
                return HttpResponse.json("{\"status\":\"ok\"}");
            }
            if ("/api/player/scale_mode".equals(path) && "POST".equals(method)) {
                pushCommand("SET_SCALE_MODE", new JSONObject(req.getBodyText()));
                return HttpResponse.json("{\"status\":\"ok\"}");
            }

            // 5. 素材列表与分类 API (返回 6 大规范标准分类)
            if (("/api/media".equals(path) || "/api/media/list".equals(path)) && "GET".equals(method)) {
                JSONArray files = new JSONArray();
                Map<String, Integer> folderCounts = new HashMap<>();
                Set<String> allFolders = new HashSet<>();
                File mediaDir = StorageHelper.getMediaDir(context);
                if (mediaDir.exists()) {
                    scanMediaDirectory(mediaDir, mediaDir, files, folderCounts, allFolders);
                }
// 合并 custom_media.json 确保添加的网页与网络流必显 (严格根据名称去重，杜绝重复出现两个)
                try {
                    Set<String> existingNames = new HashSet<>();
                    for (int fi = 0; fi < files.length(); fi++) {
                        JSONObject fo = files.getJSONObject(fi);
                        existingNames.add(fo.optString("name", ""));
                    }
                    File customFile = new File(StorageHelper.getConfigDir(context), "custom_media.json");
                    if (customFile.exists()) {
                        JSONArray customArr = new JSONArray(readFileToString(customFile));
                        for (int ci = 0; ci < customArr.length(); ci++) {
                            JSONObject cItem = customArr.getJSONObject(ci);
                            String cName = cItem.optString("name", "").trim();
                            String cUrl = cItem.optString("url", cItem.optString("target", "")).trim();
                            String cType = cItem.optString("type", "web");
                            if (!cName.isEmpty() && !existingNames.contains(cName)) {
                                existingNames.add(cName);
                                JSONObject mObj = new JSONObject();
                                mObj.put("name", cName);
                                mObj.put("filename", cName + ".txt");
                                mObj.put("path", cUrl);
                                mObj.put("url", cUrl);
                                mObj.put("folder", "网页_流码");
                                mObj.put("type", cType);
                                mObj.put("is_custom", true);
                                files.put(mObj);
                                int prevC = folderCounts.containsKey("网页_流码") ? folderCounts.get("网页_流码") : 0;
                                folderCounts.put("网页_流码", prevC + 1);
                                allFolders.add("网页_流码");
                            }
                        }
                    }
                } catch(Exception ignored) {}
                JSONArray foldersArr = new JSONArray();
                try {
                    JSONObject allOpt = new JSONObject();
                    allOpt.put("name", "全部素材");
                    allOpt.put("folder", "ALL");
                    allOpt.put("count", files.length());
                    foldersArr.put(allOpt);

                    String[][] stdCategories = {
                        {"待机", "待机"},
                        {"音乐", "音乐"},
                        {"图片", "图片"},
                        {"视频", "视频"},
                        {"文档", "文档"},
                        {"网页_流码", "网页\\流码"}
                    };
                    Set<String> seenStd = new HashSet<>();
                    for (String[] cat : stdCategories) {
                        seenStd.add(cat[0]);
                        JSONObject fObj = new JSONObject();
                        fObj.put("name", cat[1]);
                        fObj.put("folder", cat[0]);
                        fObj.put("count", folderCounts.containsKey(cat[0]) ? folderCounts.get(cat[0]) : 0);
                        fObj.put("is_standby", "待机".equals(cat[0]));
                        foldersArr.put(fObj);
                    }

                    if (folderCounts.containsKey("") && folderCounts.get("") > 0) {
                        JSONObject rootOpt = new JSONObject();
                        rootOpt.put("name", "未分类根目录");
                        rootOpt.put("folder", "");
                        rootOpt.put("count", folderCounts.get(""));
                        foldersArr.put(rootOpt);
                    }

                    for (String f : allFolders) {
                        if (!seenStd.contains(f) && !f.isEmpty()) {
                            JSONObject fObj = new JSONObject();
                            fObj.put("name", f);
                            fObj.put("folder", f);
                            fObj.put("count", folderCounts.containsKey(f) ? folderCounts.get(f) : 0);
                            foldersArr.put(fObj);
                        }
                    }
                } catch (Exception ignored) {}

                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("media", files);
                res.put("files", files);
                res.put("folders", foldersArr);
                res.put("count", files.length());
                res.put("current_folder", playerConfig.optString("current_folder", ""));
                    res.put("subtitle", playerConfig.optJSONObject("subtitle") != null ? playerConfig.optJSONObject("subtitle") : new JSONObject());
                res.put("loop_mode", playerConfig.optString("loop_mode", "FOLDER_LOOP"));
                return HttpResponse.json(res.toString());
            }

            // 5.0 工业级纯二进制流直传 API (完全摆脱 multipart boundary 解析风险，零 OOM 零语法错误)
            if ("/api/media/upload_raw".equals(path) && "POST".equals(method)) {

                String rawFilename = req.getHeader("x-filename");
                if (rawFilename == null || rawFilename.trim().isEmpty()) {
                    rawFilename = req.getQuery("filename");
                }
                String rawFolder = req.getHeader("x-folder");
                if (rawFolder == null) {
                    rawFolder = req.getQuery("folder");
                }

                String filename = "unnamed_media";
                if (rawFilename != null && !rawFilename.trim().isEmpty()) {
                    try {
                        filename = java.net.URLDecoder.decode(rawFilename.trim(), "UTF-8");
                    } catch (Exception ignored) {
                        filename = rawFilename.trim();
                    }
                    filename = new File(filename).getName().trim();
                }

                String folder = "";
                if (rawFolder != null && !rawFolder.trim().isEmpty()) {
                    try {
                        folder = java.net.URLDecoder.decode(rawFolder.trim(), "UTF-8");
                    } catch (Exception ignored) {
                        folder = rawFolder.trim();
                    }
                    folder = folder.replace("\\", "/").trim();
                    if ("ALL".equalsIgnoreCase(folder) || "全部".equals(folder) || folder.contains("..")) {
                        folder = "";
                    }
                }
                // 播放端/直传硬性规范：若未指定子目录或为根目录，一律默认存入【待机】文件夹
                if (folder.isEmpty()) {
                    folder = "待机";
                }

                File mediaDir = StorageHelper.getMediaDir(context);
                File targetDir = folder.isEmpty() ? mediaDir : new File(mediaDir, folder);
                if (!targetDir.exists()) targetDir.mkdirs();

                File dest = new File(targetDir, filename);
                long savedSize = 0;

                // 若请求已由 HttpRequest.parse 流式落盘至临时文件，直接秒级重命名/流式拷贝
                if (req.getBodyFile() != null && req.getBodyFile().exists()) {
                    if (dest.exists()) dest.delete();
                    boolean moved = req.getBodyFile().renameTo(dest);
                    if (!moved) {
                        try (FileInputStream in = new FileInputStream(req.getBodyFile());
                             FileOutputStream out = new FileOutputStream(dest)) {
                            byte[] buf = new byte[65536];
                            int len;
                            while ((len = in.read(buf)) > 0) {
                                out.write(buf, 0, len);
                            }
                            out.flush();
                        } catch (Exception ignored) {}
                    }
                    savedSize = dest.length();
                } else {
                    byte[] b = req.getBody();
                    if (b != null && b.length > 0) {
                        try (FileOutputStream out = new FileOutputStream(dest)) {
                            out.write(b);
                            out.flush();
                            savedSize = b.length;
                        } catch (Exception ignored) {}
                    }
                }

                if (savedSize > 0 || dest.exists()) {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("message", "素材直传保存成功: " + filename);
                    res.put("filename", folder.isEmpty() ? filename : (folder + "/" + filename));
                    res.put("name", folder.isEmpty() ? filename : (folder + "/" + filename));
                    res.put("path", "/media/" + (folder.isEmpty() ? filename : (folder + "/" + filename)));
                    res.put("size", savedSize > 0 ? savedSize : dest.length());
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.notifyUsbMediaUpdated();
                    }
                    return HttpResponse.json(res.toString());
                } else {
                    return HttpResponse.error(400, "文件写入失败，请检查存储权限或磁盘空间");
                }
            }

            // 5.0.1 主动深度扫描探测 U 盘并立即同步 API (带完整诊断详情与手动路径支持)
            if ("/api/system/usb_sync".equals(path) || "/api/usb/sync".equals(path)) {
                String manualPath = req.getQuery("path");
                if (manualPath == null || manualPath.trim().isEmpty()) {
                    try {
                        String bodyText = req.getBodyText();
                        if (bodyText != null && !bodyText.trim().isEmpty()) {
                            JSONObject bodyObj = new JSONObject(bodyText);
                            manualPath = bodyObj.optString("path", "");
                        }
                    } catch (Exception ignored) {}
                }
                JSONObject result = com.visualcast.player.utils.UsbMountReceiver.performUsbSync(context, manualPath);
                return HttpResponse.json(result.toString());
            }

            // 5.1 上传素材 API (multipart/form-data)
            if ("/api/media/upload".equals(path) && "POST".equals(method)) {
                File mediaDir = StorageHelper.getMediaDir(context);
                String contentType = req.getHeader("content-type");
                MultipartParser.ParseResult parsed;
                if (req.getBodyFile() != null && req.getBodyFile().exists()) {
                    parsed = MultipartParser.parseAndSaveFromFile(req.getBodyFile(), contentType, mediaDir, mediaDir);
                } else {
                    parsed = MultipartParser.parseAndSave(req.getBody(), contentType, mediaDir, mediaDir);
                }
                if (parsed.savedFilename != null) {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("message", "素材上传成功: " + parsed.savedFilename);
                    res.put("filename", parsed.savedFilename);
                    res.put("name", parsed.savedFilename);
                    res.put("path", "/media/" + parsed.savedFilename);
                    res.put("size", parsed.savedFileSize);
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.notifyUsbMediaUpdated();
                    }
                    return HttpResponse.json(res.toString());
                } else {
                    return HttpResponse.error(400, parsed.error != null ? parsed.error : "上传文件解析失败");
                }
            }

            // 5.2 删除素材 API
            if ("/api/media/delete".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                String filename = b.optString("filename", b.optString("name", b.optString("path", "")));
                if (filename.startsWith("/media/")) {
                    filename = filename.substring(7);
                }
                boolean deleted = false;
                File target = new File(StorageHelper.getMediaDir(context), filename);
                if (target.exists()) {
                    deleted = target.delete();
                } else {
                    deleted = deleteMediaFileRecursive(StorageHelper.getMediaDir(context), filename);
                }
                JSONObject res = new JSONObject();
                res.put("status", deleted ? "ok" : "error");
                res.put("message", deleted ? "素材已成功删除" : "未找到指定素材文件或已删除");
                return HttpResponse.json(res.toString());
            }

            // 5.3 新建素材分类文件夹 API
            if ("/api/media/folder/create".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                String folderName = b.optString("name", b.optString("folder", "")).trim();
                if (!folderName.isEmpty()) {
                    File folder = new File(StorageHelper.getMediaDir(context), folderName);
                    if (!folder.exists()) folder.mkdirs();
                }
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"文件夹已创建\"}");
            }

            // 5.4 素材复制与剪切/移动 API (待机与其他文件夹互通)
            if ("/api/media/transfer".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                String action = b.optString("action", "copy").toLowerCase().trim();
                String targetFolder = b.optString("target_folder", "").trim().replace("\\", "/");
                if ("ALL".equalsIgnoreCase(targetFolder) || "全部".equals(targetFolder)) {
                    targetFolder = "";
                }
                java.util.List<String> sources = new java.util.ArrayList<>();
                JSONArray arr = b.optJSONArray("sources");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        sources.add(arr.optString(i));
                    }
                } else if (b.has("source")) {
                    sources.add(b.optString("source"));
                } else if (b.has("name")) {
                    sources.add(b.optString("name"));
                }

                File mediaDir = StorageHelper.getMediaDir(context);
                File destDir = targetFolder.isEmpty() ? mediaDir : new File(mediaDir, targetFolder);
                if (!destDir.exists()) destDir.mkdirs();

                int successCount = 0;
                JSONArray results = new JSONArray();

                for (String src : sources) {
                    String srcClean = src.trim().replace("\\", "/");
                    if (srcClean.isEmpty() || srcClean.contains("..")) continue;
                    File srcFile = new File(mediaDir, srcClean);
                    if (!srcFile.exists()) {
                        JSONObject r = new JSONObject();
                        r.put("name", srcClean);
                        r.put("status", "error");
                        r.put("message", "源文件不存在");
                        results.put(r);
                        continue;
                    }

                    String baseName = srcFile.getName();
                    File destFile = new File(destDir, baseName);

                    if (srcFile.getAbsolutePath().equals(destFile.getAbsolutePath())) {
                        if ("move".equals(action)) {
                            JSONObject r = new JSONObject();
                            r.put("name", srcClean);
                            r.put("status", "skipped");
                            results.put(r);
                            continue;
                        } else {
                            // 复制副本
                            String stem = baseName;
                            String ext = "";
                            int dotIdx = baseName.lastIndexOf('.');
                            if (dotIdx > 0) {
                                stem = baseName.substring(0, dotIdx);
                                ext = baseName.substring(dotIdx);
                            }
                            int counter = 1;
                            while (true) {
                                String suffix = (counter == 1) ? "_副本" : ("_副本(" + counter + ")");
                                String newBase = stem + suffix + ext;
                                File testFile = new File(destDir, newBase);
                                if (!testFile.exists()) {
                                    destFile = testFile;
                                    baseName = newBase;
                                    break;
                                }
                                counter++;
                            }
                        }
                    } else if (destFile.exists()) {
                        if ("copy".equals(action)) {
                            String stem = baseName;
                            String ext = "";
                            int dotIdx = baseName.lastIndexOf('.');
                            if (dotIdx > 0) {
                                stem = baseName.substring(0, dotIdx);
                                ext = baseName.substring(dotIdx);
                            }
                            int counter = 1;
                            while (true) {
                                String suffix = (counter == 1) ? "_副本" : ("_副本(" + counter + ")");
                                String newBase = stem + suffix + ext;
                                File testFile = new File(destDir, newBase);
                                if (!testFile.exists()) {
                                    destFile = testFile;
                                    baseName = newBase;
                                    break;
                                }
                                counter++;
                            }
                        } else {
                            destFile.delete();
                        }
                    }

                    boolean opSuccess = false;
                    try {
                        if ("copy".equals(action)) {
                            copyFileStream(srcFile, destFile);
                            opSuccess = true;
                        } else {
                            opSuccess = srcFile.renameTo(destFile);
                            if (!opSuccess) {
                                copyFileStream(srcFile, destFile);
                                srcFile.delete();
                                opSuccess = true;
                            }
                        }
                    } catch (Exception ex) {
                        opSuccess = false;
                    }

                    JSONObject r = new JSONObject();
                    r.put("name", srcClean);
                    r.put("status", opSuccess ? "ok" : "error");
                    if (opSuccess) {
                        successCount++;
                        r.put("new_name", targetFolder.isEmpty() ? baseName : (targetFolder + "/" + baseName));
                    }
                    results.put(r);
                }

                JSONObject res = new JSONObject();
                res.put("status", successCount > 0 ? "ok" : "error");
                res.put("action", action);
                res.put("success_count", successCount);
                String actName = "copy".equals(action) ? "复制" : "剪切移动";
                res.put("message", "成功" + actName + " " + successCount + " 个素材至【" + (targetFolder.isEmpty() ? "根目录" : targetFolder) + "】");
                res.put("results", results);
                return HttpResponse.json(res.toString());
            }

            // 5.5 素材安全重命名 API
            if ("/api/media/rename".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                String oldName = b.optString("old_name", b.optString("name", "")).trim().replace("\\", "/");
                String newName = b.optString("new_name", "").trim().replace("\\", "/");

                if (oldName.isEmpty()) return HttpResponse.error(400, "原素材名称不能为空");
                if (newName.isEmpty()) return HttpResponse.error(400, "新素材名称不能为空");
                if (oldName.contains("..") || newName.contains("..")) return HttpResponse.error(400, "包含非法路径字符");

                File mediaDir = StorageHelper.getMediaDir(context);
                File srcFile = new File(mediaDir, oldName);
                if (!srcFile.exists()) return HttpResponse.error(404, "原素材文件不存在");

                String folderPrefix = "";
                int lastSlash = oldName.lastIndexOf('/');
                if (lastSlash != -1) {
                    folderPrefix = oldName.substring(0, lastSlash);
                }

                String newBase = newName;
                int newSlash = newBase.lastIndexOf('/');
                if (newSlash != -1) {
                    newBase = newBase.substring(newSlash + 1);
                }

                // 检查扩展名，若未输入则自动继承原扩展名
                String oldExt = "";
                int oldDot = srcFile.getName().lastIndexOf('.');
                if (oldDot != -1) {
                    oldExt = srcFile.getName().substring(oldDot);
                }
                int newDot = newBase.lastIndexOf('.');
                if (newDot == -1 && !oldExt.isEmpty()) {
                    newBase = newBase + oldExt;
                }

                String destRel = folderPrefix.isEmpty() ? newBase : (folderPrefix + "/" + newBase);
                File destFile = new File(mediaDir, destRel);

                if (srcFile.getAbsolutePath().equals(destFile.getAbsolutePath())) {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("message", "素材名称未更改");
                    res.put("new_name", destRel);
                    return HttpResponse.json(res.toString());
                }

                if (destFile.exists()) {
                    return HttpResponse.error(400, "目标文件名 [" + newBase + "] 已存在，请更换名称");
                }

                boolean renOk = srcFile.renameTo(destFile);
                if (!renOk) {
                    try {
                        copyFileStream(srcFile, destFile);
                        srcFile.delete();
                        renOk = true;
                    } catch (Exception e) {
                        return HttpResponse.error(500, "重命名失败: " + e.getMessage());
                    }
                }

                // 若是网页流码或自定义条目，联动更新 custom_media.json
                try {
                    File cmFile = new File(StorageHelper.getConfigDir(context), "custom_media.json");
                    if (cmFile.exists()) {
                        JSONArray cmArr = new JSONArray(readFileToString(cmFile));
                        boolean cmUpdated = false;
                        for (int i = 0; i < cmArr.length(); i++) {
                            JSONObject it = cmArr.optJSONObject(i);
                            if (it != null) {
                                String n = it.optString("name", "");
                                if (n.equals(oldName)) {
                                    it.put("name", destRel);
                                    cmUpdated = true;
                                } else if (n.equals(srcFile.getName())) {
                                    it.put("name", newBase);
                                    cmUpdated = true;
                                }
                            }
                        }
                        if (cmUpdated) {
                            writeStringToFile(cmFile, cmArr.toString());
                        }
                    }
                } catch (Exception ignored) {}

                // 同步更新播放态
                try {
                    if (oldName.equals(playerState.optString("current_media"))) {
                        playerState.put("current_media", destRel);
                    }
                } catch (Exception ignored) {}

                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("message", "素材已成功重命名为 [" + newBase + "]");
                res.put("old_name", oldName);
                res.put("new_name", destRel);
                res.put("filename", newBase);
                return HttpResponse.json(res.toString());
            }

            // 6. 展馆物联控制 API (校验权限)
            if ("/api/iot/devices".equals(path)) {
                if ("POST".equals(method)) {
                    if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                    JSONObject b = new JSONObject(req.getBodyText());
                    JSONObject cfg = iotEngine.getConfig();
                    cfg.put("devices", b.optJSONArray("devices"));
                    iotEngine.saveConfig(cfg);
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"设备库配置已保存\"}");
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("devices", iotEngine.getConfig().optJSONArray("devices"));
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/iot/devices/test".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                JSONObject ret = iotEngine.sendDeviceCommand(b.optString("device_id"), b.optString("cmd_type", "on"), b.optString("custom_cmd", null));
                return HttpResponse.json(ret.toString());
            }
            if ("/api/iot/macros".equals(path)) {
                if ("POST".equals(method)) {
                    if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                    JSONObject b = new JSONObject(req.getBodyText());
                    JSONObject cfg = iotEngine.getConfig();
                    cfg.put("macros", b.optJSONObject("macros"));
                    cfg.put("custom_scenarios", b.optJSONArray("custom_scenarios"));
                    iotEngine.saveConfig(cfg);
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"宏配置已保存\"}");
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("macros", iotEngine.getConfig().optJSONObject("macros"));
                    res.put("custom_scenarios", iotEngine.getConfig().optJSONArray("custom_scenarios"));
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/iot/macros/run".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                String macroId = b.optString("macro_id");
                JSONObject ret = iotEngine.runMacroAsync(macroId);
                return HttpResponse.json(ret.toString());
            }
            if ("/api/iot/timeline".equals(path)) {
                if ("POST".equals(method)) {
                    if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                    JSONObject b = new JSONObject(req.getBodyText());
                    JSONObject cfg = iotEngine.getConfig();
                    cfg.put("timeline", b.optJSONObject("timeline"));
                    iotEngine.saveConfig(cfg);
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"时间轴配置已保存\"}");
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    JSONObject tl = iotEngine.getConfig().optJSONObject("timeline");
                    res.put("timeline", tl != null ? tl : new JSONObject());
                    return HttpResponse.json(res.toString());
                }
            }

            // 自定义中转与协议网关 API
            if ("/api/iot/forwarders".equals(path)) {
                if ("POST".equals(method)) {
                    if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                    JSONObject b = new JSONObject(req.getBodyText());
                    return HttpResponse.json(iotEngine.saveForwarder(b).toString());
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("forwarders", iotEngine.getForwarders());
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/iot/forwarders/delete".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                return HttpResponse.json(iotEngine.deleteForwarder(b.optString("id")).toString());
            }
            if ("/api/iot/forwarders/toggle".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                return HttpResponse.json(iotEngine.toggleForwarder(b.optString("id"), b.optBoolean("enabled", true)).toString());
            }
            if ("/api/iot/forwarders/test".equals(path) && "POST".equals(method)) {
                if (!checkAuth(req)) return HttpResponse.error(401, "未授权");
                JSONObject b = new JSONObject(req.getBodyText());
                return HttpResponse.json(iotEngine.testForwarder(b.optString("id")).toString());
            }
            if ("/api/iot/trigger".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String cmd = b.optString("cmd", b.optString("command", ""));
                String proto = b.optString("protocol", "HTTP");
                iotEngine.processForwarding(cmd, proto);
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("message", "指令 [" + cmd + "] 已触发并转发");
                return HttpResponse.json(res.toString());
            }

            // 7. 系统与应用运维 API
            // 定时开关机配置与状态 API (支持定时开机与定时关机黑屏休眠)
            if ("/api/system/scheduled_shutdown".equals(path)) {
                File f = new File(StorageHelper.getConfigDir(context), "scheduled_shutdown.json");
                if ("POST".equals(method)) {
                    try {
                        JSONObject b = new JSONObject(req.getBodyText());
                        writeStringToFile(f, b.toString());
                        playerConfig.put("scheduled_shutdown", b);
                        savePlayerConfig();
                        ScheduledShutdownManager.lastExecutedBootStamp = "";
                        ScheduledShutdownManager.lastExecutedShutdownStamp = "";
                        ScheduledShutdownManager.todayCancelled = false;
                    } catch(Exception ignored) {}
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("message", "定时开关机排程已生效并永久固化保存");
                    return HttpResponse.json(res.toString());
                } else {
                    JSONObject cfg = new JSONObject();
                    if (f.exists()) {
                        try { cfg = new JSONObject(readFileToString(f)); } catch(Exception ignored) {}
                    }
                    if (!cfg.has("enabled")) cfg.put("enabled", false);
                    if (!cfg.has("boot_enabled")) cfg.put("boot_enabled", true);
                    if (!cfg.has("boot_time")) cfg.put("boot_time", "08:30");
                    if (!cfg.has("shutdown_time")) cfg.put("shutdown_time", "21:30");
                    if (!cfg.has("time")) cfg.put("time", "21:30");
                    if (!cfg.has("weekdays")) {
                        JSONArray defDays = new JSONArray();
                        for (int di = 1; di <= 7; di++) defDays.put(di);
                        cfg.put("weekdays", defDays);
                    }

                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    JSONObject data = new JSONObject();
                    data.put("config", cfg);
                    data.put("today_cancelled", false);
                    data.put("today_executed", false);
                    data.put("target_time_str", cfg.optString("shutdown_time", "21:30"));
                    data.put("schedule_desc", "周一至周日已排程");
                    res.put("data", data);
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/system/cancel_shutdown".equals(path) && "POST".equals(method)) {
                com.visualcast.player.server.ScheduledShutdownManager.todayCancelled = true;
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"今日关机已取消\"}");
            }
            if ("/api/system/reset_shutdown".equals(path) && "POST".equals(method)) {
                com.visualcast.player.server.ScheduledShutdownManager.todayCancelled = false;
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"今日排程已恢复\"}");
            }

            if ("/api/system/save_all_config".equals(path) && "POST".equals(method)) {
                try {
                    JSONObject b = new JSONObject(req.getBodyText());
                    java.util.Iterator<String> keys = b.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        playerConfig.put(k, b.get(k));
                    }
                    savePlayerConfig();
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("SYNC_CONFIG", playerConfig);
                    }
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏全局配置已固化保存，下次启动自动生效\"}");
                } catch(Exception e) {
                    return HttpResponse.error(500, "保存配置异常: " + e.getMessage());
                }
            }

            if (("/api/system/reboot".equals(path) || "/api/system/restart".equals(path)) && "POST".equals(method)) {
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已执行重启服务\"}");
            }

            if ("/api/system/sleep".equals(path) && "POST".equals(method)) {
                setGlobalSleepMode(true);
                MainActivity act = MainActivity.getInstance();
                if (act != null) {
                    act.triggerSleepTransition(true);
                }
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏已待机 (开启黑场，停止播放)\"}");
            }
            if ("/api/system/wakeup".equals(path) && "POST".equals(method)) {
                setGlobalSleepMode(false);
                playerConfig.put("muted", false);
                MainActivity act = MainActivity.getInstance();
                if (act != null) {
                    act.triggerSleepTransition(false);
                }
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"大屏已唤醒 (播放待机素材，解除黑场与静音)\"}");
            }
            if ("/api/system/return_to_player".equals(path) && "POST".equals(method)) {
                SystemHelper.bringVisualCastToFront(context);
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已切回 VisualCast 大屏播控视窗\"}");
            }
            if ("/api/player/launch_ppt".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String fileName = b.optString("file", "");
                File f = new File(StorageHelper.getMediaDir(context), fileName);
                if (f.exists()) {
                    boolean ok = SystemHelper.launchWPSPresentation(context, f);
                    return HttpResponse.json("{\"status\":\"" + (ok ? "ok" : "error") + "\",\"message\":\"" + (ok ? "已唤醒 WPS Office 全屏放映" : "启动失败") + "\"}");
                }
                return HttpResponse.error(404, "文件不存在: " + fileName);
            }

            if ("/api/system/volume".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String action = b.optString("action", "up");
                SystemHelper.adjustVolume(context, action);
                return HttpResponse.json("{\"status\":\"ok\"}");
            }
            if ("/api/system/launch_app".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                boolean ok = SystemHelper.launchExternalApp(context, b.optString("path"));
                return HttpResponse.json("{\"status\":\"" + (ok ? "ok" : "error") + "\",\"message\":\"" + (ok ? "已成功唤醒应用" : "启动失败，请检查包名") + "\"}");
            }
            if ("/api/system/kill_app".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String p = b.optString("path", "");
                String n = b.optString("name", "");
                SystemHelper.killExternalApp(context, p, n);
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"已强行关闭第三方应用并切回 VisualCast 主播控视窗\"}");
            }
            if ("/api/system/app_status".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("app_status", new JSONObject());
                return HttpResponse.json(res.toString());
            }
            if ("/api/system/save_apps".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                playerConfig.put("external_apps", b.optJSONArray("apps"));
                savePlayerConfig();
                return HttpResponse.json("{\"status\":\"ok\",\"message\":\"外部应用列表已更新\"}");
            }
            if ("/api/system/autostart".equals(path)) {
                if ("POST".equals(method)) {
                    JSONObject b = new JSONObject(req.getBodyText());
                    boolean enable = b.optBoolean("enable", true);
                    setAutostartEnabled(enable);
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("enabled", enable);
                    res.put("message", enable ? "开机自启已成功开启" : "开机自启已关闭");
                    return HttpResponse.json(res.toString());
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("enabled", isAutostartEnabled());
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/display/settings".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("config", playerConfig);
                res.put("local_ips", new JSONArray(Collections.singletonList(NetworkUtils.getLocalIpAddress())));
                res.put("web_port", 8088);
                return HttpResponse.json(res.toString());
            }
            if ("/api/subtitle".equals(path)) {
                if ("POST".equals(method)) {
                    JSONObject b = new JSONObject(req.getBodyText());
                    playerConfig.put("subtitle", b);
                    savePlayerConfig();
                    pushCommand("UPDATE_SUBTITLE", b);
                    if (com.visualcast.player.MainActivity.instance != null) {
                        com.visualcast.player.MainActivity.instance.dispatchCommandToWeb("UPDATE_SUBTITLE", b);
                    }
                    return HttpResponse.json("{\"status\":\"ok\",\"message\":\"字幕设置已保存生效\"}");
                } else {
                    JSONObject res = new JSONObject();
                    res.put("status", "ok");
                    res.put("subtitle", playerConfig.optJSONObject("subtitle") != null ? playerConfig.optJSONObject("subtitle") : new JSONObject());
                    return HttpResponse.json(res.toString());
                }
            }
            if ("/api/system/hardware_status".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                JSONObject cpu = new JSONObject();
                cpu.put("percent", 18.0);
                cpu.put("cores", Runtime.getRuntime().availableProcessors());
                cpu.put("model", Build.MODEL + " (Android " + Build.VERSION.RELEASE + ")");
                res.put("cpu", cpu);

                JSONObject mem = new JSONObject();
                android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                if (am != null) {
                    am.getMemoryInfo(mi);
                }
                double totalGb = Math.round((mi.totalMem / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
                double availGb = Math.round((mi.availMem / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
                double usedGb = Math.max(0.1, Math.round((totalGb - availGb) * 10.0) / 10.0);
                double memPercent = totalGb > 0 ? Math.round(((totalGb - availGb) / totalGb * 100.0) * 10.0) / 10.0 : 45.0;
                mem.put("total_gb", totalGb);
                mem.put("used_gb", usedGb);
                mem.put("free_gb", availGb);
                mem.put("percent", memPercent);
                res.put("memory", mem);

                JSONObject gpu = new JSONObject();
                gpu.put("name", "Mali / Adreno 商显硬件加速引擎");
                gpu.put("percent", 12.0);
                gpu.put("memory_total_mb", 1024);
                gpu.put("memory_used_mb", 256);
                gpu.put("memory_percent", 25.0);
                gpu.put("temperature", 42);
                gpu.put("status_text", "硬件加速运行中");
                res.put("gpu", gpu);

                return HttpResponse.json(res.toString());
            }

            if ("/api/system/info".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("platform", "android");
                res.put("is_android", true);
                List<Map<String, Object>> netList = NetworkUtils.getNetworkInterfaces();
                JSONArray netArr = new JSONArray();
                JSONArray ipArr = new JSONArray();
                for (Map<String, Object> m : netList) {
                    netArr.put(new JSONObject(m));
                    ipArr.put(m.get("ip"));
                }
                res.put("network_interfaces", netArr);
                res.put("ips", ipArr);
                res.put("selected_ip", playerConfig.optString("selected_ip", ""));
                res.put("orientation", playerConfig.optString("orientation", "landscape"));
                res.put("external_apps", playerConfig.optJSONArray("external_apps") != null ? playerConfig.optJSONArray("external_apps") : new JSONArray());
                return HttpResponse.json(res.toString());
            }
            if ("/api/system/network_interfaces".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                List<Map<String, Object>> netList = NetworkUtils.getNetworkInterfaces();
                JSONArray netArr = new JSONArray();
                for (Map<String, Object> m : netList) {
                    netArr.put(new JSONObject(m));
                }
                res.put("network_interfaces", netArr);
                res.put("selected_ip", playerConfig.optString("selected_ip", ""));
                res.put("port", 8088);
                return HttpResponse.json(res.toString());
            }
            if ("/api/system/select_network_interface".equals(path) && "POST".equals(method)) {
                JSONObject b = new JSONObject(req.getBodyText());
                String ip = b.optString("ip", "");
                playerConfig.put("selected_ip", ip);
                savePlayerConfig();
                return HttpResponse.json("{\"status\":\"ok\",\"selected_ip\":\"" + ip + "\"}");
            }

            return HttpResponse.error(404, "Endpoint Not Found: " + path);

        } catch (Exception e) {
            e.printStackTrace();
            return HttpResponse.error(500, "Server Error: " + e.getMessage());
        }
    }

        private byte[] defaultStandbyBytes = null;
    private byte[] getDefaultStandbyBytes() {
        if (defaultStandbyBytes == null) {
            try (InputStream in = context.getAssets().open("static/default_standby.jpg")) {
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    baos.write(buf, 0, n);
                }
                defaultStandbyBytes = baos.toByteArray();
            } catch (Exception ignored) {}
        }
        return defaultStandbyBytes != null ? defaultStandbyBytes : new byte[0];
    }

    public void pushCommand(String action, JSONObject params) {
        synchronized (pendingCommands) {
            try {
                if (pendingCommands.size() >= 50) {
                    pendingCommands.remove(0);
                }
                JSONObject cmd = new JSONObject();
                cmd.put("type", action);
                cmd.put("action", action);
                cmd.put("params", params);
                cmd.put("timestamp", System.currentTimeMillis() / 1000);
                pendingCommands.add(cmd);
            } catch (Exception ignored) {}
        }
        if (com.visualcast.player.MainActivity.instance != null) {
            com.visualcast.player.MainActivity.instance.dispatchCommandToWeb(action, params);
        }
        try {
            if (ClusterSyncEngine.getInstance() != null) {
                ClusterSyncEngine.getInstance().broadcastMasterCommand(action, params);
            }
        } catch (Exception ignored) {}
    }

    private void scanMediaDirectory(File baseDir, File currentDir, JSONArray files, Map<String, Integer> folderCounts, Set<String> allFolders) {
        File[] list = com.visualcast.player.utils.UsbMountReceiver.listFilesRobust(currentDir);
        if (list == null) return;
        for (File f : list) {
            if (f.getName().startsWith(".") || f.getName().endsWith(".trans_tmp")) continue;
            if (f.isDirectory()) {
                String relPath = f.getAbsolutePath().substring(baseDir.getAbsolutePath().length()).replace('\\', '/');
                if (relPath.startsWith("/")) relPath = relPath.substring(1);
                allFolders.add(relPath);
                scanMediaDirectory(baseDir, f, files, folderCounts, allFolders);
            } else if (f.isFile()) {
                String relDir = currentDir.getAbsolutePath().substring(baseDir.getAbsolutePath().length()).replace('\\', '/');
                if (relDir.startsWith("/")) relDir = relDir.substring(1);
                String fullName = relDir.isEmpty() ? f.getName() : (relDir + "/" + f.getName());
                try {
                    JSONObject item = new JSONObject();
                    item.put("name", fullName);
                    item.put("filename", f.getName());
                    item.put("folder", relDir);
                    item.put("size", f.length());
                    item.put("type", StorageHelper.getMediaType(f.getName()));
                    item.put("mtime", f.lastModified() / 1000);
                    item.put("url", "/media/" + fullName);
                    boolean isStandby = "待机".equalsIgnoreCase(relDir) || relDir.toLowerCase().startsWith("待机") || relDir.toLowerCase().startsWith("standby");
                    item.put("is_standby", isStandby);
                    item.put("is_custom", false);
                    files.put(item);
                    folderCounts.put(relDir, folderCounts.containsKey(relDir) ? folderCounts.get(relDir) + 1 : 1);
                } catch (Exception ignored) {}
            }
        }
    }

    private HttpResponse serveAsset(String assetPath, String mime) {
        try (InputStream in = context.getAssets().open(assetPath);
             java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int read;
            while ((read = in.read(buf)) != -1) {
                baos.write(buf, 0, read);
            }
            return HttpResponse.bytes(baos.toByteArray(), mime);
        } catch (Exception e) {
            return HttpResponse.error(404, "Asset Not Found: " + assetPath);
        }
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".pdf")) return "application/pdf";
        return URLConnection.guessContentTypeFromName(name);
    }

    private static boolean deleteMediaFileRecursive(File dir, String filename) {
        if (!dir.exists() || !dir.isDirectory()) return false;
        File[] files = dir.listFiles();
        if (files == null) return false;
        for (File f : files) {
            if (f.isDirectory()) {
                if (deleteMediaFileRecursive(f, filename)) return true;
            } else if (f.getName().equalsIgnoreCase(filename)) {
                return f.delete();
            }
        }
        return false;
    }

    public static File findMediaFile(File dir, String filename) {
        if (!dir.exists() || !dir.isDirectory()) return null;
        File direct = new File(dir, filename);
        if (direct.exists()) return direct;
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.isDirectory()) {
                    File found = findMediaFile(f, filename);
                    if (found != null) return found;
                } else if (f.getName().equalsIgnoreCase(filename)) {
                    return f;
                }
            }
        }
        return null;
    }

    private void setAutostartEnabled(boolean enable) {
        try {
            context.getSharedPreferences("visualcast_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean("autostart_enabled", enable)
                    .apply();

            // 动态启用/禁用系统级 BootReceiver 组件，彻底消除关机重启后自启
            android.content.ComponentName receiver = new android.content.ComponentName(context, com.visualcast.player.BootReceiver.class);
            android.content.pm.PackageManager pm = context.getPackageManager();
            if (pm != null) {
                pm.setComponentEnabledSetting(
                        receiver,
                        enable ? android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                               : android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        android.content.pm.PackageManager.DONT_KILL_APP
                );
            }
        } catch (Exception e) {
            android.util.Log.w("HttpRouter", "更新自启组件配置异常: " + e.getMessage());
        }
    }


    private static int[] getRealScreenResolution(Context ctx) {
        int w = 1920, h = 1080;
        try {
            android.view.WindowManager wm = (android.view.WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
                    wm.getDefaultDisplay().getRealMetrics(dm);
                } else {
                    wm.getDefaultDisplay().getMetrics(dm);
                }
                if (dm.widthPixels > 0 && dm.heightPixels > 0) {
                    w = dm.widthPixels;
                    h = dm.heightPixels;
                }
            }
        } catch (Exception ignored) {}
        return new int[]{w, h};
    }

    private boolean isAutostartEnabled() {
        try {
            return context.getSharedPreferences("visualcast_prefs", Context.MODE_PRIVATE)
                    .getBoolean("autostart_enabled", true);
        } catch (Exception ignored) {
            return true;
        }
    }

    public static String readFileToString(File f) {
        if (!f.exists()) return "";
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            in.read(buf);
            return new String(buf, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return "";
        }
    }

    private static void writeStringToFile(File f, String s) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
            out.write(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }

    private static void copyFileStream(File src, File dest) throws java.io.IOException {
        try (java.io.InputStream in = new java.io.FileInputStream(src);
             java.io.OutputStream out = new java.io.FileOutputStream(dest)) {
            byte[] buf = new byte[8192];
            int len;
            while ((len = in.read(buf)) > 0) {
                out.write(buf, 0, len);
            }
        }
    }

    public JSONObject getPlayerStatusJsonObject() {
        JSONObject res = new JSONObject();
        try {
            res.put("status", "ok");
            JSONObject pl = new JSONObject();
            pl.put("state", playerState.optString("state", "IDLE"));
            pl.put("current_media", playerState.optString("current_media", playerConfig.optJSONObject("playback") != null ? playerConfig.optJSONObject("playback").optString("current_media", "demo_show.mp4") : "demo_show.mp4"));
            pl.put("current_time", playerState.optDouble("current_time", 0.0));
            pl.put("duration", playerState.optDouble("duration", 0.0));
            pl.put("volume", playerConfig.optInt("volume", playerState.optInt("volume", 85)));
            pl.put("muted", playerConfig.optBoolean("muted", playerState.optBoolean("muted", false)));
            pl.put("loop", playerState.optBoolean("loop", true));
            pl.put("loop_mode", playerConfig.optString("loop_mode", "FOLDER_LOOP"));
            pl.put("current_folder", playerConfig.optString("current_folder", ""));
            pl.put("mode", playerState.optString("mode", "ATTRACT"));
            pl.put("idle_media", playerConfig.optJSONObject("playback") != null ? playerConfig.optJSONObject("playback").optString("idle_media", "demo_show.mp4") : "demo_show.mp4");
            pl.put("idle_timeout", playerConfig.optJSONObject("playback") != null ? playerConfig.optJSONObject("playback").optInt("idle_timeout", 60) : 60);
            pl.put("scale_mode", playerConfig.optString("scale_mode", "fill"));
            pl.put("orientation", playerConfig.optString("orientation", "landscape"));
            pl.put("fullscreen", true);
            pl.put("last_heartbeat", Math.max(lastPlayerHeartbeat, lastNativeHeartbeat));
            pl.put("blackout", playerState.optBoolean("blackout", false));
            pl.put("freeze", playerState.optBoolean("freeze", false));
            res.put("player", pl);
        } catch (Exception ignored) {}
        return res;
    }

    public void setLoopMode(String loopMode) {
        try {
            playerConfig.put("loop_mode", loopMode);
            savePlayerConfig();
        } catch (Exception ignored) {}
    }
}
