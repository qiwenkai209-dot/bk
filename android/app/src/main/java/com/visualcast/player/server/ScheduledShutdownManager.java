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
    public static volatile String lastExecutedShutdownStamp = "";
    public static volatile String lastExecutedBootStamp = "";

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

            // 1. 定时关机/待机排程核验：重调用【待机按钮】标准指令链 (STOP + BLACKOUT)
            String shutdownTime = cfg.optString("shutdown_time", cfg.optString("time", "21:30")).trim();
            String currentShutdownStamp = todayStr + "_" + shutdownTime;
            if (nowTimeStr.equals(shutdownTime)) {
                if (!todayCancelled && !currentShutdownStamp.equals(lastExecutedShutdownStamp)) {
                    lastExecutedShutdownStamp = currentShutdownStamp;
                    Log.i(TAG, "🌙 命中定时闭馆关机时刻: " + nowTimeStr + "，自动重调用【待机按钮】标准指令链 (停止放映 + 开启黑场)");
                    HttpRouter.setGlobalSleepMode(true);
                    HttpRouter.updateBlackoutState(true);
                    MainActivity act = MainActivity.getInstance();
                    if (act != null) {
                        act.dispatchCommandToWeb("STOP", new JSONObject());
                        JSONObject pBlackout = new JSONObject();
                        try { pBlackout.put("blackout", true); } catch(Exception ignored) {}
                        act.dispatchCommandToWeb("BLACKOUT", pBlackout);
                        act.triggerSleepTransition(true);
                    }
                }
            } else {
                if (!nowTimeStr.equals(shutdownTime) && todayCancelled && !currentShutdownStamp.equals(lastExecutedShutdownStamp)) {
                    todayCancelled = false;
                }
            }

            // 2. 定时开机/唤醒排程核验：重调用【唤醒按钮】标准指令链 (解除黑场 + 播放待机素材 + 永久常亮)
            boolean bootEnabled = cfg.optBoolean("boot_enabled", false);
            String bootTime = cfg.optString("boot_time", "08:30").trim();
            String currentBootStamp = todayStr + "_" + bootTime;
            if (bootEnabled && nowTimeStr.equals(bootTime)) {
                if (!currentBootStamp.equals(lastExecutedBootStamp)) {
                    lastExecutedBootStamp = currentBootStamp;
                    Log.i(TAG, "☀️ 命中定时开馆开机时刻: " + nowTimeStr + "，自动重调用【唤醒按钮】标准指令链 (解除黑场 + 播放待机 + 永久高亮)");
                    HttpRouter.setGlobalSleepMode(false);
                    HttpRouter.updateBlackoutState(false);
                    MainActivity act = MainActivity.getInstance();
                    if (act != null) {
                        JSONObject pBlackout = new JSONObject();
                        try { pBlackout.put("blackout", false); } catch(Exception ignored) {}
                        act.dispatchCommandToWeb("BLACKOUT", pBlackout);
                        act.dispatchCommandToWeb("RETURN_TO_STANDBY", new JSONObject());
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
