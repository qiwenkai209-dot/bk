package com.visualcast.player.vnc;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Build;
import android.view.accessibility.AccessibilityEvent;

public class VncAccessibilityService extends AccessibilityService {
    public static volatile VncAccessibilityService instance;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 无需处理事件
    }

    @Override
    public void onInterrupt() {
        instance = null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        instance = null;
    }

    public static boolean isAvailable() {
        return instance != null;
    }

    /**
     * 免 Root 注入单点触摸/点击手势 (Android 7.0+)
     */
    public boolean performTap(float x, float y) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            Path path = new Path();
            path.moveTo(x, y);
            GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 50);
            GestureDescription.Builder builder = new GestureDescription.Builder();
            builder.addStroke(stroke);
            return dispatchGesture(builder.build(), null, null);
        }
        return false;
    }

    /**
     * 免 Root 注入滑动/拖拽手势
     */
    public boolean performSwipe(float x1, float y1, float x2, float y2, long duration) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            Path path = new Path();
            path.moveTo(x1, y1);
            path.lineTo(x2, y2);
            GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, duration);
            GestureDescription.Builder builder = new GestureDescription.Builder();
            builder.addStroke(stroke);
            return dispatchGesture(builder.build(), null, null);
        }
        return false;
    }
}
