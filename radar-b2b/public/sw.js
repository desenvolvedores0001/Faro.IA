// Service worker do Faro: só acelera reaberturas da própria página (ícones, fontes, o HTML).
// Nunca intercepta /api/*, pra nunca servir dado de empresa antigo do cache.
// Estratégia "rede primeiro": tenta a rede, guarda a resposta no cache, e só usa o cache
// se a rede falhar (offline ou servidor fora do ar). Assim uma nova versão do site é sempre
// a primeira opção; o cache é rede de segurança, não um "congelamento" da página.
const CACHE = "faro-v1";

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return; // nunca cacheia dados de busca/enriquecimento

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Promise.reject("offline e sem cache")))
  );
});
