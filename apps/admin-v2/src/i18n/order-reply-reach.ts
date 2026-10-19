import { defineMessages } from "./index";

/** Copy for the order card's reply-reach note; it loads with that note, apart from the card's own catalog. */
export const orderReplyReachMessages = defineMessages({
  en: {
    note: "{name} won't be notified of replies. They'll see them on their order page.",
    fallbackName: "The customer",
    linkSms: "Send replies by SMS in Settings → Notifications.",
    linkEmail: "Send replies by email in Settings → Notifications.",
    link: "Reply settings in Settings → Notifications.",
  },
  bn: {
    note: "{name} উত্তরের নোটিফিকেশন পাবেন না। তিনি অর্ডারের পেজে উত্তর দেখতে পাবেন।",
    fallbackName: "কাস্টমার",
    linkSms: "সেটিংস → নোটিফিকেশনে গিয়ে এসএমএসে উত্তর পাঠান।",
    linkEmail: "সেটিংস → নোটিফিকেশনে গিয়ে ইমেইলে উত্তর পাঠান।",
    link: "সেটিংস → নোটিফিকেশনে উত্তরের সেটিং দেখুন।",
  },
});
