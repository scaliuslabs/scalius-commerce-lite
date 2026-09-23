// Firebase Cloud Messaging service worker for dashboard order notifications.
// The page registers it with the store's public Firebase config in the query
// string (src/hooks/use-firebase-init.ts), so this file stays static.

importScripts("https://www.gstatic.com/firebasejs/9.15.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.15.0/firebase-messaging-compat.js");

const firebaseConfig = Object.fromEntries(new URL(self.location.href).searchParams);
// The dashboard root this worker controls, e.g. "/" or "/dashboard/".
const dashboardRoot = self.registration.scope;

if (firebaseConfig.apiKey) {
  firebase.initializeApp(firebaseConfig);
  firebase.messaging().onBackgroundMessage((payload) => {
    const title = payload.data?.customerName
      ? `${payload.data.customerName} placed a new order`
      : payload.notification?.title || "New Order Received";
    self.registration.showNotification(title, {
      body: payload.data?.orderId
        ? `Order ID: ${payload.data.orderId}. Click to view.`
        : payload.notification?.body || "A new order has been placed on your store.",
      icon: new URL("favicon.png", dashboardRoot).href,
      badge: new URL("favicon.png", dashboardRoot).href,
      tag: "order-notification",
      requireInteraction: true,
      data: { url: payload.data?.link || new URL("admin/orders", dashboardRoot).href },
    });
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || new URL("admin/orders", dashboardRoot).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(new URL("admin", dashboardRoot).href) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(urlToOpen) : undefined;
    }),
  );
});
