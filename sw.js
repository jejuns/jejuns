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

// v4 §S10: 설치 시점에 integrity.json과 대조해 배포본이 조용히 바뀌지 않았는지
// 확인한다. 하나라도 어긋나면 throw해서 설치를 중단시킨다 — 그러면 기존 서비스
// 워커가 계속 서빙하므로, 변조된 코드가 활성화되지 않는다.
//
// 한계(불변식 #5): 코드를 서빙하는 서버 자체를 장악한 공격자는 integrity.json도
// 함께 고칠 수 있으므로 이건 완전한 방어가 아니다. 표적이 아닌 변조를 탐지하는
// 용도다.
async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyIntegrity() {
  const res = await fetch("integrity.json", { cache: "no-store" });
  if (!res.ok) throw new Error("mildam sw: integrity.json 을 가져올 수 없습니다");
  const manifest = await res.json();
  for (const [path, expected] of Object.entries(manifest.files)) {
    const fileRes = await fetch(path, { cache: "no-store" });
    if (!fileRes.ok) throw new Error(`mildam sw: ${path} 을 가져올 수 없습니다`);
    const actual = await sha256Hex(await fileRes.arrayBuffer());
    if (actual !== expected) {
      throw new Error(`mildam sw: 무결성 불일치 — ${path}`);
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await verifyIntegrity();
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE);
    })()
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
