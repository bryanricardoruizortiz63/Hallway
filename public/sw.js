// Hallway service worker: offline app shell + push notifications.
// Paths are relative to this file so the app works under a sub-path (e.g. GitHub Pages).
// VERSION is a fingerprint of every file in SHELL, written by `npm run sw-version` (CI checks it is up to date): any
// change to the app changes this file, so phones download the new version.
const VERSION = 'lah-50e3464bae3b';
const SHELL = [
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'vendor/supabase.js',
  'vendor/qrcode.js',
  'js/boot.js',
  'js/app.js',
  'js/backend.js',
  'js/config.js',
  'js/lib.js',
  'js/icons.js',
  'js/pwa.js',
  'js/store.js',
  'js/branding.js',
  'js/xlsx.js',
  'js/zip.js',
  'js/views/common.js',
  'js/views/roles.js',
  'js/views/auth.js',
  'js/views/absences.js',
  'js/views/staff.js',
  'js/views/admin.js',
  'js/views/account.js',
  'js/views/platform.js',
  'js/views/icon-tool.js',
  'js/views/archive.js',
  'js/views/messages.js',
  'js/views/calendar.js',
  'js/views/alerts.js',
  'js/views/students.js',
  'js/views/turns.js',
  'js/views/visits.js',
  'js/views/maintenance.js',
  'js/views/rooms.js',
  'js/views/panels.js',
  'js/views/guide.js',
  'js/views/summary.js',
  'js/views/access.js',
  'js/nav.js',
  'js/alarm.js',
  'icons/icon-192.png',
  'icons/badge-72.png',
];
const scoped = (path) => new URL(path, self.registration.scope).href;

// The page keeps no file on its own (GitHub Pages lets it keep each one 10 minutes): it always asks this service
// worker, so after an update it never mixes files of two versions.
function noCopy(response, body) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// Same fingerprint as scripts/sw-version.mjs: SHA-256 of each file's path and content, in path order.
async function fingerprint(files) {
  const parts = files
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .flatMap(({ path, body }) => [new TextEncoder().encode(`${path}\0`), body]);
  const digest = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
  return `lah-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)}`;
}

// The whole app at once, straight from the server (the copies the browser keeps may be of the previous version). It
// installs only if every file is exactly the one of this version: right after publishing, the server may still hand
// out an old file for a moment. Until then the version already on the phone keeps working (it retries on the next
// opening).
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const files = await Promise.all(
        SHELL.map(async (path) => {
          const response = await fetch(scoped(path), { cache: 'reload' });
          if (!response.ok) throw new Error(`${path}: ${response.status}`);
          return { path, response, body: await response.arrayBuffer() };
        }),
      );
      if ((await fingerprint(files)) !== VERSION) throw new Error('Archivos de otra versión: se intentará más tarde');
      const cache = await caches.open(VERSION);
      await Promise.all(files.map(({ path, response, body }) => cache.put(scoped(path), noCopy(response, body))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app opens from the copy installed on the phone, without waiting for the network: on an iPhone the first
// connection after opening the app can take many seconds. Each time the app opens the browser compares sw.js with
// the server; when the app changed, the new version downloads in the background and is used from then on (pwa.js).
// Other files of the site: network first, the saved copy when offline. Supabase requests always go to the network.
function shellKey(request) {
  const url = new URL(request.url);
  url.hash = '';
  // The app's page, whatever its ?query (e.g. ?source=pwa from the home screen icon).
  if (request.mode === 'navigate') {
    url.search = '';
    return url.href === self.registration.scope || url.href === scoped('index.html') ? scoped('index.html') : null;
  }
  return SHELL.some((path) => scoped(path) === url.href) ? url.href : null;
}

// Always asked to the server ("no-cache": a quick "not modified" when nothing changed).
const fresh = (request) =>
  request.mode === 'navigate'
    ? fetch(request.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' })
    : fetch(request, { cache: request.cache === 'reload' ? 'reload' : 'no-cache' });

// A file of the app that wasn't on the phone (e.g. after «Actualizar» in boot.js) is saved for the next time.
async function fromNetwork(request, key) {
  try {
    const response = await fresh(request);
    if (!response.ok || response.type !== 'basic') return response;
    const copy = noCopy(response, await response.blob());
    const saved = copy.clone();
    caches.open(VERSION).then((cache) => cache.put(key || request, saved));
    return copy;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    return (request.mode === 'navigate' && (await caches.match(scoped('index.html')))) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  const key = shellKey(request);
  // «Actualizar» (boot.js) asks for every file again with cache: 'reload'.
  const installed =
    key && request.cache !== 'reload' ? caches.open(VERSION).then((cache) => cache.match(key)) : Promise.resolve(null);
  event.respondWith(installed.then((response) => response || fromNetwork(request, key)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  const url = scoped(data.url || '');
  const urgent = !!data.urgent;
  // Notices about the same thing (an alert and its "Apareció") replace each other.
  const tag = data.tag || data.url || undefined;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Hallway', {
        body: data.body || '',
        // The school's own icon (sent by the server) or the app's.
        icon: typeof data.icon === 'string' && data.icon.startsWith('https://') ? data.icon : scoped('icons/icon-192.png'),
        badge: scoped('icons/badge-72.png'),
        data: { url },
        tag,
        renotify: !!tag,
        // Urgent: stays on screen until touched and vibrates long (Android).
        requireInteraction: urgent,
        vibrate: urgent ? [500, 200, 500, 200, 900, 200, 900] : [200],
      }),
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) =>
          clients.forEach((c) =>
            c.postMessage({ type: 'push', urgent, title: data.title || '', body: data.body || '', link: data.url || '' }),
          ),
        ),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => c.url.startsWith(self.registration.scope));
      if (client) {
        client.postMessage({ type: 'navigate', url });
        return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
