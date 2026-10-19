package com.visualcast.player.vnc;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import com.visualcast.player.MainActivity;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class VncScreenCapturer {
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static volatile byte[] cachedJpeg = null;
    private static volatile long lastCaptureTime = 0;
    private static final Object captureLock = new Object();
    private static volatile byte[] defaultBlackFrame = null;

    private static byte[] getDefaultBlackFrame(int targetW, int targetH, int quality) {
        if (defaultBlackFrame != null) return defaultBlackFrame;
        try {
            Bitmap bmp = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.RGB_565);
            Canvas c = new Canvas(bmp);
            c.drawColor(Color.BLACK);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, quality, baos);
            bmp.recycle();
            defaultBlackFrame = baos.toByteArray();
            return defaultBlackFrame;
        } catch (Throwable t) {
            return new byte[0];
        }
    }

    /**
     * 高性能低开销捕获当前大屏画面 (RGB_565 异步节流绘制，彻底根除死锁与主线程卡死)
     */
    public static byte[] captureOptimizedJpeg(int targetW, int targetH, int quality) {
        long now = System.currentTimeMillis();
        // 节流保护：80ms 内请求直接复用缓存帧 (约 12-15 FPS)，大幅降低 CPU 与 GPU 负担
        if (cachedJpeg != null && (now - lastCaptureTime < 80)) {
            return cachedJpeg;
        }

        if (MainActivity.instance == null || MainActivity.isScreenAsleep || MainActivity.instance.isFinishing() || MainActivity.isExternalDocActive) {
            if (cachedJpeg != null && cachedJpeg.length > 0) return cachedJpeg;
            return getDefaultBlackFrame(targetW, targetH, quality);
        }

        synchronized (captureLock) {
            if (cachedJpeg != null && (now - lastCaptureTime < 80)) {
                return cachedJpeg;
            }

            if (MainActivity.instance != null && !MainActivity.isScreenAsleep && !MainActivity.isExternalDocActive) {
                View view = MainActivity.instance.getWindow().getDecorView();
                int vw = view.getWidth();
                int vh = view.getHeight();
                if (vw > 0 && vh > 0) {
                    if (Looper.myLooper() == Looper.getMainLooper()) {
                        try {
                            Bitmap bmp = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.RGB_565);
                            Canvas canvas = new Canvas(bmp);
                            canvas.scale((float) targetW / vw, (float) targetH / vh);
                            view.draw(canvas);
                            ByteArrayOutputStream baos = new ByteArrayOutputStream();
                            bmp.compress(Bitmap.CompressFormat.JPEG, quality, baos);
                            bmp.recycle();
                            cachedJpeg = baos.toByteArray();
                            lastCaptureTime = System.currentTimeMillis();
                            return cachedJpeg;
                        } catch (Throwable ignored) {}
                    } else {
                        final Bitmap[] result = new Bitmap[1];
                        final CountDownLatch latch = new CountDownLatch(1);

                        boolean posted = mainHandler.post(() -> {
                            try {
                                Bitmap bmp = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.RGB_565);
                                Canvas canvas = new Canvas(bmp);
                                canvas.scale((float) targetW / vw, (float) targetH / vh);
                                view.draw(canvas);
                                result[0] = bmp;
                            } catch (Throwable ignored) {} finally {
                                latch.countDown();
                            }
                        });

                        if (posted) {
                            try {
                                // 适度 150ms 超时，确保商显主板主线程能够稳定完成视图渲染
                                if (latch.await(100, TimeUnit.MILLISECONDS) && result[0] != null) {
                                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                    result[0].compress(Bitmap.CompressFormat.JPEG, quality, baos);
                                    result[0].recycle();
                                    result[0] = null;
                                    cachedJpeg = baos.toByteArray();
                                    lastCaptureTime = System.currentTimeMillis();
                                    return cachedJpeg;
                                }
                            } catch (InterruptedException ignored) {
                            } finally {
                                if (result[0] != null && !result[0].isRecycled()) {
                                    try { result[0].recycle(); } catch (Exception ignored) {}
                                    result[0] = null;
                                }
                            }
                        }
                    }
                }
            }

            // 若 View 尚未就绪或超时，安全回退已缓存帧或低开销保底黑帧，绝不执行阻塞式底层命令
            if (cachedJpeg != null && cachedJpeg.length > 0) {
                return cachedJpeg;
            }
            return getDefaultBlackFrame(targetW, targetH, quality);
        }
    }

    public static byte[] captureJpeg(int quality, float scale) {
        return captureOptimizedJpeg(640, 360, quality > 0 ? quality : 75);
    }

    /**
     * 捕获当前屏幕原始位图 (供 VNC RFB 协议使用，带严格超时保护)
     */
    public static Bitmap captureCurrentScreen() {
        if (MainActivity.instance != null && !MainActivity.isScreenAsleep && !MainActivity.instance.isFinishing()) {
            View view = MainActivity.instance.getWindow().getDecorView();
            int vw = view.getWidth();
            int vh = view.getHeight();
            if (vw > 0 && vh > 0) {
                if (Looper.myLooper() == Looper.getMainLooper()) {
                    try {
                        Bitmap bmp = Bitmap.createBitmap(vw, vh, Bitmap.Config.RGB_565);
                        Canvas canvas = new Canvas(bmp);
                        view.draw(canvas);
                        return bmp;
                    } catch (Throwable ignored) {}
                } else {
                    final Bitmap[] result = new Bitmap[1];
                    final CountDownLatch latch = new CountDownLatch(1);

                    boolean posted = mainHandler.post(() -> {
                        try {
                            Bitmap bmp = Bitmap.createBitmap(vw, vh, Bitmap.Config.RGB_565);
                            Canvas canvas = new Canvas(bmp);
                            view.draw(canvas);
                            result[0] = bmp;
                        } catch (Throwable ignored) {} finally {
                            latch.countDown();
                        }
                    });

                    if (posted) {
                        try {
                            if (latch.await(60, TimeUnit.MILLISECONDS) && result[0] != null) {
                                return result[0];
                            }
                        } catch (InterruptedException ignored) {}
                    }
                }
            }
        }

        try {
            Bitmap bmp = Bitmap.createBitmap(640, 360, Bitmap.Config.RGB_565);
            Canvas c = new Canvas(bmp);
            c.drawColor(Color.BLACK);
            return bmp;
        } catch (Throwable ignored) {}

        return null;
    }
}
