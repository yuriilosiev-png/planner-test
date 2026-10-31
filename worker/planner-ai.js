/* planner-ai — Cloudflare Worker для помощника Planner (1.7.8).
   Не собирается CI: код вставляется в Cloudflare вручную (см. worker/README.md).

   POST /interview — один шаг опроса по цели: персонаж отвечает на ответ
                     пользователя и достаёт из него значение для цели.
   POST /report    — жалоба на ответ AI (требование Google Play для AI-контента).

   Переменные окружения (Settings → Variables):
     GEMINI_KEY   (секрет, обязательно) — ключ из Google AI Studio
     MODEL        модели Gemini через запятую, по очереди при ошибке;
                  по умолчанию gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash
     DEVICE_LIMIT запросов в день на одно устройство, по умолчанию 60
     GLOBAL_LIMIT запросов в день на всех, по умолчанию 1200
     ORIGINS      разрешённые Origin через запятую
   KV (необязательно) — привязка с именем RL: дневные счётчики и жалобы.
   Без KV лимиты не считаются, жалобы пишутся в лог Worker'а. */

const DEF_ORIGINS = 'https://yuriilosiev-png.github.io,null';

const PERSONA = {
  coach: 'Coach Max: a strict sports coach. Short, direct, no excuses, dry humour. Talks to the user informally (in Russian: «ты»).',
  nadia: 'Assistant Nadia: polite, well organised, a little mysterious. Addresses the user formally (in Russian: «вы»).',
  guru:  'Guru: a calm, wise man of about forty. Speaks slowly, sometimes with a short nature metaphor (river, tree, mountain). Informal «ты».',
  genie: 'Genie from a magic lamp: cheerful, jokes a lot, talks about wishes, magic, the lamp and the scroll. At most one emoji. Informal «ты».'
};
const STYLE = {
  soft: 'Be gentle and supportive.',
  normal: 'Be friendly but keep the user on track.',
  strict: 'Be demanding, but never rude or insulting.'
};
const LANG = { ru: 'Russian', en: 'English', es: 'Spanish (Latin America)', pt: 'Portuguese (Brazil)', de: 'German', fr: 'French' };

const STEP = {
  goal: 'The user names ONE goal. value = the goal as a short title in the user\'s language (max 60 chars, capital first letter, no quotes). type = physical (sport, health, body), material (money, savings, buying), learning (study, reading, languages, skills, work) or travel (trips, rest). ok=false if it is not a goal: a question to you, a greeting, nonsense, or something harmful or illegal.',
  why:  'The user says why the goal matters / what will change when it comes true. value = that reason, cleaned up, max 120 chars. ok=false only for questions to you or text unrelated to the goal.',
  num:  'The user gives the measurable target of the goal (a number and a unit). num = the number (expand words like «тысяч», «thousand», «k», «млн»). unit = a short unit: pick from units if one fits, otherwise a short word in the user\'s language. ok=false if there is no number; then in reply suggest a sensible measure for THIS goal.',
  obst: 'The user names what may get in the way. value = the obstacle, max 80 chars. tip = one short if-then rule that beats this obstacle, in the user\'s language, lowercase, max 80 chars, e.g. «если устал — делаю минимум: 10 минут».',
  plan: 'The user gives their own rule for the obstacle (the suggested one is in tip). value = the rule, max 100 chars. If the user agrees with the suggestion or does not know, ok=true and value = tip.'
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    ok:    { type: 'BOOLEAN' },
    reply: { type: 'STRING' },
    value: { type: 'STRING' },
    num:   { type: 'NUMBER' },
    unit:  { type: 'STRING' },
    tip:   { type: 'STRING' },
    type:  { type: 'STRING', enum: ['physical', 'material', 'learning', 'travel'] }
  },
  required: ['ok', 'reply']
};

function system(b) {
  return [
    'You are a character inside "Planner", a mobile app for goals and tasks. You run a short fixed interview (7 questions) that turns the user\'s wish into a goal with a daily norm.',
    'Character: ' + (PERSONA[b.persona] || PERSONA.coach),
    'Tone: ' + (STYLE[b.style] || STYLE.normal),
    'Write "reply" in ' + (LANG[b.lang] || 'English') + ', 1–2 short sentences, plain text, no markdown, stay in character.',
    'Current step: ' + b.step + '. The question you asked: «' + b.question + '».',
    'Step rules: ' + STEP[b.step],
    'If ok=true: reply is a short reaction to the answer. Do NOT ask the next question — the app asks it.',
    'If ok=false: if the user asked you something, answer it in one short phrase if it is harmless (you are an AI helper of the Planner app — say so honestly if asked), then steer back to your question.',
    'Never give medical, legal or financial advice beyond common sense; for health goals suggest checking with a doctor when relevant. If the user hints at self-harm, reply with care, suggest talking to someone close or a professional, ok=false.',
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

/* дневные счётчики в KV: d:<день>:<устройство> и g:<день> (eventual consistency — для лимита достаточно) */
async function overLimit(env, device) {
  if (!env.RL) return false;
  const day = new Date().toISOString().slice(0, 10);
  const kd = 'd:' + day + ':' + device, kg = 'g:' + day;
  const [d, g] = await Promise.all([env.RL.get(kd), env.RL.get(kg)]);
  const nd = +d || 0, ng = +g || 0;
  if (nd >= (+env.DEVICE_LIMIT || 60) || ng >= (+env.GLOBAL_LIMIT || 1200)) return true;
  await Promise.all([
    env.RL.put(kd, String(nd + 1), { expirationTtl: 172800 }),
    env.RL.put(kg, String(ng + 1), { expirationTtl: 172800 })
  ]);
  return false;
}

/* Модели пробуются по очереди: первая не ответила (нет такой модели, кончилась
   бесплатная квота, перегрузка) — берём следующую. Для каждой модели сначала
   просим не «думать» (быстрее и дешевле), а если модель такой параметр не
   принимает — повторяем без него. */
const DEF_MODELS = 'gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash';

async function callModel(env, model, sys, user, thinking) {
  const gc = {
    temperature: 0.8,
    maxOutputTokens: 400,
    responseMimeType: 'application/json',
    responseSchema: SCHEMA
  };
  if (thinking) gc.thinkingConfig = /^gemini-[3-9]/.test(model) ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 };
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 7000);
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
    return { out: txt ? JSON.parse(txt) : null };
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
    if (r.out) return r.out;
  }
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cors(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.h });
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'planner-ai' }, 200, c.h);
    if (req.method !== 'POST') return json({ error: 'method' }, 405, c.h);
    if (!c.ok) return json({ error: 'origin' }, 403, c.h);

    let b;
    try { b = await req.json(); } catch (e) { return json({ error: 'json' }, 400, c.h); }
    const device = clip(b.device, 40).replace(/[^a-z0-9]/gi, '') || 'anon';

    if (url.pathname === '/report') {
      const rec = {
        at: new Date().toISOString(), device, persona: clip(b.persona, 10), lang: clip(b.lang, 5),
        step: clip(b.step, 10), answer: clip(b.answer, 500), reply: clip(b.reply, 500)
      };
      if (env.RL) await env.RL.put('r:' + rec.at + ':' + device, JSON.stringify(rec), { expirationTtl: 7776000 });
      console.log('REPORT', JSON.stringify(rec));
      return json({ ok: true }, 200, c.h);
    }

    if (url.pathname !== '/interview') return json({ error: 'path' }, 404, c.h);
    if (!env.GEMINI_KEY) return json({ error: 'nokey' }, 503, c.h);
    if (!STEP[b.step]) return json({ error: 'step' }, 400, c.h);
    if (await overLimit(env, device)) return json({ error: 'limit' }, 429, c.h);

    const p = {
      persona: PERSONA[b.persona] ? b.persona : 'coach',
      style: STYLE[b.style] ? b.style : 'normal',
      lang: LANG[b.lang] ? b.lang : 'en',
      step: b.step,
      question: clip(b.question, 300)
    };
    const user = JSON.stringify({
      answer: clip(b.answer, 500),
      goal: clip(b.goal && b.goal.title, 100),
      why: clip(b.goal && b.goal.why, 200),
      units: Array.isArray(b.units) ? b.units.slice(0, 12).map(u => clip(u, 12)) : [],
      selectedUnit: clip(b.unit, 12),
      tip: clip(b.tip, 120)
    });

    const out = await gemini(env, system(p), user);
    if (!out || typeof out.reply !== 'string' || !out.reply.trim()) return json({ error: 'model' }, 502, c.h);
    return json({
      ok: !!out.ok,
      reply: clip(out.reply.trim(), 400),
      value: clip(out.value, 140).trim(),
      num: typeof out.num === 'number' && isFinite(out.num) ? out.num : 0,
      unit: clip(out.unit, 16).trim(),
      tip: clip(out.tip, 120).trim(),
      type: ['physical', 'material', 'learning', 'travel'].includes(out.type) ? out.type : ''
    }, 200, c.h);
  }
};
