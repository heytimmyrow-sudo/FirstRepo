const APP_URL = "./";
const ICON_URL = "./threadline-icon-192.png";

self.addEventListener("push", (event) => {
  const payload = event.data?.json?.() || {};
  const callType = payload.call_type === "video" ? "FaceTime" : "voice call";
  event.waitUntil(self.registration.showNotification(payload.title || `Incoming ${callType}`, {
    body: payload.body || `${payload.caller_handle || "Someone"} is calling you on Threadline.`,
    icon: ICON_URL,
    badge: ICON_URL,
    tag: payload.tag || `threadline-call-${payload.call_id || "incoming"}`,
    requireInteraction: true,
    data: { url: payload.url || APP_URL, callId: payload.call_id || "" },
    actions: [{ action: "open", title: "Tap to answer" }],
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
