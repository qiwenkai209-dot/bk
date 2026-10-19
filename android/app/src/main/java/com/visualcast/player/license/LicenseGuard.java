package com.visualcast.player.license;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;
import com.visualcast.player.utils.StorageHelper;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

public class LicenseGuard {
    private static final byte[] STORAGE_KEY_BASE = "VC_License_Storage_Protected_Key_#2026_V3!".getBytes(StandardCharsets.UTF_8);

    private final Context context;
    private final File licenseFile;
    private final String hardwareId;
    private final int hwHash;
    private final String machineCode;
    private int pendingNonce;

    public LicenseGuard(Context context) {
        this.context = context;
        this.licenseFile = new File(StorageHelper.getConfigDir(context), ".license.dat");
        this.hardwareId = calcHardwareId(context);
        this.hwHash = calcHwHash(this.hardwareId);
        this.machineCode = String.format("MC-%03X", this.hwHash);
        ensurePendingNonce();
    }

    public String getMachineCode() {
        return machineCode;
    }

    public int getHwHash() {
        return hwHash;
    }

    private static volatile String sCachedHardwareId = null;

    @SuppressLint("HardwareIds")
    private static String calcHardwareId(Context ctx) {
        if (sCachedHardwareId != null) {
            return sCachedHardwareId;
        }
        StringBuilder sb = new StringBuilder();
        try {
            if (ctx != null) {
                String androidId = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
                if (androidId != null && !androidId.isEmpty() && !"9774d56d682e549c".equals(androidId)) {
                    sb.append("AID:").append(androidId).append("|");
                }
            }
        } catch (Exception ignored) {}

        // Android 7 及商显定制主板底层序列号
        try {
            String serial = Build.SERIAL;
            if (serial != null && !serial.isEmpty() && !"unknown".equalsIgnoreCase(serial)) {
                sb.append("SER:").append(serial).append("|");
            }
        } catch (Exception ignored) {}

        sb.append("BOARD:").append(Build.BOARD).append("|");
        sb.append("BRAND:").append(Build.BRAND).append("|");
        sb.append("DEVICE:").append(Build.DEVICE).append("|");
        sb.append("HARDWARE:").append(Build.HARDWARE).append("|");
        sb.append("MODEL:").append(Build.MODEL).append("|");

        // 若前述特征过少，从 SharedPreferences 提取或生成固化安装 UUID
        if (ctx != null) {
            try {
                android.content.SharedPreferences sp = ctx.getSharedPreferences("VC_HardwareFingerprint", Context.MODE_PRIVATE);
                String uuid = sp.getString("device_uuid", "");
                if (uuid == null || uuid.isEmpty()) {
                    uuid = java.util.UUID.randomUUID().toString();
                    sp.edit().putString("device_uuid", uuid).apply();
                }
                sb.append("UUID:").append(uuid).append("|");
            } catch (Exception ignored) {}
        }

        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(sb.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : hash) {
                hex.append(String.format("%02x", b));
            }
            sCachedHardwareId = hex.toString();
            return sCachedHardwareId;
        } catch (Exception e) {
            sCachedHardwareId = "DEFAULT_ANDROID_7_HARDWARE_ID";
            return sCachedHardwareId;
        }
    }

    private static int calcHwHash(String hwId) {
        try {
            String sub = hwId.length() >= 8 ? hwId.substring(0, 8) : hwId;
            long val = Long.parseLong(sub, 16);
            return (int) ((val % 4095) + 1);
        } catch (Exception e) {
            return 1;
        }
    }

    private byte[] getCryptoKey() {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(STORAGE_KEY_BASE);
            md.update(hardwareId.getBytes(StandardCharsets.UTF_8));
            return md.digest();
        } catch (Exception e) {
            return STORAGE_KEY_BASE;
        }
    }

    private static byte[] xorCipher(byte[] data, byte[] key) {
        byte[] out = new byte[data.length];
        for (int i = 0; i < data.length; i++) {
            out[i] = (byte) (data[i] ^ key[i % key.length]);
        }
        return out;
    }

    private JSONObject readStorage() {
        if (licenseFile.exists() && licenseFile.length() > 0) {
            try (FileInputStream fis = new FileInputStream(licenseFile)) {
                byte[] enc = new byte[(int) licenseFile.length()];
                fis.read(enc);
                byte[] dec = xorCipher(enc, getCryptoKey());
                return new JSONObject(new String(dec, StandardCharsets.UTF_8));
            } catch (Exception ignored) {}
        }
        // 尝试从 Android 7 SharedPreferences 双保险备份中恢复
        if (context != null) {
            try {
                android.content.SharedPreferences sp = context.getSharedPreferences("VC_LicenseBackup", Context.MODE_PRIVATE);
                String backup = sp.getString("license_json", "");
                if (backup != null && !backup.isEmpty()) {
                    return new JSONObject(backup);
                }
            } catch (Exception ignored) {}
        }
        return new JSONObject();
    }

    private boolean writeStorage(JSONObject data) {
        boolean fileOk = false;
        try {
            if (licenseFile.getParentFile() != null && !licenseFile.getParentFile().exists()) {
                licenseFile.getParentFile().mkdirs();
            }
            try (FileOutputStream fos = new FileOutputStream(licenseFile)) {
                byte[] raw = data.toString().getBytes(StandardCharsets.UTF_8);
                byte[] enc = xorCipher(raw, getCryptoKey());
                fos.write(enc);
                fos.flush();
                fileOk = true;
            }
        } catch (Exception ignored) {}

        // 同步保存至 SharedPreferences 双保险备份，永不丢失
        if (context != null) {
            try {
                android.content.SharedPreferences sp = context.getSharedPreferences("VC_LicenseBackup", Context.MODE_PRIVATE);
                sp.edit().putString("license_json", data.toString()).apply();
            } catch (Exception ignored) {}
        }
        return fileOk;
    }

    private int generateNewNonce() {
        SecureRandom sr = new SecureRandom();
        int n = sr.nextInt(65535) + 1;
        return n & 0xFFFF;
    }

    private synchronized void ensurePendingNonce() {
        JSONObject store = readStorage();
        int p = store.optInt("pending_nonce", 0);
        if (p <= 0) {
            int newN = generateNewNonce();
            try {
                store.put("pending_nonce", newN);
                writeStorage(store);
            } catch (Exception ignored) {}
            this.pendingNonce = newN;
        } else {
            this.pendingNonce = p;
        }
    }

    public synchronized String getRequestCode() {
        ensurePendingNonce();
        return LicenseCore.encodeRequestCode(hwHash, pendingNonce);
    }

    public static class Status {
        public boolean isValid;
        public String statusCode;
        public JSONObject details = new JSONObject();
    }

    public Status checkLicense() {
        Status st = new Status();
        long nowTs = System.currentTimeMillis() / 1000L;
        ensurePendingNonce();
        JSONObject store = readStorage();

        try {
            st.details.put("machine_code", machineCode);
            st.details.put("hw_hex", String.format("%03X", hwHash));
            st.details.put("request_code", getRequestCode());
            st.details.put("code", store.optString("code", ""));
            st.details.put("contact_wechat", "19203642022");

            if (store.length() == 0 || !store.has("code") || store.optString("code", "").isEmpty()) {
                st.isValid = false;
                st.statusCode = "NO_LICENSE";
                st.details.put("is_trial", false);
                st.details.put("remaining_days", "未授权");
                st.details.put("error", "系统尚未激活，请在受控端输入激活码或联系支持热线: 19203642022");
                return st;
            }

            int licHw = store.optInt("hw_hash", -1);
            if (licHw != 0 && licHw != hwHash) {
                st.isValid = false;
                st.statusCode = "MACHINE_MISMATCH";
                st.details.put("error", "授权凭证绑定的特征码 (" + String.format("MC-%03X", licHw) + ") 与本机不符");
                return st;
            }

            long lastTs = store.optLong("last_seen_ts", 0);
            if (lastTs > 0 && nowTs < (lastTs - 3600)) {
                st.isValid = false;
                st.statusCode = "CLOCK_TAMPERED";
                st.details.put("error", "系统时钟出现回拨");
                return st;
            }

            long expireTs = store.optLong("expire_ts", -1);
            if (expireTs != -1) {
                if (nowTs > expireTs) {
                    st.isValid = false;
                    st.statusCode = "EXPIRED";
                    st.details.put("remaining_days", "已到期");
                    return st;
                } else {
                    long remSeconds = expireTs - nowTs;
                    if (remSeconds >= 86400) {
                        long remDays = remSeconds / 86400L;
                        long remHours = (remSeconds % 86400L) / 3600L;
                        st.details.put("remaining_days", remDays + " 天 " + remHours + " 小时");
                    } else if (remSeconds >= 3600) {
                        long remHours = remSeconds / 3600L;
                        long remMins = (remSeconds % 3600L) / 60L;
                        st.details.put("remaining_days", remHours + " 小时 " + remMins + " 分钟");
                    } else {
                        long remMins = Math.max(1, remSeconds / 60L);
                        st.details.put("remaining_days", remMins + " 分钟");
                    }
                }
            } else {
                st.details.put("remaining_days", "永久有效");
            }

            int maxRuns = store.optInt("max_runs", -1);
            int usedRuns = store.optInt("used_runs", 0);
            if (maxRuns != -1) {
                if (usedRuns >= maxRuns) {
                    st.isValid = false;
                    st.statusCode = "EXHAUSTED";
                    st.details.put("remaining_runs", "0 次");
                    return st;
                } else {
                    st.details.put("remaining_runs", (maxRuns - usedRuns) + " 次");
                }
            } else {
                st.details.put("remaining_runs", "无限制");
            }

            st.isValid = true;
            st.statusCode = "VALID";
            return st;

        } catch (Exception e) {
            st.isValid = false;
            st.statusCode = "NO_LICENSE";
            return st;
        }
    }

    public synchronized void recordLaunch() {
        JSONObject store = readStorage();
        if (store.length() == 0) return;
        long nowTs = System.currentTimeMillis() / 1000L;
        try {
            store.put("used_runs", store.optInt("used_runs", 0) + 1);
            store.put("last_seen_ts", nowTs);
            writeStorage(store);
        } catch (Exception ignored) {}
    }

    public synchronized boolean activate(String codeStr) {
        LicenseCore.LicenseResult res = LicenseCore.decodeLicense(codeStr);
        if (!res.valid) {
            return false;
        }

        if (!res.isUniversal && res.hwHash != hwHash) {
            return false;
        }

        ensurePendingNonce();

        // 核心防二次激活 1: 必须匹配当前设备待激活的 pendingNonce
        if (res.nonce != this.pendingNonce) {
            return false; // 随机 Nonce 不匹配，旧激活码不可二次使用
        }

        JSONObject oldStore = readStorage();
        org.json.JSONArray consumed = oldStore.optJSONArray("consumed_codes");
        if (consumed == null) consumed = new org.json.JSONArray();

        String raw = res.rawCode != null ? res.rawCode : codeStr.trim().toUpperCase().replace("-", "").replace(" ", "");
        for (int i = 0; i < consumed.length(); i++) {
            if (raw.equalsIgnoreCase(consumed.optString(i))) {
                return false; // 该授权码已被使用激活过，已失效作废，不可重复使用
            }
        }

        long nowTs = System.currentTimeMillis() / 1000L;
        long expireTs = (res.durationDays == -1.0) ? -1 : (nowTs + (long)(res.durationDays * 86400.0));

        // 核心安全防线：激活成功立即翻转生成下一代全新的随机 Nonce
        int nextNonce = generateNewNonce();
        this.pendingNonce = nextNonce;

        try {
            JSONObject store = new JSONObject();
            store.put("code", res.code != null ? res.code : codeStr.trim().toUpperCase());
            store.put("hw_hash", res.hwHash);
            store.put("is_universal", res.isUniversal);
            store.put("duration_days", res.durationDays);
            store.put("duration_label", res.durationLabel);
            store.put("max_runs", res.maxRuns);
            store.put("runs_label", res.runsLabel);
            store.put("activated_at", nowTs);
            store.put("expire_ts", expireTs);
            store.put("used_runs", 0);
            store.put("last_seen_ts", nowTs);
            store.put("pending_nonce", nextNonce);

            // 记录核销作废
            consumed.put(raw);
            store.put("consumed_codes", consumed);

            return writeStorage(store);
        } catch (Exception e) {
            return false;
        }
    }
}
