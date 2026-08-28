// sw.js — 밀담 서비스 워커. 캐시 로직은 PLAN.md §10.2, 푸시 로직은 §10.2/M6.

const CACHE_NAME = "mildam-v3";

const PRECACHE = [
  "./",
  "index.html",
  "css/style.css",
  "js/main.js",
  "js/util.js",
  "js/pfs.js",
  "js/crypto.js",
  "js/store.js",
  "js/net.js",
  "js/config.js",
  "vendor/nostr-tools.js",
  "icons/icon.svg",
  "manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});

// PLAN.md §10.2: 페이로드는 파싱하지 않는다 — 도우미가 애초에 암호문 외에는
// 아무것도 보내지 않으므로(내용 없는 빈 알림), 여기서 읽을 것이 없다.
self.addEventListener("push", (event) => {
  event.waitUntil(
    // v4 §S9: tag를 고정하고 renotify를 끄면, 탈취된 맥이 푸시를 남발해도
    // 알림 1건으로 병합된다.
    self.registration.showNotification("밀담", {
      body: "새 메시지가 도착했습니다",
      icon: "icons/icon.svg",
      tag: "mildam-new",
      renotify: false,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(".");
    })()
  );
});
