// The digital delivery card's own words: the card shows on every product page, so it
// must not pull the full digital catalogue (digital.ts) into the page's first download.
import { defineMessages } from "./index";

export const digitalCardMessages = defineMessages({
  en: {
    title: "Digital delivery",
    description: "Buyers get these once they pay, on their order page and by message.",
    saveFirst: "Save the product to add files or licence keys.",
    notDigital: "For digital products: files and licence keys buyers get after they pay.",
    notDigitalHelp: "Set Shipping to Digital to add files or licence keys.",
  },
  bn: {
    title: "ডিজিটাল ডেলিভারি",
    description: "পেমেন্ট করার পর ক্রেতা এগুলো অর্ডার পেজে ও মেসেজে পান।",
    saveFirst: "ফাইল বা লাইসেন্স কী যোগ করতে আগে প্রোডাক্টটি সেভ করুন।",
    notDigital: "ডিজিটাল প্রোডাক্টের জন্য: পেমেন্টের পর ক্রেতা যে ফাইল ও লাইসেন্স কী পান।",
    notDigitalHelp: "ফাইল বা লাইসেন্স কী যোগ করতে ডেলিভারিতে ডিজিটাল বাছাই করুন।",
  },
});
