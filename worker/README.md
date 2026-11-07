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
5. **Проверка.** Открыть `https://planner-ai.<твой-поддомен>.workers.dev/` — должно показать `{"ok":true,"service":"planner-ai","v":7}`.
   Этот адрес вписывается в `HP_AI_URL` в index.html.

## Workers AI (основной вариант)

Worker → Settings → Bindings → Add binding → **Workers AI** → имя переменной `AI` → Deploy. Ключ не нужен. Бесплатно 10 000 «нейронов» в день (примерно 150 ходов опроса), дальше — план Workers Paid.

## Настройки (Settings → Variables, тип Text)

| Имя | По умолчанию | Что |
|---|---|---|
| `MODEL` | `cf:@cf/qwen/qwen3.8-27b,cf:@cf/zai-org/glm-4.7-flash,cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast` | модели через запятую: первая не ответила — пробуется следующая. `cf:` — Workers AI (привязка `AI`), без префикса — Gemini (только при платном тарифе) |
| `DEVICE_LIMIT` | `80` | запросов в день на устройство (общий лимит держит квота Google) |
| `ORIGINS` | `https://yuriilosiev-png.github.io,null` | откуда разрешены запросы (`null` — офлайн-копия в APK) |

## Ответ `/chat` (v6)

`reply`, `ask`, `set`, `emo` — как раньше. Приложение с `cv: 2` в запросе (planner-test после этапа 1) получает ещё:

| Поле | Значения |
|---|---|
| `emo` | neutral, smile, happy, excited, proud, think, doubt, surprised, sad, worried, sly, strict |
| `gesture` | none, wave, nod, shake_head, point_up, thumbs_up, show_check, shrug, hand_on_chin, celebrate, signature |
| `intensity` | 0.3…1 |

Неизвестное значение заменяется на `think` / `none`. Приложение без `cv` (прод 1.7.8) получает `emo` только из старых пяти (think, happy, proud, sad, sly) и без новых полей, поэтому v6 можно ставить, не дожидаясь обновления прода. Проверка: `GET /` → `"v":6`.

## Жалобы

Кнопка ⚑ у ответа AI → `POST /report`. С KV — записи `r:…` в `planner-ai-rl` (хранятся 90 дней), без KV — строки `REPORT` в логах Worker'а (Worker → Logs).

## v7: действия над записями (`cv: 3`)

Приложение с `cv: 3` (planner-test с 1.7.9) присылает в `/chat` ещё `data` — краткую сводку записей с id
(goals, tree, tasks на 14 дней вперёд и невыполненные за 7 дней назад, events, rewards) и может прислать
`mode: "assist"` — свободный разговор «Попросить помощника» без опроса по цели.

В ответ, кроме полей v6, приходит `actions` (до 3), только если человек сам попросил что-то изменить:

| op | поля |
|---|---|
| `event.add` / `event.update` / `event.delete` | date, title, note, time (напоминание), type meeting/event/birthday, repeat once/monthly/yearly, alert:false |
| `task.add` / `task.update` / `task.done` / `task.delete` | date, title, time; удалять можно только задачи без цели |
| `goal.update` / `goal.delete` / `goal.achieve` | title, deadline, target, unit, days (0=Пн…6=Вс), time, vision |
| `tree.add` / `tree.update` / `tree.delete` | parent, title, deadline, time |
| `reward.add` / `reward.update` / `reward.delete` | title, price, emoji |

Worker отбрасывает неизвестные операции и поля с неверным форматом, приложение ещё раз проверяет каждое
действие по своим данным и применяет только после кнопки «Выполнить» (есть «Отменить»).
Клиенты с `cv` 1–2 (прод 1.7.8) не получают `actions` и `data` не шлют — v7 можно ставить сразу.
Им добавлено только правило «не описывать кнопки и жесты приложения».
Сводка записей увеличивает запрос, поэтому бесплатных ходов Workers AI в день станет меньше (примерно в 1,5–2 раза).
Проверка: `GET /` → `"v":8`.

## v8: быстрые платные модели

Перебор моделей: `an:claude-haiku-5-5` (Anthropic) → `gq:openai/gpt-oss-120b` (Groq) → Workers AI.
Модель без ключа пропускается. На одну модель — 9 с, на весь перебор — 20 с (приложение ждёт 25 с и уходит на сценарий).

- **Anthropic:** console.anthropic.com → Billing (пополнить от $5) → API Keys → Create. В Worker: Settings → Variables and Secrets → Add → Secret `ANTHROPIC_KEY`.
- **Groq:** console.groq.com → API Keys → Create. Secret `GROQ_KEY`. Бесплатно ~1000 запросов в день и 8000 токенов в минуту (это 1–2 хода в минуту на всех), платно — Developer.
- Если в Worker задана переменная `MODEL`, она перекрывает порядок по умолчанию: удалить её или вписать `an:claude-haiku-5-5,gq:openai/gpt-oss-120b,cf:@cf/qwen/qwen3.8-27b,cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Проверка: `GET /` → `"v":8`. В логах Worker (Observability) видно, какая модель ответила (поле `model` в ответе).

## v9: характеры и настройки

- Характеры: Макс — спортивный тренер, Надежда — загадочная, добрая, слегка кокетливая и иногда стеснительная (без романтики), Гуру — философ-стоик, Джин — шутник на позитиве. Действует и для прода 1.7.8.
- Новые действия: `set.theme` (screen, mode, hue/sat, hue2/sat2), `set.lang`, `set.helper` (persona, style, freq, morning), `set.notify` (on, count — только в APK); `goal.update` с `notify` (цель в шторке); тип события `milestone` (веха).
- В `data.settings` приложение присылает текущие настройки. Проверка: `GET /` → `"v":9`.

## v10: правки по тесту

- Подсказка ИИ: сначала перечитать диалог и не переспрашивать сказанное; сразу ставить единицу (для творческих проектов — секунды, сцены, часы работы); цели от 3 месяцев — долгосрочные.
- Характеры Макса и Надежды доработаны (Макс сам предлагает реальные цифры, Надежда «всё записывает» и ссылается на сказанное).
- Проверка: `GET /` → `"v":10`.

## v11

- Фон: явные правила hue/sat (названный цвет — sat 65–85, верх = hue/sat, низ = hue2/sat2), `reset: true` — стандартные цвета; в тексте ответа без технических названий и чисел.
- Ошибка AI в «Попросить помощника» показывает причину: код ответа, `timeout` или `net`; 429 — «лимит на сегодня». Лимит на устройство — переменная `DEVICE_LIMIT` (по умолчанию 80 в день).
- Проверка: `GET /` → `"v":11`.

## v12

- Надежда переписана: естественная речь, без пересказа слов пользователя, лёгкое смущение не чаще раза в несколько ответов.
- Для всех: не начинать ответ с пересказа, не повторять свои прошлые ответы, на посторонний вопрос — коротко ответить и вернуться к цели; «25-минутный мультфильм» сразу в target/unit.
- Приложение: если AI упал, через 20 с следующее сообщение снова идёт в AI; в сценарии вместо одинаковой реплики — подсказка «напишите число».
- Проверка: `GET /` → `"v":12`.
