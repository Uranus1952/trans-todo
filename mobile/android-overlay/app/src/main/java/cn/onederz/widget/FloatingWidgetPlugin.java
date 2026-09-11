package cn.onederz.widget;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Onederz · 悬浮窗插件
 *
 * 给前端（同一套 app.js）暴露三个能力：检查权限、申请权限、开关悬浮窗。
 * 前端检测到 window.Capacitor 且用户点了「开启桌面悬浮」时才会调用。
 */
@CapacitorPlugin(name = "FloatingWidget")
public class FloatingWidgetPlugin extends Plugin {

    /** 是否已获得"在其他应用上层显示"权限 */
    @PluginMethod
    public void isGranted(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasOverlayPermission(getContext()));
        ret.put("running", FloatingWidgetService.isRunning);
        call.resolve(ret);
    }

    /** 跳转到系统设置页让用户授权 */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        Context ctx = getContext();
        if (hasOverlayPermission(ctx)) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
        } catch (Exception e) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
            } catch (Exception ignored) {
            }
        }
        JSObject ret = new JSObject();
        ret.put("granted", false);
        call.resolve(ret);
    }

    /** 显示悬浮窗（同时启动前台服务，避免被系统回收） */
    @PluginMethod
    public void show(PluginCall call) {
        Context ctx = getContext();
        if (!hasOverlayPermission(ctx)) {
            call.reject("尚未获得「在其他应用上层显示」权限");
            return;
        }
        Intent intent = new Intent(ctx, FloatingWidgetService.class);
        intent.setAction(FloatingWidgetService.ACTION_SHOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(ctx, intent);
        } else {
            ctx.startService(intent);
        }
        JSObject ret = new JSObject();
        ret.put("running", true);
        call.resolve(ret);
    }

    /** 关闭悬浮窗 */
    @PluginMethod
    public void hide(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, FloatingWidgetService.class);
        intent.setAction(FloatingWidgetService.ACTION_HIDE);
        try {
            ctx.startService(intent);
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }

    /**
     * 桌面小组件数据同步：前端每次任务变化后调用。
     * 传入任务原始数据的 JSON 数组（t=标题 ty=daily|temp d=日期 dd=完成日），
     * 存入 SharedPreferences 后由 TransTodoWidgetProvider 重绘桌面组件。
     */
    @PluginMethod
    public void updateWidget(PluginCall call) {
        String json = call.getString("data");
        Context ctx = getContext().getApplicationContext();
        ctx.getSharedPreferences(TransTodoWidgetProvider.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(TransTodoWidgetProvider.KEY_SNAPSHOT, json == null ? "[]" : json)
                .apply();
        TransTodoWidgetProvider.updateAll(ctx);
        call.resolve();
    }

    public static boolean hasOverlayPermission(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return Settings.canDrawOverlays(ctx);
        }
        return true;
    }
}
