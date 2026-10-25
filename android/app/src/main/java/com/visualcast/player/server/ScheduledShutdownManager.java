package com.visualcast.player.server;

import android.content.Context;
import android.util.Log;
import com.visualcast.player.MainActivity;
import com.visualcast.player.utils.StorageHelper;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * 展厅闭馆与定时开关机后台排程守护引擎
 * 自动核验周排程星期及 HH:mm 时间点，执行安全黑场休眠闭馆与自动开馆唤醒
 */
public class ScheduledShutdownManager {
    private static final String TAG = "VisualCastScheduler";
    private final Context context;
    private volatile boolean isRunning = false;
    private Thread workerThread;

    public static volatile boolean todayCancelled = false;
    public static volatile String lastExecutedDate = "";
    public static volatile String lastExecutedBootDate = "";

    public ScheduledShutdownManager(Context context) {
        this.context = context;
    }

    public synchronized void start() {
        if (isRunning) return;
        isRunning = true;
        workerThread = new Thread(() -> {
            Log.i(TAG, "定时开关机与闭馆守护引擎已启动 (15秒精密检测)");
            while (isRunning) {
                try {
                    Thread.sleep(15000); // 15秒精密轮询，绝不错过排程时刻
                    checkSchedule();
                } catch (InterruptedException e) {
                    break;
                } catch (Exception e) {
                    Log.w(TAG, "排程核验异常: " + e.getMessage());
                }
            }
        }, "VC-SchedulerWorker");
        workerThread.start();
    }

    private void checkSchedule() {
        File cfgFile = new File(StorageHelper.getConfigDir(context), "scheduled_shutdown.json");
        if (!cfgFile.exists()) return;

        try {
            String content;
            try (FileInputStream fis = new FileInputStream(cfgFile)) {
                byte[] b = new byte[(int) cfgFile.length()];
                fis.read(b);
                content = new String(b, StandardCharsets.UTF_8);
            }
            if (content.trim().isEmpty()) return;
            JSONObject cfg = new JSONObject(content);

            boolean enabled = cfg.optBoolean("enabled", false);
            if (!enabled) return;

            Calendar cal = Calendar.getInstance();
            // Calendar.DAY_OF_WEEK: Sunday is 1, Monday is 2 ... Saturday is 7
            int dayOfWeek = cal.get(Calendar.DAY_OF_WEEK);
            int isoWeekday = (dayOfWeek == Calendar.SUNDAY) ? 7 : (dayOfWeek - 1);

            JSONArray weekdays = cfg.optJSONArray("weekdays");
            boolean dayMatched = false;
            if (weekdays != null && weekdays.length() > 0) {
                for (int i = 0; i < weekdays.length(); i++) {
                    if (weekdays.optInt(i) == isoWeekday) {
                        dayMatched = true;
                        break;
                    }
                }
            } else {
                dayMatched = true; // 默认每天生效
            }
            if (!dayMatched) return;

            SimpleDateFormat dfDate = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
            String todayStr = dfDate.format(new Date());

            SimpleDateFormat dfTime = new SimpleDateFormat("HH:mm", Locale.getDefault());
            String nowTimeStr = dfTime.format(new Date());

            // 1. 关机/待机排程核验：停止放映并切入黑场待机
            String shutdownTime = cfg.optString("shutdown_time", cfg.optString("time", "21:30")).trim();
            if (nowTimeStr.equals(shutdownTime)) {
                if (!todayCancelled && !todayStr.equals(lastExecutedDate)) {
                    lastExecutedDate = todayStr;
                    Log.i(TAG, "命中定时关机排程时刻: " + nowTimeStr + "，触发黑场待机");
                    HttpRouter.setGlobalSleepMode(true);
                    MainActivity act = MainActivity.getInstance();
                    if (act != null) {
                        act.triggerSleepTransition(true);
                    }
                }
            } else {
                if (!nowTimeStr.equals(shutdownTime) && todayCancelled && !todayStr.equals(lastExecutedDate)) {
                    todayCancelled = false;
                }
            }

            // 2. 开机/唤醒排程核验：强力唤醒屏幕、解除黑场并永久保持高亮常亮放映
            boolean bootEnabled = cfg.optBoolean("boot_enabled", false);
            String bootTime = cfg.optString("boot_time", "08:30").trim();
            if (bootEnabled && nowTimeStr.equals(bootTime)) {
                if (!todayStr.equals(lastExecutedBootDate)) {
                    lastExecutedBootDate = todayStr;
                    Log.i(TAG, "命中开馆开机排程: " + nowTimeStr + "，触发自动强力亮屏与待机播放");
                    HttpRouter.setGlobalSleepMode(false);
                    MainActivity act = MainActivity.getInstance();
                    if (act != null) {
                        act.triggerSleepTransition(false);
                    }
                }
            }

        } catch (Exception e) {
            Log.w(TAG, "读取排程异常: " + e.getMessage());
        }
    }

    public synchronized void stop() {
        isRunning = false;
        if (workerThread != null) {
            workerThread.interrupt();
            workerThread = null;
        }
        Log.i(TAG, "定时开关机守护引擎已停止");
    }
}
