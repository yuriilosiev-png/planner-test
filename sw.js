/* Planner service worker — network-first for HTML, cache-first for static assets.
   App is fully local (localStorage), no backend needed.

   СТРАТЕГИЯ (важно для авто-обновлений):
   - index.html и навигация → NETWORK-FIRST: всегда пробуем свежую версию из сети,
     кэш используем только если сети нет (офлайн). Значит правки index.html
     подтягиваются АВТОМАТИЧЕСКИ при следующем открытии с интернетом — без смены
     версии кэша и без переустановки.
   - иконки/манифест (статика) → CACHE-FIRST: они меняются редко, быстрее из кэша.

   Сайт-визитка (/planner/en/, /ru/, …, /site/img/) лежит в той же области SW, но
   приложением не является: его страницы и картинки идут мимо SW, напрямую в сеть.
   Иначе страница сайта попала бы в кэш под именем index.html и офлайн вместо
   приложения открывался бы сайт.

   Версию CACHE всё равно меняем при релизе, чтобы очистить старый кэш иконок. */

const CACHE = 'planner-v4-27f349f7';
const ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon.png'
];

// Путь области SW, например "/planner/"
const SCOPE_PATH = new URL(self.registration.scope).pathname;
// Имя кэша с привязкой к области. /planner/ и /planner-test/ живут на одном домене
// и видят кэши друг друга; без метки каждый SW при активации удалял бы чужой кэш.
const SCOPE_TAG = '@' + SCOPE_PATH;
const STORE = CACHE + SCOPE_TAG;

// Install: pre-cache только статику (НЕ index.html — он всегда из сети)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STORE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: удалить старые кэши своей области
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      // свои старые кэши + старые кэши без метки (версии до 1.7.8); чужую область не трогаем
      Promise.all(keys.filter((k) => k !== STORE && (k.endsWith(SCOPE_TAG) || k.indexOf('@') < 0)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Страница самого приложения: /planner/ или /planner/index.html (с любыми ?параметрами)
function isAppShell(url) {
  return url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + 'index.html';
}

// Определяем, является ли запрос HTML-документом / навигацией
function isHtmlRequest(req) {
  if (req.mode === 'navigate') return true;
  const url = req.url || '';
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html')
      || url.endsWith('/')
      || url.endsWith('index.html');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isHtmlRequest(req)) {
    // Сайт-визитка и прочие страницы — не трогаем, браузер грузит их сам
    if (url.origin !== self.location.origin || !isAppShell(url)) return;

    // NETWORK-FIRST: сначала сеть (свежий index.html), кэш — только офлайн-фолбэк.
    e.respondWith(
      fetch(req)
        .then((res) => {
          // положить свежую копию в кэш (для будущего офлайна)
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(STORE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() =>
          // сети нет → отдать последний закэшированный index.html
          caches.match('./index.html').then((cached) =>
            cached || caches.match(req)
          )
        )
    );
    return;
  }

  // Картинки сайта-визитки в кэш приложения не складываем
  if (url.origin === self.location.origin && url.pathname.startsWith(SCOPE_PATH + 'site/')) return;

  // СТАТИКА (иконки, манифест): cache-first, сеть как фолбэк.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(STORE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
