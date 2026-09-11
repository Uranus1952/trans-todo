package cn.onederz.widget;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Onederz · Android 桌面悬浮窗
 * ---------------------------------------------------------------
 * 把待办挂成 TYPE_APPLICATION_OVERLAY 窗口，浮在其他 App 之上，
 * 与 Windows 端的桌面部件形成一致的"随手可见、随手可用"体验。
 *
 * 关键实现：
 *   1. 复用同一套 Web 前端 —— 用 WebViewAssetLoader 把 assets/public 映射到
 *      https://localhost，与 Capacitor 主 WebView **同源**，因此两者共用同一份
 *      localStorage，不存在"两个界面数据不一致"的问题；
 *   2. 磨砂玻璃 —— Android 12+ 用窗口级模糊（FLAG_BLUR_BEHIND +
 *      setBlurBehindRadius），配合半透明圆角容器，质感与 PC 端对齐；
 *      Android 12 以下退化为半透明圆角填充，仍是玻璃观感；
 *   3. 拖拽与缩放 —— 顶部条拖动移动窗口，右下角热区缩放，位置尺寸持久化。
 */
public class FloatingWidgetService extends Service {

    public static final String ACTION_SHOW = "cn.onederz.widget.SHOW";
    public static final String ACTION_HIDE = "cn.onederz.widget.HIDE";
    public static volatile boolean isRunning = false;

    private static final String CHANNEL_ID = "onederz_widget";
    private static final int NOTI_ID = 4711;
    private static final String PREFS = "onederz_widget";
    private static final int MIN_W_DP = 250;
    private static final int MIN_H_DP = 200;

    private WindowManager windowManager;
    private SharedPreferences prefs;
    private View root;
    private WebView webView;
    private WindowManager.LayoutParams params;
    private WebViewAssetLoader assetLoader;
    private int minW;
    private int minH;

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        minW = dp(MIN_W_DP);
        minH = dp(MIN_H_DP);
        assetLoader = buildAssetLoader();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTI_ID, buildNotification());
        String action = intent != null && intent.getAction() != null ? intent.getAction() : ACTION_SHOW;
        if (ACTION_HIDE.equals(action)) {
            removeOverlay();
            stopSelf();
            return START_NOT_STICKY;
        }
        showOverlay();
        isRunning = true;
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        removeOverlay();
        isRunning = false;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /* ==================== 悬浮窗构建 ==================== */

    private void showOverlay() {
        if (root != null) return;

        final int radius = dp(22);
        // 半透明圆角容器：既提供玻璃底色，也作为 WebView 的裁剪轮廓
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setCornerRadius(radius);
        bg.setColor(0x26FFFFFF);
        bg.setStroke(dp(1), 0x40FFFFFF);

        android.widget.FrameLayout frame = new android.widget.FrameLayout(this);
        frame.setBackground(bg);
        frame.setClipToOutline(true);
        frame.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), radius);
            }
        });

        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.setVerticalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        webView.setWebViewClient(new WebViewClient() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
        });
        attachGestureHandler();
        // 与 Capacitor 主 WebView 同源（https://localhost）→ 共用同一份 localStorage
        webView.loadUrl("https://localhost/index.html?overlay=1");

        frame.addView(webView, new android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT));
        root = frame;

        int w = prefs.getInt("w", dp(320));
        int h = prefs.getInt("h", dp(440));
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        int flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+：真正的窗口级模糊 —— 磨砂玻璃的核心
            flags |= WindowManager.LayoutParams.FLAG_BLUR_BEHIND;
        }

        params = new WindowManager.LayoutParams(w, h, type, flags, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = prefs.getInt("x", dp(20));
        params.y = prefs.getInt("y", dp(180));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setBlurBehindRadius(dp(26));
        }

        try {
            windowManager.addView(root, params);
        } catch (Exception e) {
            root = null;
            webView = null;
        }
    }

    private void removeOverlay() {
        if (root != null && windowManager != null) {
            try {
                windowManager.removeView(root);
            } catch (Exception ignored) {
            }
            root = null;
            webView = null;
        }
        isRunning = false;
    }

    /* ==================== 拖拽 / 缩放 ==================== */

    private void attachGestureHandler() {
        webView.setOnTouchListener(new View.OnTouchListener() {
            private float downRawX, downRawY;
            private int startX, startY, startW, startH;
            private boolean active;
            private boolean resizing;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN: {
                        // 顶部条拖动、右下角缩放，其余区域交还给网页正常交互
                        boolean onBar = e.getY() <= dp(58);
                        boolean onCorner = e.getX() >= v.getWidth() - dp(30)
                                && e.getY() >= v.getHeight() - dp(30);
                        if (!onBar && !onCorner) return false;
                        resizing = onCorner;
                        active = true;
                        downRawX = e.getRawX();
                        downRawY = e.getRawY();
                        startX = params.x;
                        startY = params.y;
                        startW = params.width;
                        startH = params.height;
                        return true;
                    }
                    case MotionEvent.ACTION_MOVE: {
                        if (!active) return false;
                        int dx = (int) (e.getRawX() - downRawX);
                        int dy = (int) (e.getRawY() - downRawY);
                        if (resizing) {
                            params.width = Math.max(minW, startW + dx);
                            params.height = Math.max(minH, startH + dy);
                        } else {
                            params.x = startX + dx;
                            params.y = startY + dy;
                        }
                        try {
                            windowManager.updateViewLayout(root, params);
                        } catch (Exception ignored) {
                        }
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL: {
                        if (active) persistGeometry();
                        active = false;
                        return true;
                    }
                }
                return false;
            }
        });
    }

    private void persistGeometry() {
        if (params == null) return;
        prefs.edit()
                .putInt("x", params.x)
                .putInt("y", params.y)
                .putInt("w", params.width)
                .putInt("h", params.height)
                .apply();
    }

    /* ==================== 资源映射（与 Capacitor 同源） ==================== */

    private WebViewAssetLoader buildAssetLoader() {
        return new WebViewAssetLoader.Builder()
                .setDomain("localhost")
                .addPathHandler("/", path -> {
                    String p = path.startsWith("/") ? path.substring(1) : path;
                    if (p.isEmpty()) p = "index.html";
                    try {
                        InputStream in = getAssets().open("public/" + p);
                        return new WebResourceResponse(mimeOf(p), null, in);
                    } catch (IOException e) {
                        return null;
                    }
                })
                .build();
    }

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("svg", "image/svg+xml");
        MIME.put("woff2", "font/woff2");
    }

    private static String mimeOf(String path) {
        int i = path.lastIndexOf('.');
        String ext = i >= 0 ? path.substring(i + 1).toLowerCase() : "";
        String m = MIME.get(ext);
        return m == null ? "application/octet-stream" : m + "; charset=utf-8";
    }

    /* ==================== 前台通知 ==================== */

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "桌面待办悬浮窗", NotificationManager.IMPORTANCE_MIN);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent hide = new Intent(this, FloatingWidgetService.class).setAction(ACTION_HIDE);
        PendingIntent hp = PendingIntent.getService(this, 1, hide,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("Onederz 待办悬浮中")
                .setContentText("点按打开应用，或从下方操作栏关闭悬浮窗")
                .setSmallIcon(android.R.drawable.checkbox_on_background)
                .setContentIntent(pi)
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            b.addAction(new Notification.Action.Builder(null, "关闭悬浮窗", hp).build());
        }
        return b.build();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }
}
