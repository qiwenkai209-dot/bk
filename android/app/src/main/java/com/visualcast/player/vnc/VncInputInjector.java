package com.visualcast.player.vnc;

import android.content.Context;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import com.visualcast.player.MainActivity;
import com.visualcast.player.utils.SystemHelper;

public class VncInputInjector {

    public static int getScreenWidth(Context context) {
        try {
            WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                DisplayMetrics dm = new DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(dm);
                return dm.widthPixels;
            }
        } catch (Exception ignored) {}
        return 1920;
    }

    public static int getScreenHeight(Context context) {
        try {
            WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                DisplayMetrics dm = new DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(dm);
                return dm.heightPixels;
            }
        } catch (Exception ignored) {}
        return 1080;
    }

    /**
     * 注入点击事件 (三轨智能路由)
     */
    public static void injectTap(float x, float y) {
        // 1. 无障碍手势服务优先 (免 Root，完全合规)
        if (VncAccessibilityService.isAvailable()) {
            boolean ok = VncAccessibilityService.instance.performTap(x, y);
            if (ok) return;
        }

        // 2. Root Shell 极速注入 (展厅板卡高可用)
        if (SystemHelper.isDeviceRooted()) {
            SystemHelper.execRootCmd("input tap " + (int) x + " " + (int) y);
            return;
        }

        // 3. 应用内 WebView 视图事件直接派发兜底
        if (MainActivity.instance != null) {
            MainActivity.instance.runOnUiThread(() -> {
                try {
                    long downTime = SystemClock.uptimeMillis();
                    long eventTime = SystemClock.uptimeMillis() + 10;
                    MotionEvent down = MotionEvent.obtain(downTime, eventTime, MotionEvent.ACTION_DOWN, x, y, 0);
                    MotionEvent up = MotionEvent.obtain(downTime, eventTime + 20, MotionEvent.ACTION_UP, x, y, 0);
                    MainActivity.instance.dispatchTouchEvent(down);
                    MainActivity.instance.dispatchTouchEvent(up);
                    down.recycle();
                    up.recycle();
                } catch (Exception ignored) {}
            });
        }
    }

    /**
     * 注入双击事件
     */
    public static void injectDoubleTap(float x, float y) {
        injectTap(x, y);
        try { Thread.sleep(60); } catch (InterruptedException ignored) {}
        injectTap(x, y);
    }

    /**
     * 注入滑动手势
     */
    public static void injectSwipe(float x1, float y1, float x2, float y2, long duration) {
        if (VncAccessibilityService.isAvailable()) {
            boolean ok = VncAccessibilityService.instance.performSwipe(x1, y1, x2, y2, duration);
            if (ok) return;
        }

        if (SystemHelper.isDeviceRooted()) {
            SystemHelper.execRootCmd("input swipe " + (int) x1 + " " + (int) y1 + " " + (int) x2 + " " + (int) y2 + " " + duration);
        }
    }

    /**
     * 注入物理/系统按键
     */
    public static void injectKeyEvent(int keyCode) {
        // 优先使用 Root 注入系统全局按键
        if (SystemHelper.isDeviceRooted()) {
            SystemHelper.execRootCmd("input keyevent " + keyCode);
            return;
        }

        // 若无障碍可用，特殊按键可通过全局动作分发
        if (VncAccessibilityService.isAvailable()) {
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                VncAccessibilityService.instance.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
                return;
            } else if (keyCode == KeyEvent.KEYCODE_HOME) {
                VncAccessibilityService.instance.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME);
                return;
            }
        }

        // 应用内派发
        if (MainActivity.instance != null) {
            MainActivity.instance.runOnUiThread(() -> {
                try {
                    long now = SystemClock.uptimeMillis();
                    KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0);
                    KeyEvent up = new KeyEvent(now, now + 10, KeyEvent.ACTION_UP, keyCode, 0);
                    MainActivity.instance.dispatchKeyEvent(down);
                    MainActivity.instance.dispatchKeyEvent(up);
                } catch (Exception ignored) {}
            });
        }
    }
}
