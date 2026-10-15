// Ofertazera: cache para abrir rápido/offline e notificações de ofertas (enviadas pelo server.py do PC).
const CACHE = 'ofertazera-v2';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'sync.js',
  'icon.svg', 'icon-192.png', 'badge-96.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ofertazera-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Rede primeiro (pega atualizações), cache como reserva offline. A API do server.py nunca vai para o cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const atualizado = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    atualizado
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match(e.request, { ignoreSearch: true })))
  );
});

function base64url(texto) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(texto))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Push: { title, body, tag, image?, oferta? } — oferta traz o resumo (link, cupom...) para abrir na hora
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const o = d.oferta;
  const actions = o ? [
    ...(o.link ? [{ action: 'loja', title: '🛒 Ir à loja' }] : []),
    { action: 'app', title: o.coupon ? '🏷️ Ver cupom' : '📱 Ver no app' },
  ] : [];
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Ofertazera', {
      body: d.body || 'Oferta nova no Discord.',
      tag: d.tag || 'ofertazera',
      renotify: true,
      requireInteraction: Boolean(o),
      vibrate: [200, 100, 200, 100, 300],
      icon: 'icon-192.png',
      badge: 'badge-96.png',
      image: d.image || undefined,
      actions,
      data: { oferta: o || null },
    });
    // App aberto: atualiza a lista na hora
    const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    abertos.forEach((c) => c.postMessage({ tipo: 'push', oferta: o || null }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const o = e.notification.data?.oferta;
  const escopo = self.registration.scope;
  let destino = escopo;
  if (o) {
    const detalhe = `${escopo}#/oferta/${encodeURIComponent(o.id)}?d=${base64url(JSON.stringify(o))}`;
    if (e.action === 'loja') destino = o.link;
    else if (e.action === 'app') destino = detalhe;
    // Toque na notificação: sem cupom para copiar/resgatar vai direto à loja; com cupom, abre o detalhe
    else destino = (o.coupon || o.coupon_link || !o.link) ? detalhe : o.link;
  }
  e.waitUntil((async () => {
    if (destino.startsWith(escopo)) {
      const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = abertos.find((c) => c.url.startsWith(escopo));
      if (app) {
        app.postMessage({ tipo: 'abrir', url: destino });
        return app.focus();
      }
    }
    return self.clients.openWindow(destino);
  })());
});
