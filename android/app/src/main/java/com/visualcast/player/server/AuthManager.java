package com.visualcast.player.server;

import android.content.Context;
import com.visualcast.player.utils.StorageHelper;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;

public class AuthManager {
    private final File configFile;
    private final Map<String, Long> activeSessions = new HashMap<>();
    private String salt = "";
    private String passwordHash = "";
    private boolean enabled = true;
    private int expireHours = 168; // 7天

    public AuthManager(Context context) {
        this.configFile = new File(StorageHelper.getConfigDir(context), "auth_config.json");
        loadConfig();
    }

    private static String sha256(String base) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(base.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception ex) {
            throw new RuntimeException(ex);
        }
    }

    private static String randomHex(int bytesCount) {
        byte[] bytes = new byte[bytesCount];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    public synchronized void loadConfig() {
        if (!configFile.exists()) {
            this.salt = randomHex(8);
            this.passwordHash = sha256(this.salt + "admin888");
            this.enabled = true;
            saveConfig();
            return;
        }
        try (FileInputStream fis = new FileInputStream(configFile)) {
            byte[] data = new byte[(int) configFile.length()];
            fis.read(data);
            JSONObject json = new JSONObject(new String(data, StandardCharsets.UTF_8));
            this.enabled = json.optBoolean("enabled", true);
            this.salt = json.optString("salt", "");
            this.passwordHash = json.optString("password_hash", "");
            this.expireHours = json.optInt("session_expire_hours", 168);
        } catch (Exception e) {
            this.salt = randomHex(8);
            this.passwordHash = sha256(this.salt + "admin888");
        }
    }

    public synchronized void saveConfig() {
        try (FileOutputStream fos = new FileOutputStream(configFile)) {
            JSONObject json = new JSONObject();
            json.put("enabled", enabled);
            json.put("salt", salt);
            json.put("password_hash", passwordHash);
            json.put("session_expire_hours", expireHours);
            fos.write(json.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public synchronized boolean verifyPassword(String password) {
        if (!enabled) return true;
        if (password == null) return false;
        String hashed = sha256(this.salt + password);
        return hashed.equalsIgnoreCase(this.passwordHash);
    }

    public synchronized String createSession() {
        String token = randomHex(16) + randomHex(16);
        long expireTime = System.currentTimeMillis() + (long) expireHours * 3600 * 1000;
        activeSessions.put(token, expireTime);
        return token;
    }

    public synchronized boolean validateToken(String token) {
        if (!enabled) return true;
        if (token == null || token.isEmpty()) return false;
        Long exp = activeSessions.get(token);
        if (exp != null && exp > System.currentTimeMillis()) {
            return true;
        }
        activeSessions.remove(token);
        return false;
    }

    public synchronized void revokeSession(String token) {
        if (token != null) activeSessions.remove(token);
    }

    public synchronized boolean changePassword(String oldPwd, String newPwd) {
        if (enabled && !verifyPassword(oldPwd)) return false;
        if (newPwd == null || newPwd.trim().length() < 4) return false;
        this.salt = randomHex(8);
        this.passwordHash = sha256(this.salt + newPwd.trim());
        saveConfig();
        activeSessions.clear();
        return true;
    }

    public boolean isEnabled() {
        return enabled;
    }
}
