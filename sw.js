// SPAEI DIGITAL — Service Worker
// Estratégia: network-first (dados via Firebase precisam estar sempre atualizados),
// com fallback em cache para permitir abrir o app-shell offline.
// CACHE_NAME muda a cada deploy (ver rodapé do arquivo — atualizado automaticamente
// pelo script de publicação, não precisa mais editar manualmente).
const CACHE_NAME = 'spaei-digital-shell-v6.12';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((e) => console.warn('SW install: falha ao pré-cachear', e.message))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
      // Assim que este SW novo assume o controle (troca de versão), avisa todas
      // as abas abertas para recarregarem sozinhas — sem isso, uma aba já aberta
      // continuava rodando o JS antigo em memória mesmo com o cache já limpo.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clientsList) => clientsList.forEach((c) => c.postMessage({ type: 'SW_UPDATED' })))
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navegação de página (não asset): sempre tenta a rede primeiro com um
  // timeout curto — numa conexão lenta ou instável, não faz sentido esperar
  // indefinidamente antes de cair no cache; melhor mostrar algo rápido.
  event.respondWith(
    Promise.race([
      fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
    ]).catch(() =>
      caches.match(req).then((cached) => cached || caches.match('./index.html'))
    )
  );
});
