import { defineMessages } from "./index";

/** Order card copy stays separate from the lazily loaded conversation workspace. */
export const orderConversationMessages = defineMessages({
  en: {
    threadLoadFailed: "Couldn't load this conversation",
    "card.title": "Messages",
    "card.empty": "No messages yet",
    "card.emptyBody": "Message the customer about this order. They can reply from their order page.",
    "card.openInInbox": "Open in inbox",
    "card.noAccess": "The customer's messages about this order are in the inbox, which your role can't open.",
    "card.readOnly": "You can read these messages but not reply.",
    "card.askOwner": "Ask the store owner for access.",
  },
  bn: {
    threadLoadFailed: "এই কথোপকথন লোড করা যায়নি",
    "card.title": "মেসেজ",
    "card.empty": "এখনও কোনো মেসেজ নেই",
    "card.emptyBody": "এই অর্ডার নিয়ে কাস্টমারকে মেসেজ দিন। তিনি অর্ডারের পেজ থেকে উত্তর দিতে পারবেন।",
    "card.openInInbox": "ইনবক্সে খুলুন",
    "card.noAccess": "এই অর্ডার নিয়ে কাস্টমারের মেসেজ ইনবক্সে আছে, যা আপনার রোল খুলতে পারে না।",
    "card.readOnly": "আপনি এই মেসেজগুলো পড়তে পারবেন, উত্তর দিতে পারবেন না।",
    "card.askOwner": "অ্যাক্সেসের জন্য স্টোরের মালিককে বলুন।",
  },
});
