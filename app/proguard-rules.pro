# Правила R8 для Planner (включены с 1.7.10).
#
# Приложение — обёртка WebView: страница вызывает Java через window.AndroidBridge.
# R8 не видит эти вызовы и без правил удалил или переименовал бы методы моста —
# кнопки на странице молча перестали бы работать. Поэтому:

# 1. Все классы приложения сохраняются как есть (их немного, выигрыш от сжатия
#    мал, а риск сломать мост, ресиверы, виджет или сервис — большой).
-keep class com.planner.app.** { *; }

# 2. На всякий случай — любые методы с @JavascriptInterface в любом классе.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keepattributes *Annotation*

# 3. Без переименования: стек-трейсы сбоев в Play Console остаются читаемыми,
#    и не нужно загружать файл деобфускации (иначе Play выдаст новое предупреждение).
-dontobfuscate
