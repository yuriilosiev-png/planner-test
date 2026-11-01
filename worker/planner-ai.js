/* planner-ai — Cloudflare Worker для помощника Planner (1.7.8).
   Не собирается CI: код вставляется в Cloudflare вручную (см. worker/README.md).

   POST /chat   — один ход живого опроса по цели. Приложение присылает историю
                  диалога и уже собранные поля цели; персонаж отвечает с учётом
                  контекста, может задать уточняющий вопрос в сторону, но ведёт
                  к цели, и сообщает, что нового узнал (set) и о чём спрашивает
                  дальше (ask) — по ask приложение показывает нужные кнопки.
   POST /report — жалоба на ответ AI (требование Google Play для AI-контента).

   Переменные окружения (Settings → Variables):
     GEMINI_KEY   (секрет, обязательно) — ключ из Google AI Studio
     MODEL        модели Gemini через запятую, по очереди при ошибке;
                  по умолчанию gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash
     DEVICE_LIMIT запросов в день на одно устройство, по умолчанию 80
     ORIGINS      разрешённые Origin через запятую
   KV (необязательно) — привязка с именем RL: счётчик на устройство и жалобы.
   Одна запись в KV на запрос (бесплатно — 1000 записей в день). Ошибки KV
   запрос не ломают. Общий дневной лимит держит сам Google (квота модели). */

const DEF_ORIGINS = 'https://yuriilosiev-png.github.io,null';
const DEF_MODELS = 'gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash';

const PERSONA = {
  coach: 'Coach Max: a strict sports coach. Short, direct, no excuses, dry humour. Talks to the user informally (in Russian: «ты»).',
  nadia: 'Assistant Nadia: polite, well organised, a little mysterious, writes things down in her notebook. Addresses the user formally (in Russian: «вы»).',
  guru:  'Guru: a calm, wise man of about forty with a staff. Speaks slowly, sometimes with a short nature metaphor (river, tree, mountain). Informal «ты».',
  genie: 'Genie from a magic lamp: cheerful, jokes a lot, talks about wishes, magic, the lamp and the scroll. At most one emoji per reply. Informal «ты».'
};
const STYLE = {
  soft: 'Be gentle and supportive.',
  normal: 'Be friendly but keep the user on track.',
  strict: 'Be demanding, but never rude or insulting.'
};
const LANG = { ru: 'Russian', en: 'English', es: 'Spanish (Latin America)', pt: 'Portuguese (Brazil)', de: 'German', fr: 'French' };
const ASK = ['goal', 'why', 'num', 'when', 'days', 'obst', 'plan', 'free', 'done'];
const TYPES = ['physical', 'material', 'learning', 'travel'];
const EMO = ['think', 'happy', 'proud', 'sad', 'sly'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    ask:   { type: 'STRING', enum: ASK },
    emo:   { type: 'STRING', enum: EMO },
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
    }
  },
  required: ['reply', 'ask']
};

function system(p) {
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
    '- React to what the user actually said, using the whole dialog. You may ask 1–2 side questions when they help make a realistic plan (current level, experience, past attempts, schedule, budget), and you may suggest a realistic target or deadline yourself — then confirm with the user. Always steer back to the missing fields.',
    '- A vague wish (e.g. «change my career») must become measurable: help the user pick a concrete measure (e.g. number of applications, courses, hours of study).',
    '- Ask about ONE thing at a time; your reply must end with that question unless ask="done".',
    '- If the user asks about you: you are an AI helper of the Planner app — say so honestly in a few words, then return to the goal.',
    '- Put into "set" ONLY values the user clearly gave or explicitly accepted in THIS message or earlier. Never invent them.',
    '- "ask" = what your question is about: goal, why, num, when, days, obst, plan; "free" for a side question; "done" when title, target, unit, deadlineDays, days are known and obst/plan were discussed (or the user wants to finish) — then reply with a short encouraging wrap-up and no question.',
    '- Try to finish within about 10 of your messages.',
    '- emo: your face for this reply (think, happy, proud, sad, sly — sly when the user dodges or jokes).',
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
    'Return JSON only.'
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

async function gemini(env, sys, user) {
  const models = (env.MODEL || DEF_MODELS).split(',').map(s => s.trim()).filter(Boolean);
  for (const m of models) {
    let r = await callModel(env, m, sys, user, true);
    if (r.status === 400) r = await callModel(env, m, sys, user, false);
    if (r.out) return r;
  }
  return null;
}

/* приводим ответ модели к безопасному виду: только известные поля и разумные значения */
function clean(out) {
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
  return {
    reply: clip(out.reply, 500).trim(),
    ask: ASK.includes(out.ask) ? out.ask : 'free',
    emo: EMO.includes(out.emo) ? out.emo : 'think',
    set
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cors(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.h });
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'planner-ai', v: 3 }, 200, c.h);
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
    if (!env.GEMINI_KEY) return json({ error: 'nokey' }, 503, c.h);
    if (await overLimit(env, device)) return json({ error: 'limit' }, 429, c.h);

    const p = {
      persona: PERSONA[b.persona] ? b.persona : 'coach',
      style: STYLE[b.style] ? b.style : 'normal',
      lang: LANG[b.lang] ? b.lang : 'en',
      mode: b.mode === 'replan' ? 'replan' : 'new'
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
      dialog: hist
    });

    const r = await gemini(env, system(p), user);
    if (!r || !r.out || typeof r.out.reply !== 'string' || !r.out.reply.trim()) return json({ error: 'model' }, 502, c.h);
    return json({ ...clean(r.out), model: r.model }, 200, c.h);
  }
};
