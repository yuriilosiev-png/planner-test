package com.planner.app;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.provider.DocumentsContract;
import android.webkit.WebViewClient;
import android.webkit.CookieManager;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;

import android.Manifest;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.speech.RecognizerIntent;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.ByteArrayInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Planner — нативная обёртка (WebView) для веб-планировщика.
 *
 * EDGE-TO-EDGE: WebView под статусбаром, статусбар прозрачный (фон приложения
 * заходит под часы). В index.html зона закрыта через env(safe-area-inset-top).
 *
 * ГИБРИД: сначала GitHub Pages (PAGES_URL); при ошибке — офлайн-копия из assets.
 *
 * МОСТ ДЛЯ БЭКАПА (работает на любом Android, minSdk 24):
 *   - shareBackup(json, filename)  — системный «Поделиться» (Telegram, Drive, почта)
 *   - saveToDownloads(json, filename) — сохранить в папку Загрузки
 *   - pickBackupFile()             — системный выбор .json для импорта
 * Web Share API НЕ используем — он нестабилен в WebView на части устройств.
 *
 * МОСТ ДЛЯ УВЕДОМЛЕНИЯ (Этап 2, локально, без Firebase/FCM):
 *   - updateNotificationTasks(json) — JS отдаёт задачи на сегодня
 *   - setNotificationEnabled(bool)  — тумблер в настройках приложения
 *   - isNotificationEnabled()       — состояние тумблера для UI
 *   - setNotificationMaxTasks(int)  — сколько задач показывать (1..5)
 *   - getNotificationMaxTasks()     — текущее значение для UI
 *   - openBatterySettings()         — MIUI: экономия батареи вручную
 *   - openAutostartSettings()       — MIUI: автозапуск вручную
 */
public class MainActivity extends Activity {

    private static final String TAG = "PlannerMain";
    private static final int REQ_POST_NOTIFICATIONS = 1001;
    private static final int REQ_PICK_BACKUP = 2001;
    private static final int REQ_VOICE = 3001;
    private static final String CHANNEL_ID = "planner_tasks";

    private WebView webView;

    // Путь берётся из сборки: /planner/ у боевой версии, /planner-test/ у тестовой.
    private static final String PAGES_URL =
        "https://yuriilosiev-png.github.io" + BuildConfig.PAGES_PATH + "index.html";
    private static final String ASSET_URL = "file:///android_asset/index.html";

    private volatile boolean loadedOfflineFallback = false;

    /* ЕДИНОЕ ХРАНИЛИЩЕ (1.7.4). До 1.7.3 при неудачной загрузке Pages открывалась
       file:///android_asset/index.html — другой источник (origin), а значит другое
       хранилище localStorage. Всё, что человек делал без сети, жило отдельно и
       «пропадало» при следующем запуске с сетью. Теперь главная страница всегда
       открывается под адресом Pages: shouldInterceptRequest берёт её из сети,
       а без сети отдаёт офлайн-копию из assets ПОД ТЕМ ЖЕ АДРЕСОМ. */
    private static final String PAGES_HOST = "yuriilosiev-png.github.io";
    private static final String MIG_PREFS = "planner_migration";
    private static final String KEY_LEGACY_DONE = "legacy_offline_store_done";
    private static final String KEY_LEGACY_TRIES = "legacy_offline_store_tries";
    /** Идёт разовое чтение старого офлайн-хранилища (file://). */
    private volatile boolean migratingLegacy = false;
    /** Прочитанные данные старого офлайн-хранилища — отдаём странице Pages. */
    private String legacyPayload = null;
    /** После служебной страницы чтения история WebView хранит её адрес:
     *  «назад» вернул бы на неё — пустой экран без данных. Чистим историю
     *  сразу после загрузки Pages. */
    private boolean clearHistoryOnPagesLoad = false;

    private static WeakReference<MainActivity> sInstance;

    public static MainActivity getInstance() {
        return sInstance != null ? sInstance.get() : null;
    }

    /** 1.7.7: задачу отметили в шторке или виджете. Если приложение живо —
     *  страница сразу забирает очередь отметок; если нет — заберёт при запуске
     *  (init) или возврате (visibilitychange). */
    static void onNativeDone() {
        MainActivity a = getInstance();
        if (a != null) a.callJs("window.applyNativeDone&&applyNativeDone()");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sInstance = new WeakReference<>(this);

        // ---- EDGE-TO-EDGE ----
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        }

        createNotificationChannel();
        requestNotificationPermission();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0f1115"));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // КЭШ: если сеть есть — всегда берём свежую версию с Pages (LOAD_NO_CACHE),
        // если сети нет — разрешаем кэш (LOAD_CACHE_ELSE_NETWORK), а при полном
        // провале загрузки onReceivedError уведёт на офлайн-копию из assets.
        // Это убирает баг «белый экран / старая версия до перезапуска».
        settings.setCacheMode(isOnline()
            ? WebSettings.LOAD_NO_CACHE
            : WebSettings.LOAD_CACHE_ELSE_NETWORK);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setSupportZoom(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(
            settings.getUserAgentString() + " PlannerApp/1.2"
        );

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidBridge(this), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // страница разового чтения старого хранилища — это не приложение
                if (url != null && url.startsWith("file:")) return;
                pageReady = true;
                if (clearHistoryOnPagesLoad) {
                    clearHistoryOnPagesLoad = false;
                    view.clearHistory();
                }
                if (legacyPayload != null) {
                    final String b64 = android.util.Base64.encodeToString(
                        legacyPayload.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
                    legacyPayload = null;
                    // если одновременно пришёл файл из «Поделиться», окно импорта заменит
                    // окно переноса — перенос не будет отмечен выполненным и повторится
                    view.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            callJs("window.onLegacyStore && window.onLegacyStore('" + b64 + "')");
                        }
                    }, 400);
                }
                if (pendingImportUri != null) {
                    final Uri u = pendingImportUri;
                    pendingImportUri = null;
                    // небольшая пауза: JS ещё доинициализирует обработчики
                    view.postDelayed(new Runnable() {
                        @Override
                        public void run() { readBackupUri(u); }
                    }, 400);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                // На file:// больше НЕ уходим — это другое хранилище (см. PAGES_HOST).
                // Главную страницу отдаёт shouldInterceptRequest; если и он не смог,
                // пробуем ещё раз тот же адрес — перехват отдаст офлайн-копию.
                if (request != null && request.isForMainFrame()
                        && isPagesIndex(request.getUrl()) && !loadedOfflineFallback) {
                    loadedOfflineFallback = true;
                    Log.w(TAG, "Pages main frame error, retrying via intercept. code="
                        + (error != null ? error.getErrorCode() : "?"));
                    view.post(new Runnable() {
                        @Override
                        public void run() {
                            view.loadUrl(PAGES_URL);
                        }
                    });
                }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request == null || !request.isForMainFrame()) return null;
                if (!"GET".equalsIgnoreCase(request.getMethod())) return null;
                if (!isPagesIndex(request.getUrl())) return null;
                return loadIndexNetworkFirst();
            }
        });

        webView.setWebChromeClient(new WebChromeClient());
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        // Если есть сеть — чистим кэш WebView перед загрузкой.
        // Это добивает старый залипший service-worker-кэш (из прежних сборок),
        // из-за которого приложение показывало устаревшую версию/белый экран
        // до ручного перезапуска. JS со своей стороны тоже снимает регистрацию SW.
        if (isOnline()) {
            try {
                webView.clearCache(true);
                webView.clearHistory();
            } catch (Exception e) {
                Log.w(TAG, "clearCache failed", e);
            }
        }

        startMainPage();

        // файл мог прийти вместе с запуском («Поделиться» из Telegram, тап в Файлах)
        handleIncomingFile(getIntent());

        // vC 11: первый запуск — включаем шторку сами, если уведомления разрешены.
        // Стоит ПЕРЕД restore, чтобы сервис поднялся тем же вызовом.
        applyDefaultNotifEnabled();

        // Этап 2: если тумблер уведомления включён — поднять сервис при старте.
        // Задачи берутся из SharedPreferences (кэш последнего updateNotificationTasks),
        // поэтому уведомление появляется сразу, не дожидаясь загрузки WebView.
        restoreNotificationServiceIfEnabled();
    }

    // ─────────────────────────────────────────────────────────────────
    // Вызвать JS-функцию в WebView (натив → веб)
    // ─────────────────────────────────────────────────────────────────
    /* Файл, пришедший из «Поделиться», пока страница ещё не загрузилась.
       Интент прилетает раньше, чем WebView готов принять evaluateJavascript,
       поэтому ссылку придерживаем и отдаём в onPageFinished. */
    private Uri pendingImportUri = null;
    private boolean pageReady = false;

    /** Приложение уже запущено — файл приходит сюда (launchMode=singleTask). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingFile(intent);
    }

    /** Вытащить ссылку на файл из SEND или VIEW и передать в общий читатель. */
    private void handleIncomingFile(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            } else if (Intent.ACTION_VIEW.equals(action)) {
                uri = intent.getData();
            }
        } catch (Exception e) {
            Log.e(TAG, "handleIncomingFile failed", e);
        }
        if (uri == null) return;
        // один и тот же интент не разбираем дважды при повороте/возврате
        intent.setAction(null);
        intent.setData(null);
        intent.removeExtra(Intent.EXTRA_STREAM);
        if (pageReady) {
            readBackupUri(uri);
        } else {
            pendingImportUri = uri;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // ЕДИНОЕ ХРАНИЛИЩЕ: главная страница всегда под адресом Pages
    // ─────────────────────────────────────────────────────────────────
    private boolean isPagesIndex(Uri u) {
        if (u == null || !PAGES_HOST.equalsIgnoreCase(u.getHost())) return false;
        String path = u.getPath();
        String p = BuildConfig.PAGES_PATH;                     // "/planner/" или "/planner-test/"
        return (p + "index.html").equals(path) || p.equals(path)
            || p.substring(0, p.length() - 1).equals(path);
    }

    /** Сеть → свежий index.html с Pages; не вышло → офлайн-копия из assets.
     *  В обоих случаях WebView считает, что страница пришла с Pages, —
     *  хранилище localStorage одно. Вызывается на фоновом потоке WebView. */
    private WebResourceResponse loadIndexNetworkFirst() {
        if (isOnline()) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(PAGES_URL).openConnection();
                c.setConnectTimeout(4000);
                c.setReadTimeout(7000);
                c.setUseCaches(false);
                c.setRequestProperty("Cache-Control", "no-cache");
                if (c.getResponseCode() == 200) {
                    InputStream is = c.getInputStream();
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                    is.close();
                    return new WebResourceResponse("text/html", "utf-8",
                        new ByteArrayInputStream(bos.toByteArray()));
                }
                Log.w(TAG, "Pages HTTP " + c.getResponseCode() + ", serving offline copy");
            } catch (Exception e) {
                Log.w(TAG, "Pages fetch failed, serving offline copy", e);
            } finally {
                if (c != null) c.disconnect();
            }
        }
        try {
            return new WebResourceResponse("text/html", "utf-8", getAssets().open("index.html"));
        } catch (Exception e) {
            Log.e(TAG, "offline copy missing", e);
            return null;
        }
    }

    /* Разовый перенос из старого офлайн-хранилища (file://), куда до 1.7.4 попадали
       данные при запуске без сети. Прочитать его можно только страницей с того же
       источника: грузим офлайн-копию с меткой #legacy-export — скрипт в этом режиме
       не запускает приложение, а только отдаёт localStorage в legacyStoreResult().
       Дальше обычная загрузка Pages, данные передаются в window.onLegacyStore(),
       там человек (если данные есть в обоих местах) выбирает, что оставить. */
    private void startMainPage() {
        SharedPreferences p = getSharedPreferences(MIG_PREFS, MODE_PRIVATE);
        if (p.getBoolean(KEY_LEGACY_DONE, false) || p.getInt(KEY_LEGACY_TRIES, 0) >= 3) {
            webView.loadUrl(PAGES_URL);
            return;
        }
        migratingLegacy = true;
        webView.loadUrl(ASSET_URL + "#legacy-export");
        // страховка: если страница чтения не ответила — не держим человека на пустом экране
        webView.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!migratingLegacy) return;
                migratingLegacy = false;
                SharedPreferences sp = getSharedPreferences(MIG_PREFS, MODE_PRIVATE);
                sp.edit().putInt(KEY_LEGACY_TRIES, sp.getInt(KEY_LEGACY_TRIES, 0) + 1).apply();
                Log.w(TAG, "legacy store read timed out");
                clearHistoryOnPagesLoad = true;
                webView.loadUrl(PAGES_URL);
            }
        }, 4000);
    }

    void onLegacyStoreRead(String raw) {
        if (!migratingLegacy) return;          // таймаут уже увёл на Pages
        migratingLegacy = false;
        if (raw == null || raw.trim().isEmpty()) {
            markLegacyDone();                  // старое хранилище пустое — переносить нечего
        } else {
            legacyPayload = raw;               // отметку поставит JS после выбора
        }
        clearHistoryOnPagesLoad = true;
        webView.loadUrl(PAGES_URL);
    }

    void markLegacyDone() {
        getSharedPreferences(MIG_PREFS, MODE_PRIVATE).edit()
            .putBoolean(KEY_LEGACY_DONE, true).apply();
    }

    private void callJs(final String js) {
        if (webView == null) return;
        webView.post(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    /**
     * Есть ли интернет. От этого зависит стратегия кэша:
     * онлайн → всегда свежая версия с Pages; офлайн → кэш/assets.
     */
    private boolean isOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager)
                getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= 23) {
                Network n = cm.getActiveNetwork();
                if (n == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                return caps != null
                    && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            } else {
                NetworkInfo ni = cm.getActiveNetworkInfo();
                return ni != null && ni.isConnected();
            }
        } catch (Exception e) {
            Log.w(TAG, "isOnline check failed", e);
            return false;
        }
    }

    // экранирование строки для безопасной вставки в JS
    private static String jsEscape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }

    // ─────────────────────────────────────────────────────────────────
    // ЭТАП 2: запуск сервиса уведомления при старте приложения
    // ─────────────────────────────────────────────────────────────────
    /** Шторка включена по умолчанию — но только если пользователь согласился
     *  получать уведомления. Разрешение не дали (или отозвали) — тумблер
     *  остаётся выключенным, иначе сервис стартовал бы в пустоту.
     *  Применяется РОВНО ОДИН РАЗ: флаг KEY_DEFAULT_APPLIED. Без него мы
     *  переоткрывали бы шторку тем, кто её осознанно выключил. */
    private static final String KEY_DEFAULT_APPLIED = "notif_default_applied";

    private void applyDefaultNotifEnabled() {
        try {
            SharedPreferences sp = getSharedPreferences(
                NotificationService.PREFS, Context.MODE_PRIVATE);
            if (sp.getBoolean(KEY_DEFAULT_APPLIED, false)) return;
            boolean allowed = true;
            if (Build.VERSION.SDK_INT >= 33) {
                allowed = ContextCompat.checkSelfPermission(
                        this, Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED;
            }
            if (!allowed) return;   // спросим снова при следующем запуске
            sp.edit()
              .putBoolean(NotificationService.KEY_ENABLED, true)
              .putBoolean(KEY_DEFAULT_APPLIED, true)
              .apply();
            NotificationService.start(this);
        } catch (Exception e) {
            Log.e(TAG, "applyDefaultNotifEnabled failed", e);
        }
    }

    private void restoreNotificationServiceIfEnabled() {
        try {
            SharedPreferences sp = getSharedPreferences(
                NotificationService.PREFS, Context.MODE_PRIVATE);
            if (sp.getBoolean(NotificationService.KEY_ENABLED, false)) {
                NotificationService.start(this);
            }
        } catch (Exception e) {
            Log.e(TAG, "restoreNotificationServiceIfEnabled failed", e);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // AndroidBridge — JS-интерфейс.
    // В JS вызывать ТОЛЬКО с проверкой: if (typeof AndroidBridge !== 'undefined')
    // ─────────────────────────────────────────────────────────────────
    public static class AndroidBridge {
        private final WeakReference<MainActivity> activityRef;

        public AndroidBridge(MainActivity activity) {
            this.activityRef = new WeakReference<>(activity);
        }

        @JavascriptInterface
        public String getVersion() {
            return "1.0";
        }

        /** Есть ли нативный мост (JS проверяет, чтобы решить какие кнопки показать). */
        @JavascriptInterface
        public boolean hasNativeBackup() {
            return true;
        }

        /**
         * Системный «Поделиться»: сохраняет JSON во внутренний кэш и открывает
         * системный диалог (Telegram, Google Drive, почта, Files...).
         * Работает на любом Android через FileProvider.
         */
        @JavascriptInterface
        public void shareBackup(final String json, final String filename) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doShareBackup(json, filename);
                }
            });
        }

        /** 1.7.7: поделиться картинкой (карточка «Моя дисциплина за 30 дней»).
         *  base64 — PNG без префикса data:, text — подпись со ссылкой на Play. */
        @JavascriptInterface
        public void shareImage(final String base64, final String filename, final String text) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doShareImage(base64, filename, text);
                }
            });
        }

        /** Сохранить JSON в папку Загрузки (Downloads). */
        @JavascriptInterface
        public void saveToDownloads(final String json, final String filename) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doSaveToDownloads(json, filename);
                }
            });
        }

        /** Открыть системный выбор файла для импорта бэкапа. */
        @JavascriptInterface
        public void pickBackupFile() {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doPickBackupFile();
                }
            });
        }

        // ───────── ЭТАП 2: постоянное уведомление ─────────

        /** Есть ли нативное уведомление (JS решает, показывать ли тумблер). */
        @JavascriptInterface
        public boolean hasNativeNotification() {
            return true;
        }

        /**
         * JS отдаёт задачи на сегодня.
         * Формат: [{"time":"09:30","title":"Дев-сессия"},{"time":"","title":"..."}]
         * time — "HH:MM" или "" (тогда колонка времени скрыта).
         * Порядок задач = порядок в уведомлении, натив не сортирует.
         */
        @JavascriptInterface
        public void updateNotificationTasks(final String json) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        NotificationService.updateTasks(a, json);
                    } catch (Exception e) {
                        Log.e(TAG, "updateNotificationTasks failed", e);
                    }
                }
            });
        }

        /** Тумблер «Показывать уведомление» из настроек приложения. */
        @JavascriptInterface
        public void setNotificationEnabled(final boolean enabled) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        SharedPreferences sp = a.getSharedPreferences(
                            NotificationService.PREFS, Context.MODE_PRIVATE);
                        sp.edit().putBoolean(NotificationService.KEY_ENABLED, enabled).apply();
                        if (enabled) {
                            NotificationService.start(a);
                        } else {
                            NotificationService.stop(a);
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "setNotificationEnabled failed", e);
                    }
                }
            });
        }

        /** Техсводка по шторке для блока настроек (пять тапов по заголовку).
         *  Без adb на устройстве иначе не отличить «список не дошёл до натива»
         *  от «дошёл, но не сработало пробуждение». */
        @JavascriptInterface
        public String getNotifDebug() {
            final MainActivity a = activityRef.get();
            if (a == null) return "no activity";
            try {
                return NotificationService.debugInfo(a);
            } catch (Exception e) {
                return "err: " + e.getMessage();
            }
        }

        /** Состояние тумблера — чтобы JS отрисовал настройки в актуальном виде. */
        @JavascriptInterface
        public boolean isNotificationEnabled() {
            final MainActivity a = activityRef.get();
            if (a == null) return false;
            try {
                SharedPreferences sp = a.getSharedPreferences(
                    NotificationService.PREFS, Context.MODE_PRIVATE);
                return sp.getBoolean(NotificationService.KEY_ENABLED, false);
            } catch (Exception e) {
                Log.e(TAG, "isNotificationEnabled failed", e);
                return false;
            }
        }

        /** Сколько задач показывать в уведомлении (1..5). */
        @JavascriptInterface
        public void setNotificationMaxTasks(final int max) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        int v = max;
                        if (v < 1) v = 1;
                        if (v > 5) v = 5;
                        SharedPreferences sp = a.getSharedPreferences(
                            NotificationService.PREFS, Context.MODE_PRIVATE);
                        sp.edit().putInt(NotificationService.KEY_MAX_TASKS, v).apply();
                        if (sp.getBoolean(NotificationService.KEY_ENABLED, false)) {
                            NotificationService.start(a);
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "setNotificationMaxTasks failed", e);
                    }
                }
            });
        }

        /** Текущее «сколько задач» для отрисовки настроек. */
        @JavascriptInterface
        public int getNotificationMaxTasks() {
            final MainActivity a = activityRef.get();
            if (a == null) return 5;
            try {
                SharedPreferences sp = a.getSharedPreferences(
                    NotificationService.PREFS, Context.MODE_PRIVATE);
                return sp.getInt(NotificationService.KEY_MAX_TASKS, 5);
            } catch (Exception e) {
                Log.e(TAG, "getNotificationMaxTasks failed", e);
                return 5;
            }
        }

        /**
         * MIUI душит фоновые сервисы. Открыть системные настройки батареи,
         * чтобы юзер вручную снял ограничение для Planner.
         */
        @JavascriptInterface
        public void openBatterySettings() {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doOpenBatterySettings();
                }
            });
        }

        /** MIUI: экран автозапуска (у Xiaomi он отдельный от батареи). */
        @JavascriptInterface
        public void openAutostartSettings() {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doOpenAutostartSettings();
                }
            });
        }

        /** Есть ли на устройстве системный распознаватель речи.
         *  JS спрашивает один раз при старте: нет распознавателя — микрофоны
         *  в полях не рисуются вовсе (мёртвая кнопка хуже отсутствующей). */
        @JavascriptInterface
        public boolean hasVoiceInput() {
            final MainActivity a = activityRef.get();
            return a != null && a.isVoiceAvailable();
        }

        /** Системный голосовой ввод. langTag — BCP-47 из чипа языка
         *  (ru-RU, en-US, es-419, pt-BR), а не системная локаль.
         *  Результат придёт в window.onNativeVoiceResult(status, b64). */
        @JavascriptInterface
        public void startVoiceInput(final String langTag) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doStartVoiceInput(langTag);
                }
            });
        }

        /** versionCode установленной сборки. index.html приходит с Pages свежим,
         *  сравнивает это число со своим списком релизов и решает, показывать ли
         *  плашку «Доступно обновление». В 1.7.3 и раньше метода нет — JS считает
         *  такую сборку версией 11. */
        @JavascriptInterface
        public int getAppVersionCode() {
            final MainActivity a = activityRef.get();
            return a == null ? 0 : a.appVersionCode();
        }

        /** Страница #legacy-export отдаёт содержимое старого офлайн-хранилища. */
        @JavascriptInterface
        public void legacyStoreResult(final String raw) {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.onLegacyStoreRead(raw);
                }
            });
        }

        /** Перенос решён (перенесли или человек оставил текущие) — больше не спрашивать. */
        @JavascriptInterface
        public void legacyStoreDone() {
            final MainActivity a = activityRef.get();
            if (a != null) a.markLegacyDone();
        }

        /** 1.7.7: отметки «выполнено» из шторки и виджета, ещё не применённые
         *  страницей. Возвращает JSON [{"id","at"}] и очищает очередь. */
        @JavascriptInterface
        public String takePendingDone() {
            final MainActivity a = activityRef.get();
            return a == null ? "[]" : DoneReceiver.takePending(a);
        }

        /** Открыть страницу приложения в Google Play (кнопка «Обновить»). */
        @JavascriptInterface
        public void openStore() {
            final MainActivity a = activityRef.get();
            if (a == null) return;
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.doOpenStore();
                }
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // ШАРИНГ: файл в кэш → FileProvider → системный chooser
    // ─────────────────────────────────────────────────────────────────
    private void doShareBackup(String json, String filename) {
        try {
            if (filename == null || filename.trim().isEmpty()) filename = "planner-backup.json";
            // Кладём в cache/backups (этот путь прописан в file_paths.xml)
            File dir = new File(getCacheDir(), "backups");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, filename);
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(json.getBytes(StandardCharsets.UTF_8));
            fos.close();

            Uri uri = FileProvider.getUriForFile(
                this, getPackageName() + ".fileprovider", f);

            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("application/json");
            share.putExtra(Intent.EXTRA_STREAM, uri);
            share.putExtra(Intent.EXTRA_SUBJECT, filename);
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(share, "Сохранить резервную копию"));
            callJs("window.onNativeBackupResult && window.onNativeBackupResult('share','ok','')");
        } catch (Exception e) {
            Log.e(TAG, "shareBackup failed", e);
            callJs("window.onNativeBackupResult && window.onNativeBackupResult('share','error','"
                + jsEscape(e.getMessage()) + "')");
        }
    }

    /** 1.7.7: PNG из страницы → cache/backups (тот же путь FileProvider, что у
     *  копии) → системный «Поделиться». ClipData нужен, чтобы право чтения
     *  файла дошло до выбранного приложения через chooser на Android 10+. */
    private void doShareImage(String base64, String filename, String text) {
        try {
            if (filename == null || filename.trim().isEmpty()) filename = "planner-discipline.png";
            byte[] png = Base64.decode(base64, Base64.DEFAULT);
            File dir = new File(getCacheDir(), "backups");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, filename);
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(png);
            fos.close();

            Uri uri = FileProvider.getUriForFile(
                this, getPackageName() + ".fileprovider", f);

            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("image/png");
            share.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && !text.isEmpty()) share.putExtra(Intent.EXTRA_TEXT, text);
            share.setClipData(ClipData.newRawUri("", uri));
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(share, null));
        } catch (Exception e) {
            Log.e(TAG, "shareImage failed", e);
            callJs("window.toast && toast(tr('sh.fail'))");
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // СОХРАНЕНИЕ В DOWNLOADS
    // Android 10+ (API 29): MediaStore (без разрешений)
    // Android 9-  (API 24-28): прямая запись в public Downloads
    // ─────────────────────────────────────────────────────────────────
    private void doSaveToDownloads(String json, String filename) {
        try {
            if (filename == null || filename.trim().isEmpty()) filename = "planner-backup.json";
            byte[] data = json.getBytes(StandardCharsets.UTF_8);

            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                cv.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                cv.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new Exception("MediaStore insert failed");
                OutputStream os = getContentResolver().openOutputStream(uri);
                if (os == null) throw new Exception("openOutputStream failed");
                os.write(data);
                os.close();
                cv.clear();
                cv.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, cv, null, null);
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, filename);
                FileOutputStream fos = new FileOutputStream(f);
                fos.write(data);
                fos.close();
            }
            callJs("window.onNativeBackupResult && window.onNativeBackupResult('save','ok','"
                + jsEscape(filename) + "')");
        } catch (Exception e) {
            Log.e(TAG, "saveToDownloads failed", e);
            callJs("window.onNativeBackupResult && window.onNativeBackupResult('save','error','"
                + jsEscape(e.getMessage()) + "')");
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // ИМПОРТ: системный выбор файла → чтение → отдать JSON в JS
    // createChooser обязателен: без него на части устройств (MIUI и др.)
    // intent молча уходит в Google Drive, и выбрать другой источник нельзя.
    // С chooser система показывает список: Файлы, Диск, Telegram, Загрузки…
    // ─────────────────────────────────────────────────────────────────
    private void doPickBackupFile() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");   // некоторые провайдеры не отдают application/json
            // подсказка системе, какие типы нам интересны (Files подсветит .json)
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/json", "text/plain", "application/octet-stream", "*/*"
            });
            i.putExtra(Intent.EXTRA_LOCAL_ONLY, false); // разрешить облачные источники
            // DocumentsUI запоминает последнюю папку и открывается в ней — у части
            // пользователей это Google Диск, хотя копия лежит в «Загрузках».
            // EXTRA_INITIAL_URI — подсказка, а не команда: провайдер вправе её
            // проигнорировать, поэтому пункт меню ☰ в подсказках оставляем.
            if (Build.VERSION.SDK_INT >= 26) {
                try {
                    i.putExtra(DocumentsContract.EXTRA_INITIAL_URI,
                        DocumentsContract.buildDocumentUri(
                            "com.android.externalstorage.documents", "primary:Download"));
                } catch (Exception ignored) {}
            }

            Intent chooser = Intent.createChooser(i, "Откуда взять резервную копию?");
            startActivityForResult(chooser, REQ_PICK_BACKUP);
        } catch (Exception e) {
            Log.e(TAG, "pickBackupFile failed", e);
            // запасной путь: ACTION_GET_CONTENT понимают почти все файловые приложения
            try {
                Intent g = new Intent(Intent.ACTION_GET_CONTENT);
                g.addCategory(Intent.CATEGORY_OPENABLE);
                g.setType("*/*");
                startActivityForResult(
                    Intent.createChooser(g, "Откуда взять резервную копию?"),
                    REQ_PICK_BACKUP);
            } catch (Exception e2) {
                Log.e(TAG, "GET_CONTENT fallback failed", e2);
                callJs("window.onNativeImportResult && window.onNativeImportResult('error','"
                    + jsEscape(e2.getMessage()) + "','')");
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_VOICE) {
            handleVoiceResult(resultCode, data);
            return;
        }
        if (requestCode != REQ_PICK_BACKUP) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            callJs("window.onNativeImportResult && window.onNativeImportResult('cancel','','')");
            return;
        }
        readBackupUri(data.getData());
    }

    // ─────────────────────────────────────────────────────────────────
    // ГОЛОСОВОЙ ВВОД: RecognizerIntent → текст → JS
    // Web Speech API в WebView не реализован (Blink отдаёт интерфейс, движка
    // распознавания в WebView нет), поэтому идём через системный распознаватель.
    // RECORD_AUDIO не нужен: пишет системное приложение, а не мы.
    // На API 30+ queryIntentActivities видит распознаватель только при наличии
    // <queries> с RECOGNIZE_SPEECH в манифесте — без него микрофоны пропадут у всех.
    // ─────────────────────────────────────────────────────────────────
    boolean isVoiceAvailable() {
        try {
            List<ResolveInfo> list = getPackageManager().queryIntentActivities(
                new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0);
            return list != null && !list.isEmpty();
        } catch (Exception e) {
            Log.e(TAG, "isVoiceAvailable failed", e);
            return false;
        }
    }

    private void doStartVoiceInput(String langTag) {
        try {
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            if (langTag != null && !langTag.trim().isEmpty()) {
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, langTag);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, langTag);
            }
            // сначала локальный языковой пакет, в сеть — только если его нет
            i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            startActivityForResult(i, REQ_VOICE);
        } catch (ActivityNotFoundException e) {
            callJs("window.onNativeVoiceResult && window.onNativeVoiceResult('unavailable','')");
        } catch (Exception e) {
            Log.e(TAG, "startVoiceInput failed", e);
            callJs("window.onNativeVoiceResult && window.onNativeVoiceResult('error','')");
        }
    }

    private void handleVoiceResult(int resultCode, Intent data) {
        String status;
        String b64 = "";
        if (resultCode == RESULT_OK) {
            ArrayList<String> res = (data == null) ? null
                : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            String text = (res == null || res.isEmpty()) ? null : res.get(0);
            if (text != null && !text.trim().isEmpty()) {
                status = "ok";
                // base64 — чтобы кавычки и переносы не ломали строку JS
                b64 = android.util.Base64.encodeToString(
                    text.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
            } else {
                status = "nomatch";
            }
        } else if (resultCode == RESULT_CANCELED) {
            status = "cancel";
        } else if (resultCode == RecognizerIntent.RESULT_NETWORK_ERROR) {
            status = "network";
        } else if (resultCode == RecognizerIntent.RESULT_NO_MATCH) {
            status = "nomatch";
        } else {
            status = "error";
        }
        callJs("window.onNativeVoiceResult && window.onNativeVoiceResult('"
            + status + "','" + b64 + "')");
    }

    // ─────────────────────────────────────────────────────────────────
    // ОБНОВЛЕНИЕ: версия сборки и переход в Google Play
    // WebView сам не открывает market:// (своего shouldOverrideUrlLoading у нас
    // нет), поэтому ссылка из JS ведёт в никуда — только через этот мост.
    // getPackageName() = applicationId (com.losev.planner), не namespace.
    // ─────────────────────────────────────────────────────────────────
    int appVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return (int) pi.getLongVersionCode();
            return pi.versionCode;
        } catch (Exception e) {
            Log.e(TAG, "appVersionCode failed", e);
            return 0;
        }
    }

    private void doOpenStore() {
        final String id = getPackageName();
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + id));
            i.setPackage("com.android.vending");   // сразу в Play, без выбора приложения
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            // Play нет (прошивка без сервисов Google) — открываем веб-страницу в браузере
            try {
                Intent w = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("https://play.google.com/store/apps/details?id=" + id));
                w.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(w);
            } catch (Exception e2) {
                Log.e(TAG, "openStore failed", e2);
            }
        }
    }

    /** Прочитать файл копии по ссылке и отдать его в JS.
     *  Один путь и для выбора через пикер, и для «Поделиться» — чтобы проверки
     *  формата и размера не разъехались между двумя реализациями. */
    private void readBackupUri(Uri uri) {
        try {
            if (uri == null) throw new Exception("empty uri");
            InputStream is = getContentResolver().openInputStream(uri);
            if (is == null) throw new Exception("openInputStream failed");
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = is.read(buf)) != -1) {
                total += n;
                if (total > 20 * 1024 * 1024) throw new Exception("Файл слишком большой");
                bos.write(buf, 0, n);
            }
            is.close();
            String json = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            // отдаём JSON в JS через base64, чтобы не ломать кавычками/переносами
            String b64 = android.util.Base64.encodeToString(
                json.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
            callJs("window.onNativeImportResult && window.onNativeImportResult('ok','','" + b64 + "')");
        } catch (Exception e) {
            Log.e(TAG, "read picked file failed", e);
            callJs("window.onNativeImportResult && window.onNativeImportResult('error','"
                + jsEscape(e.getMessage()) + "','')");
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // ЭТАП 2 / MIUI: системные экраны батареи и автозапуска.
    // Xiaomi без этих настроек убивает foreground service через несколько часов.
    // Экраны у MIUI нестандартные — пробуем фирменный intent, при провале
    // откатываемся на общие настройки приложения.
    // ─────────────────────────────────────────────────────────────────
    private void doOpenBatterySettings() {
        // 1) MIUI: фирменный экран экономии батареи для конкретного приложения
        try {
            Intent i = new Intent();
            i.setClassName("com.miui.powerkeeper",
                "com.miui.powerkeeper.ui.HiddenAppsConfigActivity");
            i.putExtra("package_name", getPackageName());
            i.putExtra("package_label", "Planner");
            startActivity(i);
            return;
        } catch (Exception e) {
            Log.w(TAG, "MIUI powerkeeper screen unavailable: " + e.getMessage());
        }
        // 2) Общий системный экран оптимизации батареи (чистый Android)
        try {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            startActivity(i);
            return;
        } catch (Exception e) {
            Log.w(TAG, "battery optimization screen unavailable: " + e.getMessage());
        }
        // 3) Последний рубеж: карточка приложения в настройках
        openAppDetailsSettings();
    }

    private void doOpenAutostartSettings() {
        // 1) MIUI: экран автозапуска (Безопасность → Разрешения → Автозапуск)
        try {
            Intent i = new Intent();
            i.setClassName("com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity");
            startActivity(i);
            return;
        } catch (Exception e) {
            Log.w(TAG, "MIUI autostart screen unavailable: " + e.getMessage());
        }
        // 2) Фолбэк: карточка приложения
        openAppDetailsSettings();
    }

    private void openAppDetailsSettings() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            Log.e(TAG, "openAppDetailsSettings failed", e);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[]{ Manifest.permission.POST_NOTIFICATIONS },
                    REQ_POST_NOTIFICATIONS
                );
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_POST_NOTIFICATIONS) {
            boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Log.d(TAG, "POST_NOTIFICATIONS granted: " + granted);
            // Разрешение дали и тумблер включён — поднять сервис сразу,
            // не заставляя перезапускать приложение.
            if (granted) {
                applyDefaultNotifEnabled();          // первый запуск — включаем шторку сами
                restoreNotificationServiceIfEnabled();
            }
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Задачи на сегодня",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Постоянное уведомление со списком задач");
            channel.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    @Override
    public void onBackPressed() {
        // на служебную страницу чтения (file://) «назад» не ведёт никогда —
        // там приложение не запущено, человек увидел бы пустой экран
        if (webView.canGoBack() && !previousIsFilePage()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private boolean previousIsFilePage() {
        try {
            WebBackForwardList list = webView.copyBackForwardList();
            int i = list.getCurrentIndex() - 1;
            if (i < 0) return false;
            String u = list.getItemAtIndex(i).getUrl();
            return u != null && u.startsWith("file:");
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        sInstance = null;
        webView.destroy();
    }
}
