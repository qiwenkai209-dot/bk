package com.visualcast.player;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

import com.visualcast.player.server.EmbeddedHttpServer;
import com.visualcast.player.utils.StorageHelper;
import com.visualcast.player.utils.FloatingBallHelper;
import org.json.JSONObject;

public class MainActivity extends AppCompatActivity {
    public static MainActivity instance;

    public static MainActivity getInstance() {
        return instance;
    }
    public static volatile boolean isScreenAsleep = false;
    private android.content.BroadcastReceiver screenReceiver;
    public WebView webView;
    private EmbeddedHttpServer httpServer;
    private com.visualcast.player.server.CentralControlServer centralControlServer;
    private com.visualcast.player.server.ScheduledShutdownManager scheduledShutdownManager;
    private com.visualcast.player.vnc.AndroidVncServer vncServer;
    private com.visualcast.player.server.NativeCastServer nativeCastServer;
    private android.net.wifi.WifiManager.MulticastLock multicastLock;
    private PowerManager.WakeLock wakeLock;
    private Thread usbPollingThread;
    private long lastBackPressTime = 0;

    public com.visualcast.player.server.NativeCastServer getNativeCastServer() {
        return nativeCastServer;
    }

    private final android.os.Handler heartbeatHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable heartbeatRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                com.visualcast.player.server.HttpRouter.recordNativeHeartbeat();
            } catch (Exception ignored) {}
            heartbeatHandler.postDelayed(this, 1000);
        }
    };

    public void bringToFrontAndCloseDoc() {
        isExternalDocActive = false;
        runOnUiThread(() -> {
            try {
                com.visualcast.player.utils.FloatingBallHelper.hideReturnBall();
                com.visualcast.player.utils.SystemHelper.controlWPSPresentation(this, "close");
                Intent intent = new Intent(this, MainActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(intent);
                hideSystemUI();
            } catch (Exception ignored) {}
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        hideSystemUI();
    }

    public void dispatchCommandToWeb(final String cmd, final JSONObject params) {
        // 核心支持：如果在播放外部文档状态下切换到其他素材或待机，立即关闭外部文档并将 VisualCast 视窗带回前台
        if (isExternalDocActive) {
            String cUpper = (cmd != null) ? cmd.toUpperCase() : "";
            boolean isSwitchToOther = false;
            if ("PLAY_MEDIA".equals(cUpper) || "LOAD_AND_PLAY".equals(cUpper)) {
                String mName = (params != null) ? params.optString("media", params.optString("name", "")).toLowerCase() : "";
                if (!mName.endsWith(".ppt") && !mName.endsWith(".pptx") && !mName.endsWith(".pps") && !mName.endsWith(".ppsx") && !mName.endsWith(".pdf") && !mName.endsWith(".doc") && !mName.endsWith(".docx")) {
                    isSwitchToOther = true;
                }
            } else if ("RETURN_TO_STANDBY".equals(cUpper) || "RETURN_TO_IDLE".equals(cUpper) || "REFRESH_LIBRARY_AND_PLAY".equals(cUpper) || "DOC_EXIT".equals(cUpper) || "STOP".equals(cUpper) || "WAKEUP".equals(cUpper)) {
                isSwitchToOther = true;
            }

            if (isSwitchToOther) {
                bringToFrontAndCloseDoc();
            }
        }

        runOnUiThread(() -> {
            if (webView != null) {
                try {
                    String pStr = (params != null) ? params.toString() : "{}";
                    String js = "try { var fn = (window.applyCommand || (typeof applyCommand === 'function' ? applyCommand : null)); if (fn) fn(" + JSONObject.quote(cmd) + ", " + pStr + "); } catch (e) { console.error('dispatchCommandToWeb error:', e); }";
                    webView.evaluateJavascript(js, null);
                } catch (Exception ignored) {}
            }
        });
    }

    public void setScreenOrientation(final String orientation) {
        runOnUiThread(() -> {
            try {
                if (orientation != null && orientation.toLowerCase().startsWith("portrait")) {
                    setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                } else {
                    setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
                }
            } catch (Exception ignored) {}
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;

        // 1. 全屏沉浸与屏幕常亮配置 (防黑屏休眠)
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 申请底层 CPU/屏幕常亮锁，彻底杜绝工控盒子在长时间无触摸下省电挂起
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ON_AFTER_RELEASE, "VisualCast:MainWakeLock");
                wakeLock.acquire();
            }
        } catch (Exception ignored) {}

        // 适配 Android 9.0+ 刘海屏/挖孔屏/异形商显屏幕，允许全屏延伸至边缘
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        hideSystemUI();
        checkAndRequestPermissions();

        // 4. 创建并配置硬件加速大屏呈现 WebView (先于后台服务完成布局，主线程 0 阻塞立即呈现黑屏视窗)
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // 关键：允许无用户手势直接自动播放视频/音频
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 缓存与硬件加速
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // 注入原生安全交互网桥
        webView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void heartbeat() {
                com.visualcast.player.server.HttpRouter.recordNativeHeartbeat();
            }
            @android.webkit.JavascriptInterface
            public void showToast(String msg) {
                showScreenToast(msg);
            }
            @android.webkit.JavascriptInterface
            public void setOrientation(String ori) {
                setScreenOrientation(ori);
            }
        }, "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                hideSystemUI();
                android.util.Log.i("VisualCast", "大屏核心视窗页面加载成功完成: " + url);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                android.util.Log.w("VisualCast", "WebView 加载提示: " + description + " (" + failingUrl + ")");
                if (failingUrl != null && failingUrl.contains("8088")) {
                    view.postDelayed(() -> {
                        if (webView != null) {
                            webView.loadUrl("http://127.0.0.1:8088/player");
                        }
                    }, 1000);
                }
            }

            // 低内存工控板 (如 RK3288 / 1G-2G 廉价盒子) 渲染进程崩溃自愈保护 (真·无人值守)
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                android.util.Log.e("VisualCast", "感知 WebView 渲染进程异常挂起，执行极速安全自愈重建流程");
                runOnUiThread(() -> {
                    try {
                        if (webView != null) {
                            android.view.ViewParent parent = webView.getParent();
                            if (parent instanceof android.view.ViewGroup) {
                                ((android.view.ViewGroup) parent).removeView(webView);
                            }
                            try { webView.destroy(); } catch (Throwable ignored) {}
                            webView = null;
                        }
                        recreate();
                    } catch (Throwable ignored) {
                        try { recreate(); } catch (Throwable t2) {}
                    }
                });
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
                android.util.Log.d("VisualCastJS", "[" + consoleMessage.messageLevel() + "] " + consoleMessage.message() + " (行号 " + consoleMessage.lineNumber() + ")");
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<android.net.Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                    uploadMessage = null;
                }
                uploadMessage = filePathCallback;

                Intent intent = null;
                if (fileChooserParams != null) {
                    try {
                        intent = fileChooserParams.createIntent();
                    } catch (Exception ignored) {}
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }

                try {
                    startActivityForResult(Intent.createChooser(intent, "选择要上传的多媒体素材"), FILE_CHOOSER_RESULT_CODE);
                    return true;
                } catch (ActivityNotFoundException e1) {
                    try {
                        startActivityForResult(intent, FILE_CHOOSER_RESULT_CODE);
                        return true;
                    } catch (ActivityNotFoundException e2) {
                        try {
                            Intent docIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                            docIntent.addCategory(Intent.CATEGORY_OPENABLE);
                            docIntent.setType("*/*");
                            docIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                            startActivityForResult(docIntent, FILE_CHOOSER_RESULT_CODE);
                            return true;
                        } catch (Exception e3) {
                            if (uploadMessage != null) {
                                uploadMessage.onReceiveValue(null);
                                uploadMessage = null;
                            }
                            Toast.makeText(MainActivity.this, "当前设备系统未安装文件管理器，建议插入U盘自动同步素材", Toast.LENGTH_LONG).show();
                            return false;
                        }
                    }
                } catch (Exception e) {
                    if (uploadMessage != null) {
                        uploadMessage.onReceiveValue(null);
                        uploadMessage = null;
                    }
                    return false;
                }
            }
        });

        // 5. 启动后台异步微服务并在就绪后加载视窗 (彻底解脱主线程，0 阻塞立即呈现)
        startBackgroundServices();

        // 6. 动态注册 U 盘挂载广播监听器与屏幕休眠/唤醒广播监听器
        registerUsbReceiver();
        registerScreenReceiver();
    }

    private void registerScreenReceiver() {
        try {
            screenReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (intent == null || intent.getAction() == null) return;
                    String action = intent.getAction();
                    if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                        android.util.Log.i("VisualCast", "系统广播感知：大屏屏幕熄灭事件，已按需求旁路，保持商显常亮");
                        isScreenAsleep = false;
                    } else if (Intent.ACTION_SCREEN_ON.equals(action) || Intent.ACTION_USER_PRESENT.equals(action)) {
                        android.util.Log.i("VisualCast", "系统广播感知：大屏屏幕点亮，从待机态唤醒");
                        isScreenAsleep = false;
                        runOnUiThread(() -> {
                            hideSystemUI();
                            if (webView != null) {
                                try {
                                    webView.onResume();
                                    webView.resumeTimers();
                                } catch (Exception ignored) {}
                            }
                            triggerSleepTransition(false);
                        });
                    }
                }
            };
            android.content.IntentFilter filter = new android.content.IntentFilter();
            filter.addAction(Intent.ACTION_SCREEN_OFF);
            filter.addAction(Intent.ACTION_SCREEN_ON);
            filter.addAction(Intent.ACTION_USER_PRESENT);
            registerReceiver(screenReceiver, filter);
        } catch (Exception ignored) {}
    }

    private void startBackgroundServices() {
        new Thread(() -> {
            try {
                // 1. 初始化工作目录与释放默认配置 (后台 IO)
                StorageHelper.initDefaultConfigs(MainActivity.this);

                // 2. 读取固化屏幕方向并在主线程安全设置
                try {
                    File cfgFile = new File(StorageHelper.getConfigDir(MainActivity.this), "player_config.json");
                    if (cfgFile.exists()) {
                        String txt = com.visualcast.player.server.HttpRouter.readFileToString(cfgFile);
                        if (txt != null && !txt.trim().isEmpty()) {
                            JSONObject j = new JSONObject(txt);
                            String ori = j.optString("orientation", "landscape");
                            setScreenOrientation(ori);
                        }
                    }
                } catch (Exception ignored) {}

                // 3. 启动内嵌 HTTP 服务 (0.0.0.0:8088)
                httpServer = new EmbeddedHttpServer(MainActivity.this, 8088);
                httpServer.start();

                // 4. 激活底层 Wi-Fi 组播锁 (仅在连接 Wi-Fi 时申请)
                try {
                    android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                    if (wm != null && wm.isWifiEnabled()) {
                        multicastLock = wm.createMulticastLock("VisualCastCastLock");
                        multicastLock.setReferenceCounted(false);
                        multicastLock.acquire();
                    }
                } catch (Exception ignored) {}

                // 5. 启动原生 DLNA / UPnP SSDP 1900 局域网无线投屏设备引擎
                try {
                    String devName = com.visualcast.player.server.HttpRouter.getCastDeviceName(MainActivity.this);
                    nativeCastServer = new com.visualcast.player.server.NativeCastServer(MainActivity.this, 8088, devName);
                    nativeCastServer.start();
                } catch (Exception ignored) {}

                // 6. 启动原生内置 VNC 远程播控服务端
                try {
                    vncServer = new com.visualcast.player.vnc.AndroidVncServer(MainActivity.this, 5900, 5901);
                    vncServer.start();
                } catch (Exception ignored) {}

                // 7. 启动展厅外部智能中控通信与指令调度中枢 (TCP 8000 & UDP 8001)
                try {
                    com.visualcast.player.server.IoTEngine iotEngine = new com.visualcast.player.server.IoTEngine(MainActivity.this);
                    centralControlServer = new com.visualcast.player.server.CentralControlServer(MainActivity.this, iotEngine, 8000, 8001);
                    centralControlServer.start();
                } catch (Exception e) {
                    android.util.Log.w("VisualCast", "启动外部中控服务异常: " + e.getMessage());
                }

                // 8. 启动定时开关机与闭馆排程后台守护引擎
                try {
                    scheduledShutdownManager = new com.visualcast.player.server.ScheduledShutdownManager(MainActivity.this);
                    scheduledShutdownManager.start();
                } catch (Exception e) {
                    android.util.Log.w("VisualCast", "启动定时排程引擎异常: " + e.getMessage());
                }

                // 9. 启动原生级每秒活跃心跳保底打点
                heartbeatHandler.post(heartbeatRunnable);

                // 10. 核心服务就绪，通知主线程加载大屏端网页
                runOnUiThread(this::loadPlayerView);

            } catch (Exception e) {
                android.util.Log.e("VisualCast", "后台微服务初始化异常: " + e.getMessage(), e);
                runOnUiThread(this::loadPlayerView);
            }
        }, "VC-AsyncStartup").start();
    }

    public static volatile boolean isExternalDocActive = false;
    private ValueCallback<android.net.Uri[]> uploadMessage;
    private static final int FILE_CHOOSER_RESULT_CODE = 2001;

    private com.visualcast.player.utils.UsbMountReceiver usbReceiver;
    private com.visualcast.player.utils.UsbMountReceiver usbDeviceReceiver;

    private void registerUsbReceiver() {
        try {
            usbReceiver = new com.visualcast.player.utils.UsbMountReceiver();
            android.content.IntentFilter filter = new android.content.IntentFilter();
            filter.addAction(Intent.ACTION_MEDIA_MOUNTED);
            filter.addAction(Intent.ACTION_MEDIA_UNMOUNTED);
            filter.addAction(Intent.ACTION_MEDIA_REMOVED);
            filter.addAction("android.intent.action.MEDIA_CHECKING");
            filter.addDataScheme("file");
            registerReceiver(usbReceiver, filter);
        } catch (Exception ignored) {}

        try {
            usbDeviceReceiver = new com.visualcast.player.utils.UsbMountReceiver();
            android.content.IntentFilter usbDeviceFilter = new android.content.IntentFilter();
            usbDeviceFilter.addAction(android.hardware.usb.UsbManager.ACTION_USB_DEVICE_ATTACHED);
            usbDeviceFilter.addAction(android.hardware.usb.UsbManager.ACTION_USB_DEVICE_DETACHED);
            registerReceiver(usbDeviceReceiver, usbDeviceFilter);
        } catch (Exception ignored) {}

        startUsbPollingThread();
    }

    /**
     * 后台无感心跳守护线程：每 8 秒探测外置卷并比对盘符变动 (降低空载唤醒频率，彻底根除CPU与Flash开销)
     */
    private void startUsbPollingThread() {
        usbPollingThread = new Thread(() -> {
            java.util.Set<String> lastKnownVolumes = new java.util.HashSet<>();

            // 关键：冷启动初始基线预热！静默收录启动时刻已有的挂载卷
            try {
                java.util.Set<File> initVols = com.visualcast.player.utils.UsbMountReceiver.getUsbVolumes(MainActivity.this);
                for (File f : initVols) {
                    lastKnownVolumes.add(f.getAbsolutePath());
                }
                android.util.Log.i("VisualCastUsb", "U盘轮询守护线程初始化完成，初始基线外置卷数量: " + lastKnownVolumes.size());
            } catch (Exception ignored) {}

            while (!isFinishing() && !isDestroyed()) {
                try {
                    Thread.sleep(8000);

                    // 扫描系统真实有效的外置存储卷 (全面兼容全志、瑞芯微、晶晨及各品牌商显板)
                    java.util.Set<File> currentVols = com.visualcast.player.utils.UsbMountReceiver.getUsbVolumes(MainActivity.this);
                    if (!currentVols.isEmpty()) {
                        java.util.Set<String> currentPaths = new java.util.HashSet<>();
                        boolean hasNewUsb = false;

                        for (File f : currentVols) {
                            String p = f.getAbsolutePath();
                            currentPaths.add(p);
                            if (!lastKnownVolumes.contains(p)) {
                                hasNewUsb = true;
                            }
                        }

                        // 仅当确实有全新物理 U 盘卷接入时才触发同步！绝对不比对文件修改时间，彻底根治自我触发死循环！
                        if (hasNewUsb && !currentPaths.isEmpty()) {
                            android.util.Log.i("VisualCastUsb", "心跳轮询探测到全新物理外置 U 盘卷接入: " + currentPaths);
                            lastKnownVolumes = new java.util.HashSet<>(currentPaths);
                            com.visualcast.player.utils.UsbMountReceiver.triggerManualScan(MainActivity.this);
                        } else {
                            lastKnownVolumes = currentPaths;
                        }
                    } else {
                        // 核心：若当前无外置卷 (U盘已拔出)，立即清空基线，确保再次插入时可被秒级识别！
                        if (!lastKnownVolumes.isEmpty()) {
                            android.util.Log.i("VisualCastUsb", "检测到所有外置 U 盘均已拔出，清空挂载基线");
                            lastKnownVolumes.clear();
                        }
                    }
                } catch (InterruptedException e) {
                    break;
                } catch (Exception ignored) {}
            }
        }, "VC-UsbPollingThread");
        usbPollingThread.start();
    }

    public void showScreenToast(final String msg) {
        runOnUiThread(() -> {
            try {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                if (webView != null) {
                    webView.evaluateJavascript(
                        "if (typeof showPlayerToast === 'function') { showPlayerToast(" + JSONObject.quote(msg) + ", 'U盘同步'); } else if (typeof showToast === 'function') { showToast(" + JSONObject.quote(msg) + "); }", null);
                }
            } catch (Exception ignored) {}
        });
    }

    public void reloadWebView() {
        runOnUiThread(() -> {
            if (webView != null) {
                webView.reload();
            }
        });
    }

    public void notifyUsbMediaUpdated() {
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                    "try { var fn = (window.applyCommand || (typeof applyCommand === 'function' ? applyCommand : null)); if (fn) fn('REFRESH_LIBRARY_AND_PLAY', { folder: '待机', force_reload: true, force_play: true, is_usb: true }); } catch(e){}", null);
            }
        });
    }

    public void triggerSleepTransition(final boolean sleep) {
        if (sleep) {
            // 按用户要求：彻底删除待机、休眠功能，保留按钮，商显大屏保持常亮放映
            android.util.Log.i("VisualCast", "待机休眠功能已删除，商显大屏保持常亮放映");
            isScreenAsleep = false;
            return;
        }
        isScreenAsleep = false;
        com.visualcast.player.server.HttpRouter.setGlobalSleepMode(false);
        com.visualcast.player.server.HttpRouter.updateBlackoutState(false);
        runOnUiThread(() -> {
            try {
                com.visualcast.player.utils.SystemHelper.bringVisualCastToFront(MainActivity.this);
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm != null) {
                        wakeLock = pm.newWakeLock(PowerManager.FULL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE, "VisualCast:Wakeup");
                    }
                }
                if (wakeLock != null && !wakeLock.isHeld()) {
                    wakeLock.acquire(10000);
                }
            } catch (Exception ignored) {}
            if (webView != null) {
                try {
                    webView.onResume();
                    webView.resumeTimers();
                } catch (Exception ignored) {}
                String js = "try { if (window.setBlackout) window.setBlackout(false); if (window.triggerSystemPowerOn) window.triggerSystemPowerOn(); if (window.returnToStandby) window.returnToStandby(true); if (window.applyCommand) window.applyCommand('WAKEUP'); } catch(e){}";
                webView.evaluateJavascript(js, null);
            }
        });
    }

    private void checkPermissionsAndLoad() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] perms = {
                    android.Manifest.permission.READ_EXTERNAL_STORAGE,
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            };
            boolean needReq = false;
            for (String p : perms) {
                if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                    needReq = true;
                    break;
                }
            }
            if (needReq) {
                ActivityCompat.requestPermissions(this, perms, 1001);
            }
        }
        loadPlayerView();
    }

    private void checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                if (!android.os.Environment.isExternalStorageManager()) {
                    android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(android.net.Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                }
            } catch (Exception e) {
                try {
                    android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    startActivity(intent);
                } catch (Exception ignored) {}
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] perms = {
                android.Manifest.permission.READ_EXTERNAL_STORAGE,
                android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            };
            boolean need = false;
            for (String p : perms) {
                if (checkSelfPermission(p) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    need = true;
                    break;
                }
            }
            if (need) {
                requestPermissions(perms, 1001);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        StorageHelper.getMediaDir(this);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (uploadMessage == null) return;
            android.net.Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new android.net.Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new android.net.Uri[]{data.getData()};
                }
            }
            uploadMessage.onReceiveValue(results);
            uploadMessage = null;
        }
    }

    

    private void loadPlayerView() {
        if (webView != null) {
            final String targetUrl = "http://127.0.0.1:8088/player";
            android.util.Log.i("VisualCast", "大屏 WebView 加载地址: " + targetUrl);
            webView.postDelayed(() -> {
                if (webView != null) {
                    webView.loadUrl(targetUrl);
                }
            }, 300);
        }
    }

    /**
     * 沉浸式粘性全屏模式 (彻底消除底部虚拟键和顶部状态栏)
     */
    private void hideSystemUI() {
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
        );
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUI();
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (isExternalDocActive) {
            if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
                com.visualcast.player.utils.SystemHelper.controlWPSPresentation(this, "close");
                isExternalDocActive = false;
                com.visualcast.player.utils.FloatingBallHelper.hideReturnBall();
                if (webView != null) {
                    webView.evaluateJavascript("if (typeof returnToStandby === 'function') { returnToStandby(); } else if (typeof playNextTrack === 'function') { playNextTrack(); }", null);
                }
                return true;
            }
        }

        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
            if (webView != null) {
                webView.evaluateJavascript("if (typeof togglePlayPause === 'function') togglePlayPause(); else if (typeof applyCommand === 'function') applyCommand('TOGGLE_PLAY');", null);
            }
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY) {
            if (webView != null) {
                webView.evaluateJavascript("if (typeof playCurrentMedia === 'function') playCurrentMedia(); else if (typeof applyCommand === 'function') applyCommand('PLAY');", null);
            }
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            if (webView != null) {
                webView.evaluateJavascript("if (typeof pauseCurrentMedia === 'function') pauseCurrentMedia(); else if (typeof applyCommand === 'function') applyCommand('PAUSE');", null);
            }
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_MEDIA_STOP) {
            if (webView != null) {
                webView.evaluateJavascript("if (typeof stopMedia === 'function') stopMedia(); else if (typeof applyCommand === 'function') applyCommand('STOP');", null);
            }
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_PAGE_DOWN || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT || keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
            if (webView != null) {
                webView.evaluateJavascript("if (typeof nextMedia === 'function') nextMedia(); else if (typeof applyCommand === 'function') applyCommand('NEXT');", null);
            }
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_PAGE_UP || keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
            if (webView != null) {
                webView.evaluateJavascript("if (typeof prevMedia === 'function') prevMedia(); else if (typeof applyCommand === 'function') applyCommand('PREV');", null);
            }
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_H || keyCode == KeyEvent.KEYCODE_MENU || keyCode == 72 || keyCode == 82) {
            // 物理键盘按 H 键 (72) 或 红外遥控器按下 MENU 菜单键 (82)
            if (webView != null) {
                webView.evaluateJavascript("if (typeof window.togglePanel === 'function') { window.togglePanel(); }", null);
            }
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_BACK) {
            long now = System.currentTimeMillis();
            if (now - lastBackPressTime < 2500) {
                // 2.5秒内连续按两次返回键，无条件安全退出播控，彻底杜绝死锁与困在全屏
                finish();
                return true;
            }
            lastBackPressTime = now;
            Toast.makeText(MainActivity.this, "再次点击返回键退出系统", Toast.LENGTH_SHORT).show();
            // 尝试通知网页端收起侧边设置面板
            if (webView != null) {
                try {
                    webView.evaluateJavascript(
                        "(function(){" +
                        "  const p = document.getElementById('control-panel');" +
                        "  if (p && !p.classList.contains('hidden')) { p.classList.add('hidden'); }" +
                        "})()", null
                    );
                } catch (Exception ignored) {}
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUI();
        if (webView != null) {
            try {
                webView.onResume();
                webView.resumeTimers();
            } catch (Exception ignored) {}
        }

        // 仅在真实息屏唤醒时触发系统开机点亮流程
        if (isScreenAsleep) {
            isScreenAsleep = false;
            android.util.Log.i("VisualCast", "感知真实息屏待机态恢复，自动唤醒播控视窗");
            if (webView != null) {
                webView.postDelayed(() -> {
                    if (webView != null) {
                        webView.evaluateJavascript(
                            "try { if (window.setBlackout) window.setBlackout(false); var fn = (window.triggerSystemPowerOn || (typeof triggerSystemPowerOn === 'function' ? triggerSystemPowerOn : null)); if (fn) fn(); else { var r = (window.returnToStandby || (typeof returnToStandby === 'function' ? returnToStandby : null)); if (r) r(); } } catch(e){}", null);
                    }
                }, 300);
            }
        } else if (isExternalDocActive) {
            android.util.Log.i("VisualCast", "检测到从外部文档查看器切回 VisualCast 主界面，自动恢复播控");
            isExternalDocActive = false;
            com.visualcast.player.utils.FloatingBallHelper.hideReturnBall();
            if (webView != null) {
                webView.postDelayed(() -> {
                    if (webView != null) {
                        webView.evaluateJavascript(
                            "try { if (window.setBlackout) window.setBlackout(false); var fn = (window.triggerSystemPowerOn || (typeof triggerSystemPowerOn === 'function' ? triggerSystemPowerOn : null)); if (fn) fn(); else { var r = (window.returnToStandby || (typeof returnToStandby === 'function' ? returnToStandby : null)); if (r) r(); } } catch(e){}", null);
                    }
                }, 300);
            }
        }
        // 普通的界面切入 (如关弹窗、文件选择返回) 严禁调用 returnToStandby，杜绝打断当前正常播放中的媒体！
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 关键防护：普通 Activity 切出严禁篡改 isScreenAsleep，必须由系统底层屏幕广播决定
        if (webView != null && !isExternalDocActive) {
            try {
                webView.onPause();
            } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        heartbeatHandler.removeCallbacks(heartbeatRunnable);
        if (instance == this) {
            instance = null;
        }
        if (usbPollingThread != null) {
            usbPollingThread.interrupt();
            usbPollingThread = null;
        }
        if (usbReceiver != null) {
            try {
                unregisterReceiver(usbReceiver);
            } catch (Exception ignored) {}
            usbReceiver = null;
        }
        if (usbDeviceReceiver != null) {
            try {
                unregisterReceiver(usbDeviceReceiver);
            } catch (Exception ignored) {}
            usbDeviceReceiver = null;
        }
        if (screenReceiver != null) {
            try {
                unregisterReceiver(screenReceiver);
            } catch (Exception ignored) {}
            screenReceiver = null;
        }
        FloatingBallHelper.hideReturnBall();
        if (centralControlServer != null) {
            centralControlServer.stop();
            centralControlServer = null;
        }
        if (scheduledShutdownManager != null) {
            scheduledShutdownManager.stop();
            scheduledShutdownManager = null;
        }
        if (httpServer != null) {
            httpServer.stop();
        }
        if (nativeCastServer != null) {
            nativeCastServer.stop();
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            try { multicastLock.release(); } catch (Exception ignored) {}
        }
        if (vncServer != null) {
            vncServer.stop();
        }
        if (com.visualcast.player.server.ScreenStreamEngine.getInstance() != null) {
            com.visualcast.player.server.ScreenStreamEngine.getInstance().stop();
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        if (webView != null) {
            webView.destroy();
        }
    }
}
