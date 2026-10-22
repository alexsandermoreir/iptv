// Service worker: guarda só a "casca" do site (HTML, CSS, JS) para abrir mais rápido e funcionar como app instalado.
// Nunca guarda vídeo, listas, imagens do provedor nem respostas do Firebase/Worker (nada de credenciais no cache).
const CACHE = "iptv-shell-v3";
const SHELL = ["./", "index.html", "styles.css", "app.js", "catalog.js", "cloud.js", "google-login.js", "pair-connect.js", "firebase-config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {})); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Rede primeiro (para sempre pegar a versão nova); o cache só entra se estiver sem internet.
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok && SHELL.some((p) => url.pathname.endsWith(p === "./" ? "/" : p))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match("index.html"))));
});