package com.planner.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 1.7.9: после перезагрузки телефона и после обновления приложения система
 * забывает будильники. Поднимаем будильник напоминания помощника из
 * сохранённого плана. Шторку с задачами не трогаем — она как и раньше
 * поднимается при открытии приложения.
 *
 * exported=true обязательно для системных событий; оба действия защищены —
 * отправить их может только система.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        try {
            NudgeReceiver.schedule(ctx);
        } catch (Exception e) {
            Log.e("PlannerNudge", "boot reschedule failed: " + e.getMessage());
        }
    }
}
