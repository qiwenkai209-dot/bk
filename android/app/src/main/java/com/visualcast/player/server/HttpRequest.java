package com.visualcast.player.server;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class HttpRequest {
    private String method = "GET";
    private String path = "/";
    private final Map<String, String> headers = new HashMap<>();
    private final Map<String, String> queryParams = new HashMap<>();
    private final Map<String, String> cookies = new HashMap<>();
    private byte[] body = new byte[0];
    private java.io.File bodyTempFile = null;

    public static HttpRequest parse(InputStream in) throws Exception {
        return parse(in, null, null);
    }

    public static HttpRequest parse(InputStream in, java.net.Socket socket) throws Exception {
        return parse(in, socket, null);
    }

    public static HttpRequest parse(InputStream in, java.net.Socket socket, android.content.Context context) throws Exception {
        HttpRequest req = new HttpRequest();
        ByteArrayOutputStream lineBuf = new ByteArrayOutputStream();
        int b;
        boolean firstLine = true;
        int contentLength = 0;
        String contentType = "";

        // 逐行解析 Header
        while ((b = in.read()) != -1) {
            if (b == '\n') {
                byte[] raw = lineBuf.toByteArray();
                lineBuf.reset();
                String line = new String(raw, StandardCharsets.UTF_8).trim();
                if (line.isEmpty()) {
                    // Header 结束
                    break;
                }
                if (firstLine) {
                    firstLine = false;
                    String[] parts = line.split("\\s+");
                    if (parts.length >= 2) {
                        req.method = parts[0].toUpperCase();
                        String rawUri = parts[1];
                        int qIdx = rawUri.indexOf('?');
                        if (qIdx >= 0) {
                            req.path = URLDecoder.decode(rawUri.substring(0, qIdx), "UTF-8");
                            String qs = rawUri.substring(qIdx + 1);
                            for (String param : qs.split("&")) {
                                int eq = param.indexOf('=');
                                if (eq > 0) {
                                    String k = URLDecoder.decode(param.substring(0, eq), "UTF-8");
                                    String v = URLDecoder.decode(param.substring(eq + 1), "UTF-8");
                                    req.queryParams.put(k, v);
                                }
                            }
                        } else {
                            req.path = URLDecoder.decode(rawUri, "UTF-8");
                        }
                    }
                } else {
                    int colon = line.indexOf(':');
                    if (colon > 0) {
                        String k = line.substring(0, colon).trim().toLowerCase();
                        String v = line.substring(colon + 1).trim();
                        req.headers.put(k, v);
                        if ("content-length".equals(k)) {
                            try { contentLength = Integer.parseInt(v); } catch (Exception ignored) {}
                        } else if ("content-type".equals(k)) {
                            contentType = v.toLowerCase();
                        } else if ("cookie".equals(k)) {
                            for (String c : v.split(";")) {
                                int eq = c.indexOf('=');
                                if (eq > 0) {
                                    req.cookies.put(c.substring(0, eq).trim(), c.substring(eq + 1).trim());
                                }
                            }
                        }
                    }
                }
            } else if (b != '\r') {
                lineBuf.write(b);
            }
        }

        // 大文件或上传请求时延长 Socket 超时至 300 秒 (5分钟)，杜绝慢速网络与大文件上传中断
        boolean isMultipart = contentType.contains("multipart/form-data");
        if (socket != null && (contentLength > 512 * 1024 || isMultipart)) {
            try { socket.setSoTimeout(300000); } catch (Exception ignored) {}
        }

        // 工业级稳健 Body 读取：
        // 若超过 1MB 或者是 multipart 文件上传，流式保存至临时文件，彻底杜绝 Dalvik 堆内存溢出 (OOM)！
        if (contentLength > 0) {
            boolean useFileStreaming = isMultipart || (contentLength > 1024 * 1024);
            if (useFileStreaming) {
                java.io.File cacheDir = null;
                if (context != null) cacheDir = context.getCacheDir();
                if (cacheDir == null) {
                    String tmpProp = System.getProperty("java.io.tmpdir");
                    cacheDir = (tmpProp != null) ? new java.io.File(tmpProp) : new java.io.File("/data/local/tmp");
                }
                if (!cacheDir.exists()) cacheDir.mkdirs();

                java.io.File tempFile = java.io.File.createTempFile("vc_body_", ".tmp", cacheDir);
                byte[] buf = new byte[65536];
                int remaining = contentLength;
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(tempFile)) {
                    while (remaining > 0) {
                        int toRead = Math.min(buf.length, remaining);
                        int read = in.read(buf, 0, toRead);
                        if (read < 0) break;
                        fos.write(buf, 0, read);
                        remaining -= read;
                    }
                    fos.flush();
                }
                req.bodyTempFile = tempFile;
            } else {
                // 小请求 (常规 JSON API) 直接读入内存
                req.body = new byte[contentLength];
                int readTotal = 0;
                while (readTotal < contentLength) {
                    int read = in.read(req.body, readTotal, contentLength - readTotal);
                    if (read < 0) break;
                    readTotal += read;
                }
            }
        }

        return req;
    }

    public String getMethod() { return method; }
    public String getPath() { return path; }
    public String getHeader(String name) { return headers.get(name.toLowerCase()); }
    public String getQuery(String name) { return queryParams.get(name); }
    public String getCookie(String name) { return cookies.get(name); }
    public java.io.File getBodyFile() { return bodyTempFile; }

    public byte[] getBody() {
        if (body != null && body.length > 0) return body;
        if (bodyTempFile != null && bodyTempFile.exists()) {
            try {
                long len = bodyTempFile.length();
                if (len < 16 * 1024 * 1024) { // 小于 16MB 才允许一次性加载进 byte[]
                    byte[] data = new byte[(int) len];
                    try (java.io.FileInputStream fis = new java.io.FileInputStream(bodyTempFile)) {
                        int r = 0;
                        while (r < len) {
                            int n = fis.read(data, r, (int) len - r);
                            if (n < 0) break;
                            r += n;
                        }
                    }
                    return data;
                }
            } catch (Exception ignored) {}
        }
        return new byte[0];
    }

    public String getBodyText() {
        byte[] b = getBody();
        return new String(b, StandardCharsets.UTF_8);
    }

    public void cleanup() {
        if (bodyTempFile != null && bodyTempFile.exists()) {
            try { bodyTempFile.delete(); } catch (Exception ignored) {}
            bodyTempFile = null;
        }
    }
}
