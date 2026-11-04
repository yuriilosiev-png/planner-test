/* planner-ai v6 — Cloudflare Worker для помощника Planner (1.7.8+).
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
const DEF_MODELS = 'cf:@cf/qwen/qwen3.8-27b,cf:@cf/zai-org/glm-4.7-flash,cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// модели Workers AI, которые умеют строгий JSON по схеме (у остальных — разбор ответа)
const CF_JSON = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];

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
// v6: единая библиотека для всех четырёх персонажей (мастер-план, Character Controller)
const EMO = ['neutral', 'smile', 'happy', 'excited', 'proud', 'think', 'doubt', 'surprised', 'sad', 'worried', 'sly', 'strict'];
const GESTURE = ['none', 'wave', 'nod', 'shake_head', 'point_up', 'thumbs_up', 'show_check', 'shrug', 'hand_on_chin', 'celebrate', 'signature'];
// для приложений до cv=2 (прод 1.7.8): они понимают только эти пять лиц
const EMO_OLD = { neutral: 'think', smile: 'happy', happy: 'happy', excited: 'happy', proud: 'proud', think: 'think',
  doubt: 'think', surprised: 'think', sad: 'sad', worried: 'sad', sly: 'sly', strict: 'think' };

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
    '- Be warm and human, never robotic. Use the user\'s own words. Never repeat a phrase you already used in this dialog.',
    '- If the user asks about you, what you can do, or complains about your answers — answer that properly first (2–3 sentences, in character), then gently return to the goal. You are an AI helper of the Planner app: you help choose a realistic goal, turn it into a daily norm, plan around obstacles, and later the app tracks progress, praises, and helps re-plan. Do not claim abilities beyond that.',
    '- Greetings and small talk: reply briefly and kindly, then ask about the goal.',
    '- Put into "set" ONLY values the user clearly gave or explicitly accepted in THIS message or earlier. Never invent them.',
    '- "ask" = what your question is about: goal, why, num, when, days, obst, plan; "free" for a side question; "done" when title, target, unit, deadlineDays, days are known and obst/plan were discussed (or the user wants to finish) — then reply with a short encouraging wrap-up and no question.',
    '- Try to finish within about 10 of your messages.',
    '- emo: your face for this reply: neutral, smile, happy, excited (big step, the goal is ready), proud (user did well), think, doubt (the number or plan looks unrealistic), surprised, sad, worried (user struggles or misses), sly (user dodges or jokes), strict (user makes excuses; never in a gentle tone).',
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
    for (const k in x) o[k] = k === 'type' ? String(x[k]).toLowerCase() : stdSchema(x[k]);
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
async function gemini(env, sys, user) {
  const models = (env.MODEL || DEF_MODELS).split(',').map(s => s.trim()).filter(Boolean);
  for (const m of models) {
    let r;
    if (m.startsWith('cf:')) r = await callCF(env, m.slice(3), sys, user);
    else {
      if (!env.GEMINI_KEY) continue;
      r = await callModel(env, m, sys, user, true);
      if (r.status === 400) r = await callModel(env, m, sys, user, false);
    }
    if (r.out && typeof r.out.reply === 'string' && r.out.reply.trim()) return r;
  }
  return null;
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
    emo: cv >= 2 ? emo : EMO_OLD[emo],
    set
  };
  if (cv >= 2) {
    res.gesture = GESTURE.includes(out.gesture) ? out.gesture : 'none';
    const k = +out.intensity;
    res.intensity = isFinite(k) && k > 0 ? Math.round(Math.min(Math.max(k, 0.3), 1) * 10) / 10 : 0.6;
  }
  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cors(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.h });
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'planner-ai', v: 6 }, 200, c.h);
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
    if (!env.AI && !env.GEMINI_KEY) return json({ error: 'nokey' }, 503, c.h);
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
    return json({ ...clean(r.out, +b.cv || 1), model: r.model }, 200, c.h);
  }
};
