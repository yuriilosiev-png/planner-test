# Промпты для GPT — этап 1 (рот) и подготовка этапа 2 (Надя под риг)

Общие правила:
- К каждому запросу прикладывай утверждённую картинку из `coach/`. Без картинки GPT рисует чужого персонажа.
- Один запрос — одна картинка. Новый чат на каждого персонажа, чтобы GPT не смешивал их.
- Если GPT поменял лицо, причёску, одежду или пропорции — не исправляй, просто перегенерируй.
- Готовые картинки присылай мне как есть (PNG). Выравнивание по оригиналу и вклейку рта делаю я скриптом `tools/mouth_frames.py`: из ответа GPT берётся только рот, остальное остаётся от оригинала.

## 1. Формы рта — 4 картинки на персонажа (16 всего)

Прикладываешь: `coach/nadia-hello.webp`, `coach/genie-hello.webp`, `coach/guru-hello.webp`, `coach/coach-hello.webp` — по одной на чат.

Сначала отправь общий промпт, потом по очереди 4 короткие команды.

**Общий промпт (первым сообщением, с картинкой):**

```
This is an approved cartoon character from my app. I need 4 versions of this exact image for lip-sync animation.
Rules for every version:
- Change ONLY the mouth. Everything else must stay pixel-identical: face, eyes, eyebrows, glasses, hair, hat, beard and moustache, pose, hands, clothes, props, colours, line style, lighting.
- Same framing, same size and position of the character, same canvas, transparent background (PNG).
- Keep the character's natural expression; the mouth shape is just a frame of talking.
- Do not redraw, restyle or "improve" anything.
I will ask for the versions one by one. Reply only with the image.
```

**Команды по очереди:**

```
Version 1 (closed): lips gently closed, relaxed, a slight friendly smile, no teeth visible.
```
```
Version 2 (slightly open): lips slightly parted as in the middle of a word, a thin dark gap, top teeth barely visible.
```
```
Version 3 (open): mouth open as when saying "ah", the tongue faintly visible, top teeth visible.
```
```
Version 4 (round): lips rounded into a small "o" as when saying "oh", no teeth visible.
```

Особенности персонажей — добавь одной строкой к общему промпту:
- Джин: `The beard and moustache must stay exactly the same; only the lips between them move.`
- Гуру: `He has a big moustache and NO beard. Do not add a beard. The moustache stays the same; only the lips under it move.`
- Тренер Макс: `Keep the stubble and the whistle cord exactly as they are.`
- Надя: `Keep the red lipstick colour exactly the same in every version.`

Имена файлов при отправке мне: `nadia-m0.png … nadia-m3.png` (m0 — закрыт, m1 — приоткрыт, m2 — открыт, m3 — «о»). Так же для `genie`, `guru`, `coach`.

## 2. Надя под риг (этап 2, готовим заранее)

Прикладываешь: `coach/nadia-hello.webp` и `coach/nadia-think.webp` (вторая — чтобы GPT видел её с другого ракурса).

**Исходник в нейтральной позе:**

```
This is Nadia, an approved character of my app (two reference images attached). Draw her again for skeletal animation.
- Same character, face, glasses, hairstyle, red lipstick, purple blazer, cream blouse, black trousers and shoes, same line style and colours. Do not change her look.
- Full body, front view, standing straight, weight on both feet, feet slightly apart.
- Arms hanging slightly away from the body (about 20 degrees), elbows slightly bent, hands open and relaxed, fingers together. No hand may touch or cover the body.
- NO notebook, NO pencil — empty hands.
- Nothing overlaps: arms do not cover the torso, hair does not cover the shoulders, legs do not cross.
- Neutral calm face: eyes open looking at the viewer, eyebrows relaxed, mouth closed with a slight smile.
- Transparent background, PNG, portrait 1024x2048, the figure fills the height with a small margin.
```

**Ежедневник отдельно:**

```
Draw only Nadia's purple notebook from the reference, alone, closed, front view, same style and colours, transparent background, PNG 512x512.
```

**Варианты лица — с картинкой нейтральной позы из шага выше:**

Общий промпт — тот же, что для рта, но вместо «Change ONLY the mouth» пиши «Change ONLY the eyes» (или «eyebrows»). Команды:

```
Eyes half closed (relaxed blink, upper lids halfway down).
```
```
Eyes fully closed (thin curved lines).
```
```
Eyebrows raised (surprised, curious).
```
```
Eyebrows slightly frowned (thinking, doubtful).
```
```
One eyebrow raised (ironic look).
```

Формы рта для нейтральной позы — те же 4 команды из раздела 1.

Итого для Нади: исходник, ежедневник, 2 варианта глаз, 3 варианта бровей, 4 формы рта — 11 картинок. Нарезку слоёв и дорисовку под рукой делает Никита в Photopea по моему ТЗ (пришлю, когда будет исходник).
