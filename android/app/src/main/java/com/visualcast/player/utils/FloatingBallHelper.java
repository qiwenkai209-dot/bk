package com.visualcast.player.utils;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.visualcast.player.MainActivity;
import org.json.JSONObject;

/**
 * 第三方应用置顶悬浮返回与放映控制胶囊管理器
 * 当大屏唤起外部 WPS Office 或第三方应用程序时，在屏幕右上边缘自动挂载半透明触控工具胶囊
 * 包含【⏮ 上一页】、【⏭ 下一页】、【✕ 退出放映】三个高响应触摸按钮
 * 触碰即可跨进程控制翻页或退出第三方应用切回 VisualCast 主播控视窗
 */
public class FloatingBallHelper {
    private static final String TAG = "FloatingBallHelper";
    private static WindowManager windowManager;
    private static View floatingView;
    private static boolean isShowing = false;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    @SuppressLint("ClickableViewAccessibility")
    public static void showReturnBall(final Context context) {
        if (context == null) return;
        mainHandler.post(() -> {
            synchronized (FloatingBallHelper.class) {
                if (isShowing) return;
                try {
                    // Android 6.0+ 悬浮窗权限安全校验
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        if (!Settings.canDrawOverlays(context)) {
                            Log.w(TAG, "未授予悬浮窗权限，无法显示置顶放映控制球");
                            return;
                        }
                    }

                    windowManager = (WindowManager) context.getApplicationContext().getSystemService(Context.WINDOW_SERVICE);
                    if (windowManager == null) return;

                    final LinearLayout container = new LinearLayout(context.getApplicationContext());
                    container.setOrientation(LinearLayout.HORIZONTAL);
                    container.setGravity(Gravity.CENTER_VERTICAL);
                    container.setPadding(16, 10, 16, 10);

                    // 醒目科技深蓝半透明圆角胶囊背景
                    GradientDrawable bg = new GradientDrawable();
                    bg.setColor(Color.parseColor("#E60F172A")); // 深色高保真毛玻璃底色
                    bg.setCornerRadius(36);
                    bg.setStroke(2, Color.parseColor("#38BDF8")); // 荧光青蓝边框
                    container.setBackground(bg);

                    // 1. 上一页按钮
                    TextView btnPrev = new TextView(context.getApplicationContext());
                    btnPrev.setText(" ⏮ 上页 ");
                    btnPrev.setTextColor(Color.parseColor("#E0F2FE"));
                    btnPrev.setTextSize(14);
                    btnPrev.setPadding(18, 12, 18, 12);
                    GradientDrawable prevBg = new GradientDrawable();
                    prevBg.setColor(Color.parseColor("#330284C7"));
                    prevBg.setCornerRadius(20);
                    btnPrev.setBackground(prevBg);

                    // 2. 下一页按钮
                    TextView btnNext = new TextView(context.getApplicationContext());
                    btnNext.setText(" ⏭ 下页 ");
                    btnNext.setTextColor(Color.parseColor("#E0F2FE"));
                    btnNext.setTextSize(14);
                    btnNext.setPadding(18, 12, 18, 12);
                    LinearLayout.LayoutParams nextLp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                    nextLp.setMargins(12, 0, 12, 0);
                    btnNext.setLayoutParams(nextLp);
                    GradientDrawable nextBg = new GradientDrawable();
                    nextBg.setColor(Color.parseColor("#330284C7"));
                    nextBg.setCornerRadius(20);
                    btnNext.setBackground(nextBg);

                    // 3. 退出放映按钮
                    TextView btnClose = new TextView(context.getApplicationContext());
                    btnClose.setText(" ✕ 退出放映 ");
                    btnClose.setTextColor(Color.WHITE);
                    btnClose.setTextSize(14);
                    btnClose.setTypeface(null, android.graphics.Typeface.BOLD);
                    btnClose.setPadding(20, 12, 20, 12);
                    GradientDrawable closeBg = new GradientDrawable();
                    closeBg.setColor(Color.parseColor("#DC2626")); // 警示红色退出
                    closeBg.setCornerRadius(20);
                    btnClose.setBackground(closeBg);

                    container.addView(btnPrev);
                    container.addView(btnNext);
                    container.addView(btnClose);

                    // 适配系统浮窗类型
                    int layoutType;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        layoutType = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
                    } else {
                        layoutType = WindowManager.LayoutParams.TYPE_PHONE;
                    }

                    final WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        layoutType,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                        PixelFormat.TRANSLUCENT
                    );

                    params.gravity = Gravity.TOP | Gravity.END;
                    params.x = 24;
                    params.y = 80;

                    // 拖拽支持
                    container.setOnTouchListener(new View.OnTouchListener() {
                        private int initialX, initialY;
                        private float initialTouchX, initialTouchY;

                        @Override
                        public boolean onTouch(View v, MotionEvent event) {
                            switch (event.getAction()) {
                                case MotionEvent.ACTION_DOWN:
                                    initialX = params.x;
                                    initialY = params.y;
                                    initialTouchX = event.getRawX();
                                    initialTouchY = event.getRawY();
                                    return false; // 让子按钮正常接收点击

                                case MotionEvent.ACTION_MOVE:
                                    int dx = (int) (initialTouchX - event.getRawX());
                                    int dy = (int) (event.getRawY() - initialTouchY);
                                    if (Math.abs(dx) > 15 || Math.abs(dy) > 15) {
                                        params.x = initialX + dx;
                                        params.y = initialY + dy;
                                        try {
                                            windowManager.updateViewLayout(container, params);
                                        } catch (Exception ignored) {}
                                        return true;
                                    }
                                    break;
                            }
                            return false;
                        }
                    });

                    // 点击事件绑定
                    btnPrev.setOnClickListener(v -> {
                        SystemHelper.controlWPSPresentation(context, "prev");
                    });

                    btnNext.setOnClickListener(v -> {
                        SystemHelper.controlWPSPresentation(context, "next");
                    });

                    btnClose.setOnClickListener(v -> {
                        hideReturnBall();
                        SystemHelper.controlWPSPresentation(context, "close");
                        SystemHelper.bringVisualCastToFront(context);
                        MainActivity.isExternalDocActive = false;
                        if (MainActivity.instance != null) {
                            MainActivity.instance.dispatchCommandToWeb("DOC_EXIT", new JSONObject());
                            MainActivity.instance.runOnUiThread(() -> {
                                if (MainActivity.instance.webView != null) {
                                    MainActivity.instance.webView.evaluateJavascript(
                                        "if (typeof returnToStandby === 'function') { returnToStandby(); } else if (typeof playNextTrack === 'function') { playNextTrack(); }", null);
                                }
                            });
                        }
                    });

                    windowManager.addView(container, params);
                    floatingView = container;
                    isShowing = true;
                    Log.i(TAG, "成功挂载置顶放映返回控制胶囊");
                } catch (Exception e) {
                    Log.e(TAG, "创建置顶放映悬浮窗异常: " + e.getMessage(), e);
                    isShowing = false;
                }
            }
        });
    }

    public static void hideReturnBall() {
        mainHandler.post(() -> {
            synchronized (FloatingBallHelper.class) {
                if (!isShowing || floatingView == null || windowManager == null) {
                    isShowing = false;
                    floatingView = null;
                    return;
                }
                try {
                    windowManager.removeView(floatingView);
                    Log.i(TAG, "成功移除置顶放映悬浮窗");
                } catch (Exception ignored) {}
                floatingView = null;
                isShowing = false;
            }
        });
    }
}
