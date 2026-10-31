# planner-ai — сервер AI для помощника

Cloudflare Worker между приложением и Gemini. Ключ хранится только в секретах Worker'а, в приложении его нет.
CI этот код не собирает — он вставляется в Cloudflare вручную.

## Развёртывание (один раз)

1. **Ключ Gemini.** https://aistudio.google.com → Get API key → Create API key. Скопировать. В чат и в репозиторий не вставлять.
2. **Worker.** https://dash.cloudflare.com → Workers & Pages → Create → Worker → имя `planner-ai` → Deploy.
   Потом Edit code → заменить весь код содержимым `worker/planner-ai.js` → Deploy.
3. **Секрет.** Worker → Settings → Variables and Secrets → Add → тип **Secret**, имя `GEMINI_KEY`, значение — ключ → Deploy.
4. **Лимиты (желательно).** Storage & Databases → KV → Create → `planner-ai-rl`.
   Worker → Settings → Bindings → Add → KV namespace → имя переменной `RL`, namespace `planner-ai-rl`.
   Без KV всё работает, но дневные лимиты не считаются, а жалобы видны только в логах.
5. **Проверка.** Открыть `https://planner-ai.<твой-поддомен>.workers.dev/` — должно показать `{"ok":true,"service":"planner-ai"}`.
   Этот адрес вписывается в `HP_AI_URL` в index.html.

## Настройки (Settings → Variables, тип Text)

| Имя | По умолчанию | Что |
|---|---|---|
| `MODEL` | `gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash` | модели через запятую: первая не ответила — пробуется следующая |
| `DEVICE_LIMIT` | `60` | запросов в день на устройство |
| `GLOBAL_LIMIT` | `1200` | запросов в день на всех |
| `ORIGINS` | `https://yuriilosiev-png.github.io,null` | откуда разрешены запросы (`null` — офлайн-копия в APK) |

## Жалобы

Кнопка ⚑ у ответа AI → `POST /report`. С KV — записи `r:…` в `planner-ai-rl` (хранятся 90 дней), без KV — строки `REPORT` в логах Worker'а (Worker → Logs).
