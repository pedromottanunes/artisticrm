/* Only public offline assets are cached. CRM responses and authenticated HTML
   are always fetched from the server and never stored in Cache Storage. */
const CACHE = 'artisti-offline-v1';
const PUBLIC_FILES = [
  '/offline.html',
  '/offline.css',
  '/artisti-logo.webp',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PUBLIC_FILES))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith('artisti-offline-') && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/webhooks/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  } else if (PUBLIC_FILES.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data?.json() || {};
      } catch {
        /* A malformed push still shows a generic notice. */
      }
      const requestedPage = data.page === 'distribution' ? 'central' : data.page;
      const page = ['mine', 'pool', 'comments', 'central', 'settings', 'inbox'].includes(requestedPage)
        ? requestedPage
        : 'mine';
      await self.registration.showNotification(data.title || 'Artisti CRM', {
        body: data.body || 'Há uma atualização no CRM. Abra para consultar.',
        icon: '/icons/icon-192.png',
        tag: data.tag || 'artisti-update',
        renotify: false,
        silent: false,
        vibrate: [200, 100, 200],
        data: { page, opportunityId: data.opportunityId },
      });
      // Notify exactly one visible window for the custom foreground sound.
      // Always show the system notification too, as required for Web Push on iOS.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === 'visible');
      const client = visible.find((item) => item.focused) || visible[0];
      client?.postMessage({ type: 'artisti-push', userId: data.userId, tag: data.tag });
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const requestedPage =
        event.notification.data?.page === 'distribution'
          ? 'central'
          : event.notification.data?.page;
      const page = ['mine', 'pool', 'comments', 'central', 'settings', 'inbox'].includes(requestedPage)
        ? requestedPage
        : 'mine';
      const lead = event.notification.data?.opportunityId;
      const query =
        page === 'inbox' &&
        typeof lead === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lead)
          ? `?lead=${encodeURIComponent(lead)}`
          : '';
      const url = `${self.location.origin}/#${page}${query}`;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.navigate(url);
        await existing.focus();
      } else await self.clients.openWindow(url);
    })(),
  );
});
