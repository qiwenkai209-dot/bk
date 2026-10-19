package com.visualcast.player.utils;

import android.content.Context;
import android.os.Environment;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public class StorageHelper {

    public static final Set<String> VIDEO_EXTS = new HashSet<>(Arrays.asList(".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".ts"));
    public static final Set<String> IMAGE_EXTS = new HashSet<>(Arrays.asList(".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"));
    public static final Set<String> AUDIO_EXTS = new HashSet<>(Arrays.asList(".mp3", ".wav", ".aac", ".flac", ".ogg"));
    public static final Set<String> DOC_EXTS = new HashSet<>(Arrays.asList(".pptx", ".ppt", ".pps", ".ppsx", ".pdf", ".doc", ".docx", ".wps", ".dps", ".et", ".xls", ".xlsx"));
    public static final Set<String> WEB_EXTS = new HashSet<>(Arrays.asList(".html", ".htm", ".m3u8"));
    public static final Set<String> SUB_EXTS = new HashSet<>(Arrays.asList(".srt", ".vtt"));

    /**
     * 获取 VisualCast 工作根目录 (优先 /sdcard/VisualCast/)
     */
    public static File getRootDir(Context context) {
        File dir;
        try {
            dir = new File(Environment.getExternalStorageDirectory(), "VisualCast");
            if (!dir.exists()) dir.mkdirs();
            if (dir.canWrite()) return dir;
        } catch (Exception ignored) {}
        
        // 兜底外部私有存储 (规避某些 Android 7 机型返回 null 导致 NPE)
        try {
            if (context != null) {
                File extDir = context.getExternalFilesDir(null);
                if (extDir != null) {
                    dir = new File(extDir, "VisualCast");
                    if (!dir.exists()) dir.mkdirs();
                    if (dir.canWrite()) return dir;
                }
            }
        } catch (Exception ignored) {}

        // 终极安全内部存储兜底 (100% 可写且永不为 null，无需任何运行时权限)
        try {
            if (context != null) {
                File intDir = context.getFilesDir();
                if (intDir != null) {
                    dir = new File(intDir, "VisualCast");
                    if (!dir.exists()) dir.mkdirs();
                    return dir;
                }
            }
        } catch (Exception ignored) {}

        dir = new File("/sdcard/VisualCast");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    public static File getMediaDir(Context context) {
        File dir = new File(getRootDir(context), "media");
        if (!dir.exists()) dir.mkdirs();
        // 自动初始化标准 6 大素材分类子目录
        String[] subDirs = {"待机", "音乐", "图片", "视频", "文档", "网页_流码"};
        for (String sub : subDirs) {
            File subFolder = new File(dir, sub);
            if (!subFolder.exists()) subFolder.mkdirs();
        }

        // 自动将历史旧分类目录 (PPT_PDF / 网页 / 流码) 迁移归并至标准分类
        try {
            File oldDoc = new File(dir, "PPT_PDF");
            File targetDoc = new File(dir, "文档");
            if (oldDoc.exists() && oldDoc.isDirectory()) {
                File[] fl = oldDoc.listFiles();
                if (fl != null) {
                    for (File f : fl) {
                        File dest = new File(targetDoc, f.getName());
                        if (!dest.exists()) f.renameTo(dest);
                        else f.delete();
                    }
                }
                oldDoc.delete();
            }

            File targetWebStream = new File(dir, "网页_流码");
            if (!targetWebStream.exists()) targetWebStream.mkdirs();
            String[] oldWebFolders = {"网页", "流码"};
            for (String oldName : oldWebFolders) {
                File oldF = new File(dir, oldName);
                if (oldF.exists() && oldF.isDirectory()) {
                    File[] fl = oldF.listFiles();
                    if (fl != null) {
                        for (File f : fl) {
                            File dest = new File(targetWebStream, f.getName());
                            if (!dest.exists()) f.renameTo(dest);
                            else f.delete();
                        }
                    }
                    oldF.delete();
                }
            }
        } catch (Exception ignored) {}

        return dir;
    }

    public static File getConfigDir(Context context) {
        File dir = new File(getRootDir(context), "config");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /**
     * 首次初始化：从 assets/config 释放默认配置到工作目录
     */
    public static void initDefaultConfigs(Context context) {
        File cfgDir = getConfigDir(context);
        String[] configs = {"player_config.json", "iot_config.json", "auth_config.json", "custom_media.json"};
        for (String cfg : configs) {
            File target = new File(cfgDir, cfg);
            if (!target.exists()) {
                copyAssetFile(context, "config/" + cfg, target);
            }
        }
    }

    public static boolean copyAssetFile(Context context, String assetPath, File destFile) {
        try (InputStream in = context.getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(destFile)) {
            byte[] buf = new byte[8192];
            int len;
            while ((len = in.read(buf)) > 0) {
                out.write(buf, 0, len);
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public static String getMediaType(String filename) {
        String lower = filename.toLowerCase();
        int dot = lower.lastIndexOf('.');
        if (dot < 0) return "other";
        String ext = lower.substring(dot);
        if (VIDEO_EXTS.contains(ext)) return "video";
        if (IMAGE_EXTS.contains(ext)) return "image";
        if (AUDIO_EXTS.contains(ext)) return "audio";
        if (DOC_EXTS.contains(ext)) return "doc";
        if (WEB_EXTS.contains(ext)) return "web";
        if (SUB_EXTS.contains(ext)) return "subtitle";
        if (ext.equals(".txt") || ext.equals(".url")) {
            if (!lower.contains("readme") && !lower.contains("说明") && !lower.contains("规范") && !lower.contains("info")) {
                return "web";
            }
        }
        return "other";
    }
}
