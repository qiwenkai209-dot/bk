package com.visualcast.player.license;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class LicenseCore {
    public static final String CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    private static final byte[] SECRET_SALT = "VisualCast_License_Salt_v3_2026_RandomNonceSecure!".getBytes(StandardCharsets.UTF_8);

    // 40-bit 置换表 (8 位设备随机申请码)
    private static final int[] SHUFFLE_P_40 = {
        31, 7, 23, 15, 39, 3, 19, 11, 27, 35,
        0, 16, 8, 24, 32, 4, 20, 12, 28, 36,
        1, 17, 9, 25, 33, 5, 21, 13, 29, 37,
        2, 18, 10, 26, 34, 6, 22, 14, 30, 38
    };
    private static final int[] UNSHUFFLE_P_40 = new int[40];

    // 60-bit 置换表 (12 位一次性授权激活码)
    private static final int[] SHUFFLE_P_60 = {
        13, 50, 27, 4, 41, 18, 55, 32, 9, 46, 23, 0, 37, 14, 51, 28, 5, 42, 19, 56,
        33, 10, 47, 24, 1, 38, 15, 52, 29, 6, 43, 20, 57, 34, 11, 48, 25, 2, 39, 16,
        53, 30, 7, 44, 21, 58, 35, 12, 49, 26, 3, 40, 17, 54, 31, 8, 45, 22, 59, 36
    };
    private static final int[] UNSHUFFLE_P_60 = new int[60];

    private static final Map<Character, Integer> CHAR_TO_VAL = new HashMap<>();

    static {
        for (int i = 0; i < SHUFFLE_P_40.length; i++) {
            UNSHUFFLE_P_40[SHUFFLE_P_40[i]] = i;
        }
        for (int i = 0; i < SHUFFLE_P_60.length; i++) {
            UNSHUFFLE_P_60[SHUFFLE_P_60[i]] = i;
        }
        for (int i = 0; i < CHARSET.length(); i++) {
            CHAR_TO_VAL.put(CHARSET.charAt(i), i);
        }
    }

    public static class DurationInfo {
        public final String label;
        public final double days;
        public DurationInfo(String label, double days) {
            this.label = label;
            this.days = days;
        }
    }

    public static class RunsInfo {
        public final String label;
        public final int runs;
        public RunsInfo(String label, int runs) {
            this.label = label;
            this.runs = runs;
        }
    }

    public static DurationInfo getDuration(int code) {
        switch (code) {
            case 11: return new DurationInfo("0.5天 (半天/12小时)", 0.5);
            case 0: return new DurationInfo("1天 (试用)", 1.0);
            case 1: return new DurationInfo("3天 (试用)", 3.0);
            case 2: return new DurationInfo("7天 (1周)", 7.0);
            case 3: return new DurationInfo("15天 (半月)", 15.0);
            case 4: return new DurationInfo("30天 (1个月)", 30.0);
            case 5: return new DurationInfo("60天 (2个月)", 60.0);
            case 6: return new DurationInfo("90天 (1季度)", 90.0);
            case 7: return new DurationInfo("180天 (半年)", 180.0);
            case 8: return new DurationInfo("365天 (1年)", 365.0);
            case 9: return new DurationInfo("730天 (2年)", 730.0);
            case 10: return new DurationInfo("1095天 (3年)", 1095.0);
            case 31: return new DurationInfo("永久有效", -1.0);
            default: return new DurationInfo(code + " 档位", -1.0);
        }
    }

    public static RunsInfo getRuns(int code) {
        switch (code) {
            case 0: return new RunsInfo("5 次", 5);
            case 1: return new RunsInfo("10 次", 10);
            case 2: return new RunsInfo("20 次", 20);
            case 3: return new RunsInfo("50 次", 50);
            case 4: return new RunsInfo("100 次", 100);
            case 5: return new RunsInfo("200 次", 200);
            case 6: return new RunsInfo("500 次", 500);
            case 7: return new RunsInfo("1000 次", 1000);
            case 8: return new RunsInfo("2000 次", 2000);
            case 9: return new RunsInfo("5000 次", 5000);
            case 10: return new RunsInfo("10000 次", 10000);
            case 31: return new RunsInfo("无限制", -1);
            default: return new RunsInfo(code + " 档位", -1);
        }
    }

    private static long permuteBitsLong(long val, int[] perm) {
        long result = 0;
        for (int newPos = 0; newPos < perm.length; newPos++) {
            int oldPos = perm[newPos];
            long bit = (val >> oldPos) & 1L;
            result |= (bit << newPos);
        }
        return result;
    }

    private static int calcReqChecksum(int hwHash, int nonce) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(SECRET_SALT, "HmacSHA256"));
            byte[] prefix = "REQ:".getBytes(StandardCharsets.UTF_8);
            byte[] payload = new byte[]{
                (byte) ((hwHash >> 8) & 0x0F),
                (byte) (hwHash & 0xFF),
                (byte) ((nonce >> 8) & 0xFF),
                (byte) (nonce & 0xFF)
            };
            mac.update(prefix);
            byte[] digest = mac.doFinal(payload);
            int raw = ((digest[0] & 0xFF) << 8) | (digest[1] & 0xFF);
            return raw & 0x0FFF;
        } catch (Exception e) {
            return 0;
        }
    }

    public static String encodeRequestCode(int hwHash, int nonce) {
        hwHash &= 0x0FFF;
        nonce &= 0xFFFF;
        int checksum = calcReqChecksum(hwHash, nonce);

        long rawNum = (((long) hwHash) << 28) | (((long) nonce) << 12) | ((long) checksum);
        long shuffled = permuteBitsLong(rawNum, SHUFFLE_P_40);

        char[] chars = new char[8];
        long tmp = shuffled;
        for (int i = 7; i >= 0; i--) {
            chars[i] = CHARSET.charAt((int) (tmp & 0x1FL));
            tmp >>= 5;
        }
        String s = new String(chars);
        return s.substring(0, 4) + "-" + s.substring(4);
    }

    public static class RequestResult {
        public boolean valid;
        public int hwHash;
        public int nonce;
        public String code;
        public String error;
    }

    public static RequestResult decodeRequestCode(String codeStr) {
        RequestResult res = new RequestResult();
        if (codeStr == null) {
            res.valid = false;
            res.error = "申请码不能为空";
            return res;
        }
        String clean = codeStr.trim().toUpperCase().replace("-", "").replace(" ", "").replace("RC-", "").replace("RC", "");
        if (clean.length() != 8) {
            res.valid = false;
            res.error = "申请码须为 8 位字符";
            return res;
        }
        long shuffled = 0;
        for (int i = 0; i < clean.length(); i++) {
            char c = clean.charAt(i);
            if (!CHAR_TO_VAL.containsKey(c)) {
                res.valid = false;
                res.error = "包含非法字符: " + c;
                return res;
            }
            shuffled = (shuffled << 5) | CHAR_TO_VAL.get(c);
        }
        long raw = permuteBitsLong(shuffled, UNSHUFFLE_P_40);
        int checksum = (int) (raw & 0x0FFFL);
        int nonce = (int) ((raw >> 12) & 0xFFFFL);
        int hwHash = (int) ((raw >> 28) & 0x0FFFL);

        int expected = calcReqChecksum(hwHash, nonce);
        if (checksum != expected) {
            res.valid = false;
            res.error = "申请码防伪校验未通过";
            return res;
        }

        res.valid = true;
        res.hwHash = hwHash;
        res.nonce = nonce;
        res.code = clean.substring(0, 4) + "-" + clean.substring(4);
        return res;
    }

    private static byte[][] getCandidateSalts() {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] vcSalt = md.digest("VisualCast_Universal_Armor_License_v3_2026_Secure!::VisualCast".getBytes(StandardCharsets.UTF_8));
            byte[] globalSalt = "VisualCast_Universal_Armor_License_v3_2026_Secure!".getBytes(StandardCharsets.UTF_8);
            byte[] legacySalt = SECRET_SALT;
            return new byte[][]{vcSalt, globalSalt, legacySalt};
        } catch (Exception e) {
            return new byte[][]{SECRET_SALT};
        }
    }

    private static int calcLicChecksumWithSalt(int hwHash, int nonce, int durationCode, int runsCode, byte[] salt) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(salt, "HmacSHA256"));
            byte[] prefix = "LIC:".getBytes(StandardCharsets.UTF_8);
            byte[] payload = new byte[]{
                (byte) ((hwHash >> 8) & 0x0F),
                (byte) (hwHash & 0xFF),
                (byte) ((nonce >> 8) & 0xFF),
                (byte) (nonce & 0xFF),
                (byte) (durationCode & 0x1F),
                (byte) (runsCode & 0x1F)
            };
            mac.update(prefix);
            byte[] digest = mac.doFinal(payload);
            int raw = ((digest[0] & 0xFF) << 16) | ((digest[1] & 0xFF) << 8) | (digest[2] & 0xFF);
            return raw & 0x3FFFFF; // 22 bits
        } catch (Exception e) {
            return 0;
        }
    }

    private static int calcLicChecksum(int hwHash, int nonce, int durationCode, int runsCode) {
        return calcLicChecksumWithSalt(hwHash, nonce, durationCode, runsCode, SECRET_SALT);
    }

    public static class LicenseResult {
        public boolean valid;
        public String code;
        public String rawCode;
        public int hwHash;
        public int nonce;
        public boolean isUniversal;
        public int durationCode;
        public double durationDays;
        public String durationLabel;
        public int runsCode;
        public int maxRuns;
        public String runsLabel;
        public String error;
    }

    public static LicenseResult decodeLicense(String codeStr) {
        LicenseResult res = new LicenseResult();
        if (codeStr == null) {
            res.valid = false;
            res.error = "激活码不能为空";
            return res;
        }
        String clean = codeStr.trim().toUpperCase().replace("-", "").replace(" ", "");
        if (clean.length() != 12) {
            res.valid = false;
            res.error = "授权激活码须为 12 位字符 (XXXX-XXXX-XXXX)";
            return res;
        }

        // 验证字符集
        for (int i = 0; i < clean.length(); i++) {
            char c = clean.charAt(i);
            if (!CHAR_TO_VAL.containsKey(c)) {
                res.valid = false;
                res.error = "激活码包含非法字符: " + c;
                return res;
            }
        }

        byte[][] candidateSalts = getCandidateSalts();

        // 1. 尝试国文创加密机默认通用体系 (低位优先解码 Low-bit first)
        long shuffledLow = 0;
        for (int i = 0; i < clean.length(); i++) {
            shuffledLow |= ((long) CHAR_TO_VAL.get(clean.charAt(i)) << (i * 5));
        }
        long rawLow = permuteBitsLong(shuffledLow, UNSHUFFLE_P_60);
        int checksumLow = (int) (rawLow & 0x3FFFFFL);
        int runsLow = (int) ((rawLow >> 22) & 0x1FL);
        int durLow = (int) ((rawLow >> 27) & 0x1FL);
        int nonceLow = (int) ((rawLow >> 32) & 0xFFFFL);
        int hwLow = (int) ((rawLow >> 48) & 0x0FFFL);

        for (byte[] salt : candidateSalts) {
            int exp = calcLicChecksumWithSalt(hwLow, nonceLow, durLow, runsLow, salt);
            if (checksumLow == exp) {
                DurationInfo dInfo = getDuration(durLow);
                RunsInfo rInfo = getRuns(runsLow);
                res.valid = true;
                res.code = clean.substring(0, 4) + "-" + clean.substring(4, 8) + "-" + clean.substring(8);
                res.rawCode = clean;
                res.hwHash = hwLow;
                res.nonce = nonceLow;
                res.isUniversal = (hwLow == 0);
                res.durationCode = durLow;
                res.durationDays = dInfo.days;
                res.durationLabel = dInfo.label;
                res.runsCode = runsLow;
                res.maxRuns = rInfo.runs;
                res.runsLabel = rInfo.label;
                return res;
            }
        }

        // 2. 尝试原生体系 (高位优先解码 High-bit first)
        long shuffledHigh = 0;
        for (int i = 0; i < clean.length(); i++) {
            shuffledHigh = (shuffledHigh << 5) | (long) CHAR_TO_VAL.get(clean.charAt(i));
        }
        long rawHigh = permuteBitsLong(shuffledHigh, UNSHUFFLE_P_60);
        int checksumHigh = (int) (rawHigh & 0x3FFFFFL);
        int runsHigh = (int) ((rawHigh >> 22) & 0x1FL);
        int durHigh = (int) ((rawHigh >> 27) & 0x1FL);
        int nonceHigh = (int) ((rawHigh >> 32) & 0xFFFFL);
        int hwHigh = (int) ((rawHigh >> 48) & 0x0FFFL);

        for (byte[] salt : candidateSalts) {
            int exp = calcLicChecksumWithSalt(hwHigh, nonceHigh, durHigh, runsHigh, salt);
            if (checksumHigh == exp) {
                DurationInfo dInfo = getDuration(durHigh);
                RunsInfo rInfo = getRuns(runsHigh);
                res.valid = true;
                res.code = clean.substring(0, 4) + "-" + clean.substring(4, 8) + "-" + clean.substring(8);
                res.rawCode = clean;
                res.hwHash = hwHigh;
                res.nonce = nonceHigh;
                res.isUniversal = (hwHigh == 0);
                res.durationCode = durHigh;
                res.durationDays = dInfo.days;
                res.durationLabel = dInfo.label;
                res.runsCode = runsHigh;
                res.maxRuns = rInfo.runs;
                res.runsLabel = rInfo.label;
                return res;
            }
        }

        res.valid = false;
        res.error = "激活码防伪签名未通过 (输错或非官方授权加密机生成)";
        return res;
    }
}
