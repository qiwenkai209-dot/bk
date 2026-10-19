package com.visualcast.player.server;

import android.content.Context;
import android.util.Log;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class EmbeddedHttpServer {
    private static final String TAG = "VisualCastServer";
    private final Context context;
    private final int port;
    private final HttpRouter router;
    private ServerSocket serverSocket;
    private volatile boolean isRunning = false;
    // 高性能非阻塞线程池：采用 SynchronousQueue 直接移交模式，新请求零排队、零延迟、立即响应！
    private final ExecutorService executor = new java.util.concurrent.ThreadPoolExecutor(
            16, 128, 60L, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.SynchronousQueue<>(),
            (r, exec) -> {
                // 当极端并发达到 128 线程时，使用独立临时守护线程执行，绝对不阻塞 accept 循环
                new Thread(r, "VC-HttpFallbackWorker").start();
            }
    );

    public EmbeddedHttpServer(Context context, int port) {
        this.context = context;
        this.port = port;
        AuthManager authManager = new AuthManager(context);
        IoTEngine iotEngine = new IoTEngine(context);
        this.router = new HttpRouter(context, authManager, iotEngine);
    }

    public synchronized void start() {
        if (isRunning) return;
        isRunning = true;
        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(port, 128, java.net.InetAddress.getByName("0.0.0.0"));
                Log.i(TAG, "VisualCast 内嵌 HTTP 微服务已在端口 " + port + " 成功启动 (高性能非阻塞架构)");
                while (isRunning && !serverSocket.isClosed()) {
                    try {
                        Socket client = serverSocket.accept();
                        client.setTcpNoDelay(true);
                        client.setSoTimeout(6000); // 短请求6秒快速超时，防止死锁
                        executor.submit(() -> handleClient(client));
                    } catch (Exception e) {
                        if (!isRunning) break;
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "启动 HTTP 服务异常: " + e.getMessage());
            }
        }, "EmbeddedHttpServerThread").start();
    }

    private void handleClient(Socket client) {
        HttpRequest req = null;
        try (InputStream in = client.getInputStream();
             OutputStream out = client.getOutputStream()) {
            req = HttpRequest.parse(in, client, context);
            if (req.getPath() != null && req.getPath().startsWith("/api/stream/")) {
                client.setSoTimeout(0); // 屏幕实时推流长连接，保持永久连通
                client.setTcpNoDelay(true); // 禁用 Nagle 算法，达到演播级零延迟
                try { client.setSendBufferSize(256 * 1024); } catch (Exception ignored) {}
            }
            HttpResponse res = router.handle(req);
            res.send(out);
        } catch (Throwable t) {
            Log.e(TAG, "处理客户端请求异常: " + t.getMessage(), t);
            try {
                if (!client.isClosed() && client.isConnected()) {
                    OutputStream out = client.getOutputStream();
                    String msg = t.getMessage() != null ? t.getMessage().replace("\"", "\\\"") : t.getClass().getSimpleName();
                    byte[] errBody = ("{\"status\":\"error\",\"message\":\"服务器处理异常: " + msg + "\"}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    String header = "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + errBody.length + "\r\nConnection: close\r\n\r\n";
                    out.write(header.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    out.write(errBody);
                    out.flush();
                }
            } catch (Exception ignored) {}
        } finally {
            if (req != null) {
                req.cleanup();
            }
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    public synchronized void stop() {
        isRunning = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception ignored) {}
        executor.shutdownNow();
    }
}
