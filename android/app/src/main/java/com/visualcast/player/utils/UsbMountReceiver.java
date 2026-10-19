package com.visualcast.player.utils;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.util.Log;
import com.visualcast.player.MainActivity;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 工业级 U 盘热插拔检测、多通道真实外置卷识别与全自动分类目录构建引擎
 * 针对各类商显主板 (全志/瑞芯微/晶晨等) 深度穿透识别挂载卷
 * 彻底攻克 Android 外置卷写权限沙箱，支持 Root su / Shell sh / 物理映射三重穿透
 * 自动建立【素材/待机-音乐-图片-视频-文档-网页-流码】标准分类文件夹并完成素材镜像同步
 */
public class UsbMountReceiver extends BroadcastReceiver {
    private static final String TAG = "VisualCastUsb";
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    public static boolean isUsbMounted = false;
    public static long lastSyncTime = 0;
    public static int syncedCount = 0;
    public static JSONObject lastSyncReport = new JSONObject();

    private static final Object SYNC_LOCK = new Object();
    private static volatile boolean isSyncRunning = false;

    public static void triggerManualScan(Context context) {
        new UsbMountReceiver().syncUsbMediaAsync(context, 1, null);
    }

    @Override
    public void onReceive(final Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();

        if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
            Log.i(TAG, "检测到 USB 设备物理接入: " + action);
            // 立即启动 3 轮渐进式挂载探测 (0.8s, 2.5s, 5.5s)，确保不论大小 U 盘与 NTFS/FAT32 均能被挂载识别
            mainHandler.postDelayed(() -> syncUsbMediaAsync(context, 1, null), 800);
            mainHandler.postDelayed(() -> syncUsbMediaAsync(context, 2, null), 2500);
            mainHandler.postDelayed(() -> syncUsbMediaAsync(context, 3, null), 5500);

        } else if (Intent.ACTION_MEDIA_MOUNTED.equals(action) ||
                   "android.intent.action.MEDIA_CHECKING".equals(action)) {

            Log.i(TAG, "检测到存储卷挂载广播: " + action);
            mainHandler.postDelayed(() -> syncUsbMediaAsync(context, 1, null), 600);
            mainHandler.postDelayed(() -> syncUsbMediaAsync(context, 2, null), 2200);

        } else if (Intent.ACTION_MEDIA_UNMOUNTED.equals(action) ||
                   Intent.ACTION_MEDIA_REMOVED.equals(action) ||
                   UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {

            Log.i(TAG, "U 盘已拔出或安全卸载");
            isUsbMounted = false;
        }
    }

    public void syncUsbMediaAsync(final Context context, final int attempt, final String manualPath) {
        new Thread(() -> {
            synchronized (SYNC_LOCK) {
                if (isSyncRunning) {
                    Log.d(TAG, "已有 U 盘同步任务正在运行中，跳过重复调用 (第 " + attempt + " 轮探测)");
                    return;
                }
                isSyncRunning = true;
            }
            try {
                // 1. 硬件级纯物理外设前置检测：若 USB 总线上未检测到大容量设备，静默退出杜绝误报
                if (!hasPhysicalUsbMassStorage(context)) {
                    isUsbMounted = false;
                    return;
                }

                // 2. 深度探测是否存在真实有效的外置大容量 U 盘卷
                Set<File> candidateVolumes = getUsbVolumes(context);
                if (manualPath != null && !manualPath.trim().isEmpty()) {
                    File mf = new File(manualPath.trim());
                    if (mf.exists() && mf.isDirectory()) {
                        candidateVolumes.add(mf);
                    }
                }

                // 若尚未挂载完成，静默退出等待下一轮渐进探测
                if (candidateVolumes.isEmpty()) {
                    Log.d(TAG, "第 " + attempt + " 轮探测：未发现有效外接 U 盘卷");
                    isUsbMounted = false;
                    return;
                }

                JSONObject report = performUsbSync(context, manualPath, candidateVolumes);
                lastSyncReport = report;

                int totalCopied = report.optInt("total_copied", 0);
                int standbyCopied = report.optInt("standby_copied", 0);
                boolean standbyUpdated = report.optBoolean("standby_updated", false);
                int volumeCount = report.optInt("volume_count", 0);

                mainHandler.post(() -> {
                    if (MainActivity.instance != null) {
                        // 核心：仅保留一个最终更新结果提醒，杜绝多次重复弹窗打扰用户
                        if (standbyUpdated || totalCopied > 0) {
                            StringBuilder msg = new StringBuilder("🎉 素材更新完成：");
                            if (standbyUpdated) {
                                msg.append("待机已更新 ").append(standbyCopied).append(" 个文件；");
                            }
                            if (totalCopied > standbyCopied) {
                                msg.append("其他分类更新 ").append(totalCopied - standbyCopied).append(" 个素材");
                            }
                            MainActivity.instance.showScreenToast(msg.toString());
                            MainActivity.instance.notifyUsbMediaUpdated();
                        } else if (volumeCount > 0) {
                            // 素材已是最新版本，静默完成并通知列表就绪，不弹出额外冗余弹窗
                            MainActivity.instance.notifyUsbMediaUpdated();
                        }
                    }
                });

            } catch (Exception e) {
                Log.e(TAG, "异步 U 盘同步异常: " + e.getMessage(), e);
            } finally {
                synchronized (SYNC_LOCK) {
                    isSyncRunning = false;
                }
            }
        }).start();
    }

    public static JSONObject performUsbSync(Context context, String manualPath) {
        Set<File> candidateVolumes = getUsbVolumes(context);
        if (manualPath != null && !manualPath.trim().isEmpty()) {
            File mf = new File(manualPath.trim());
            if (mf.exists() && mf.isDirectory()) {
                candidateVolumes.add(mf);
            }
        }
        return performUsbSync(context, manualPath, candidateVolumes);
    }

    /**
     * 核心同步执行入口：全方位探测外置卷、穿透创建标准目录结构、清空覆盖待机与增量分类同步
     */
    public static JSONObject performUsbSync(Context context, String manualPath, Set<File> candidateVolumes) {
        JSONObject report = new JSONObject();
        JSONArray volumeReports = new JSONArray();
        List<String> diagnosticLogs = new ArrayList<>();

        int totalCopied = 0;
        int standbyCopied = 0;
        boolean standbyUpdated = false;
        int totalFoldersCreated = 0;

        try {
            if (candidateVolumes == null || candidateVolumes.isEmpty()) {
                report.put("status", "ok");
                report.put("message", "未检测到有效外接U盘");
                report.put("volume_count", 0);
                report.put("total_copied", 0);
                return report;
            }

            diagnosticLogs.add("已探测到候选存储卷数量: " + candidateVolumes.size());
            File localMediaDir = StorageHelper.getMediaDir(context);

            String[] standbyKeywords = {"待机", "standby", "idle", "daocji", "daiji", "休眠"};
            String[] musicKeywords = {"音乐", "音频", "music", "audio", "yinyue", "sound"};
            String[] imageKeywords = {"图片", "image", "pic", "photo", "tupian", "img"};
            String[] videoKeywords = {"视频", "video", "shipin", "movie", "film"};
            String[] docKeywords = {"文档", "ppt", "pdf", "pptx", "ppt_pdf", "ppt-pdf", "doc", "docx", "wendang"};
            String[] webKeywords = {"网页", "web", "html", "wangye"};
            String[] streamKeywords = {"流码", "stream", "rtsp", "rtmp", "m3u8", "liuma", "直播流"};

            for (File volume : candidateVolumes) {
                if (volume == null || !volume.exists() || !volume.isDirectory()) continue;
                String vPath = volume.getAbsolutePath();
                JSONObject vReport = new JSONObject();
                vReport.put("path", vPath);
                vReport.put("exists", volume.exists());
                vReport.put("can_read", volume.canRead());
                vReport.put("has_lost_dir", new File(volume, "LOST.DIR").exists());

                diagnosticLogs.add(">>> 开始处理存储卷: " + vPath);

                // 1. 尝试挂载可读写
                tryRemountRw(volume);

                // 2. 强力穿透自动生成标准分类目录：素材-待机-音乐-图片-视频-文档-网页、流码 (双重根目录+私有合法目录保障)
                int createdInThisVol = ensureUsbStandardFoldersInternal(context, volume, vReport, diagnosticLogs);
                totalFoldersCreated += createdInThisVol;
                vReport.put("folders_created_count", createdInThisVol);

                // 3. 扫描已存在的素材进行同步
                DiscoveredMediaStructure structure = new DiscoveredMediaStructure();
                scanDirectoryDeep(context, volume, 0, 4, structure, standbyKeywords, musicKeywords, imageKeywords, videoKeywords, docKeywords, webKeywords, streamKeywords);

                int volCopied = 0;
                int volStandby = 0;

                // 待机文件夹处理 (以 U 盘为主：先彻底清空删除本地原有待机文件，再全新导入覆盖更新)
                if (!structure.standbyDirs.isEmpty()) {
                    File localStandbyDir = new File(localMediaDir, "待机");
                    if (!localStandbyDir.exists()) localStandbyDir.mkdirs();

                    List<File> allUsbStandbyFiles = new ArrayList<>();
                    for (File sDir : structure.standbyDirs) {
                        collectMediaFilesRecursive(sDir, allUsbStandbyFiles, 0);
                    }

                    Log.i(TAG, "从 U 盘待机目录探测到有效媒体文件: " + allUsbStandbyFiles.size() + " 个");

                    if (!allUsbStandbyFiles.isEmpty()) {
                        Set<String> usbStandbyNames = new HashSet<>();
                        for (File sf : allUsbStandbyFiles) {
                            usbStandbyNames.add(sf.getName());
                        }

                        // 1. 删除在 U 盘待机目录中已被用户删除的文件 (确保与 U 盘镜像一致)
                        File[] existingLocalFiles = localStandbyDir.listFiles();
                        if (existingLocalFiles != null) {
                            for (File lf : existingLocalFiles) {
                                if (lf.isFile() && !usbStandbyNames.contains(lf.getName())) {
                                    lf.delete();
                                    standbyUpdated = true;
                                }
                            }
                        }

                        // 2. 差异化增量写入：若本地文件已存在且大小完全一致，绝对不重复擦写 Flash，绝不打断正在播放的解码器
                        for (File sf : allUsbStandbyFiles) {
                            File dest = new File(localStandbyDir, sf.getName());
                            boolean needCopy = true;
                            if (dest.exists() && dest.length() == sf.length() && sf.length() > 0) {
                                needCopy = false;
                            }
                            if (needCopy) {
                                if (copyFile(sf, dest)) {
                                    volStandby++;
                                    volCopied++;
                                    standbyUpdated = true;
                                }
                            }
                        }
                        standbyCopied += volStandby;
                        if (volStandby > 0) {
                            Log.i(TAG, "待机素材增量导入成功，已更新写入 " + volStandby + " 个新文件");
                        }
                    }
                }

                // 分类文件夹增量导入
                for (String catName : structure.categoryDirs.keySet()) {
                    List<File> catDirs = structure.categoryDirs.get(catName);
                    if (catDirs == null) continue;
                    File localCatDir = new File(localMediaDir, catName);
                    if (!localCatDir.exists()) localCatDir.mkdirs();

                    for (File cd : catDirs) {
                        volCopied += copyMediaRecursive(context, cd, localCatDir);
                    }
                }

                // 散落素材智能归类
                if (!structure.looseMediaFiles.isEmpty()) {
                    for (File lf : structure.looseMediaFiles) {
                        String targetCat = getCategoryByFilename(lf.getName());
                        File targetDir = new File(localMediaDir, targetCat);
                        if (!targetDir.exists()) targetDir.mkdirs();
                        File dest = new File(targetDir, lf.getName());
                        if (!dest.exists() || dest.length() != lf.length()) {
                            if (copyFile(lf, dest)) {
                                volCopied++;
                                if ("待机".equals(targetCat)) {
                                    volStandby++;
                                    standbyUpdated = true;
                                    standbyCopied++;
                                }
                            }
                        }
                    }
                }

                totalCopied += volCopied;
                vReport.put("copied_files", volCopied);
                volumeReports.put(vReport);
            }

            if (candidateVolumes.size() > 0) {
                isUsbMounted = true;
                lastSyncTime = System.currentTimeMillis();
                syncedCount = totalCopied;
            }

            report.put("status", "ok");
            report.put("message", totalCopied > 0 ? "U盘素材同步成功" : (totalFoldersCreated > 0 ? "已在U盘创建标准分类文件夹" : "扫描完成"));
            report.put("volumes", volumeReports);
            report.put("volume_count", candidateVolumes.size());
            report.put("total_copied", totalCopied);
            report.put("standby_copied", standbyCopied);
            report.put("standby_updated", standbyUpdated);
            report.put("total_folders_created", totalFoldersCreated);

            JSONArray logsArr = new JSONArray();
            for (String l : diagnosticLogs) logsArr.put(l);
            report.put("diagnostic_logs", logsArr);

        } catch (Exception e) {
            Log.e(TAG, "performUsbSync 异常: " + e.getMessage(), e);
            try {
                report.put("status", "error");
                report.put("message", "U盘处理异常: " + e.getMessage());
            } catch (Exception ignored) {}
        }
        return report;
    }

    /**
     * 针对单个卷强力构建标准素材体系
     */
    private static int ensureUsbStandardFoldersInternal(Context context, File usbRoot, JSONObject vReport, List<String> logs) {
        int countCreated = 0;
        JSONArray createdFolders = new JSONArray();
        JSONArray errors = new JSONArray();

        String[] subFolders = {"待机", "音乐", "图片", "视频", "文档", "网页_流码"};
        String content = "========================================================\r\n"
                + "VisualCast 展馆智能播控系统 - U盘素材使用规范\r\n"
                + "========================================================\r\n"
                + "系统已自动为您在 U 盘生成标准分类文件夹，请按需放入素材：\r\n\r\n"
                + "1. 【待机】文件夹：\r\n"
                + "   - 存放展馆待机时轮播播放的高清视频或图片 (MP4, JPG, PNG 等)\r\n"
                + "   - 插入设备后，大屏将清空旧待机内容并全新覆盖导入，立即自动开播！\r\n\r\n"
                + "2. 【音乐】文件夹：\r\n"
                + "   - 存放 MP3, WAV, FLAC, AAC 等背景音频与音效文件\r\n\r\n"
                + "3. 【图片】文件夹：\r\n"
                + "   - 存放 JPG, PNG, WEBP, BMP, GIF 等展示图片\r\n\r\n"
                + "4. 【视频】文件夹：\r\n"
                + "   - 存放 MP4, MKV, MOV, AVI, TS 等高清视频文件\r\n\r\n"
                + "5. 【文档】文件夹：\r\n"
                + "   - 存放 PPT, PPTX, PDF, DOC 等演示文档\r\n\r\n"
                + "6. 【网页_流码】文件夹：\r\n"
                + "   - 存放包含外部网页网址 (如 http://...) 或 RTSP / RTMP / HLS 视频流地址的 .txt 文件\r\n"
                + "========================================================\r\n";

        // ===== 路径 A：尝试在物理 U 盘根目录下创建 =====
        File suCaiDir = new File(usbRoot, "素材");
        boolean rootSuCaiOk = robustMkdirWithSu(suCaiDir);
        if (rootSuCaiOk) {
            countCreated++;
            createdFolders.put("素材");
        } else {
            errors.put("根目录创建 [素材] 受限(非Root系统沙盒保护)，路径: " + suCaiDir.getAbsolutePath());
        }

        for (String sub : subFolders) {
            File subDir = new File(suCaiDir, sub);
            if (robustMkdirWithSu(subDir)) {
                countCreated++;
                createdFolders.put("素材/" + sub);
            }
            File rootSub = new File(usbRoot, sub);
            if (robustMkdirWithSu(rootSub)) {
                createdFolders.put(sub);
            }
        }

        File readmeFile = new File(suCaiDir, "【VisualCast_U盘素材使用规范】.txt");
        if (!readmeFile.exists()) {
            robustWriteFileWithSu(readmeFile, content);
        }

        // ===== 路径 B：官方外置专属合法目录保底穿透 (100% 免疫系统沙盒与非Root限制) =====
        if (context != null) {
            try {
                File[] extDirs = context.getExternalFilesDirs(null);
                if (extDirs != null) {
                    for (File ef : extDirs) {
                        if (ef == null) continue;
                        String efPath = ef.getAbsolutePath();
                        // 确保该目录是位于当前物理 U 盘卷上
                        if (efPath.startsWith(usbRoot.getAbsolutePath()) || (usbRoot.getName().length() > 3 && efPath.contains(usbRoot.getName()))) {
                            File appSuCaiDir = new File(ef, "素材");
                            if (appSuCaiDir.mkdirs() || appSuCaiDir.isDirectory()) {
                                countCreated++;
                                createdFolders.put("App私有合法卷/素材");
                                for (String sub : subFolders) {
                                    File appSub = new File(appSuCaiDir, sub);
                                    if (appSub.mkdirs() || appSub.isDirectory()) {
                                        countCreated++;
                                        createdFolders.put("App私有合法卷/素材/" + sub);
                                    }
                                }
                                File appReadme = new File(appSuCaiDir, "【VisualCast_U盘素材使用规范】.txt");
                                if (!appReadme.exists()) {
                                    try (FileOutputStream fos = new FileOutputStream(appReadme)) {
                                        fos.write(content.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                                    } catch (Exception ignored) {}
                                }
                            }

                            // 尝试在根目录做软链接 (若 Root 支持)
                            if (!rootSuCaiOk) {
                                executeRootCommand("ln -s \"" + appSuCaiDir.getAbsolutePath() + "\" \"" + suCaiDir.getAbsolutePath() + "\"");
                            }
                        }
                    }
                }
            } catch (Exception ex) {
                logs.add("处理应用专属外置目录异常: " + ex.getMessage());
            }
        }

        // 测试物理可写性
        boolean writable = testDirectoryWritable(suCaiDir.exists() ? suCaiDir : usbRoot);
        try {
            vReport.put("is_writable", writable);
            vReport.put("folders_created_list", createdFolders);
            vReport.put("errors", errors);
        } catch (Exception ignored) {}

        logs.add("卷 [" + usbRoot.getAbsolutePath() + "] 写入测试: " + (writable ? "成功(可写)" : "受限") + "，建立目录数: " + countCreated);
        return countCreated;
    }

    /**
     * 测试目录物理可写性
     */
    private static boolean testDirectoryWritable(File dir) {
        if (dir == null || !dir.exists()) return false;
        File testF = new File(dir, ".vc_probe_test_" + System.currentTimeMillis());
        try {
            if (testF.createNewFile()) {
                testF.delete();
                return true;
            }
        } catch (Exception ignored) {}

        // 尝试通过 su 写入测试
        if (checkHasRoot()) {
            String cmd = "touch \"" + testF.getAbsolutePath() + "\" && rm -f \"" + testF.getAbsolutePath() + "\"";
            return executeRootCommand(cmd);
        }
        return false;
    }

    public static boolean waitForProcessWithTimeout(final Process p, long timeoutMs) {
        if (p == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
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
            try {
                p.destroy();
            } catch (Exception ignored) {}
            return false;
        }
        return true;
    }

    public static boolean checkHasRoot() {
        return SystemHelper.isDeviceRooted();
    }

    public static boolean executeRootCommand(String command) {
        return SystemHelper.execRootCmd(command);
    }


    /**
     * 硬件级纯物理外设检测：检查 USB 总线上是否真实挂接了大容量存储设备 (Class 0x08)
     */
    public static boolean hasPhysicalUsbMassStorage(Context context) {
        if (context == null) return false;
        try {
            UsbManager um = (UsbManager) context.getSystemService(Context.USB_SERVICE);
            if (um != null) {
                Map<String, UsbDevice> list = um.getDeviceList();
                if (list != null && !list.isEmpty()) {
                    for (UsbDevice dev : list.values()) {
                        if (dev == null) continue;
                        if (dev.getDeviceClass() == UsbConstants.USB_CLASS_MASS_STORAGE) {
                            return true;
                        }
                        for (int i = 0; i < dev.getInterfaceCount(); i++) {
                            UsbInterface iface = dev.getInterface(i);
                            if (iface != null && iface.getInterfaceClass() == UsbConstants.USB_CLASS_MASS_STORAGE) {
                                return true;
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    /**
     * 强力健壮的纯 Java 极速安全目录创建引擎 (零子进程 fork，杜绝 I/O 死锁与整机卡死)
     */
    public static boolean robustMkdirWithSu(File dir) {
        if (dir == null) return false;
        if (dir.exists() && dir.isDirectory()) return true;
        try {
            if (dir.mkdirs() || dir.mkdir()) return true;
        } catch (Exception ignored) {}
        return dir.exists();
    }

    public static boolean robustWriteFileWithSu(File file, String content) {
        if (file == null) return false;
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(content.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            fos.flush();
            return true;
        } catch (Exception ignored) {}
        return file.exists();
    }

    private static void tryRemountRw(File mountDir) {
        // 纯净模式：不再调用可能引起商显主板死锁的 su remount
    }

    public static boolean isSystemOrVirtualPath(String path) {
        if (path == null) return true;
        String p = path.trim().toLowerCase(Locale.ROOT);
        if (p.equals("/") || p.isEmpty()) return true;
        if (p.startsWith("/system") || p.startsWith("/vendor") || p.startsWith("/data") ||
            p.startsWith("/cache") || p.startsWith("/apex") || p.startsWith("/dev") ||
            p.startsWith("/proc") || p.startsWith("/sys") || p.startsWith("/etc") ||
            p.startsWith("/product") || p.startsWith("/odm") || p.startsWith("/acct") ||
            p.startsWith("/config") || p.startsWith("/metadata") || p.startsWith("/oem") ||
            p.startsWith("/bin") || p.startsWith("/xbin")) {
            return true;
        }
        if (p.contains("emulated") || p.contains("self")) return true;
        if (p.contains("/mnt/runtime") || p.contains("/mnt/user") || p.contains("/mnt/asec") ||
            p.contains("/mnt/obb") || p.contains("/mnt/secure") || p.contains("/mnt/expand") ||
            p.equals("/mnt/sdcard") || p.equals("/sdcard")) {
            return true;
        }
        return false;
    }

    /**
     * 严格鉴别真实外接 U 盘卷：排除系统虚拟卷、内部存储与空占位目录
     */
    public static boolean isValidUsbVolume(File f, Context context) {
        if (f == null) return false;
        try {
            if (!f.exists() || !f.isDirectory()) return false;
            String path = f.getAbsolutePath();

            // 1. 过滤系统保留路径与虚拟路径
            if (isSystemOrVirtualPath(path)) return false;

            // 2. 排除内部主存储 (如 /storage/emulated/0 或 /sdcard)
            try {
                File internalRoot = Environment.getExternalStorageDirectory();
                if (internalRoot != null) {
                    String internalPath = internalRoot.getAbsolutePath();
                    if (path.equalsIgnoreCase(internalPath) || path.startsWith(internalPath + "/")) {
                        return false;
                    }
                }
            } catch (Exception ignored) {}

            // 3. 排除系统常见的挂载点母目录自身 (例如 /mnt/usbhost, /mnt/usb 等自身)
            String pLower = path.toLowerCase(Locale.ROOT);
            if (pLower.equals("/storage") || pLower.equals("/mnt") ||
                pLower.equals("/mnt/usbhost") || pLower.equals("/mnt/usb") ||
                pLower.equals("/mnt/udisk") || pLower.equals("/mnt/media_rw") ||
                pLower.equals("/udisk") || pLower.equals("/storage/emulated")) {
                return false;
            }

            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 工业级全方位发现 Android 设备真实物理 U 盘/OTG 挂载路径
     * 汇聚 StorageManager / getExternalFilesDirs / /proc/mounts / 商显目录树
     * 优先硬件级校验物理设备，未插U盘时 0 毫秒极速退出
     */
    public static Set<File> getUsbVolumes(Context context) {
        Set<File> volumes = new LinkedHashSet<>();
        List<File> lostDirVolumes = new ArrayList<>();

        // 通道 1: Android 官方 StorageManager 权威发现 (最准确无误，识别真正已挂载可移动存储卷)
        if (context != null) {
            try {
                StorageManager sm = (StorageManager) context.getSystemService(Context.STORAGE_SERVICE);
                if (sm != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        List<StorageVolume> storageVolumes = sm.getStorageVolumes();
                        for (StorageVolume sv : storageVolumes) {
                            boolean isMounted = Environment.MEDIA_MOUNTED.equalsIgnoreCase(sv.getState());
                            if (isMounted && (sv.isRemovable() || !sv.isPrimary())) {
                                try {
                                    Method getPathMethod = sv.getClass().getMethod("getPath");
                                    String path = (String) getPathMethod.invoke(sv);
                                    checkAndAddCandidate(path, volumes, lostDirVolumes, context);
                                } catch (Exception ignored) {}
                            }
                        }
                    } else {
                        Method getVolumeList = sm.getClass().getMethod("getVolumeList");
                        Object[] vols = (Object[]) getVolumeList.invoke(sm);
                        if (vols != null) {
                            for (Object vol : vols) {
                                try {
                                    Method isPrimary = vol.getClass().getMethod("isPrimary");
                                    Boolean prim = (Boolean) isPrimary.invoke(vol);
                                    Method isRemovable = vol.getClass().getMethod("isRemovable");
                                    Boolean rem = (Boolean) isRemovable.invoke(vol);
                                    Method getState = vol.getClass().getMethod("getState");
                                    String state = (String) getState.invoke(vol);
                                    if ((Boolean.TRUE.equals(rem) || Boolean.FALSE.equals(prim)) && Environment.MEDIA_MOUNTED.equalsIgnoreCase(state)) {
                                        Method getPath = vol.getClass().getMethod("getPath");
                                        String p = (String) getPath.invoke(vol);
                                        checkAndAddCandidate(p, volumes, lostDirVolumes, context);
                                    }
                                } catch (Exception ignored) {}
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        // 通道 2: context.getExternalFilesDirs 权威外置回溯
        if (context != null) {
            try {
                File[] extDirs = context.getExternalFilesDirs(null);
                if (extDirs != null) {
                    for (File ef : extDirs) {
                        if (ef == null) continue;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            try {
                                if (Environment.isExternalStorageRemovable(ef)) {
                                    File cur = ef;
                                    while (cur != null && cur.getParentFile() != null) {
                                        if ("Android".equalsIgnoreCase(cur.getName())) {
                                            File root = cur.getParentFile();
                                            if (root != null) checkAndAddCandidate(root.getAbsolutePath(), volumes, lostDirVolumes, context);
                                            break;
                                        }
                                        cur = cur.getParentFile();
                                    }
                                }
                            } catch (Exception ignored) {}
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        // 通道 3: 解析 /proc/mounts 静态内核表 (严格匹配大容量存储文件系统)
        try (BufferedReader br = new BufferedReader(new FileReader("/proc/mounts"))) {
            String line;
            Set<String> validFs = new HashSet<>(Arrays.asList("vfat", "exfat", "ntfs", "fuse", "sdcardfs", "ext4", "ext3", "ext2", "iso9660", "udf", "msdos", "texfat"));
            while ((line = br.readLine()) != null) {
                String[] parts = line.split("\\s+");
                if (parts.length >= 3) {
                    String mp = parts[1];
                    String fs = parts[2].toLowerCase(Locale.ROOT);
                    if (validFs.contains(fs)) {
                        checkAndAddCandidate(mp, volumes, lostDirVolumes, context);
                    }
                }
            }
        } catch (Exception ignored) {}

        // 通道 4: 常见商显盒子供选目录探测 (严格校验 isValidUsbVolume)
        String[] fallbackRoots = {
            "/storage", "/mnt", "/mnt/usb_storage", "/mnt/usbhost", "/mnt/usb", "/mnt/udisk",
            "/mnt/media_rw", "/udisk", "/mnt/sda", "/mnt/sda1", "/mnt/sdb", "/mnt/sdb1"
        };
        for (String r : fallbackRoots) {
            File rDir = new File(r);
            if (!rDir.exists() || !rDir.isDirectory()) continue;
            File[] subs = rDir.listFiles();
            if (subs != null) {
                for (File s : subs) {
                    if (s.isDirectory() && !"emulated".equalsIgnoreCase(s.getName()) && !"self".equalsIgnoreCase(s.getName())) {
                        checkAndAddCandidate(s.getAbsolutePath(), volumes, lostDirVolumes, context);
                    }
                }
            }
        }

        // 优先将带有 LOST.DIR 的真实物理外置卷排在最前！
        Set<File> finalSet = new LinkedHashSet<>();
        finalSet.addAll(lostDirVolumes);
        finalSet.addAll(volumes);
        return finalSet;
    }

    private static void checkAndAddCandidate(String mp, Set<File> volumes, List<File> lostDirVolumes, Context context) {
        if (mp == null || mp.trim().isEmpty()) return;
        mp = mp.trim();
        if (isSystemOrVirtualPath(mp)) return;

        File f = new File(mp);
        if (!isValidUsbVolume(f, context)) return;

        if (new File(f, "LOST.DIR").exists()) {
            lostDirVolumes.add(f);
        } else {
            volumes.add(f);
        }

        // 自动双向映射 (/mnt/media_rw/XXXX <-> /storage/XXXX)
        if (mp.startsWith("/mnt/media_rw/")) {
            String sub = mp.substring("/mnt/media_rw/".length());
            File mFile = new File("/storage", sub);
            if (isValidUsbVolume(mFile, context)) {
                if (new File(mFile, "LOST.DIR").exists()) lostDirVolumes.add(mFile);
                else volumes.add(mFile);
            }
        } else if (mp.startsWith("/storage/")) {
            String sub = mp.substring("/storage/".length());
            File rwFile = new File("/mnt/media_rw", sub);
            if (isValidUsbVolume(rwFile, context)) {
                volumes.add(rwFile);
            }
        }
    }

    public static long calculateVolumesFingerprint(Set<File> volumes) {
        if (volumes == null || volumes.isEmpty()) return 0;
        long fp = 0;
        for (File v : volumes) {
            if (v == null || !v.exists()) continue;
            fp += v.lastModified();
            File[] subs = v.listFiles();
            if (subs != null) {
                for (File sf : subs) {
                    fp += sf.lastModified() + sf.length();
                }
            }
        }
        return fp;
    }

    private static class DiscoveredMediaStructure {
        List<File> standbyDirs = new ArrayList<>();
        Map<String, List<File>> categoryDirs = new LinkedHashMap<>();
        List<File> looseMediaFiles = new ArrayList<>();
    }

    private static void scanDirectoryDeep(Context context, File dir, int currentDepth, int maxDepth, DiscoveredMediaStructure res,
                                          String[] standbyKw, String[] musicKw, String[] imageKw,
                                          String[] videoKw, String[] docKw, String[] webKw, String[] streamKw) {
        if (dir == null || currentDepth > maxDepth) return;
        File[] files = listFilesRobust(dir);
        if (files == null || files.length == 0) return;

        for (File f : files) {
            String name = f.getName().trim();
            if (name.startsWith(".") || "lost.dir".equalsIgnoreCase(name) || "System Volume Information".equalsIgnoreCase(name)) {
                continue;
            }

            // 特别处理 Android 目录：若是系统无关目录则跳过，但若为当前 App 专属目录则允许深入扫描
            if ("Android".equalsIgnoreCase(name)) {
                if (currentDepth == 0 && context != null) {
                    try {
                        File[] extDirs = context.getExternalFilesDirs(null);
                        if (extDirs != null) {
                            for (File ef : extDirs) {
                                if (ef != null && ef.exists()) {
                                    File appSuCai = new File(ef, "素材");
                                    if (appSuCai.exists() && appSuCai.isDirectory()) {
                                        scanDirectoryDeep(context, appSuCai, currentDepth + 1, maxDepth, res,
                                                standbyKw, musicKw, imageKw, videoKw, docKw, webKw, streamKw);
                                    }
                                }
                            }
                        }
                    } catch (Exception ignored) {}
                }
                continue;
            }

            if (f.isDirectory()) {
                String lower = name.toLowerCase(Locale.ROOT);
                if (matchesAnyKeyword(lower, standbyKw)) {
                    res.standbyDirs.add(f);
                } else if (matchesAnyKeyword(lower, musicKw)) {
                    addCatDir(res, "音乐", f);
                } else if (matchesAnyKeyword(lower, imageKw)) {
                    addCatDir(res, "图片", f);
                } else if (matchesAnyKeyword(lower, videoKw)) {
                    addCatDir(res, "视频", f);
                } else if (matchesAnyKeyword(lower, docKw)) {
                    addCatDir(res, "文档", f);
                } else if (matchesAnyKeyword(lower, webKw) || matchesAnyKeyword(lower, streamKw)) {
                    addCatDir(res, "网页_流码", f);
                } else {
                    scanDirectoryDeep(context, f, currentDepth + 1, maxDepth, res, standbyKw, musicKw, imageKw, videoKw, docKw, webKw, streamKw);
                }
            } else if (f.isFile() && isMediaFile(name) && f.length() > 0) {
                res.looseMediaFiles.add(f);
            }
        }
    }

    private static boolean matchesAnyKeyword(String str, String[] keywords) {
        String clean = str.replace(" ", "").replace("_", "").replace("-", "");
        for (String kw : keywords) {
            String kwClean = kw.toLowerCase(Locale.ROOT).replace(" ", "").replace("_", "").replace("-", "");
            if (clean.equals(kwClean) || clean.contains(kwClean)) return true;
        }
        return false;
    }

    private static void addCatDir(DiscoveredMediaStructure res, String cat, File dir) {
        if (!res.categoryDirs.containsKey(cat)) {
            res.categoryDirs.put(cat, new ArrayList<>());
        }
        res.categoryDirs.get(cat).add(dir);
    }

    private static String getCategoryByFilename(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.contains("待机") || lower.contains("standby") || lower.contains("idle")) return "待机";
        if (lower.endsWith(".mp4") || lower.endsWith(".mkv") || lower.endsWith(".mov") ||
            lower.endsWith(".avi") || lower.endsWith(".flv") || lower.endsWith(".webm") || lower.endsWith(".ts")) return "视频";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") ||
            lower.endsWith(".webp") || lower.endsWith(".bmp") || lower.endsWith(".gif")) return "图片";
        if (lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav") ||
            lower.endsWith(".aac") || lower.endsWith(".ogg") || lower.endsWith(".wma") || lower.endsWith(".m4a")) return "音乐";
        if (lower.endsWith(".ppt") || lower.endsWith(".pptx") || lower.endsWith(".pps") ||
            lower.endsWith(".ppsx") || lower.endsWith(".pdf") || lower.endsWith(".doc") ||
            lower.endsWith(".docx") || lower.endsWith(".wps") || lower.endsWith(".dps") ||
            lower.endsWith(".et") || lower.endsWith(".xls") || lower.endsWith(".xlsx")) return "文档";
        if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".m3u8") || lower.endsWith(".txt") || lower.endsWith(".url")) return "网页_流码";
        return "待机";
    }

    private static boolean isMediaFile(String name) {
        if (name == null) return false;
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".txt") || n.endsWith(".url")) {
            if (n.contains("说明") || n.contains("readme") || n.contains("规范") || n.contains("info")) {
                return false;
            }
        }
        return n.endsWith(".mp4") || n.endsWith(".mkv") || n.endsWith(".mov") ||
               n.endsWith(".avi") || n.endsWith(".flv") || n.endsWith(".webm") || n.endsWith(".ts") ||
               n.endsWith(".m4v") || n.endsWith(".3gp") || n.endsWith(".wmv") || n.endsWith(".rmvb") ||
               n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") ||
               n.endsWith(".webp") || n.endsWith(".bmp") || n.endsWith(".gif") || n.endsWith(".svg") ||
               n.endsWith(".mp3") || n.endsWith(".flac") || n.endsWith(".wav") ||
               n.endsWith(".aac") || n.endsWith(".ogg") || n.endsWith(".m4a") || n.endsWith(".wma") ||
               n.endsWith(".ppt") || n.endsWith(".pptx") || n.endsWith(".pps") ||
               n.endsWith(".ppsx") || n.endsWith(".pdf") || n.endsWith(".doc") ||
               n.endsWith(".docx") || n.endsWith(".wps") || n.endsWith(".txt") ||
               n.endsWith(".html") || n.endsWith(".htm") || n.endsWith(".m3u8");
    }

    public static File[] listFilesRobust(File dir) {
        if (dir == null || !dir.exists()) return new File[0];
        try {
            File[] fl = dir.listFiles();
            if (fl != null) return fl;
        } catch (Exception ignored) {}
        return new File[0];
    }

    private static int copyMediaRecursive(Context context, File srcDir, File destDir) {
        int count = 0;
        File[] files = listFilesRobust(srcDir);
        if (files == null) return 0;

        for (File f : files) {
            String dirName = f.getName();
            if (dirName.startsWith(".") || "Android".equalsIgnoreCase(dirName) ||
                "lost.dir".equalsIgnoreCase(dirName) || "System Volume Information".equalsIgnoreCase(dirName)) {
                continue;
            }

            if (f.isDirectory()) {
                File subDest = new File(destDir, dirName);
                if (!subDest.exists()) subDest.mkdirs();
                count += copyMediaRecursive(context, f, subDest);
            } else {
                if (isMediaFile(f.getName()) && (f.length() > 0 || !f.exists())) {
                    if (!destDir.exists()) destDir.mkdirs();
                    File target = new File(destDir, f.getName());
                    if (!target.exists() || target.length() != f.length() || target.length() == 0) {
                        if (copyFile(f, target)) {
                            count++;
                        }
                    }
                }
            }
        }
        return count;
    }

    private static void collectMediaFilesRecursive(File dir, List<File> result, int depth) {
        if (dir == null || !dir.exists() || depth > 5) return;
        File[] files = listFilesRobust(dir);
        if (files == null) return;
        for (File f : files) {
            String name = f.getName().trim();
            if (name.startsWith(".") || "lost.dir".equalsIgnoreCase(name) || "System Volume Information".equalsIgnoreCase(name)) continue;
            if (f.isDirectory()) {
                collectMediaFilesRecursive(f, result, depth + 1);
            } else if (f.isFile() && isMediaFile(name) && f.length() > 0) {
                result.add(f);
            }
        }
    }

    private static void cleanDirectory(File dir) {
        if (dir == null || !dir.exists() || !dir.isDirectory()) return;
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) cleanDirectory(child);
                child.delete();
            }
        }
    }

    private static boolean copyFile(File src, File dest) {
        if (src == null || dest == null) return false;
        File parent = dest.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();

        File tmpFile = new File(dest.getParentFile(), dest.getName() + ".vc_tmp_" + System.currentTimeMillis());
        try {
            // 通道 1: 纯 Java 流式原子拷贝 (写入临时文件，成功后瞬间原子重命名，绝不产生残缺损坏文件)
            try (FileInputStream in = new FileInputStream(src);
                 FileOutputStream out = new FileOutputStream(tmpFile)) {
                byte[] buf = new byte[65536];
                int len;
                while ((len = in.read(buf)) > 0) {
                    out.write(buf, 0, len);
                }
                out.flush();
                try {
                    out.getFD().sync();
                } catch (Exception ignored) {}
            }

            if (tmpFile.exists() && tmpFile.length() == src.length() && tmpFile.length() > 0) {
                if (dest.exists()) dest.delete();
                if (tmpFile.renameTo(dest)) {
                    try { dest.setReadable(true, false); } catch (Exception ignored) {}
                    return true;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (tmpFile.exists()) {
                tmpFile.delete();
            }
        }

        // 通道 2: 普通 sh cp 兜底 (根据文件大小动态计算超时，杜绝大视频被强行腰斩)
        try {
            String srcPath = src.getAbsolutePath();
            String destPath = dest.getAbsolutePath();
            long waitMs = Math.max(60000L, (src.length() / (1024 * 1024)) * 3000L); // 至少60秒，大文件充足缓冲
            Process p = Runtime.getRuntime().exec(new String[]{"sh", "-c", "cp -f \"" + srcPath + "\" \"" + destPath + "\" && chmod 666 \"" + destPath + "\""});
            boolean ok = waitForProcessWithTimeout(p, waitMs);
            if (ok && dest.exists() && dest.length() == src.length() && dest.length() > 0) {
                return true;
            } else if (dest.exists() && dest.length() != src.length()) {
                dest.delete(); // 及时清除残缺损坏文件
            }
        } catch (Exception ignored) {}

        // 通道 3: Root 提权 cp 终极穿透
        try {
            String srcPath = src.getAbsolutePath();
            String destPath = dest.getAbsolutePath();
            executeRootCommand("cp -f \"" + srcPath + "\" \"" + destPath + "\" && chmod 666 \"" + destPath + "\"");
            if (dest.exists() && dest.length() == src.length() && dest.length() > 0) {
                return true;
            } else if (dest.exists() && dest.length() != src.length()) {
                dest.delete();
            }
        } catch (Exception ignored) {}

        return false;
    }
}
