const CACHE_NAME = "coach-stats-v14";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css?v=14",
  "./app.js?v=14",
  "./manifest.json",
  "./js/xlsx.full.min.js?v=14",
  "./js/cloudbase.bundle.js?v=14",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 只处理本站（同源）的 GET 请求，走"缓存优先，联网更新"策略。
// 云端数据库/登录这些跨域接口调用完全不拦截，交给浏览器原生处理——
// 之前把所有请求都塞进这个 respondWith() 里，会在云端接口请求失败时
// 触发 "Returned response is null" 的错误，把真正的网络错误信息盖住。
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached || new Response("离线且无缓存", { status: 503, statusText: "Offline" }));
    })
  );
});
