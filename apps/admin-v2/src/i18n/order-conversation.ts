import { defineMessages } from "./index";

/** Order card copy stays separate from the lazily loaded conversation workspace. */
export const orderConversationMessages = defineMessages({
  en: {
    threadLoadFailed: "Couldn't load this conversation",
    "card.title": "Messages",
    "card.empty": "No messages yet",
    "card.emptyBody": "Message the customer about this order. They can reply from their order page.",
    "card.openInInbox": "Open in inbox",
  },
  bn: {
    threadLoadFailed: "এই কথোপকথন লোড করা যায়নি",
    "card.title": "মেসেজ",
    "card.empty": "এখনও কোনো মেসেজ নেই",
    "card.emptyBody": "এই অর্ডার নিয়ে কাস্টমারকে মেসেজ দিন। তিনি অর্ডারের পেজ থেকে উত্তর দিতে পারবেন।",
    "card.openInInbox": "ইনবক্সে খুলুন",
  },
});
