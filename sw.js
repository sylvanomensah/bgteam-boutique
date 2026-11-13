// Service worker BGTeam Boutique.
// - Fichiers de l'application : réseau d'abord (mises à jour immédiates), cache si hors ligne.
// - Bibliothèque Supabase (version figée sur le CDN) : cache d'abord.
// - Appels à la base Supabase : jamais mis en cache (données toujours à jour).
const CACHE = "bgteam-v1";
const SHELL = ["./", "index.html", "css/style.css", "js/config.js", "js/app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.concat(CDN))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.url === CDN) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then((res) => {
      // la vérification de mise à jour (?maj=…) n'est jamais mise en cache (sinon une copie par vérification)
      if (res.ok && !url.searchParams.has("maj")) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined)))
  );
});
