package com.planner.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 1.7.9: напоминание от помощника тем, кто ушёл.
 *
 * Страница при каждом открытии присылает план (scheduleNudge): кто говорит
 * и 1–2 реплики со временем показа. Пока человек открывает приложение, план
 * всё время переписывается и сдвигается вперёд, поэтому реплика приходит
 * только если приложение не открывали: «цель так и не создана» через день,
 * «не заходил» через два.
 *
 * Будильник неточный (setAndAllowWhileIdle) — разрешений не требует, минута
 * туда-сюда здесь не важна. После перезагрузки план поднимает BootReceiver.
 * exported=false — будим только сами себя.
 */
public class NudgeReceiver extends BroadcastReceiver {

    private static final String TAG = "PlannerNudge";
    static final String PREFS = "planner_nudge";
    private static final String KEY = "plan";
    private static final String CHANNEL_ID = "planner_helper";
    private static final String ACTION = "com.planner.app.NUDGE";
    private static final int NOTIF_ID = 4100;
    private static final int REQ_ALARM = 4100;
    private static final int REQ_OPEN = 4101;
    /** реплика, чьё время уже прошло больше чем на сутки (телефон был выключен), — не показываем */
    private static final long STALE_MS = 24L * 60 * 60 * 1000;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            show(ctx);
        } catch (Exception e) {
            Log.e(TAG, "show failed: " + e.getMessage());
        }
        try {
            schedule(ctx);
        } catch (Exception e) {
            Log.e(TAG, "reschedule failed: " + e.getMessage());
        }
    }

    // ── план от страницы ─────────────────────────────────────────────

    /** Сохранить новый план и поставить будильник на ближайшую реплику. */
    static void save(Context ctx, String json) {
        try {
            new JSONObject(json);   // мусор не сохраняем
        } catch (Exception e) {
            Log.w(TAG, "bad plan json");
            return;
        }
        prefs(ctx).edit().putString(KEY, json).apply();
        schedule(ctx);
    }

    /** Выключено в настройках — забыть план и снять будильник. */
    static void cancel(Context ctx) {
        prefs(ctx).edit().remove(KEY).apply();
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(ctx));
    }

    /** Будильник на ближайшую будущую реплику плана (или снять, если их нет). */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = alarmIntent(ctx);
        long next = -1;
        try {
            JSONObject plan = load(ctx);
            JSONArray items = plan == null ? null : plan.optJSONArray("items");
            long now = System.currentTimeMillis();
            for (int i = 0; items != null && i < items.length(); i++) {
                long at = items.getJSONObject(i).optLong("at", 0);
                if (at > now - STALE_MS && (next < 0 || at < next)) next = at;
            }
        } catch (Exception e) {
            Log.w(TAG, "schedule parse: " + e.getMessage());
        }
        if (next < 0) {
            am.cancel(pi);
            return;
        }
        long when = Math.max(next, System.currentTimeMillis() + 5000);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        } else {
            am.set(AlarmManager.RTC_WAKEUP, when, pi);
        }
    }

    // ── показ ────────────────────────────────────────────────────────

    /** Показать самую позднюю наступившую реплику и убрать из плана все наступившие. */
    private static void show(Context ctx) throws Exception {
        JSONObject plan = load(ctx);
        if (plan == null) return;
        JSONArray items = plan.optJSONArray("items");
        if (items == null) return;

        long now = System.currentTimeMillis();
        JSONObject due = null;
        JSONArray rest = new JSONArray();
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.getJSONObject(i);
            long at = it.optLong("at", 0);
            if (at <= now + 60000) {
                if (at > now - STALE_MS && (due == null || at > due.optLong("at", 0))) due = it;
            } else {
                rest.put(it);
            }
        }
        plan.put("items", rest);
        prefs(ctx).edit().putString(KEY, plan.toString()).apply();
        if (due == null) return;

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !nm.areNotificationsEnabled()) return;

        ensureChannel(ctx, nm, plan.optString("channel", "Helper"), plan.optString("channelDesc", ""));

        String title = due.optString("title", "Planner");
        String text = due.optString("text", "");
        String who = plan.optString("char", "nadia");

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra(MainActivity.EXTRA_OPEN, "helper");
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, REQ_OPEN, open, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL_ID)
                : new Notification.Builder(ctx);
        b.setSmallIcon(R.drawable.ic_notif)
         .setContentTitle(title)
         .setContentText(text)
         .setStyle(new Notification.BigTextStyle().bigText(text))
         .setContentIntent(pi)
         .setAutoCancel(true)
         .setShowWhen(true);
        Bitmap face = face(ctx, who);
        if (face != null) b.setLargeIcon(face);
        try {
            b.setColor(Color.parseColor(plan.optString("color", "#9b6bff")));
        } catch (Exception ignored) { }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) b.setPriority(Notification.PRIORITY_DEFAULT);
        nm.notify(NOTIF_ID, b.build());
    }

    private static Bitmap face(Context ctx, String who) {
        int id;
        switch (who) {
            case "coach": id = R.drawable.nudge_coach; break;
            case "guru":  id = R.drawable.nudge_guru;  break;
            case "genie": id = R.drawable.nudge_genie; break;
            default:      id = R.drawable.nudge_nadia; break;
        }
        try {
            return BitmapFactory.decodeResource(ctx.getResources(), id);
        } catch (Exception e) {
            return null;
        }
    }

    private static void ensureChannel(Context ctx, NotificationManager nm, String name, String desc) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        if (ch == null) {
            ch = new NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription(desc);
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        } else if (!name.equals(String.valueOf(ch.getName()))) {
            // язык приложения сменили — переименовать канал (важность система не даёт менять, и не надо)
            ch.setName(name);
            ch.setDescription(desc);
            nm.createNotificationChannel(ch);
        }
    }

    // ── служебное ────────────────────────────────────────────────────

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject load(Context ctx) {
        String raw = prefs(ctx).getString(KEY, null);
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private static PendingIntent alarmIntent(Context ctx) {
        Intent i = new Intent(ctx, NudgeReceiver.class);
        i.setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, REQ_ALARM, i, flags);
    }
}
