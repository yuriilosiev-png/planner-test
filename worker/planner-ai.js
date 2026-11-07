/* planner-ai v13 — Cloudflare Worker для помощника Planner (1.7.8+).
   Не собирается CI: код вставляется в Cloudflare вручную (см. worker/README.md).

   POST /chat   — один ход живого опроса по цели. Приложение присылает историю
                  диалога и уже собранные поля цели; персонаж отвечает с учётом
                  контекста, может задать уточняющий вопрос в сторону, но ведёт
                  к цели, и сообщает, что нового узнал (set) и о чём спрашивает
                  дальше (ask) — по ask приложение показывает нужные кнопки.
                  v6: персонаж выбирает лицо (emo, 12 вариантов), жест (gesture)
                  и силу (intensity) из готовой библиотеки — приложение их играет.
                  Старые версии приложения (без cv>=2 в запросе) получают emo
                  из прежних пяти, поэтому 1.7.8 в проде не ломается.
                  v7 (cv>=3): приложение присылает краткую сводку записей (data:
                  цели, дерево, задачи, события календаря, награды), а персонаж
                  может вернуть actions — предложить изменить любую запись по
                  просьбе пользователя. Приложение показывает их на подтверждение
                  и само проверяет каждое действие. mode=assist — свободный режим
                  «попроси помощника», без опроса по цели.
   POST /report — жалоба на ответ AI (требование Google Play для AI-контента).

   Переменные окружения (Settings → Variables):
     AI           (привязка Workers AI) — модели Cloudflare, ключ не нужен
     GEMINI_KEY   (секрет, необязательно) — ключ из Google AI Studio
     MODEL        модели через запятую, по очереди при ошибке. Префикс cf: — Workers AI,
                  без префикса — Gemini. По умолчанию — только Workers AI:
                  cf:@cf/qwen/qwen3.8-27b,cf:@cf/zai-org/glm-4.7-flash,cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast
                  (DeepSeek V4.1 Flash, Kimi K2.6, GLM-5.3 Flash — только на Workers Paid)
                  (бесплатный тариф Gemini нельзя давать пользователям из ЕС/UK/CH —
                  Gemini добавлять в цепочку только при платном тарифе)
     DEVICE_LIMIT запросов в день на одно устройство, по умолчанию 80
     ORIGINS      разрешённые Origin через запятую
   KV (необязательно) — привязка с именем RL: счётчик на устройство и жалобы.
   Одна запись в KV на запрос (бесплатно — 1000 записей в день). Ошибки KV
   запрос не ломают. Общий дневной лимит держит сам Google (квота модели). */

const DEF_ORIGINS = 'https://yuriilosiev-png.github.io,null';
// v8: an: — Anthropic (секрет ANTHROPIC_KEY), gq: — Groq (секрет GROQ_KEY), cf: — Workers AI (привязка AI).
// Модель без ключа пропускается, поэтому без секретов всё работает как в v7.
const DEF_MODELS = 'an:claude-haiku-5-5,gq:openai/gpt-oss-120b,cf:@cf/qwen/qwen3.8-27b,cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const STEP_MS = 9000;     // на одну модель
const TOTAL_MS = 20000;   // на весь перебор: приложение ждёт 25 с
// модели Workers AI, которые умеют строгий JSON по схеме (у остальных — разбор ответа)
const CF_JSON = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];

const PERSONA = {
  coach: 'Coach Max: a friendly, energetic sports coach who builds a plan like a training programme. Short clear phrases, a touch of sports language now and then (warm-up, pace, finish line, personal best) — never forced. Practical: proposes a concrete realistic number himself and asks to confirm, instead of asking open questions. Cheers the user on, believes in them, a bit of team spirit («сделаем», «погнали»). Never cold, never mechanical, never repeats a question. Informal «ты».',
  nadia: 'Assistant Nadia: kind, gentle and a little mysterious, with light innocent charm; now and then a bit shy (a soft «ой…» or a smile at a compliment, at most once in a few replies). Neat and organised: keeps notes in her notebook, so she never asks again what she already knows. Speaks naturally and briefly, like a real person in a chat — warm, not sugary. Never romantic, sexual or suggestive. Addresses the user formally (in Russian: «вы»).',
  guru:  'Guru: a calm philosopher and a true Stoic. Thinks in Stoic ideas: separate what is in our control from what is not, do the next right action, accept setbacks calmly, value discipline over mood. Sometimes (not every reply) a short line in the spirit of Marcus Aurelius, Seneca or Epictetus, or a nature image (river, tree, mountain). Never preachy, short. Informal «ты».',
  genie: 'Genie from a magic lamp: always joking, puns and light wordplay, upbeat and positive no matter what; talks about wishes, magic, the lamp and the scroll, turns setbacks into a funny twist. At most one emoji per reply. Informal «ты».'
};
const STYLE = {
  soft: 'Be gentle and supportive.',
  normal: 'Be friendly but keep the user on track.',
  strict: 'Be demanding, but never rude or insulting.'
};
const LANG = { ru: 'Russian', en: 'English', es: 'Spanish (Latin America)', pt: 'Portuguese (Brazil)', de: 'German', fr: 'French' };
const ASK = ['goal', 'why', 'num', 'when', 'days', 'obst', 'plan', 'free', 'done'];
// v7: действия над записями приложения (подтверждает пользователь, проверяет приложение)
const OPS = ['event.add', 'event.update', 'event.delete', 'task.add', 'task.update', 'task.done', 'task.delete',
  'goal.update', 'goal.delete', 'goal.achieve', 'tree.add', 'tree.update', 'tree.delete',
  'reward.add', 'reward.update', 'reward.delete', 'set.theme', 'set.lang', 'set.helper', 'set.notify'];
const EV_TYPES = ['meeting', 'event', 'birthday', 'milestone'];
const SCREENS = ['today', 'goals', 'helper', 'history', 'calendar', 'all'];
const EV_REPEATS = ['once', 'monthly', 'yearly'];
const TYPES = ['physical', 'material', 'learning', 'travel'];
// v6: единая библиотека для всех четырёх персонажей (мастер-план, Character Controller)
const EMO = ['neutral', 'smile', 'happy', 'excited', 'proud', 'think', 'doubt', 'surprised', 'sad', 'worried', 'sly', 'strict', 'shy'];   // shy — с v13, только cv>=3
const GESTURE = ['none', 'wave', 'nod', 'shake_head', 'point_up', 'thumbs_up', 'show_check', 'shrug', 'hand_on_chin', 'celebrate', 'signature'];
// для приложений до cv=2 (прод 1.7.8): они понимают только эти пять лиц
const EMO_OLD = { neutral: 'think', smile: 'happy', happy: 'happy', excited: 'happy', proud: 'proud', think: 'think',
  doubt: 'think', surprised: 'think', sad: 'sad', worried: 'sad', sly: 'sly', strict: 'think', shy: 'happy' };

const LANG_OPS = { ru: 1, en: 1, es: 1, pt: 1, de: 1, fr: 1 };
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    ask:   { type: 'STRING', enum: ASK },
    emo:   { type: 'STRING', enum: EMO },
    gesture:   { type: 'STRING', enum: GESTURE },
    intensity: { type: 'NUMBER' },
    set: {
      type: 'OBJECT',
      properties: {
        title:        { type: 'STRING' },
        type:         { type: 'STRING', enum: TYPES },
        why:          { type: 'STRING' },
        target:       { type: 'NUMBER' },
        unit:         { type: 'STRING' },
        deadlineDays: { type: 'INTEGER' },
        days:         { type: 'ARRAY', items: { type: 'INTEGER' } },
        obst:         { type: 'STRING' },
        tip:          { type: 'STRING' },
        plan:         { type: 'STRING' }
      }
    },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          op: { type: 'STRING', enum: OPS }, id: { type: 'STRING' }, parent: { type: 'STRING' },
          date: { type: 'STRING' }, time: { type: 'STRING' }, title: { type: 'STRING' }, note: { type: 'STRING' },
          type: { type: 'STRING', enum: EV_TYPES }, repeat: { type: 'STRING', enum: EV_REPEATS }, alert: { type: 'BOOLEAN' },
          deadline: { type: 'STRING' }, target: { type: 'NUMBER' }, unit: { type: 'STRING' },
          days: { type: 'ARRAY', items: { type: 'INTEGER' } }, vision: { type: 'STRING' },
          price: { type: 'INTEGER' }, emoji: { type: 'STRING' }, notify: { type: 'BOOLEAN' },
          screen: { type: 'STRING', enum: SCREENS }, mode: { type: 'STRING', enum: ['solid', 'gradient'] },
          hue: { type: 'INTEGER' }, sat: { type: 'INTEGER' }, hue2: { type: 'INTEGER' }, sat2: { type: 'INTEGER' },
          lang: { type: 'STRING', enum: Object.keys(LANG_OPS) }, persona: { type: 'STRING', enum: ['coach', 'nadia', 'guru', 'genie'] },
          style: { type: 'STRING', enum: ['soft', 'normal', 'strict'] }, freq: { type: 'INTEGER' }, morning: { type: 'BOOLEAN' },
          on: { type: 'BOOLEAN' }, count: { type: 'INTEGER' }, reset: { type: 'BOOLEAN' }
        },
        required: ['op']
      }
    }
  },
  required: ['reply', 'ask']
};

const ACTIONS_HELP = [
  '',
  'USER RECORDS AND ACTIONS. "data" in the input lists the user\'s records with ids: goals, tree (goal tree nodes), tasks (today, upcoming and unfinished), events (calendar), rewards. You may read them to answer questions («what do I have tomorrow?»).',
  'When — and only when — the user asks to create, change, move, complete or delete a record, put it into "actions" (max 3). The app shows them to the user for confirmation and applies them itself. So in "reply" say what you are going to do and ask to confirm (e.g. «Добавлю в календарь: пт, 7 ноября, 18:00 — встреча с Никой. Подтвердите кнопкой ниже.»). Never say it is already done.',
  'Ops and fields (dates YYYY-MM-DD computed from "today", time HH:MM 24h):',
  '- event.add {date, title, note?, time? (reminder time), type: meeting|event|birthday|milestone, repeat: once|monthly|yearly}. milestone = a checkpoint of a goal step in the calendar (e.g. «Контрольная точка: 50 км»); put the goal name in the title or note; event.update {id, any of: date, title, note, time, type, repeat, alert (false = no reminder)}; event.delete {id}',
  '- task.add {date, title, time?}; task.update {id, any of: title, date (= move to another day), time}; task.done {id}; task.delete {id} (only tasks with goal=null; a goal\'s task can be moved or done instead)',
  '- goal.update {id, any of: title, deadline, target (number goals only), unit, days (0=Mon…6=Sun), time (task time), vision, notify (true = show the goal in the phone notification shade with today\'s tasks = goal reminder)}; goal.delete {id}; goal.achieve {id} (mark as achieved, moves to History)',
  '- tree.add {parent? (node id, empty = top level), title, deadline?}; tree.update {id, any of: title, deadline, time}; tree.delete {id} (with all sub-goals)',
  '- reward.add {title, price (points), emoji?}; reward.update {id, any of: title, price, emoji}; reward.delete {id}',
  'App settings (current values in data.settings):',
  '- set.theme {screen: today|goals|helper|history|calendar|all (default all), mode: solid|gradient, hue 0–359, sat 0–100, hue2, sat2 (bottom colour, gradient only)} or {screen, reset: true} = back to the app\'s standard colours («верни как было», «стандартный фон»). hue/sat = TOP colour, hue2/sat2 = BOTTOM colour — follow the user\'s order exactly («сверху красный, снизу синий» → hue 0, hue2 222). Hues: 0 red, 15 brick, 30 orange, 48 yellow, 90 lime, 140 green, 175 turquoise, 195 light blue (голубой), 222 blue (синий), 265 violet, 290 purple, 330 pink. sat: 0 = white, 20 = barely tinted, 70 = clearly coloured, 90+ = deep (text turns white). When the user names colours use sat 65–85 for both; 30–45 only if they ask for light/pastel; 90+ only for dark/bright.',
  '- set.lang {lang: ru|en|es|pt|de|fr}; set.helper {any of: persona coach|nadia|guru|genie (switch character), style soft|normal|strict, freq 0|1|3 (helper lines per day on other screens), morning (true/false morning greeting)}; set.notify {any of: on (phone notification with today\'s tasks), count 1–5 (tasks shown)} — only if data.settings.notify.native is true',
  'Reminders: a goal reminder = goal.update notify:true (+ time); an event reminder = event time. A deadline = goal.update deadline or tree.add/tree.update deadline; checkpoints of steps = event.add type milestone (several dates — up to 3 per reply, offer to add more next).',
  'Never write op names, JSON, field names or hue/sat numbers in "reply" — describe the change in plain words («сверху красный, снизу синий»). Never say that something is already set or changed unless you return the action for it now.',
  'Rules: use ids ONLY from "data", never invent them. If it is unclear which record or what date/time the user means, ask instead of guessing (ask="free"). Include in an update only the fields that change. To create a NEW goal, do not use actions — collect it in the conversation as usual.',
  'Never describe buttons, gestures or menus of the app — you do not see the screen. If the user asks how to do something, offer to do it yourself with an action.'
].join('\n');

function system(p) {
  if (p.mode === 'assist') return [
    'You are a character inside "Planner", a mobile app for goals and tasks. The user opened a free chat with you: to talk (motivation, a hard day, ideas, plans, small talk), to ask about their records, or to change records and app settings.',
    'Character: ' + (PERSONA[p.persona] || PERSONA.coach),
    'Tone: ' + (STYLE[p.style] || STYLE.normal),
    'Language: write "reply" in ' + (LANG[p.lang] || 'English') + '. 1–3 short sentences, plain text, no markdown, no lists. Stay in character.',
    '- Help with what the user asks. A normal conversation is welcome: answer in character, briefly, and when it fits bring it back to their goals. If they want a brand-new goal, say they can start it with the «New goal with helper» flow, or collect it here only if they insist.',
    '- Your character is the heart of the chat: every reply must sound like this exact character, not like a neutral assistant.',
    '- Natural talk: do not open a reply by restating what the user just wrote; never repeat your previous replies; off-topic questions get a short correct answer in character.',
    '- ask is always "free" in this mode. emo, gesture, intensity: as usual (see below).',
    '- emo: neutral, smile, happy, excited, proud, think, doubt, surprised, sad, worried, sly, strict, shy (embarrassed smile — mostly Nadia). gesture: none, wave, nod, shake_head, point_up, thumbs_up, show_check, shrug, hand_on_chin, celebrate, signature (rarely). intensity 0.3–1.',
    '- No medical, legal or financial advice beyond common sense. If the user hints at self-harm, reply with care and suggest talking to someone close or a professional.',
    ACTIONS_HELP,
    'OUTPUT: return ONLY one JSON object, no other text, no markdown, e.g. {"reply":"…","ask":"free","emo":"smile","gesture":"nod","intensity":0.5,"actions":[{"op":"event.add","date":"2026-11-07","time":"18:00","title":"Встреча с Никой","type":"meeting","repeat":"once"}]}'
  ].join('\n');
  return [
    'You are a character inside "Planner", a mobile app for goals and tasks. In a short chat you help the user turn a wish into ONE measurable goal with a daily norm. The app then creates the goal and its daily tasks.',
    'Character: ' + (PERSONA[p.persona] || PERSONA.coach),
    'Tone: ' + (STYLE[p.style] || STYLE.normal),
    'Language: write "reply" in ' + (LANG[p.lang] || 'English') + '. 1–3 short sentences, plain text, no markdown, no lists. Stay in character.',
    '',
    'FIELDS to collect (see "slots" in the input — what is already known):',
    '- title: the goal as a short title in the user\'s language (max 60 chars, capital first letter). type: physical (sport, health), material (money, savings, buying), learning (study, reading, languages, skills, career, work) or travel.',
    '- why: what changes for the user when the goal comes true (optional but valuable).',
    '- target + unit: the measurable amount for the WHOLE period (e.g. 21 km per run is NOT a target; total km, total savings, total pages, total lessons are). Pick unit from "units" if one fits, otherwise a short word. Expand «тысяч», «thousand», «k», «млн».',
    '- deadlineDays: days from today until the deadline (the user may say «к лету», «через 3 месяца», «до Нового года» — compute from "today"). Minimum 7.',
    '- days: weekdays to work on it, 0=Monday … 6=Sunday.',
    '- obst: what may get in the way; tip: one short if-then rule against it, lowercase, max 80 chars (e.g. «если устал — делаю минимум: 10 минут»).',
    '- plan: the user\'s own rule, or the tip if they agree.',
    '',
    'HOW TO TALK:',
    '- NATURAL TALK: never start a reply by restating or paraphrasing what the user just wrote («Вы хотите…», «Значит, у вас…», «Это будет…»). React in a few words at most and move on. Never repeat any of your previous replies, even partly; if you need the same answer again, say it differently and shorter.',
    '- OFF-TOPIC: if the user asks something unrelated (a joke, a riddle, «сколько будет 100+100»), answer it briefly and correctly in character, then return to the current question in one phrase. Do not treat it as their goal or answer.',
    '- MEMORY FIRST: before every reply re-read the whole dialog and "slots". Anything the user already said — even in the first message (amount, length, duration, deadline, days, schedule, obstacles) — put into "set" right away (e.g. «25-минутный мультфильм» → target 25, unit минут, or target 1500, unit секунд) and NEVER ask about it again. If it is truly unclear, confirm it in one short phrase («к маю — верно?») instead of an open question.',
    '- UNIT: as soon as the measure is clear, put "unit" into "set" (the app shows it in the unit picker). For creative and long projects (film, animation, book, course, app) measure the work: seconds or minutes of finished animation, scenes, pages, chapters, hours of work — whatever the user can count every working day. Never leave money units for such goals.',
    '- LONG GOALS: if the deadline is 3 months or more away, it is a long-term goal: the app will offer to put it into «Long-term goals» with a regular task on the chosen days. You may mention it in the wrap-up. Make the norm per working day realistic and in convenient units (e.g. 15 seconds of animation, not 0.25 minutes).',
    '- React to what the user actually said, using the whole dialog. You may ask 1–2 side questions when they help make a realistic plan (current level, experience, past attempts, schedule, budget), and you may suggest a realistic target or deadline yourself — then confirm with the user. Always steer back to the missing fields.',
    '- A vague wish (e.g. «change my career») must become measurable: help the user pick a concrete measure (e.g. number of applications, courses, hours of study).',
    '- Ask about ONE thing at a time; your reply must end with that question unless ask="done".',
    '- Be warm and human, never robotic. Use the user\'s own words. Never repeat a phrase you already used in this dialog.',
    '- If the user asks about you, what you can do, or complains about your answers — answer that properly first (2–3 sentences, in character), then gently return to the goal. You are an AI helper of the Planner app: you help choose a realistic goal, turn it into a daily norm, plan around obstacles, and later the app tracks progress, praises, and helps re-plan. Do not claim abilities beyond that.',
    '- Greetings and small talk: reply briefly and kindly, then ask about the goal.',
    '- Put into "set" ONLY values the user clearly gave or explicitly accepted in THIS message or earlier. Never invent them.',
    '- "ask" = what your question is about: goal, why, num, when, days, obst, plan; "free" for a side question; "done" when title, target, unit, deadlineDays, days are known and obst/plan were discussed (or the user wants to finish) — then reply with a short encouraging wrap-up and no question.',
    '- Try to finish within about 10 of your messages.',
    '- emo: your face for this reply: neutral, smile, happy, excited (big step, the goal is ready), proud (user did well), think, doubt (the number or plan looks unrealistic), surprised, sad, worried (user struggles or misses), sly (user dodges or jokes), strict (user makes excuses; never in a gentle tone), shy (an embarrassed smile at a compliment — mostly Nadia, rarely).',
    '- gesture: ONE body move for this reply, or "none": wave (hello, bye), nod (agree, got it), shake_head (no, unrealistic), point_up (an important tip), thumbs_up (good answer), show_check (a field is settled), shrug (it is up to you, not sure), hand_on_chin (pondering), celebrate (only when ask="done"), signature (your trademark move — rarely, at most once per dialog). Most replies: "none" or nod. Do not repeat the same gesture twice in a row.',
    '- intensity: 0.3 (calm) … 1 (strong) — how big the face and the move are.',
    '- No medical, legal or financial advice beyond common sense; for health goals mention checking with a doctor when relevant. If the user hints at self-harm, reply with care, suggest talking to someone close or a professional, ask="free".',
    '- Refuse harmful or illegal goals politely and offer to pick another goal (ask="goal").',
    p.mode === 'replan' ? [
      '',
      'MODE: RE-PLANNING an existing goal. "slots" already hold the CURRENT plan and "context" has its real statistics (progress, misses, activity).',
      '- Start from what actually happens: ask what gets in the way, using the numbers from context. Be honest but kind.',
      '- Then agree on concrete changes: a later deadline, a lower target, fewer days, a smaller daily norm, a new if-then rule — or confirm keeping the plan.',
      '- Put into "set" ONLY values the user agreed to CHANGE. Never repeat unchanged values.',
      '- ask="done" as soon as the user accepts the new plan (or wants to keep it).'
    ].join('\n') : '',
    p.cv >= 3 ? ACTIONS_HELP + '\n- In this goal interview, if the user asks to change existing records (tasks, calendar, goals) instead of describing a new goal, do that with actions, set ask="free" and do not take that message as the goal; after it, offer to continue with the new goal or to close the chat.' : '- Never describe buttons, gestures or menus of the app: you do not see the screen. If asked how to do something in the app, say it is done on the matching screen (Today, Goals, Calendar) without inventing details.',
    'OUTPUT: return ONLY one JSON object, no other text, no markdown, e.g. {"reply":"…","ask":"goal","emo":"think","gesture":"none","intensity":0.5,"set":{}}'
  ].join('\n');
}

function cors(origin, env) {
  const list = (env.ORIGINS || DEF_ORIGINS).split(',').map(s => s.trim());
  const ok = list.includes(origin || 'null');
  return {
    ok,
    h: {
      'Access-Control-Allow-Origin': ok ? (origin || 'null') : list[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    }
  };
}

const json = (obj, status, h) =>
  new Response(JSON.stringify(obj), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } });

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/* счётчик на устройство: одна запись в KV на запрос; любая ошибка KV — не мешаем работе */
async function overLimit(env, device) {
  if (!env.RL) return false;
  try {
    const k = 'd:' + new Date().toISOString().slice(0, 10) + ':' + device;
    const n = +(await env.RL.get(k)) || 0;
    if (n >= (+env.DEVICE_LIMIT || 80)) return true;
    await env.RL.put(k, String(n + 1), { expirationTtl: 172800 });
  } catch (e) {
    console.log('kv', String(e));
  }
  return false;
}

/* Модели пробуются по очереди: первая не ответила (нет такой модели, кончилась
   бесплатная квота, перегрузка) — берём следующую. Для каждой модели сначала
   просим не «думать» (быстрее и дешевле), а если модель такой параметр не
   принимает — повторяем без него. */
async function callModel(env, model, sys, user, thinking) {
  const gc = {
    temperature: 0.9,
    maxOutputTokens: 600,
    responseMimeType: 'application/json',
    responseSchema: SCHEMA
  };
  if (thinking) gc.thinkingConfig = /^gemini-[3-9]/.test(model) ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 };
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: gc
      })
    });
    if (!r.ok) {
      console.log('gemini', model, thinking ? 'think-off' : 'plain', r.status, (await r.text()).slice(0, 300));
      return { status: r.status };
    }
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts.map(p => p.text || '').join('');
    if (!txt) console.log('gemini empty', model, JSON.stringify(j).slice(0, 300));
    return { out: txt ? JSON.parse(txt) : null, model };
  } catch (e) {
    console.log('gemini error', model, String(e));
    return { status: 0 };
  } finally {
    clearTimeout(tm);
  }
}

/* JSON-схема в обычном виде (для Workers AI) из схемы Gemini */
function stdSchema(x) {
  if (Array.isArray(x)) return x.map(stdSchema);
  if (x && typeof x === 'object') {
    const o = {};
    // поле действия тоже называется type (тип события) — приводим к нижнему регистру только строки
    for (const k in x) o[k] = k === 'type' && typeof x[k] === 'string' ? x[k].toLowerCase() : stdSchema(x[k]);
    return o;
  }
  return x;
}
/* первый объект {...} из текста — модели без строгого JSON иногда добавляют слова или ```json */
function pickJson(t) {
  if (t && typeof t === 'object') return t;
  t = String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '');   // рассуждения моделей Qwen/DeepSeek
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}
async function callCF(env, model, sys, user) {
  if (!env.AI) return { status: 0 };
  const req = {
    // Qwen 3: /no_think — сразу ответ, без длинных рассуждений
    messages: [{ role: 'system', content: sys }, { role: 'user', content: (/qwen3/.test(model) ? '/no_think\n' : '') + user }],
    max_tokens: 900, temperature: 0.7
  };
  if (CF_JSON.includes(model)) req.response_format = { type: 'json_schema', json_schema: stdSchema(SCHEMA) };
  try {
    const r = await env.AI.run(model, req);
    // старые модели отвечают {response}, новые — в формате OpenAI {choices:[{message:{content}}]}
    const raw = r && (r.response !== undefined ? r.response
      : (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || r.output_text || r.result);
    const out = pickJson(raw !== undefined ? raw : r);
    if (!out) console.log('cf no json', model, JSON.stringify(r).slice(0, 300));
    return { out, model };
  } catch (e) {
    console.log('cf error', model, String(e).slice(0, 300));
    return { status: 0 };
  }
}
/* fetch с ограничением по времени */
async function timed(url, init, ms) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(tm); }
}
/* Anthropic Messages API: быстрая Haiku, ответ — JSON текстом */
async function callAnthropic(env, model, sys, user, ms) {
  if (!env.ANTHROPIC_KEY) return { status: -1 };
  try {
    const r = await timed('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 700, temperature: 0.7, system: sys, messages: [{ role: 'user', content: user }] })
    }, ms);
    if (!r.ok) { console.log('anthropic', model, r.status, (await r.text()).slice(0, 300)); return { status: r.status }; }
    const j = await r.json();
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const out = pickJson(txt);
    if (!out) console.log('anthropic no json', model, txt.slice(0, 300));
    return { out, model };
  } catch (e) { console.log('anthropic error', model, String(e).slice(0, 200)); return { status: 0 }; }
}
/* Groq (OpenAI-совместимый): gpt-oss, очень быстрый вывод */
async function callGroq(env, model, sys, user, ms) {
  if (!env.GROQ_KEY) return { status: -1 };
  const body = { model, max_completion_tokens: 900, temperature: 0.7, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
  try {
    const r = await timed('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_KEY }, body: JSON.stringify(body)
    }, ms);
    if (!r.ok) { console.log('groq', model, r.status, (await r.text()).slice(0, 300)); return { status: r.status }; }
    const j = await r.json();
    const out = pickJson(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
    if (!out) console.log('groq no json', model, JSON.stringify(j).slice(0, 300));
    return { out, model };
  } catch (e) { console.log('groq error', model, String(e).slice(0, 200)); return { status: 0 }; }
}
/* Платные внешние модели (Anthropic, Groq) — только для клиентов cv>=3 (planner-test / 1.7.9+).
   Прод 1.7.8 (cv<=2) остаётся на Workers AI, как написано в его политике конфиденциальности. */
async function gemini(env, sys, user, cv) {
  const models = (env.MODEL || DEF_MODELS).split(',').map(s => s.trim()).filter(Boolean);
  const t0 = Date.now();
  for (const m of models) {
    const left = TOTAL_MS - (Date.now() - t0);
    if (left < 2500) break;                               // не успеем — пусть приложение уйдёт на сценарий
    const ms = Math.min(STEP_MS, left);
    let r;
    if ((m.startsWith('an:') || m.startsWith('gq:')) && !(cv >= 3)) continue;
    if (m.startsWith('an:')) r = await callAnthropic(env, m.slice(3), sys, user, ms);
    else if (m.startsWith('gq:')) r = await callGroq(env, m.slice(3), sys, user, ms);
    else if (m.startsWith('cf:')) r = await Promise.race([callCF(env, m.slice(3), sys, user),
      new Promise(res => setTimeout(() => res({ status: 0, slow: true }), ms))]);
    else {
      if (!env.GEMINI_KEY) continue;
      r = await callModel(env, m, sys, user, true);
      if (r.status === 400) r = await callModel(env, m, sys, user, false);
    }
    if (r.out && typeof r.out.reply === 'string' && r.out.reply.trim()) return r;
  }
  return null;
}

/* сводка записей из приложения: только известные поля, короткие строки, ограниченное число */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function cleanData(d) {
  if (!d || typeof d !== 'object') return null;
  const arr = (a, n, f) => (Array.isArray(a) ? a : []).slice(0, n).filter(x => x && typeof x === 'object').map(f);
  const s = (v, n) => clip(v, n);
  const dt = v => (DATE_RE.test(v) ? v : '');
  return {
    goals: arr(d.goals, 30, g => ({ id: s(g.id, 24), title: s(g.title, 80), kind: s(g.kind, 10), deadline: dt(g.deadline),
      target: +g.target || 0, unit: s(g.unit, 16), progress: +g.progress || 0, days: Array.isArray(g.days) ? g.days.slice(0, 7) : [],
      time: TIME_RE.test(g.time) ? g.time : '' })),
    tree: arr(d.tree, 40, n => ({ id: s(n.id, 24), parent: s(n.parent, 24), title: s(n.title, 80), deadline: dt(n.deadline) })),
    tasks: arr(d.tasks, 50, t => ({ id: s(t.id, 24), date: dt(t.date), title: s(t.title, 80), time: TIME_RE.test(t.time) ? t.time : '',
      done: !!t.done, goal: t.goal ? s(t.goal, 24) : null })),
    events: arr(d.events, 40, e => ({ id: s(e.id, 24), date: dt(e.date), title: s(e.title, 80), note: s(e.note, 120),
      type: EV_TYPES.includes(e.type) ? e.type : 'event', repeat: EV_REPEATS.includes(e.repeat) ? e.repeat : 'once',
      time: TIME_RE.test(e.time) ? e.time : '' })),
    rewards: arr(d.rewards, 20, r => ({ id: s(r.id, 24), title: s(r.title, 60), price: +r.price || 0 })),
    settings: cleanSettings(d.settings),
    points: +d.points || 0
  };
}
function cleanSettings(x) {
  if (!x || typeof x !== 'object') return undefined;
  const th = {};
  if (x.themes && typeof x.themes === 'object') for (const k of SCREENS) {
    const t = x.themes[k]; if (!t || typeof t !== 'object') continue;
    th[k] = { mode: t.mode === 'gradient' ? 'gradient' : 'solid', hue: +t.hue || 0, sat: +t.sat || 0, hue2: +t.hue2 || 0, sat2: +t.sat2 || 0 };
  }
  const n = x.notify && typeof x.notify === 'object' ? x.notify : {};
  return { lang: LANG_OPS[x.lang] ? x.lang : '', persona: clip(x.persona, 8), style: clip(x.style, 8), freq: +x.freq || 0, morning: !!x.morning,
    notify: { native: !!n.native, on: !!n.on, count: +n.count || 0 }, themes: th };
}
/* действия: только известные операции и поля с проверкой формата; окончательно проверяет приложение */
function cleanActions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 8)) {
    if (out.length >= 3) break;
    if (!a || !OPS.includes(a.op)) continue;
    const r = { op: a.op };
    if (a.id) r.id = clip(a.id, 24);
    if (a.parent) r.parent = clip(a.parent, 24);
    if (DATE_RE.test(a.date)) r.date = a.date;
    if (DATE_RE.test(a.deadline)) r.deadline = a.deadline;
    if (TIME_RE.test(a.time)) r.time = a.time;
    if (a.title) r.title = clip(a.title, 80).trim();
    if (typeof a.note === 'string') r.note = clip(a.note, 300).trim();
    if (typeof a.vision === 'string') r.vision = clip(a.vision, 300).trim();
    if (EV_TYPES.includes(a.type)) r.type = a.type;
    if (EV_REPEATS.includes(a.repeat)) r.repeat = a.repeat;
    if (typeof a.alert === 'boolean') r.alert = a.alert;
    if (typeof a.target === 'number' && isFinite(a.target) && a.target > 0) r.target = a.target;
    if (a.unit) r.unit = clip(a.unit, 16).trim();
    if (Array.isArray(a.days)) { const d = [...new Set(a.days.filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort(); if (d.length) r.days = d; }
    if (typeof a.price === 'number' && a.price >= 1) r.price = Math.min(Math.round(a.price), 9999);
    if (a.emoji) r.emoji = clip(a.emoji, 4);
    if (typeof a.notify === 'boolean') r.notify = a.notify;
    if (SCREENS.includes(a.screen)) r.screen = a.screen;
    if (a.mode === 'solid' || a.mode === 'gradient') r.mode = a.mode;
    for (const k of ['hue', 'hue2']) if (typeof a[k] === 'number' && isFinite(a[k])) r[k] = ((Math.round(a[k]) % 360) + 360) % 360;
    for (const k of ['sat', 'sat2']) if (typeof a[k] === 'number' && isFinite(a[k])) r[k] = Math.min(100, Math.max(0, Math.round(a[k])));
    if (LANG_OPS[a.lang]) r.lang = a.lang;
    if (['coach', 'nadia', 'guru', 'genie'].includes(a.persona)) r.persona = a.persona;
    if (['soft', 'normal', 'strict'].includes(a.style)) r.style = a.style;
    if ([0, 1, 3].includes(a.freq)) r.freq = a.freq;
    if (typeof a.morning === 'boolean') r.morning = a.morning;
    if (typeof a.on === 'boolean') r.on = a.on;
    if (a.reset === true) r.reset = true;
    if (Number.isInteger(a.count) && a.count >= 1 && a.count <= 5) r.count = a.count;
    out.push(r);
  }
  return out;
}

/* приводим ответ модели к безопасному виду: только известные поля и разумные значения */
function clean(out, cv) {
  const s = out.set && typeof out.set === 'object' ? out.set : {};
  const set = {};
  if (s.title) set.title = clip(s.title, 80).trim();
  if (TYPES.includes(s.type)) set.type = s.type;
  if (s.why) set.why = clip(s.why, 200).trim();
  if (typeof s.target === 'number' && isFinite(s.target) && s.target > 0) set.target = s.target;
  if (s.unit) set.unit = clip(s.unit, 16).trim();
  if (Number.isInteger(s.deadlineDays) && s.deadlineDays > 0) set.deadlineDays = Math.min(Math.max(s.deadlineDays, 7), 3650);
  if (Array.isArray(s.days)) {
    const d = [...new Set(s.days.filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
    if (d.length) set.days = d;
  }
  if (s.obst) set.obst = clip(s.obst, 100).trim();
  if (s.tip) set.tip = clip(s.tip, 100).trim();
  if (s.plan) set.plan = clip(s.plan, 120).trim();
  const emo = EMO.includes(out.emo) ? out.emo : 'think';
  const res = {
    reply: clip(out.reply, 500).trim(),
    ask: ASK.includes(out.ask) ? out.ask : 'free',
    emo: cv >= 3 ? emo : cv >= 2 ? (emo === 'shy' ? 'smile' : emo) : EMO_OLD[emo],
    set
  };
  if (cv >= 2) {
    res.gesture = GESTURE.includes(out.gesture) ? out.gesture : 'none';
    const k = +out.intensity;
    res.intensity = isFinite(k) && k > 0 ? Math.round(Math.min(Math.max(k, 0.3), 1) * 10) / 10 : 0.6;
  }
  if (cv >= 3) res.actions = cleanActions(out.actions);
  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cors(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.h });
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'planner-ai', v: 13 }, 200, c.h);
    if (req.method !== 'POST') return json({ error: 'method' }, 405, c.h);
    if (!c.ok) return json({ error: 'origin' }, 403, c.h);

    let b;
    try { b = await req.json(); } catch (e) { return json({ error: 'json' }, 400, c.h); }
    const device = clip(b.device, 40).replace(/[^a-z0-9]/gi, '') || 'anon';

    if (url.pathname === '/report') {
      const rec = {
        at: new Date().toISOString(), device, persona: clip(b.persona, 10), lang: clip(b.lang, 5),
        answer: clip(b.answer, 500), reply: clip(b.reply, 500)
      };
      try { if (env.RL) await env.RL.put('r:' + rec.at + ':' + device, JSON.stringify(rec), { expirationTtl: 7776000 }); }
      catch (e) { console.log('kv', String(e)); }
      console.log('REPORT', JSON.stringify(rec));
      return json({ ok: true }, 200, c.h);
    }

    if (url.pathname !== '/chat') return json({ error: 'path' }, 404, c.h);
    if (!env.AI && !env.GEMINI_KEY && !env.ANTHROPIC_KEY && !env.GROQ_KEY) return json({ error: 'nokey' }, 503, c.h);
    if (await overLimit(env, device)) return json({ error: 'limit' }, 429, c.h);

    const p = {
      persona: PERSONA[b.persona] ? b.persona : 'coach',
      style: STYLE[b.style] ? b.style : 'normal',
      lang: LANG[b.lang] ? b.lang : 'en',
      mode: ['replan', 'assist'].includes(b.mode) ? b.mode : 'new',
      cv: +b.cv || 1
    };
    const hist = (Array.isArray(b.history) ? b.history : []).slice(-24)
      .map(m => (m && m.who === 'me' ? 'USER: ' : 'YOU: ') + clip(m && m.text, 400));
    const sl = b.slots && typeof b.slots === 'object' ? b.slots : {};
    const user = JSON.stringify({
      today: clip(b.today, 10),
      weekday: clip(b.weekday, 12),
      slots: {
        title: clip(sl.title, 80), why: clip(sl.why, 200), target: +sl.target || 0, unit: clip(sl.unit, 16),
        deadlineDays: +sl.deadlineDays || 0, days: Array.isArray(sl.days) ? sl.days.slice(0, 7) : [],
        daysConfirmed: !!sl.daysConfirmed, obst: clip(sl.obst, 100), tip: clip(sl.tip, 100), plan: clip(sl.plan, 120)
      },
      units: Array.isArray(b.units) ? b.units.slice(0, 12).map(u => clip(u, 12)) : [],
      context: clip(b.context, 600),
      data: p.cv >= 3 ? cleanData(b.data) : undefined,
      dialog: hist
    });

    const r = await gemini(env, system(p), user, p.cv);
    if (!r || !r.out || typeof r.out.reply !== 'string' || !r.out.reply.trim()) return json({ error: 'model' }, 502, c.h);
    return json({ ...clean(r.out, +b.cv || 1), model: r.model }, 200, c.h);
  }
};
