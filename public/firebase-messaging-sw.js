// Firebase Cloud Messaging Service Worker
// This file must be served from the root of your domain (e.g., https://example.com/firebase-messaging-sw.js)
// and cannot be placed in a subdirectory.

// Import the Firebase scripts needed for messaging
importScripts("https://www.gstatic.com/firebasejs/9.15.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.15.0/firebase-messaging-compat.js");

// Initialize the Firebase app in the service worker
// Note: You'll need to replace these with your actual Firebase config values
const firebaseConfig = {
  apiKey: "AIzaSyDidXcG_vIEZeMIARmUCmpSA_cEsR-kwbw",
  authDomain: "client-id-2501.firebaseapp.com",
  projectId: "client-id-2501",
  storageBucket: "client-id-2501.firebasestorage.app",
  messagingSenderId: "941645278409",
  appId: "1:941645278409:web:74e42729d5f47c6242b118",
  measurementId: "G-B9DR3RGMQ0"
};

firebase.initializeApp(firebaseConfig);

// Retrieve an instance of Firebase Messaging so that it can handle background messages
const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Received background message", payload);
  
  // Customize notification here
  const notificationTitle = payload.data?.customerName 
    ? `${payload.data.customerName} placed a new order`
    : payload.notification?.title || "New Order Received";
    
  const notificationOptions = {
    body: payload.data?.orderId 
      ? `Order ID: ${payload.data.orderId}. Click to view.`
      : payload.notification?.body || "A new order has been placed on your store.",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: "order-notification",
    requireInteraction: true,
    data: {
      url: payload.data?.link || "/admin/orders"
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('[firebase-messaging-sw.js] Notification click received.');

  event.notification.close();

  // This looks to see if the current window is already open and focuses if it is
  const urlToOpen = event.notification.data?.url || '/admin/orders';
  
  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then((clientList) => {
      // Check if there's already a window/tab open with the target URL
      for (const client of clientList) {
        if (client.url.includes('/admin') && 'focus' in client) {
          return client.focus();
        }
      }
      
      // If no window/tab is already open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});