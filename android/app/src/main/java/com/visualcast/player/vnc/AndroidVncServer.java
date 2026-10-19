package com.visualcast.player.vnc;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AndroidVncServer {
    private static final String TAG = "AndroidVncServer";
    private final int rfbPort;
    private final int wsPort;
    private final Context context;
    private ServerSocket rfbSocket;
    private ServerSocket wsSocket;
    private volatile boolean isRunning = false;
    private final ExecutorService threadPool = Executors.newCachedThreadPool();
    private final List<VncClientSession> sessions = Collections.synchronizedList(new ArrayList<>());

    public AndroidVncServer(Context context, int rfbPort, int wsPort) {
        this.context = context;
        this.rfbPort = rfbPort;
        this.wsPort = wsPort;
    }

    public synchronized void start() {
        if (isRunning) return;
        isRunning = true;

        // 1. 启动 RFB 5900 监听 (原生 VNC 客户端)
        new Thread(() -> {
            try {
                rfbSocket = new ServerSocket(rfbPort);
                Log.i(TAG, "RFB 标准 VNC 服务端已监听端口: " + rfbPort);
                while (isRunning && !rfbSocket.isClosed()) {
                    try {
                        Socket client = rfbSocket.accept();
                        client.setTcpNoDelay(true);
                        VncClientSession session = new VncClientSession(client, false);
                        sessions.add(session);
                        threadPool.submit(session::run);
                    } catch (Exception e) {
                        if (!isRunning) break;
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "RFB 端口绑定失败: " + e.getMessage());
            }
        }, "VNC-RFB-Listener").start();

        // 2. 启动 WebSocket 5901 监听 (支持 Web 端 noVNC 直连)
        new Thread(() -> {
            try {
                wsSocket = new ServerSocket(wsPort);
                Log.i(TAG, "WebSocket VNC 隧道已监听端口: " + wsPort + " (已优化 RFC 6455 握手与 64KB 分片)");
                while (isRunning && !wsSocket.isClosed()) {
                    try {
                        Socket client = wsSocket.accept();
                        client.setTcpNoDelay(true);
                        VncClientSession session = new VncClientSession(client, true);
                        sessions.add(session);
                        threadPool.submit(session::run);
                    } catch (Exception e) {
                        if (!isRunning) break;
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "WebSocket 端口绑定失败: " + e.getMessage());
            }
        }, "VNC-WS-Listener").start();
    }

    public synchronized void stop() {
        isRunning = false;
        try {
            if (rfbSocket != null) rfbSocket.close();
        } catch (Exception ignored) {}
        try {
            if (wsSocket != null) wsSocket.close();
        } catch (Exception ignored) {}
        for (VncClientSession s : sessions) {
            s.close();
        }
        sessions.clear();
        threadPool.shutdownNow();
    }

    public boolean isRunning() {
        return isRunning;
    }

    public int getClientCount() {
        int count = 0;
        for (VncClientSession s : sessions) {
            if (s.alive) count++;
        }
        return count;
    }

    private class VncClientSession {
        private final Socket socket;
        private final boolean isWebSocket;
        private volatile boolean alive = true;
        private int screenWidth = 1920;
        private int screenHeight = 1080;
        private int clientBpp = 32;
        private int lastButtonMask = 0;
        private final ByteArrayOutputStream wsRecvBuf = new ByteArrayOutputStream();

        public VncClientSession(Socket socket, boolean isWebSocket) {
            this.socket = socket;
            this.isWebSocket = isWebSocket;
            this.screenWidth = VncInputInjector.getScreenWidth(context);
            this.screenHeight = VncInputInjector.getScreenHeight(context);
        }

        public void run() {
            try (InputStream in = socket.getInputStream();
                 OutputStream out = socket.getOutputStream();
                 DataInputStream din = new DataInputStream(in);
                 DataOutputStream dout = new DataOutputStream(out)) {

                // WebSocket 协议升级握手 (动态协商子协议)
                if (isWebSocket) {
                    byte[] buf = new byte[4096];
                    int readLen = in.read(buf);
                    if (readLen <= 0) return;
                    String req = new String(buf, 0, readLen, StandardCharsets.UTF_8);

                    String key = "";
                    String proto = "";
                    for (String line : req.split("\r\n")) {
                        String lower = line.toLowerCase();
                        if (lower.startsWith("sec-websocket-key:")) {
                            key = line.split(":", 2)[1].trim();
                        } else if (lower.startsWith("sec-websocket-protocol:")) {
                            proto = line.split(":", 2)[1].trim();
                        }
                    }
                    if (key.isEmpty()) return;

                    String accept = Base64.encodeToString(
                            MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.UTF_8)),
                            Base64.NO_WRAP
                    );

                    String protoLine = "";
                    if (!proto.isEmpty()) {
                        String chosen = "vnc";
                        if (!proto.toLowerCase().contains("vnc")) {
                            chosen = proto.split(",")[0].trim();
                        }
                        protoLine = "Sec-WebSocket-Protocol: " + chosen + "\r\n";
                    }

                    String resp = "HTTP/1.1 101 Switching Protocols\r\n" +
                            "Upgrade: websocket\r\n" +
                            "Connection: Upgrade\r\n" +
                            "Sec-WebSocket-Accept: " + accept + "\r\n" +
                            protoLine + "\r\n";

                    out.write(resp.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }

                // 1. 服务端打招呼 RFB 003.003 (锁定传统基线协议，彻底关闭现代 RealVNC 客户端的 ZSTD 流解压通道，根除 -72 报错)
                sendData(out, "RFB 003.003\n".getBytes(StandardCharsets.US_ASCII));

                // 2. 接收客户端版本 (12 bytes)
                byte[] verResp = readExact(in, out, 12);
                if (verResp == null) return;
                String verStr = new String(verResp, StandardCharsets.US_ASCII).trim();
                Log.i(TAG, "客户端连接 RFB 协商: 服务端通告=003.003, 客户端响应=" + verStr);

                // 3. RFB 3.3 规范安全协商: 服务端直接决定并发送 4 字节安全类型 1 (None)
                // 传统规范无 SecurityResult 报文，杜绝任何扩展握手陷阱
                ByteBuffer secBuf = ByteBuffer.allocate(4);
                secBuf.putInt(1);
                sendData(out, secBuf.array());

                // 4. ClientInit (shared-flag 1 byte)
                byte[] shared = readExact(in, out, 1);
                if (shared == null) return;

                // 5. ServerInit
                byte[] nameBytes = "VisualCast Android Screen".getBytes(StandardCharsets.UTF_8);
                ByteBuffer srvInit = ByteBuffer.allocate(24 + nameBytes.length);
                srvInit.putShort((short) screenWidth);
                srvInit.putShort((short) screenHeight);
                // PixelFormat: 32bpp, depth 24, big-endian 0, true-colour 1,
                // max: R=255, G=255, B=255, shift: R=16, G=8, B=0
                srvInit.put((byte) 32);  // bits-per-pixel
                srvInit.put((byte) 24);  // depth
                srvInit.put((byte) 0);   // big-endian-flag
                srvInit.put((byte) 1);   // true-colour-flag
                srvInit.putShort((short) 255); // red-max
                srvInit.putShort((short) 255); // green-max
                srvInit.putShort((short) 255); // blue-max
                srvInit.put((byte) 16);  // red-shift
                srvInit.put((byte) 8);   // green-shift
                srvInit.put((byte) 0);   // blue-shift
                srvInit.put(new byte[3]); // padding
                srvInit.putInt(nameBytes.length);
                srvInit.put(nameBytes);
                sendData(out, srvInit.array());

                // 主协议循环
                while (alive && !socket.isClosed()) {
                    byte[] msgType = readExact(in, out, 1);
                    if (msgType == null) break;
                    int type = msgType[0] & 0xFF;

                    if (type == 0) { // SetPixelFormat
                        byte[] pfData = readExact(in, out, 19);
                        if (pfData != null && pfData.length == 19) {
                            int bpp = pfData[3] & 0xFF;
                            if (bpp == 16 || bpp == 32) {
                                clientBpp = bpp;
                                Log.i(TAG, "安卓 VNC 客户端成功协商像素格式: bpp=" + bpp);
                            }
                        }
                    } else if (type == 2) { // SetEncodings
                        byte[] hdr = readExact(in, out, 3);
                        if (hdr != null) {
                            int encCount = ((hdr[1] & 0xFF) << 8) | (hdr[2] & 0xFF);
                            byte[] encBytes = readExact(in, out, encCount * 4);
                            if (encBytes != null) {
                                StringBuilder sb = new StringBuilder();
                                for (int i = 0; i < encCount; i++) {
                                    int enc = ByteBuffer.wrap(encBytes, i * 4, 4).getInt();
                                    sb.append(enc).append(" ");
                                }
                                Log.i(TAG, "客户端协商 Encodings (" + encCount + "项): " + sb.toString());
                            }
                        }
                    } else if (type == 3) { // FramebufferUpdateRequest
                        byte[] req = readExact(in, out, 9);
                        if (req != null && req.length == 9) {
                            int rx = ((req[1] & 0xFF) << 8) | (req[2] & 0xFF);
                            int ry = ((req[3] & 0xFF) << 8) | (req[4] & 0xFF);
                            int rw = ((req[5] & 0xFF) << 8) | (req[6] & 0xFF);
                            int rh = ((req[7] & 0xFF) << 8) | (req[8] & 0xFF);
                            handleFramebufferRequest(out, rx, ry, rw, rh);
                        }
                    } else if (type == 4) { // KeyEvent
                        byte[] ev = readExact(in, out, 7);
                        if (ev != null) {
                            int keysym = ByteBuffer.wrap(ev, 3, 4).getInt();
                            int keyCode = mapKeysymToAndroidKey(keysym);
                            if (keyCode > 0) {
                                VncInputInjector.injectKeyEvent(keyCode);
                            }
                        }
                    } else if (type == 5) { // PointerEvent
                        byte[] ev = readExact(in, out, 5);
                        if (ev != null) {
                            int buttonMask = ev[0] & 0xFF;
                            int x = ((ev[1] & 0xFF) << 8) | (ev[2] & 0xFF);
                            int y = ((ev[3] & 0xFF) << 8) | (ev[4] & 0xFF);
                            handlePointerEvent(buttonMask, x, y);
                        }
                    } else if (type == 6) { // ClientCutText
                        byte[] hdr = readExact(in, out, 7);
                        if (hdr != null) {
                            int textLen = ByteBuffer.wrap(hdr, 3, 4).getInt();
                            if (textLen > 0) readExact(in, out, textLen);
                        }
                    } else if (type == 150) { // EnableContinuousUpdates (RFC 6143 / RealVNC 扩展帧)
                        byte[] contHdr = readExact(in, out, 9);
                        if (contHdr != null && contHdr.length == 9) {
                            int enable = contHdr[0] & 0xFF;
                            int rx = ((contHdr[1] & 0xFF) << 8) | (contHdr[2] & 0xFF);
                            int ry = ((contHdr[3] & 0xFF) << 8) | (contHdr[4] & 0xFF);
                            int rw = ((contHdr[5] & 0xFF) << 8) | (contHdr[6] & 0xFF);
                            int rh = ((contHdr[7] & 0xFF) << 8) | (contHdr[8] & 0xFF);
                            if (enable != 0) {
                                handleFramebufferRequest(out, rx, ry, rw, rh);
                            }
                        }
                    } else if (type == 255) { // RealVNC / UltraVNC 客户端扩展包
                        byte[] subHdr = readExact(in, out, 3);
                        if (subHdr != null) {
                            int extLen = ((subHdr[1] & 0xFF) << 8) | (subHdr[2] & 0xFF);
                            if (extLen > 0) readExact(in, out, extLen);
                        }
                    } else {
                        // 忽略未知扩展帧，防止卡死
                    }
                }

            } catch (Exception ignored) {
            } finally {
                close();
            }
        }

        private void handleFramebufferRequest(OutputStream out, int rx, int ry, int rw, int rh) {
            try {
                int totalW = screenWidth;
                int totalH = screenHeight;

                // 严格视口安全边界校正
                rx = Math.max(0, Math.min(rx, totalW - 1));
                ry = Math.max(0, Math.min(ry, totalH - 1));
                rw = Math.min(Math.max(1, rw), totalW - rx);
                rh = Math.min(Math.max(1, rh), totalH - ry);

                Bitmap bmp = VncScreenCapturer.captureCurrentScreen();
                if (bmp == null) {
                    // 保底黑屏位图，绝对不能让客户端超时等待死锁
                    bmp = Bitmap.createBitmap(totalW, totalH, Bitmap.Config.ARGB_8888);
                } else if (bmp.getWidth() != totalW || bmp.getHeight() != totalH) {
                    // 严格缩放至通告桌面尺寸，防止客户端触发边界越界崩溃
                    Bitmap scaled = Bitmap.createScaledBitmap(bmp, totalW, totalH, true);
                    if (scaled != bmp) bmp.recycle();
                    bmp = scaled;
                }

                // 提取客户端请求的视口 (rx, ry, rw, rh) 像素，轻量化毫秒直达
                int[] pixels = new int[rw * rh];
                bmp.getPixels(pixels, 0, rw, rx, ry, rw, rh);
                bmp.recycle();

                byte[] pixelBytes;
                if (clientBpp == 16) {
                    // 动态转换为 16 位 RGB565 格式 (每个像素 2 字节)
                    ByteBuffer b16 = ByteBuffer.allocate(rw * rh * 2);
                    for (int color : pixels) {
                        int r = (color >> 16) & 0xFF;
                        int g = (color >> 8) & 0xFF;
                        int b = color & 0xFF;
                        short rgb565 = (short) (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
                        b16.putShort(rgb565);
                    }
                    pixelBytes = b16.array();
                } else {
                    // 32 位 RGBA 格式 (每个像素 4 字节)
                    ByteBuffer b32 = ByteBuffer.allocate(rw * rh * 4);
                    for (int color : pixels) {
                        b32.put((byte) ((color >> 16) & 0xFF)); // R
                        b32.put((byte) ((color >> 8) & 0xFF));  // G
                        b32.put((byte) (color & 0xFF));         // B
                        b32.put((byte) 0);                      // Pad
                    }
                    pixelBytes = b32.array();
                }

                // FramebufferUpdate Header: msg_type=0, pad=0, num_rectangles=1
                ByteBuffer hdr = ByteBuffer.allocate(16);
                hdr.put((byte) 0);
                hdr.put((byte) 0);
                hdr.putShort((short) 1);
                // Rectangle Header 严格对应请求坐标与尺寸
                hdr.putShort((short) rx);
                hdr.putShort((short) ry);
                hdr.putShort((short) rw);
                hdr.putShort((short) rh);
                hdr.putInt(0); // Raw

                byte[] packet = new byte[16 + pixelBytes.length];
                System.arraycopy(hdr.array(), 0, packet, 0, 16);
                System.arraycopy(pixelBytes, 0, packet, 16, pixelBytes.length);
                sendData(out, packet);

            } catch (Exception e) {
                Log.e(TAG, "推流帧异常: " + e.getMessage());
            }
        }

        private void handlePointerEvent(int mask, int x, int y) {
            if ((mask & 1) != 0 && (lastButtonMask & 1) == 0) {
                VncInputInjector.injectTap(x, y);
            }
            lastButtonMask = mask;
        }

        private int mapKeysymToAndroidKey(int keysym) {
            if (keysym == 0xFF1B) return android.view.KeyEvent.KEYCODE_BACK; // ESC -> BACK
            if (keysym == 0xFF0D) return android.view.KeyEvent.KEYCODE_ENTER;
            if (keysym == 0x0020) return android.view.KeyEvent.KEYCODE_SPACE;
            if (keysym == 0xFF51) return android.view.KeyEvent.KEYCODE_DPAD_LEFT;
            if (keysym == 0xFF52) return android.view.KeyEvent.KEYCODE_DPAD_UP;
            if (keysym == 0xFF53) return android.view.KeyEvent.KEYCODE_DPAD_RIGHT;
            if (keysym == 0xFF54) return android.view.KeyEvent.KEYCODE_DPAD_DOWN;
            if (keysym == 0xFF08) return android.view.KeyEvent.KEYCODE_DEL;
            if (keysym == 0xFFE9) return android.view.KeyEvent.KEYCODE_HOME; // Alt -> HOME
            return 0;
        }

        /**
         * 发送二进制载荷 (严格遵循 RFC 6455 64KB 分片标准，彻底杜绝浏览器缓冲区溢出断开)
         */
        private void sendData(OutputStream out, byte[] data) throws Exception {
            if (!isWebSocket) {
                int CHUNK = 65536;
                if (data.length <= CHUNK) {
                    out.write(data);
                } else {
                    int offset = 0;
                    while (offset < data.length) {
                        int len = Math.min(CHUNK, data.length - offset);
                        out.write(data, offset, len);
                        offset += len;
                    }
                }
                out.flush();
            } else {
                int CHUNK_SIZE = 65536;
                int totalLen = data.length;
                if (totalLen <= CHUNK_SIZE) {
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    baos.write(0x82); // FIN=1, Binary
                    if (totalLen <= 125) {
                        baos.write(totalLen);
                    } else if (totalLen <= 65535) {
                        baos.write(126);
                        baos.write((totalLen >> 8) & 0xFF);
                        baos.write(totalLen & 0xFF);
                    } else {
                        baos.write(127);
                        for (int i = 7; i >= 0; i--) {
                            baos.write((int) ((totalLen >> (i * 8)) & 0xFF));
                        }
                    }
                    baos.write(data);
                    out.write(baos.toByteArray());
                    out.flush();
                } else {
                    // RFC 6455 规范的 Continuation 分片发送
                    int offset = 0;
                    boolean first = true;
                    while (offset < totalLen) {
                        int chunkLen = Math.min(CHUNK_SIZE, totalLen - offset);
                        boolean isLast = (offset + chunkLen >= totalLen);

                        int opcode = first ? 0x02 : 0x00;
                        int b1 = (isLast ? 0x80 : 0x00) | opcode;

                        ByteArrayOutputStream baos = new ByteArrayOutputStream();
                        baos.write(b1);

                        if (chunkLen <= 125) {
                            baos.write(chunkLen);
                        } else if (chunkLen <= 65535) {
                            baos.write(126);
                            baos.write((chunkLen >> 8) & 0xFF);
                            baos.write(chunkLen & 0xFF);
                        } else {
                            baos.write(127);
                            for (int i = 7; i >= 0; i--) {
                                baos.write((int) ((chunkLen >> (i * 8)) & 0xFF));
                            }
                        }
                        baos.write(data, offset, chunkLen);
                        out.write(baos.toByteArray());
                        offset += chunkLen;
                        first = false;
                    }
                    out.flush();
                }
            }
        }

        private byte[] readExactRaw(InputStream in, int len) {
            byte[] buf = new byte[len];
            int readTotal = 0;
            try {
                while (readTotal < len) {
                    int r = in.read(buf, readTotal, len - readTotal);
                    if (r < 0) {
                        alive = false;
                        return null;
                    }
                    readTotal += r;
                }
                return buf;
            } catch (Exception e) {
                alive = false;
                return null;
            }
        }

        private byte[] readExact(InputStream in, OutputStream out, int len) {
            if (!isWebSocket) {
                return readExactRaw(in, len);
            }
            try {
                while (wsRecvBuf.size() < len && alive) {
                    byte[] head = readExactRaw(in, 2);
                    if (head == null) return null;
                    int b1 = head[0] & 0xFF;
                    int b2 = head[1] & 0xFF;
                    int opcode = b1 & 0x0F;
                    if (opcode == 0x08) { // WebSocket Close 帧
                        alive = false;
                        return null;
                    }

                    boolean masked = (b2 & 0x80) != 0;
                    long payloadLen = b2 & 0x7F;
                    if (payloadLen == 126) {
                        byte[] ext = readExactRaw(in, 2);
                        if (ext == null) return null;
                        payloadLen = ((ext[0] & 0xFF) << 8) | (ext[1] & 0xFF);
                    } else if (payloadLen == 127) {
                        byte[] ext = readExactRaw(in, 8);
                        if (ext == null) return null;
                        payloadLen = ByteBuffer.wrap(ext).getLong();
                    }

                    byte[] maskKey = null;
                    if (masked) {
                        maskKey = readExactRaw(in, 4);
                        if (maskKey == null) return null;
                    }

                    byte[] payload;
                    if (payloadLen > 0) {
                        payload = readExactRaw(in, (int) payloadLen);
                        if (payload == null) return null;
                    } else {
                        payload = new byte[0];
                    }

                    if (masked && maskKey != null && payload.length > 0) {
                        for (int i = 0; i < payload.length; i++) {
                            payload[i] ^= maskKey[i % 4];
                        }
                    }

                    if (opcode == 0x09) { // Ping 帧：必须立即回传 Pong 防止客户端心跳超时
                        byte[] pong = new byte[2 + payload.length];
                        pong[0] = (byte) 0x8A;
                        pong[1] = (byte) (payload.length & 0x7F);
                        System.arraycopy(payload, 0, pong, 2, payload.length);
                        out.write(pong);
                        out.flush();
                    } else if (opcode == 0x0A) { // Pong 帧
                        // 忽略
                    } else if (opcode == 0x00 || opcode == 0x01 || opcode == 0x02) {
                        wsRecvBuf.write(payload);
                    }
                }

                if (wsRecvBuf.size() < len) {
                    alive = false;
                    return null;
                }

                byte[] all = wsRecvBuf.toByteArray();
                byte[] result = new byte[len];
                System.arraycopy(all, 0, result, 0, len);

                wsRecvBuf.reset();
                if (all.length > len) {
                    wsRecvBuf.write(all, len, all.length - len);
                }
                return result;
            } catch (Exception e) {
                alive = false;
                return null;
            }
        }

        public void close() {
            alive = false;
            try { socket.close(); } catch (Exception ignored) {}
        }
    }
}
