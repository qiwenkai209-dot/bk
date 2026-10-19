package com.visualcast.player.server;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 极轻量原生 multipart/form-data 解析器
 * 支持在 Android 嵌入式 HTTP 服务中零依赖解析大屏素材上传
 * 全面支持流式磁盘文件解析，彻底消除 Dalvik 堆内存溢出 (OOM)
 */
public class MultipartParser {

    public static class ParseResult {
        public Map<String, String> fields = new HashMap<>();
        public String savedFilename;
        public String savedFilePath;
        public long savedFileSize = 0;
        public String error;
    }

    public static String extractBoundary(String contentType) {
        if (contentType == null) return null;
        for (String part : contentType.split(";")) {
            part = part.trim();
            if (part.toLowerCase().startsWith("boundary=")) {
                String boundary = part.substring(9).trim();
                if (boundary.startsWith("\"") && boundary.endsWith("\"") && boundary.length() >= 2) {
                    boundary = boundary.substring(1, boundary.length() - 1);
                }
                return boundary;
            }
        }
        return null;
    }

    /**
     * 工业级流式解析：直接从磁盘临时文件中解析并流式写入目标素材路径
     * 堆内存占用恒定 < 64KB，彻底杜绝大视频上传导致的 OOM 与连接重置
     */
    public static ParseResult parseAndSaveFromFile(File bodyFile, String contentType, File defaultTargetDir, File mediaRootDir) {
        ParseResult result = new ParseResult();
        if (bodyFile == null || !bodyFile.exists() || bodyFile.length() == 0 || contentType == null) {
            result.error = "临时上传文件不存在或为空";
            return result;
        }

        String boundary = extractBoundary(contentType);
        if (boundary == null || boundary.isEmpty()) {
            result.error = "无法从 Content-Type 提取 boundary";
            return result;
        }

        byte[] boundaryBytes = ("--" + boundary).getBytes(StandardCharsets.US_ASCII);
        byte[] headerEndMarker = "\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
        long fileLen = bodyFile.length();

        try (RandomAccessFile raf = new RandomAccessFile(bodyFile, "r")) {
            // 1. 第一遍扫描：提取文本字段 (例如 folder, original_filename)
            String targetFolder = "";
            long pos = 0;
            while (pos < fileLen) {
                long boundaryStart = findOffsetInFile(raf, boundaryBytes, pos, fileLen);
                if (boundaryStart < 0) break;
                long partStart = boundaryStart + boundaryBytes.length;
                if (partStart >= fileLen) break;

                raf.seek(partStart);
                int b1 = raf.read();
                int b2 = raf.read();
                if (b1 == '-' && b2 == '-') break; // 整个 multipart 结束标志
                if (b1 == '\r' && b2 == '\n') {
                    partStart += 2;
                }

                long nextBoundary = findOffsetInFile(raf, boundaryBytes, partStart, fileLen);
                long partEnd = (nextBoundary >= 0) ? nextBoundary : fileLen;
                if (partEnd >= 2) {
                    raf.seek(partEnd - 2);
                    if (raf.read() == '\r' && raf.read() == '\n') {
                        partEnd -= 2;
                    }
                }

                long headerEnd = findOffsetInFile(raf, headerEndMarker, partStart, partEnd);
                if (headerEnd >= 0 && headerEnd < partEnd) {
                    int headerLen = (int) (headerEnd - partStart);
                    byte[] headerBuf = new byte[headerLen];
                    raf.seek(partStart);
                    raf.readFully(headerBuf);
                    String headersStr = new String(headerBuf, StandardCharsets.UTF_8);

                    long contentStart = headerEnd + 4;
                    long contentLen = partEnd - contentStart;

                    String disposition = "";
                    for (String hLine : headersStr.split("\r\n")) {
                        if (hLine.toLowerCase().startsWith("content-disposition:")) {
                            disposition = hLine;
                            break;
                        }
                    }

                    String name = extractParam(disposition, "name");
                    String filename = extractParam(disposition, "filename");

                    if ((filename == null || filename.isEmpty()) && name != null && !name.isEmpty() && contentLen < 1024 * 1024) {
                        byte[] valBuf = new byte[(int) Math.max(0, contentLen)];
                        raf.seek(contentStart);
                        raf.readFully(valBuf);
                        String val = new String(valBuf, StandardCharsets.UTF_8).trim();
                        result.fields.put(name, val);
                        if ("folder".equalsIgnoreCase(name)) {
                            targetFolder = val;
                        }
                    }
                }
                pos = (nextBoundary >= 0) ? nextBoundary : fileLen;
            }

            File effectiveTargetDir = defaultTargetDir;
            if (!targetFolder.isEmpty() && !"ALL".equalsIgnoreCase(targetFolder)) {
                effectiveTargetDir = new File(mediaRootDir, targetFolder);
            }
            if (!effectiveTargetDir.exists()) {
                effectiveTargetDir.mkdirs();
            }

            // 2. 第二遍扫描：定位文件并在流式状态下直接写入目标素材文件
            pos = 0;
            while (pos < fileLen) {
                long boundaryStart = findOffsetInFile(raf, boundaryBytes, pos, fileLen);
                if (boundaryStart < 0) break;
                long partStart = boundaryStart + boundaryBytes.length;
                if (partStart >= fileLen) break;

                raf.seek(partStart);
                int b1 = raf.read();
                int b2 = raf.read();
                if (b1 == '-' && b2 == '-') break;
                if (b1 == '\r' && b2 == '\n') {
                    partStart += 2;
                }

                long nextBoundary = findOffsetInFile(raf, boundaryBytes, partStart, fileLen);
                long partEnd = (nextBoundary >= 0) ? nextBoundary : fileLen;
                if (partEnd >= 2) {
                    raf.seek(partEnd - 2);
                    if (raf.read() == '\r' && raf.read() == '\n') {
                        partEnd -= 2;
                    }
                }

                long headerEnd = findOffsetInFile(raf, headerEndMarker, partStart, partEnd);
                if (headerEnd >= 0 && headerEnd < partEnd) {
                    int headerLen = (int) (headerEnd - partStart);
                    byte[] headerBuf = new byte[headerLen];
                    raf.seek(partStart);
                    raf.readFully(headerBuf);
                    String headersStr = new String(headerBuf, StandardCharsets.UTF_8);

                    long contentStart = headerEnd + 4;
                    long contentLen = partEnd - contentStart;

                    String disposition = "";
                    for (String hLine : headersStr.split("\r\n")) {
                        if (hLine.toLowerCase().startsWith("content-disposition:")) {
                            disposition = hLine;
                            break;
                        }
                    }

                    String partFilename = extractParam(disposition, "filename");
                    String partName = extractParam(disposition, "name");
                    boolean isFilePart = (partFilename != null && !partFilename.trim().isEmpty())
                            || "file".equalsIgnoreCase(partName)
                            || "upload".equalsIgnoreCase(partName)
                            || "media".equalsIgnoreCase(partName);

                    if (isFilePart && contentLen > 0) {
                        String targetName = partFilename;
                        if (result.fields.containsKey("original_filename") && !result.fields.get("original_filename").trim().isEmpty()) {
                            targetName = result.fields.get("original_filename").trim();
                        }
                        if (targetName == null || targetName.trim().isEmpty()) {
                            targetName = "unnamed_media";
                        }
                        try {
                            targetName = java.net.URLDecoder.decode(targetName, "UTF-8");
                        } catch (Exception ignored) {}
                        targetName = new File(targetName).getName().trim();
                        if (targetName.isEmpty()) targetName = "unnamed_media";

                        File dest = new File(effectiveTargetDir, targetName);
                        boolean saved = false;
                        Exception lastEx = null;

                        try {
                            if (dest.getParentFile() != null && !dest.getParentFile().exists()) {
                                dest.getParentFile().mkdirs();
                            }
                            copyRafToFile(raf, contentStart, contentLen, dest);
                            saved = true;
                        } catch (Exception ex) {
                            lastEx = ex;
                            // 降级尝试：写入 defaultTargetDir
                            try {
                                dest = new File(defaultTargetDir, targetName);
                                if (dest.getParentFile() != null && !dest.getParentFile().exists()) {
                                    dest.getParentFile().mkdirs();
                                }
                                copyRafToFile(raf, contentStart, contentLen, dest);
                                saved = true;
                            } catch (Exception ex2) {
                                lastEx = ex2;
                            }
                        }

                        if (saved) {
                            String relPath = (targetFolder.isEmpty() || "ALL".equalsIgnoreCase(targetFolder)) ? targetName : (targetFolder + "/" + targetName);
                            result.savedFilename = relPath;
                            result.savedFilePath = dest.getAbsolutePath();
                            result.savedFileSize = contentLen;
                            break;
                        } else if (lastEx != null) {
                            result.error = "写入存储异常: " + lastEx.getMessage();
                        }
                    }
                }
                pos = (nextBoundary >= 0) ? nextBoundary : fileLen;
            }

        } catch (Exception e) {
            result.error = "流式解析异常: " + e.getMessage();
        }
        return result;
    }

    public static ParseResult parseAndSave(byte[] body, String contentType, File defaultTargetDir, File mediaRootDir) {
        ParseResult result = new ParseResult();
        try {
            if (body == null || body.length == 0 || contentType == null) {
                result.error = "请求体或 Content-Type 为空";
                return result;
            }

            String boundary = extractBoundary(contentType);
            if (boundary == null || boundary.isEmpty()) {
                result.error = "无法从 Content-Type 提取 boundary";
                return result;
            }

            byte[] boundaryBytes = ("--" + boundary).getBytes(StandardCharsets.US_ASCII);
            int bodyLen = body.length;

            // 预先扫描一遍文本字段 (获取 folder 参数)
            String targetFolder = "";
            int pos = 0;
            while (pos < bodyLen) {
                int boundaryStart = indexOf(body, boundaryBytes, pos);
                if (boundaryStart < 0) break;
                int partStart = boundaryStart + boundaryBytes.length;
                if (partStart >= bodyLen) break;
                if (partStart + 1 < bodyLen && body[partStart] == '-' && body[partStart + 1] == '-') {
                    break;
                }
                if (partStart + 1 < bodyLen && body[partStart] == '\r' && body[partStart + 1] == '\n') {
                    partStart += 2;
                }
                int nextBoundary = indexOf(body, boundaryBytes, partStart);
                int partEnd = (nextBoundary >= 0) ? nextBoundary : bodyLen;
                if (partEnd >= 2 && body[partEnd - 2] == '\r' && body[partEnd - 1] == '\n') {
                    partEnd -= 2;
                }

                byte[] headerEndMarker = "\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
                int headerEnd = indexOf(body, headerEndMarker, partStart);
                if (headerEnd >= 0 && headerEnd < partEnd) {
                    String headersStr = new String(body, partStart, headerEnd - partStart, StandardCharsets.UTF_8);
                    int contentStart = headerEnd + 4;
                    int contentLen = partEnd - contentStart;

                    String disposition = "";
                    for (String hLine : headersStr.split("\r\n")) {
                        if (hLine.toLowerCase().startsWith("content-disposition:")) {
                            disposition = hLine;
                            break;
                        }
                    }

                    String name = extractParam(disposition, "name");
                    String filename = extractParam(disposition, "filename");

                    if ((filename == null || filename.isEmpty()) && name != null && !name.isEmpty()) {
                        String val = new String(body, contentStart, Math.max(0, contentLen), StandardCharsets.UTF_8).trim();
                        result.fields.put(name, val);
                        if ("folder".equalsIgnoreCase(name)) {
                            targetFolder = val;
                        }
                    }
                }
                pos = (nextBoundary >= 0) ? nextBoundary : bodyLen;
            }

            // 计算实际写入的目标文件夹
            File effectiveTargetDir = defaultTargetDir;
            if (!targetFolder.isEmpty() && !"ALL".equalsIgnoreCase(targetFolder)) {
                effectiveTargetDir = new File(mediaRootDir, targetFolder);
            }
            if (!effectiveTargetDir.exists()) {
                effectiveTargetDir.mkdirs();
            }

            // 第二遍扫描写入文件
            pos = 0;
            while (pos < bodyLen) {
                int boundaryStart = indexOf(body, boundaryBytes, pos);
                if (boundaryStart < 0) break;
                int partStart = boundaryStart + boundaryBytes.length;
                if (partStart >= bodyLen) break;
                if (partStart + 1 < bodyLen && body[partStart] == '-' && body[partStart + 1] == '-') {
                    break;
                }
                if (partStart + 1 < bodyLen && body[partStart] == '\r' && body[partStart + 1] == '\n') {
                    partStart += 2;
                }
                int nextBoundary = indexOf(body, boundaryBytes, partStart);
                int partEnd = (nextBoundary >= 0) ? nextBoundary : bodyLen;
                if (partEnd >= 2 && body[partEnd - 2] == '\r' && body[partEnd - 1] == '\n') {
                    partEnd -= 2;
                }

                byte[] headerEndMarker = "\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
                int headerEnd = indexOf(body, headerEndMarker, partStart);
                if (headerEnd >= 0 && headerEnd < partEnd) {
                    String headersStr = new String(body, partStart, headerEnd - partStart, StandardCharsets.UTF_8);
                    int contentStart = headerEnd + 4;
                    int contentLen = partEnd - contentStart;

                    String disposition = "";
                    for (String hLine : headersStr.split("\r\n")) {
                        if (hLine.toLowerCase().startsWith("content-disposition:")) {
                            disposition = hLine;
                            break;
                        }
                    }

                    String partFilename = extractParam(disposition, "filename");
                    String partName = extractParam(disposition, "name");
                    boolean isFilePart = (partFilename != null && !partFilename.trim().isEmpty())
                            || "file".equalsIgnoreCase(partName)
                            || "upload".equalsIgnoreCase(partName)
                            || "media".equalsIgnoreCase(partName);

                    if (isFilePart && contentLen > 0) {
                        String targetName = partFilename;
                        if (result.fields.containsKey("original_filename") && !result.fields.get("original_filename").trim().isEmpty()) {
                            targetName = result.fields.get("original_filename").trim();
                        }
                        if (targetName == null || targetName.trim().isEmpty()) {
                            targetName = "unnamed_media";
                        }
                        try {
                            targetName = java.net.URLDecoder.decode(targetName, "UTF-8");
                        } catch (Exception ignored) {}
                        targetName = new File(targetName).getName().trim();
                        if (targetName.isEmpty()) targetName = "unnamed_media";

                        File dest = new File(effectiveTargetDir, targetName);
                        boolean saved = false;
                        Exception lastEx = null;

                        try {
                            if (dest.getParentFile() != null && !dest.getParentFile().exists()) {
                                dest.getParentFile().mkdirs();
                            }
                            try (FileOutputStream fos = new FileOutputStream(dest)) {
                                fos.write(body, contentStart, contentLen);
                                fos.flush();
                            }
                            saved = true;
                        } catch (Exception ex) {
                            lastEx = ex;
                            // 降级尝试：写入 defaultTargetDir (工作根目录 media/)
                            try {
                                dest = new File(defaultTargetDir, targetName);
                                if (dest.getParentFile() != null && !dest.getParentFile().exists()) {
                                    dest.getParentFile().mkdirs();
                                }
                                try (FileOutputStream fos = new FileOutputStream(dest)) {
                                    fos.write(body, contentStart, contentLen);
                                    fos.flush();
                                }
                                saved = true;
                            } catch (Exception ex2) {
                                lastEx = ex2;
                            }
                        }

                        if (saved) {
                            String relPath = (targetFolder.isEmpty() || "ALL".equalsIgnoreCase(targetFolder)) ? targetName : (targetFolder + "/" + targetName);
                            result.savedFilename = relPath;
                            result.savedFilePath = dest.getAbsolutePath();
                            result.savedFileSize = contentLen;
                            break;
                        } else if (lastEx != null) {
                            result.error = "写入存储异常: " + lastEx.getMessage();
                        }
                    }
                }
                pos = (nextBoundary >= 0) ? nextBoundary : bodyLen;
            }

        } catch (Exception e) {
            result.error = "解析失败: " + e.getMessage();
        }
        return result;
    }

    private static long findOffsetInFile(RandomAccessFile raf, byte[] target, long startOffset, long maxOffset) throws IOException {
        if (target == null || target.length == 0 || startOffset >= maxOffset) return -1;
        byte[] buf = new byte[65536];
        long curPos = startOffset;
        while (curPos < maxOffset) {
            raf.seek(curPos);
            int toRead = (int) Math.min(buf.length, maxOffset - curPos);
            int read = raf.read(buf, 0, toRead);
            if (read <= 0) break;

            int matchIdx = indexOf(buf, target, 0, read);
            if (matchIdx >= 0) {
                return curPos + matchIdx;
            }
            if (read == toRead && curPos + read < maxOffset) {
                curPos += (read - target.length + 1);
            } else {
                break;
            }
        }
        return -1;
    }

    private static void copyRafToFile(RandomAccessFile raf, long start, long length, File dest) throws IOException {
        raf.seek(start);
        try (FileOutputStream fos = new FileOutputStream(dest)) {
            byte[] buf = new byte[65536];
            long remaining = length;
            while (remaining > 0) {
                int toRead = (int) Math.min(buf.length, remaining);
                int r = raf.read(buf, 0, toRead);
                if (r < 0) break;
                fos.write(buf, 0, r);
                remaining -= r;
            }
            fos.flush();
        }
    }

    private static String extractParam(String disposition, String key) {
        if (disposition == null) return null;
        String pattern = key + "=\"";
        int idx = disposition.indexOf(pattern);
        if (idx >= 0) {
            int start = idx + pattern.length();
            int end = disposition.indexOf("\"", start);
            if (end > start) {
                return disposition.substring(start, end);
            }
        }
        String patternNoQuote = key + "=";
        idx = disposition.indexOf(patternNoQuote);
        if (idx >= 0) {
            int start = idx + patternNoQuote.length();
            int end = disposition.indexOf(";", start);
            if (end < 0) end = disposition.length();
            String val = disposition.substring(start, end).trim();
            if (val.startsWith("\"") && val.endsWith("\"") && val.length() >= 2) {
                val = val.substring(1, val.length() - 1);
            }
            return val;
        }
        return null;
    }

    private static int indexOf(byte[] source, byte[] target, int fromIndex) {
        return indexOf(source, target, fromIndex, source.length);
    }

    private static int indexOf(byte[] source, byte[] target, int fromIndex, int maxLen) {
        if (fromIndex >= maxLen || target.length == 0) return -1;
        int max = maxLen - target.length;
        for (int i = fromIndex; i <= max; i++) {
            boolean match = true;
            for (int j = 0; j < target.length; j++) {
                if (source[i + j] != target[j]) {
                    match = false;
                    break;
                }
            }
            if (match) return i;
        }
        return -1;
    }
}
