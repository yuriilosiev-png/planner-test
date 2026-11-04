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

## Workers AI (основной вариант)

Worker → Settings → Bindings → Add binding → **Workers AI** → имя переменной `AI` → Deploy. Ключ не нужен. Бесплатно 10 000 «нейронов» в день (примерно 150 ходов опроса), дальше — план Workers Paid.

## Настройки (Settings → Variables, тип Text)

| Имя | По умолчанию | Что |
|---|---|---|
| `MODEL` | `cf:@cf/qwen/qwen3.8-27b,cf:@cf/zai-org/glm-4.7-flash,cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast` | модели через запятую: первая не ответила — пробуется следующая. `cf:` — Workers AI (привязка `AI`), без префикса — Gemini (только при платном тарифе) |
| `DEVICE_LIMIT` | `80` | запросов в день на устройство (общий лимит держит квота Google) |
| `ORIGINS` | `https://yuriilosiev-png.github.io,null` | откуда разрешены запросы (`null` — офлайн-копия в APK) |

## Жалобы

Кнопка ⚑ у ответа AI → `POST /report`. С KV — записи `r:…` в `planner-ai-rl` (хранятся 90 дней), без KV — строки `REPORT` в логах Worker'а (Worker → Logs).
