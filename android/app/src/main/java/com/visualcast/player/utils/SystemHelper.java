package com.visualcast.player.utils;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;

public class SystemHelper {

    /**
     * 调节 Android 主机系统音量 (up/down/mute)
     */
    public static boolean adjustVolume(Context context, String action) {
        try {
            AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int curVol = am.getStreamVolume(AudioManager.STREAM_MUSIC);

            if ("up".equalsIgnoreCase(action)) {
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI);
            } else if ("down".equalsIgnoreCase(action)) {
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI);
            } else if ("mute".equalsIgnoreCase(action)) {
                if (curVol > 0) {
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, 0, AudioManager.FLAG_SHOW_UI);
                } else {
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, maxVol / 2, AudioManager.FLAG_SHOW_UI);
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 远程拉起第三方 Android 应用程序 (支持包名或者 intent action)
     */
    public static boolean launchExternalApp(Context context, String pkgOrPath) {
        if (pkgOrPath == null || pkgOrPath.trim().isEmpty()) return false;
        try {
            String pkg = pkgOrPath.trim();
            // 如果传入的是完整包名
            PackageManager pm = context.getPackageManager();
            Intent intent = pm.getLaunchIntentForPackage(pkg);
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                FloatingBallHelper.showReturnBall(context);
                return true;
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
        return false;
    }

    /**
     * 精确获取各类常见办公文档的 MIME 类型，确保第三方 Office 正确解析
     */
    public static String getDocumentMimeType(String filename) {
        if (filename == null) return "application/octet-stream";
        String lower = filename.toLowerCase();
        if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
        if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (lower.endsWith(".pps")) return "application/vnd.ms-powerpoint";
        if (lower.endsWith(".ppsx")) return "application/vnd.openxmlformats-officedocument.presentationml.slideshow";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".doc")) return "application/msword";
        if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
        if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (lower.endsWith(".wps")) return "application/kswps";
        if (lower.endsWith(".dps")) return "application/ksdps";
        if (lower.endsWith(".et")) return "application/kset";
        return "application/*";
    }

    /**
     * 安全获取可跨应用共享的 content:// URI (优先 FileProvider，异常时自动同步至安全共享缓存)
     */
    private static android.net.Uri getSafeDocumentUri(Context context, java.io.File file) {
        if (context == null || file == null || !file.exists()) return null;
        String auth = context.getPackageName() + ".fileprovider";
        try {
            // 规范化文件绝对路径，杜绝符号链接导致 FileProvider 匹配失败
            java.io.File canonical = file.getCanonicalFile();
            return androidx.core.content.FileProvider.getUriForFile(context, auth, canonical);
        } catch (Exception e) {
            try {
                return androidx.core.content.FileProvider.getUriForFile(context, auth, file);
            } catch (Exception e2) {
                // 仅对 < 30MB 的文档执行临时保护拷贝，杜绝大文件阻塞 ANR
                if (file.length() < 30 * 1024 * 1024) {
                    try {
                        java.io.File shareDir = new java.io.File(context.getCacheDir(), "shared_docs");
                        if (!shareDir.exists()) shareDir.mkdirs();
                        java.io.File safeCopy = new java.io.File(shareDir, file.getName());
                        if (!safeCopy.exists() || safeCopy.length() != file.length()) {
                            try (java.io.FileInputStream in = new java.io.FileInputStream(file);
                                 java.io.FileOutputStream out = new java.io.FileOutputStream(safeCopy)) {
                                byte[] buf = new byte[65536];
                                int len;
                                while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
                                out.flush();
                            }
                        }
                        return androidx.core.content.FileProvider.getUriForFile(context, auth, safeCopy);
                    } catch (Exception ignored) {}
                }
                return android.net.Uri.fromFile(file);
            }
        }
    }

    /**
     * 使用 Android 端 WPS Office 或系统默认查看器全屏放映 PPT/Word/Excel/PDF 办公文稿
     * 采用标准 FileProvider content:// 协议并遍历显式授予临时读写权限，彻底根治 Android 11+“无法使用此文件夹”报错
     */
    public static boolean launchWPSPresentation(Context context, java.io.File pptFile) {
        if (pptFile == null || !pptFile.exists() || context == null) return false;
        try {
            android.net.Uri uri = getSafeDocumentUri(context, pptFile);
            if (uri == null) return false;

            String mime = getDocumentMimeType(pptFile.getName());
            String nameLower = pptFile.getName().toLowerCase();
            boolean isPpt = nameLower.endsWith(".ppt") || nameLower.endsWith(".pptx") || nameLower.endsWith(".pps") || nameLower.endsWith(".ppsx");

            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(uri, mime);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

            // 金山 WPS Office 官方开放参数
            if (isPpt) {
                intent.putExtra("Mode", "Play");              // 强制进入全屏幻灯片放映模式 (非编辑浏览)
                intent.putExtra("AutoPlay", true);            // 幻灯片自动全屏开播
                intent.putExtra("PlayMode", "Auto");
                intent.putExtra("Play", true);
                intent.putExtra("ForcePlay", true);
                intent.putExtra("AutoPlayLoop", true);        // 自动循环放映
                intent.putExtra("AutoPlayInterval", 5000);    // 5秒自动换页
                intent.putExtra("IsLoop", true);
                intent.putExtra("LoopPlay", true);
            }
            intent.putExtra("OpenMode", "ReadOnly");       // 只读放映模式，防止展屏误触修改
            intent.putExtra("SendCloseBroad", true);       // 关闭放映时回传广播
            intent.putExtra("ClearBuffer", true);
            intent.putExtra("ViewScale", 1.0);

            android.content.pm.PackageManager pm = context.getPackageManager();

            // 核心：显式向系统中所有能够响应此文档的外部应用授予该 URI 的跨沙盒读写权限
            try {
                java.util.List<android.content.pm.ResolveInfo> matches = pm.queryIntentActivities(intent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
                if (matches != null) {
                    for (android.content.pm.ResolveInfo ri : matches) {
                        String pkg = ri.activityInfo.packageName;
                        context.grantUriPermission(pkg, uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    }
                }
            } catch (Exception ignored) {}

            // 优先查找金山 WPS Android 发行版本
            String[] wpsPackages = {"cn.wps.moffice_eng", "cn.wps.moffice", "cn.wps.moffice_i18n"};
            boolean foundWps = false;
            for (String pkg : wpsPackages) {
                try {
                    pm.getPackageInfo(pkg, 0);
                    context.grantUriPermission(pkg, uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    intent.setPackage(pkg);
                    foundWps = true;
                    break;
                } catch (Exception ignored) {}
            }

            if (foundWps) {
                com.visualcast.player.MainActivity.isExternalDocActive = true;
                FloatingBallHelper.showReturnBall(context);
                context.startActivity(intent);
                return true;
            } else {
                // 如果未安装 WPS，仅尝试拉起明确支持该文档的外部 Office 查看器 (排除系统弹窗选择器)
                intent.setPackage(null);
                android.content.ComponentName cn = intent.resolveActivity(pm);
                if (cn != null && !cn.getPackageName().contains("resolver")) {
                    com.visualcast.player.MainActivity.isExternalDocActive = true;
                    FloatingBallHelper.showReturnBall(context);
                    context.startActivity(intent);
                    return true;
                }
            }
            com.visualcast.player.MainActivity.isExternalDocActive = false;
            return false;
        } catch (Exception e) {
            e.printStackTrace();
            return false;
        }
    }

    /**
     * 强行终止/关闭第三方应用程序进程，并联动切回 VisualCast 主播控视窗
     */
    public static boolean killExternalApp(Context context, String pkgOrPath, String appName) {
        if (context == null) return false;
        String targetPkg = "";
        PackageManager pm = context.getPackageManager();

        // 1. 提取或反查目标包名
        if (pkgOrPath != null && !pkgOrPath.trim().isEmpty()) {
            String clean = pkgOrPath.trim();
            if (clean.contains(".") && !clean.contains("/") && !clean.contains("\\")) {
                targetPkg = clean;
            } else {
                try {
                    Intent mainIntent = new Intent(Intent.ACTION_MAIN, null);
                    mainIntent.addCategory(Intent.CATEGORY_LAUNCHER);
                    for (android.content.pm.ResolveInfo ri : pm.queryIntentActivities(mainIntent, 0)) {
                        String label = ri.loadLabel(pm).toString();
                        if (label.equalsIgnoreCase(clean) || label.contains(clean)) {
                            targetPkg = ri.activityInfo.packageName;
                            break;
                        }
                    }
                } catch (Exception ignored) {}
            }
        }

        if (targetPkg.isEmpty() && appName != null && !appName.trim().isEmpty()) {
            String nameClean = appName.trim();
            try {
                Intent mainIntent = new Intent(Intent.ACTION_MAIN, null);
                mainIntent.addCategory(Intent.CATEGORY_LAUNCHER);
                for (android.content.pm.ResolveInfo ri : pm.queryIntentActivities(mainIntent, 0)) {
                    String label = ri.loadLabel(pm).toString();
                    if (label.equalsIgnoreCase(nameClean) || label.contains(nameClean)) {
                        targetPkg = ri.activityInfo.packageName;
                        break;
                    }
                }
            } catch (Exception ignored) {}
        }

        // 2. 第一层：如果目标是金山 WPS Office，下发关闭放映广播
        if (targetPkg.contains("wps") || (appName != null && appName.toLowerCase().contains("wps"))) {
            try {
                Intent wpsClose = new Intent("cn.wps.moffice.action.CLOSE");
                wpsClose.putExtra("CloseMode", "Force");
                context.sendBroadcast(wpsClose);
            } catch (Exception ignored) {}
        }

        // 3. 第二层：调用 ActivityManager 终止后台进程
        if (!targetPkg.isEmpty()) {
            try {
                android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                if (am != null) {
                    am.killBackgroundProcesses(targetPkg);
                }
            } catch (Exception ignored) {}

            // 4. 第三层：若主板具备可用 Root 权限，安全调用工控底层强杀
            if (isDeviceRooted()) {
                execRootCmd("am force-stop " + targetPkg);
            }
        }

        // 5. 第四层核心：无条件强制将 VisualCast 视窗重新拉回前台全屏置顶，压制一切残留第三方界面！
        bringVisualCastToFront(context);
        return true;
    }

    /**
     * 将 VisualCast 主播控视窗带回最前台覆盖
     */
    public static void bringVisualCastToFront(Context context) {
        try {
            FloatingBallHelper.hideReturnBall();
            if (com.visualcast.player.MainActivity.instance != null) {
                try {
                    android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                    if (am != null) {
                        am.moveTaskToFront(com.visualcast.player.MainActivity.instance.getTaskId(), android.app.ActivityManager.MOVE_TASK_WITH_HOME);
                    }
                } catch (Exception ignored) {}
            }
            Intent intent = new Intent(context, com.visualcast.player.MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(intent);
        } catch (Exception ignored) {}
    }

    /**
     * 优先拉起 droidVNC-NG 服务
     */
    public static boolean startDroidVncNgService(Context context) {
        if (context == null) return false;
        try {
            Intent intent = context.getPackageManager().getLaunchIntentForPackage("net.christianbeier.droidvnc_ng");
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private static volatile Boolean sIsRootedCache = null;

    /**
     * 判断 Android 商显主板是否具备真实可用的 Root 权限 (带缓存与快速非阻塞检测)
     */
    public static boolean isDeviceRooted() {
        if (sIsRootedCache != null) {
            return sIsRootedCache;
        }
        String[] paths = {
            "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su",
            "/system/bin/.ext/.su", "/system/usr/we-need-root/su-backup"
        };
        boolean fileExists = false;
        for (String p : paths) {
            if (new java.io.File(p).exists()) {
                fileExists = true;
                break;
            }
        }
        if (!fileExists) {
            sIsRootedCache = false;
            return false;
        }

        // 仅在存在 su 文件时做一次轻量级 500ms 超时探测，绝不挂死主线程或子线程
        try {
            Process p = Runtime.getRuntime().exec(new String[]{"su", "-c", "id"});
            boolean ok = waitForProcessWithTimeout(p, 500);
            if (ok && p.exitValue() == 0) {
                sIsRootedCache = true;
                return true;
            }
        } catch (Exception ignored) {}

        sIsRootedCache = false;
        return false;
    }

    /**
     * 针对 Process 执行带超时的安全等待并及时销毁僵尸进程
     */
    public static boolean waitForProcessWithTimeout(final Process p, long timeoutMs) {
        if (p == null) return false;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            try {
                return p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS);
            } catch (Exception ignored) {}
        }
        final boolean[] finished = new boolean[]{false};
        Thread worker = new Thread(() -> {
            try {
                p.waitFor();
                finished[0] = true;
            } catch (Exception ignored) {}
        });
        worker.start();
        try {
            worker.join(timeoutMs);
        } catch (InterruptedException ignored) {}
        if (!finished[0]) {
            worker.interrupt();
            try { p.destroy(); } catch (Exception ignored) {}
            return false;
        }
        return true;
    }

    /**
     * 以 Root 权限安全执行工控底层 Shell 指令 (严格超时保护，杜绝系统挂死)
     */
    public static boolean execRootCmd(String cmd) {
        if (cmd == null || cmd.trim().isEmpty() || !isDeviceRooted()) return false;
        Process process = null;
        java.io.DataOutputStream os = null;
        try {
            process = Runtime.getRuntime().exec("su");
            os = new java.io.DataOutputStream(process.getOutputStream());
            os.writeBytes(cmd + "\n");
            os.writeBytes("exit\n");
            os.flush();
            os.close();
            boolean finished = waitForProcessWithTimeout(process, 1200);
            return finished && process.exitValue() == 0;
        } catch (Exception e) {
            return false;
        } finally {
            if (os != null) {
                try { os.close(); } catch (Exception ignored) {}
            }
            if (process != null) {
                try { process.destroy(); } catch (Exception ignored) {}
            }
        }
    }

    /**
     * 跨进程控制前台 WPS Office 幻灯片放映 (支持广播指令与物理按键模拟双通道)
     */
    public static void controlWPSPresentation(Context context, String action) {
        if (context == null || action == null) return;
        String act = action.trim().toLowerCase();
        new Thread(() -> {
            try {
                if ("next".equals(act) || "pgdn".equals(act) || "right".equals(act) || "down".equals(act) || "space".equals(act)) {
                    // 1. 发送 WPS 官方下一页广播
                    Intent intent = new Intent("cn.wps.moffice.action.NEXT");
                    context.sendBroadcast(intent);
                    // 2. 模拟系统按键 PAGE_DOWN(93) 与 DPAD_RIGHT(22)
                    try { Runtime.getRuntime().exec("input keyevent 93"); } catch (Exception ignored) {}
                    try { Runtime.getRuntime().exec("input keyevent 22"); } catch (Exception ignored) {}
                    execRootCmd("input keyevent 93");
                } else if ("prev".equals(act) || "pgup".equals(act) || "left".equals(act) || "up".equals(act)) {
                    // 1. 发送 WPS 官方上一页广播
                    Intent intent = new Intent("cn.wps.moffice.action.PREV");
                    context.sendBroadcast(intent);
                    // 2. 模拟系统按键 PAGE_UP(92) 与 DPAD_LEFT(21)
                    try { Runtime.getRuntime().exec("input keyevent 92"); } catch (Exception ignored) {}
                    try { Runtime.getRuntime().exec("input keyevent 21"); } catch (Exception ignored) {}
                    execRootCmd("input keyevent 92");
                } else if ("close".equals(act) || "exit".equals(act) || "esc".equals(act)) {
                    // 1. 发送金山 WPS 官方推荐的静默关闭广播 (毫秒级响应，零 CPU 占用)
                    Intent closeIntent = new Intent("cn.wps.moffice.action.CLOSE");
                    closeIntent.putExtra("CloseMode", "Force");
                    context.sendBroadcast(closeIntent);

                    // 2. 极速尝试释放常见 WPS 后台进程
                    try {
                        android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                        if (am != null) {
                            am.killBackgroundProcesses("cn.wps.moffice");
                            am.killBackgroundProcesses("cn.wps.moffice_eng");
                            am.killBackgroundProcesses("cn.wps.moffice_i18n");
                        }
                    } catch (Exception ignored) {}

                    // 3. 仅在已明确 Root 的设备上才尝试模拟 ESC / BACK 按键
                    if (isDeviceRooted()) {
                        execRootCmd("input keyevent 4");
                        execRootCmd("input keyevent 111");
                    }

                    com.visualcast.player.MainActivity.isExternalDocActive = false;
                    bringVisualCastToFront(context);
                }
            } catch (Exception ignored) {}
        }).start();
    }
}
