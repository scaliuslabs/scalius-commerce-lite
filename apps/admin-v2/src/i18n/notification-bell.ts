import { defineMessages } from "./index";

/** The notification bell: loaded with the bell, after the shell. Its push line reads `webPushMessages`. */
export const notificationBellMessages = defineMessages({
  en: {
    notifications: "Notifications",
    unreadNotifications: "Notifications ({count} unread)",
    markAllRead: "Mark all read",
    clearRead: "Clear read",
    cleared: "Read notifications cleared",
    undo: "Undo",
    unreadAlert: "Unread:",
    noNotifications: "No alerts yet.",
    scope: "Alerts that arrived while the dashboard was open in this browser · last 50",
    pushAlerts: "Browser alerts",
  },
  bn: {
    notifications: "নোটিফিকেশন",
    unreadNotifications: "নোটিফিকেশন ({count}টি পড়া হয়নি)",
    markAllRead: "সব পঠিত করুন",
    clearRead: "পড়া নোটিফিকেশন মুছুন",
    cleared: "পড়া নোটিফিকেশন মুছে ফেলা হয়েছে",
    undo: "ফিরিয়ে আনুন",
    unreadAlert: "পড়া হয়নি:",
    noNotifications: "এখনো কোনো নোটিফিকেশন নেই।",
    scope: "ড্যাশবোর্ড খোলা থাকাকালীন এই ব্রাউজারে আসা নোটিফিকেশন · সর্বশেষ ৫০টি",
    pushAlerts: "ব্রাউজার অ্যালার্ট",
  },
});
