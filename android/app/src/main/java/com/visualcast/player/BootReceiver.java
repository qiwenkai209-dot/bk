package com.visualcast.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * VisualCast 工业级展厅大屏通电开机自启动广播接收器 (全场景组合拳保障)
 * 覆盖：
 * 1. 标准冷开机 (BOOT_COMPLETED, LOCKED_BOOT_COMPLETED)
 * 2. 快速启动与特定厂商广播 (QUICKBOOT_POWERON, htc.QUICKBOOT, smdt视美泰主板等)
 * 3. 屏幕解锁/唤醒 (USER_PRESENT)
 * 4. 外部通电瞬间自启 (ACTION_POWER_CONNECTED, 专为通电自启主板打造)
 * 5. 应用覆盖安装更新自启 (MY_PACKAGE_REPLACED, PACKAGE_REPLACED)
 * 6. 开机后网络连通兜底自启 (CONNECTIVITY_CHANGE)
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "VisualCastBoot";
    private static long lastLaunchTimestamp = 0;
    private static final long LAUNCH_DEBOUNCE_MS = 6000; // 6秒防重复防抖

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (action == null) action = "";
        Log.i(TAG, "收到系统保活/自启广播: " + action);

        boolean isTriggerAction = false;

        switch (action) {
            case Intent.ACTION_BOOT_COMPLETED:
            case "android.intent.action.LOCKED_BOOT_COMPLETED":
            case "android.intent.action.QUICKBOOT_POWERON":
            case "com.htc.intent.action.QUICKBOOT_POWERON":
            case Intent.ACTION_REBOOT:
            case "com.smdt.action.BOOT_COMPLETED":
            case "android.intent.action.PRE_BOOT_COMPLETED":
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case Intent.ACTION_PACKAGE_REPLACED:
            case Intent.ACTION_POWER_CONNECTED:
                isTriggerAction = true;
                break;

            case Intent.ACTION_USER_PRESENT:
            case "android.net.conn.CONNECTIVITY_CHANGE":
                // 若应用未处于运行状态或刚刚启动阶段，响应唤醒
                if (MainActivity.getInstance() == null) {
                    isTriggerAction = true;
                }
                break;

            default:
                if (action.contains("BOOT") || action.contains("POWERON")) {
                    isTriggerAction = true;
                }
                break;
        }

        if (!isTriggerAction) {
            return;
        }

        // 核心检查：如果用户已在控制台或播放端关闭开机自启，严格拦截自启动流程
        boolean isAutostartEnabled = true;
        try {
            isAutostartEnabled = context.getSharedPreferences("visualcast_prefs", Context.MODE_PRIVATE)
                    .getBoolean("autostart_enabled", true);
        } catch (Exception ignored) {}

        if (!isAutostartEnabled) {
            Log.i(TAG, "用户已在控制台关闭开机自启，主动拦截并忽略自启动广播: " + action);
            return;
        }

        long now = System.currentTimeMillis();
        // 智能防抖：如果 MainActivity 已经处于前台活跃状态，才执行防抖拦截；如果应用尚未启动成功，坚决不拦截！
        if (MainActivity.getInstance() != null && MainActivity.getInstance().hasWindowFocus()) {
            if (now - lastLaunchTimestamp < LAUNCH_DEBOUNCE_MS) {
                Log.d(TAG, "应用已在前台活跃，防抖忽略广播: " + action);
                return;
            }
        }
        lastLaunchTimestamp = now;

        Log.i(TAG, "===> 触发展馆大屏终端自启动流程 (来源广播: " + action + ") <===");

        // 1. 点亮屏幕与获取短时 CPU WakeLock
        acquireTempWakeLock(context);

        // 2. 多重保险拉起 MainActivity (双轨并行：直接拉起 + Android 10+ 全屏通知穿透)
        launchMainActivity(context);

        // 3. 延迟阶梯二次加固拉起 (防止系统缓慢 Launcher 启动后将应用覆盖到后台)
        scheduleRetryLaunch(context, 1500);
        scheduleRetryLaunch(context, 3500);
        scheduleRetryLaunch(context, 6000);
        scheduleRetryLaunch(context, 9000);
    }

    private void acquireTempWakeLock(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
                        "VisualCast:BootLaunchWakeLock"
                );
                wl.acquire(15000L); // 保持唤醒 15 秒供页面完整加载
            }
        } catch (Exception e) {
            Log.w(TAG, "获取开机 WakeLock 异常: " + e.getMessage());
        }
    }

    private void launchMainActivity(Context context) {
        try {
            Intent launchIntent = new Intent(context, MainActivity.class);
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            context.startActivity(launchIntent);
            Log.i(TAG, "已向系统发出拉起 MainActivity Intent");
        } catch (Exception e) {
            Log.w(TAG, "直接拉起 MainActivity 提示: " + e.getMessage());
        }

        // 关键：在 Android 10+ 上，系统对后台 startActivity 会静默拦截且不抛出 Java 异常，必须同时使用全屏通知穿透
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            launchViaNotification(context);
        }
    }

    private void scheduleRetryLaunch(final Context context, long delayMillis) {
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    if (MainActivity.getInstance() == null || !MainActivity.getInstance().hasWindowFocus()) {
                        Log.i(TAG, "执行开机阶梯加固拉起 (延迟 " + delayMillis + "ms)...");
                        Intent intent = new Intent(context, MainActivity.class);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                        context.startActivity(intent);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            launchViaNotification(context);
                        }
                    }
                } catch (Exception ignored) {}
            }
        }, delayMillis);
    }

    /**
     * 适配 Android 10+ 后台启动 Activity 限制：通过高优先级全屏通知穿透拉起
     */
    private void launchViaNotification(Context context) {
        try {
            String channelId = "visualcast_boot_channel";
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                        channelId,
                        "VisualCast 展厅自启动服务",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("用于开机自动进入大屏播映");
                nm.createNotificationChannel(channel);
            }

            Intent notifyIntent = new Intent(context, MainActivity.class);
            notifyIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(
                    context,
                    0,
                    notifyIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("VisualCast 展厅大屏播控系统")
                    .setContentText("正在启动大屏播控呈现终端...")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setFullScreenIntent(pi, true)
                    .setAutoCancel(true);

            nm.notify(1001, builder.build());
        } catch (Exception ex) {
            Log.e(TAG, "全屏通知穿透拉起异常: " + ex.getMessage());
        }
    }
}
