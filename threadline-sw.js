const APP_URL = "./";
const ICON_URL = "./threadline-icon-192.png";
const CACHE_NAME = "threadline-shell-v2";
const APP_SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./threadline.webmanifest", "./threadline-icon-192.png", "./threadline-icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match(APP_URL))));
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json?.() || {};
  const isCall = Boolean(payload.call_id || payload.call_type);
  const callType = payload.call_type === "video" ? "FaceTime" : "voice call";
  event.waitUntil(self.registration.showNotification(payload.title || (isCall ? `Incoming ${callType}` : "New Threadline message"), {
    body: payload.body || (isCall ? `${payload.caller_handle || "Someone"} is calling you on Threadline.` : "Open Threadline to read your new message."),
    icon: ICON_URL,
    badge: ICON_URL,
    tag: payload.tag || `threadline-call-${payload.call_id || "incoming"}`,
    requireInteraction: true,
    data: { url: payload.url || APP_URL, callId: payload.call_id || "" },
    actions: [{ action: "open", title: isCall ? "Tap to answer" : "Open message" }],
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || APP_URL, self.location.href).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(new URL(APP_URL, self.location.href).href));
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "THREADLINE_CALL_OPENED", callId: event.notification.data?.callId || "" });
      return;
    }
    await clients.openWindow(url);
  })());
});
