package com.visualcast.player.server;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class HttpResponse {
    public interface StreamHandler {
        void handleStream(OutputStream out) throws Exception;
    }
    private StreamHandler streamHandler = null;

    public static HttpResponse mjpegStream(StreamHandler handler) {
        HttpResponse res = new HttpResponse();
        res.streamHandler = handler;
        res.contentType = "multipart/x-mixed-replace; boundary=frame";
        res.headers.put("Cache-Control", "no-cache, private");
        res.headers.put("Pragma", "no-cache");
        res.headers.put("Connection", "close");
        return res;
    }
    private int statusCode = 200;
    private String statusText = "OK";
    private String contentType = "text/html; charset=utf-8";
    private final Map<String, String> headers = new HashMap<>();
    private byte[] data = new byte[0];
    private InputStream streamData = null;
    private long streamLength = 0;
    
    // 支持文件断点续传与 Range 流式输出
    private File fileData = null;
    private long rangeStart = 0;
    private long rangeEnd = -1;

    public static HttpResponse json(String jsonStr) {
        HttpResponse res = new HttpResponse();
        res.contentType = "application/json; charset=utf-8";
        res.headers.put("Cache-Control", "no-cache, no-store, must-revalidate");
        res.headers.put("Pragma", "no-cache");
        res.headers.put("Expires", "0");
        res.data = jsonStr.getBytes(StandardCharsets.UTF_8);
        return res;
    }

    public static HttpResponse text(String text) {
        HttpResponse res = new HttpResponse();
        res.contentType = "text/plain; charset=utf-8";
        res.data = text.getBytes(StandardCharsets.UTF_8);
        return res;
    }

    public static HttpResponse xml(String xmlStr) {
        HttpResponse res = new HttpResponse();
        res.contentType = "text/xml; charset=utf-8";
        res.data = xmlStr.getBytes(StandardCharsets.UTF_8);
        return res;
    }


    public static HttpResponse error(int code, String msg) {
        HttpResponse res = new HttpResponse();
        res.statusCode = code;
        res.statusText = (code == 401 ? "Unauthorized" : (code == 404 ? "Not Found" : "Error"));
        res.contentType = "application/json; charset=utf-8";
        res.data = ("{\"status\":\"error\",\"message\":\"" + msg + "\"}").getBytes(StandardCharsets.UTF_8);
        return res;
    }

    public static HttpResponse fileStream(InputStream in, long len, String mime) {
        HttpResponse res = new HttpResponse();
        res.streamData = in;
        res.streamLength = len;
        res.contentType = mime != null ? mime : "application/octet-stream";
        res.headers.put("Accept-Ranges", "bytes");
        return res;
    }

    /**
     * Android 7 核心支持：支持 HTTP 206 Partial Content (Range: bytes=start-end)
     */
    public static HttpResponse fileRange(File file, String rangeHeader, String mime) {
        HttpResponse res = new HttpResponse();
        res.fileData = file;
        res.contentType = mime != null ? mime : "application/octet-stream";
        res.headers.put("Accept-Ranges", "bytes");
        
        long fileLen = file.length();
        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            String rangeVal = rangeHeader.substring(6).trim();
            long start = 0;
            long end = fileLen - 1;
            int dashPos = rangeVal.indexOf('-');
            if (dashPos >= 0) {
                String sStart = rangeVal.substring(0, dashPos).trim();
                String sEnd = rangeVal.substring(dashPos + 1).trim();
                try {
                    if (!sStart.isEmpty()) {
                        start = Long.parseLong(sStart);
                    }
                    if (!sEnd.isEmpty()) {
                        end = Long.parseLong(sEnd);
                    }
                } catch (Exception ignored) {}
            }
            if (start > fileLen - 1) start = fileLen - 1;
            if (end > fileLen - 1) end = fileLen - 1;
            if (start < 0) start = 0;
            if (end < start) end = start;

            res.statusCode = 206;
            res.statusText = "Partial Content";
            res.rangeStart = start;
            res.rangeEnd = end;
            long partLen = end - start + 1;
            res.streamLength = partLen;
            res.headers.put("Content-Range", "bytes " + start + "-" + end + "/" + fileLen);
        } else {
            res.statusCode = 200;
            res.statusText = "OK";
            res.rangeStart = 0;
            res.rangeEnd = fileLen - 1;
            res.streamLength = fileLen;
        }
        return res;
    }

    public static HttpResponse bytes(byte[] bytes, String mime) {
        HttpResponse res = new HttpResponse();
        res.data = bytes != null ? bytes : new byte[0];
        res.contentType = mime != null ? mime : "application/octet-stream";
        return res;
    }

    public void setCookie(String name, String value, int maxAgeSec) {
        headers.put("Set-Cookie", name + "=" + value + "; Path=/; Max-Age=" + maxAgeSec);
    }

    public void setHeader(String k, String v) {
        headers.put(k, v);
    }

    public void send(OutputStream out) throws Exception {
        StringBuilder sb = new StringBuilder();
        if (streamHandler != null) {
            sb.append("HTTP/1.1 ").append(statusCode).append(" ").append(statusText).append("\r\n");
            sb.append("Content-Type: ").append(contentType).append("\r\n");
            sb.append("Access-Control-Allow-Origin: *\r\n");
            for (Map.Entry<String, String> e : headers.entrySet()) {
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
            sb.append("\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            streamHandler.handleStream(out);
            return;
        }
        sb.append("HTTP/1.1 ").append(statusCode).append(" ").append(statusText).append("\r\n");
        sb.append("Content-Type: ").append(contentType).append("\r\n");
        sb.append("Connection: close\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Headers: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS, PUT, DELETE\r\n");

        for (Map.Entry<String, String> e : headers.entrySet()) {
            sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        }

        if (fileData != null) {
            sb.append("Content-Length: ").append(streamLength).append("\r\n");
            sb.append("\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));

            try (RandomAccessFile raf = new RandomAccessFile(fileData, "r")) {
                raf.seek(rangeStart);
                long bytesRemaining = streamLength;
                byte[] buf = new byte[32768];
                while (bytesRemaining > 0) {
                    int toRead = (int) Math.min(buf.length, bytesRemaining);
                    int read = raf.read(buf, 0, toRead);
                    if (read == -1) break;
                    out.write(buf, 0, read);
                    bytesRemaining -= read;
                }
            }
        } else if (streamData != null) {
            if (streamLength > 0) {
                sb.append("Content-Length: ").append(streamLength).append("\r\n");
            }
            sb.append("\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));

            byte[] buf = new byte[16384];
            int read;
            try {
                while ((read = streamData.read(buf)) != -1) {
                    out.write(buf, 0, read);
                }
            } finally {
                streamData.close();
            }
        } else {
            sb.append("Content-Length: ").append(data.length).append("\r\n");
            sb.append("\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            if (data.length > 0) {
                out.write(data);
            }
        }
        out.flush();
    }
}
