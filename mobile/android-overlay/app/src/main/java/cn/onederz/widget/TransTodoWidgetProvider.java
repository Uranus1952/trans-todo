package cn.onederz.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Onederz · 桌面小组件（AppWidget，类似天气卡片）
 *
 * 数据流：App 端任务变化 → FloatingWidgetPlugin.updateWidget(JSON) →
 * SharedPreferences("trans_todo_widget") → 本 Provider 重绘 RemoteViews。
 *
 * 关键设计：存的是**任务原始数据**（标题 / 类型 / 日期 / 完成日），
 * 由组件端按"今天"推导显示 —— 零点后系统周期刷新（updatePeriodMillis）时，
 * 即使 App 没打开，常驻任务也会自动回到未完成状态，与主界面逻辑一致。
 */
public class TransTodoWidgetProvider extends AppWidgetProvider {

    static final String PREFS = "trans_todo_widget";
    static final String KEY_SNAPSHOT = "snapshot";
    private static final int MAX_LINES = 9;

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        RemoteViews rv = buildRemoteViews(context);
        for (int id : appWidgetIds) {
            mgr.updateAppWidget(id, rv);
        }
    }

    /** 由 FloatingWidgetPlugin.updateWidget() 调用：任务变化后刷新所有组件实例 */
    public static void updateAll(Context context) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            if (mgr == null) return;
            ComponentName me = new ComponentName(context, TransTodoWidgetProvider.class);
            int[] ids = mgr.getAppWidgetIds(me);
            RemoteViews rv = buildRemoteViews(context);
            for (int id : ids) {
                mgr.updateAppWidget(id, rv);
            }
        } catch (Exception ignored) {
            /* 组件未添加到桌面等场景，静默即可 */
        }
    }

    static RemoteViews buildRemoteViews(Context context) {
        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.trans_todo_widget);
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());

        int total = 0, done = 0, rows = 0;
        StringBuilder lines = new StringBuilder();
        try {
            SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray arr = new JSONArray(sp.getString(KEY_SNAPSHOT, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject t = arr.getJSONObject(i);
                boolean isDaily = "daily".equals(t.optString("ty"));
                boolean isTodayTemp = "temp".equals(t.optString("ty")) && today.equals(t.optString("d", ""));
                if (!isDaily && !isTodayTemp) continue; // 过期临时任务 / 非今日，不显示

                boolean isDone = today.equals(t.optString("dd", ""));
                total++;
                if (isDone) done++;
                if (rows >= MAX_LINES) continue;
                if (lines.length() > 0) lines.append('\n');
                String title = t.optString("t", "");
                lines.append(isDone ? "✓ " : "□ ").append(title.isEmpty() ? "（空）" : title);
                rows++;
            }
        } catch (Exception ignored) {
        }

        rv.setTextViewText(R.id.widget_count, done + " / " + total);
        rv.setTextViewText(R.id.widget_body,
                total == 0 ? "今天没有待办\n点这里打开添加 +" : lines.toString());

        // 点组件任意位置 → 打开 App
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) launch = new Intent(context, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(context, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        rv.setOnClickPendingIntent(R.id.widget_root, pi);
        return rv;
    }
}
