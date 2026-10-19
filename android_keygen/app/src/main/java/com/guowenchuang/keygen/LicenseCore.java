package com.guowenchuang.keygen;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * 国文创加密机 · 核心授权算法引擎 (Universal License Core)
 * 100% 严谨对齐 Python universal_license_core.py 规范:
 * 1. 8 位动态随机申请码识别 (支持 VisualCast 原生大屏端与通用多媒体手册端)
 * 2. 12 位一次性商业授权激活码签发 (XXXX-XXXX-XXXX / 防二次激活)
 * 3. 40 位与 60 位高抗碰撞雪崩置换
 * 4. 支持 0.5 天体验及天数、月度、年度、永久时长
 * 5. 支持 5次 ~ 10000次及无限制启动授权
 */
public class LicenseCore {
    public static final String CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    private static final byte[] DEFAULT_GLOBAL_SALT = "VisualCast_Universal_Armor_License_v3_2026_Secure!".getBytes(StandardCharsets.UTF_8);
    private static final byte[] LEGACY_VISUALCAST_SALT = "VisualCast_License_Salt_v3_2026_RandomNonceSecure!".getBytes(StandardCharsets.UTF_8);

    // 40-bit 置换表 (8 位设备申请码)
    private static final int[] SHUFFLE_P_40 = {
        31, 7, 23, 15, 39, 3, 19, 11, 27, 35,
        0, 16, 8, 24, 32, 4, 20, 12, 28, 36,
        1, 17, 9, 25, 33, 5, 21, 13, 29, 37,
        2, 18, 10, 26, 34, 6, 22, 14, 30, 38
    };
    private static final int[] UNSHUFFLE_P_40 = new int[40];

    // 60-bit 置换表 (12 位一次性激活码)
    private static final int[] SHUFFLE_P_60 = {
        13, 50, 27, 4, 41, 18, 55, 32, 9, 46, 23, 0, 37, 14, 51, 28, 5, 42, 19, 56,
        33, 10, 47, 24, 1, 38, 15, 52, 29, 6, 43, 20, 57, 34, 11, 48, 25, 2, 39, 16,
        53, 30, 7, 44, 21, 58, 35, 12, 49, 26, 3, 40, 17, 54, 31, 8, 45, 22, 59, 36
    };
    private static final int[] UNSHUFFLE_P_60 = new int[60];

    private static final Map<Character, Integer> CHAR_TO_VAL = new HashMap<>();

    static {
        for (int i = 0; i < SHUFFLE_P_40.length; i++) UNSHUFFLE_P_40[SHUFFLE_P_40[i]] = i;
        for (int i = 0; i < SHUFFLE_P_60.length; i++) UNSHUFFLE_P_60[SHUFFLE_P_60[i]] = i;
        for (int i = 0; i < CHARSET.length(); i++) CHAR_TO_VAL.put(CHARSET.charAt(i), i);
    }

    public static class DurationItem {
        public final int code;
        public final String label;
        public final double days;
        public DurationItem(int code, String label, double days) {
            this.code = code;
            this.label = label;
            this.days = days;
        }
        @Override
        public String toString() {
            return label;
        }
    }

    public static final DurationItem[] DURATION_ITEMS = new DurationItem[]{
        new DurationItem(11, "0.5天 (半天/12小时)", 0.5),
        new DurationItem(0, "1天 (单日体验)", 1.0),
        new DurationItem(1, "3天 (短期试用)", 3.0),
        new DurationItem(2, "7天 (1周验收)", 7.0),
        new DurationItem(3, "15天 (半月测试)", 15.0),
        new DurationItem(4, "30天 (1个月临时)", 30.0),
        new DurationItem(5, "60天 (2个月巡展)", 60.0),
        new DurationItem(6, "90天 (1季度租赁)", 90.0),
        new DurationItem(7, "180天 (半年短期)", 180.0),
        new DurationItem(8, "365天 (1年标准维保)", 365.0),
        new DurationItem(9, "730天 (2年运营合同)", 730.0),
        new DurationItem(10, "1095天 (3年长期项目)", 1095.0),
        new DurationItem(31, "永久有效 (商业买断 / 推荐)", -1.0)
    };

    public static class RunsItem {
        public final int code;
        public final String label;
        public final int runs;
        public RunsItem(int code, String label, int runs) {
            this.code = code;
            this.label = label;
            this.runs = runs;
        }
        @Override
        public String toString() {
            return label;
        }
    }

    public static final RunsItem[] RUNS_ITEMS = new RunsItem[]{
        new RunsItem(31, "无限制 (默认不限制启动次数)", -1),
        new RunsItem(10, "10000 次限制", 10000),
        new RunsItem(9, "5000 次限制", 5000),
        new RunsItem(8, "2000 次限制", 2000),
        new RunsItem(7, "1000 次限制", 1000),
        new RunsItem(6, "500 次限制", 500),
        new RunsItem(5, "200 次限制", 200),
        new RunsItem(4, "100 次限制", 100),
        new RunsItem(3, "50 次限制", 50),
        new RunsItem(2, "20 次限制", 20),
        new RunsItem(1, "10 次限制", 10),
        new RunsItem(0, "5 次限制", 5)
    };

    public static byte[] getProductSalt(String productId) {
        if ("VisualCast_Native".equals(productId) || "LEGACY_NATIVE".equals(productId)) {
            return LEGACY_VISUALCAST_SALT;
        }
        if (productId == null || productId.isEmpty() || "DEFAULT".equals(productId)) {
            return DEFAULT_GLOBAL_SALT;
        }
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(DEFAULT_GLOBAL_SALT);
            md.update("::".getBytes(StandardCharsets.UTF_8));
            md.update(productId.getBytes(StandardCharsets.UTF_8));
            return md.digest();
        } catch (Exception e) {
            return DEFAULT_GLOBAL_SALT;
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

    private static int calcReqChecksumWithSalt(int hwHash, int nonce, byte[] salt) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(salt, "HmacSHA256"));
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

    public static class RequestResult {
        public boolean valid;
        public int hwHash;
        public int nonce;
        public String matchedProductId;
        public String bitOrder;
        public String formattedCode;
        public String error;
    }

    public static RequestResult decodeRequestCode(String codeStr) {
        RequestResult res = new RequestResult();
        if (codeStr == null) {
            res.valid = false;
            res.error = "申请码不能为空";
            return res;
        }
        StringBuilder sb = new StringBuilder();
        for (char c : codeStr.toUpperCase().toCharArray()) {
            if (CHAR_TO_VAL.containsKey(c)) sb.append(c);
        }
        if (sb.length() != 8) {
            res.valid = false;
            res.error = "有效字符不足 8 位 (当前 " + sb.length() + " 位)";
            return res;
        }
        String clean = sb.toString();
        res.formattedCode = clean.substring(0, 4) + "-" + clean.substring(4);

        // 1. 低位优先解码
        long numLow = 0;
        for (int i = 0; i < clean.length(); i++) {
            numLow |= (((long) CHAR_TO_VAL.get(clean.charAt(i))) << (i * 5));
        }
        long unLow = permuteBitsLong(numLow, UNSHUFFLE_P_40);
        int hwLow = (int) ((unLow >> 28) & 0x0FFFL);
        int nonceLow = (int) ((unLow >> 12) & 0xFFFFL);
        int chkLow = (int) (unLow & 0x0FFFL);

        // 2. 高位优先解码
        long numHigh = 0;
        for (int i = 0; i < clean.length(); i++) {
            numHigh = (numHigh << 5) | (long) CHAR_TO_VAL.get(clean.charAt(i));
        }
        long unHigh = permuteBitsLong(numHigh, UNSHUFFLE_P_40);
        int hwHigh = (int) ((unHigh >> 28) & 0x0FFFL);
        int nonceHigh = (int) ((unHigh >> 12) & 0xFFFFL);
        int chkHigh = (int) (unHigh & 0x0FFFL);

        List<String> pids = Arrays.asList("VisualCast_Native", "ShengLi", "Manual", "VisualCast", "");

        // 优先匹配低位
        for (String pid : pids) {
            byte[] salt = getProductSalt(pid);
            if (chkLow == calcReqChecksumWithSalt(hwLow, nonceLow, salt)) {
                res.valid = true;
                res.hwHash = hwLow;
                res.nonce = nonceLow;
                res.matchedProductId = pid;
                res.bitOrder = "low_first";
                return res;
            }
        }

        // 其次匹配高位
        for (String pid : pids) {
            byte[] salt = getProductSalt(pid);
            if (chkHigh == calcReqChecksumWithSalt(hwHigh, nonceHigh, salt)) {
                res.valid = true;
                res.hwHash = hwHigh;
                res.nonce = nonceHigh;
                res.matchedProductId = pid;
                res.bitOrder = "high_first";
                return res;
            }
        }

        res.valid = false;
        res.error = "申请码校验和不匹配 (输错或来自未收录版本)";
        return res;
    }

    public static String encodeLicense(int hwHash, int nonce, int durationCode, int runsCode, String productId) {
        hwHash &= 0x0FFF;
        nonce &= 0xFFFF;
        durationCode &= 0x1F;
        runsCode &= 0x1F;

        byte[] salt = getProductSalt(productId);
        int checksum = 0;
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
            checksum = (((digest[0] & 0xFF) << 16) | ((digest[1] & 0xFF) << 8) | (digest[2] & 0xFF)) & 0x3FFFFF;
        } catch (Exception e) {
            return "";
        }

        long rawNum = (((long) hwHash) << 48) | (((long) nonce) << 32) | (((long) durationCode) << 27) | (((long) runsCode) << 22) | checksum;
        long shuffled = permuteBitsLong(rawNum, SHUFFLE_P_60);

        if ("VisualCast_Native".equals(productId)) {
            char[] chars = new char[12];
            long tmp = shuffled;
            for (int i = 11; i >= 0; i--) {
                chars[i] = CHARSET.charAt((int) (tmp & 0x1FL));
                tmp >>= 5;
            }
            String s = new String(chars);
            return s.substring(0, 4) + "-" + s.substring(4, 8) + "-" + s.substring(8);
        } else {
            char[] chars = new char[12];
            long tmp = shuffled;
            for (int i = 0; i < 12; i++) {
                chars[i] = CHARSET.charAt((int) (tmp & 0x1FL));
                tmp >>= 5;
            }
            String s = new String(chars);
            return s.substring(0, 4) + "-" + s.substring(4, 8) + "-" + s.substring(8);
        }
    }
}
