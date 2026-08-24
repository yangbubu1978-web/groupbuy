// Service Worker — PWA 殼層快取
// 策略：HTML 導航 network-first（部署新版後裝置立刻拿到）；靜態資源 stale-while-revalidate；
//       API 一律不快取（價格/庫存必須即時）
const CACHE = 'groupbuy-shell-v2'
const SHELL = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Supabase API / Edge Functions：永不快取（即時性優先）
  if (url.pathname.includes('/functions/v1/') || url.pathname.includes('/rest/v1/') ||
      url.pathname.includes('/realtime/') || url.pathname.includes('/auth/')) {
    return
  }
  if (e.request.method !== 'GET') return

  if (url.origin === self.location.origin) {
    // HTML 導航請求：network-first，離線才退回快取殼層
    if (e.request.mode === 'navigate' ||
        (e.request.headers.get('accept') || '').includes('text/html')) {
      e.respondWith(
        fetch(e.request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(e.request, copy))
            }
            return res
          })
          .catch(() =>
            caches.match(e.request).then((c) => c ?? caches.match('/index.html')),
          ),
      )
      return
    }

    // 其他靜態資源（hash 檔名 assets 等）：stale-while-revalidate
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(e.request)
        const fetchPromise = fetch(e.request)
          .then((res) => {
            if (res.ok) cache.put(e.request, res.clone())
            return res
          })
          .catch(() => cached)
        return cached ?? fetchPromise
      }),
    )
  }
})
