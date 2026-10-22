import { defineMessages } from "./index";

/**
 * Why an order's items can't be edited, one sentence per server reason: the
 * edit page and the order page's disabled Edit say these, so they are apart
 * from the order form's own catalog.
 */
export const orderEditLockMessages = defineMessages({
  en: {
    lockShipped: "This order has shipped, so its items can't be changed.",
    lockPartSent: "Part of this order was sent, so its items can't be changed. Send or cancel the rest, or create a new order for more items.",
    lockClosed: "This order is cancelled, returned or refunded, so its items can't be changed.",
    lockPaid: "Items can't be changed after payment. Refund or create a new order instead.",
    lockOnlinePayment: "Items can be changed only on unpaid cash-on-delivery orders. Create a new order instead.",
    lockDiscount: "This order used a discount, so its items can't be changed.",
    lockHistory: "Items can't be changed after a refund, return or invoice. Create a new order instead.",
    lockInventory: "Stock for this order was already taken out, so its items can't be changed.",
    lockArchived: "This order is archived. Unarchive it to change its items.",
    lockBusy: "A courier booking is in progress. Try again in a minute.",
    lockUnavailable: "A product on this order is no longer sold, so its items can't be changed.",
    lockUnknown: "Items on this order can't be changed now.",
  },
  bn: {
    lockShipped: "অর্ডারটি পাঠানো হয়ে গেছে, তাই প্রোডাক্ট বদলানো যাবে না।",
    lockPartSent: "এই অর্ডারের কিছু অংশ পাঠানো হয়েছে, তাই প্রোডাক্ট বদলানো যাবে না। বাকিটা পাঠান বা বাতিল করুন, অথবা আরও প্রোডাক্টের জন্য নতুন অর্ডার তৈরি করুন।",
    lockClosed: "অর্ডারটি বাতিল, ফেরত বা রিফান্ড হয়েছে, তাই প্রোডাক্ট বদলানো যাবে না।",
    lockPaid: "পেমেন্টের পরে প্রোডাক্ট বদলানো যায় না। রিফান্ড করুন বা নতুন অর্ডার তৈরি করুন।",
    lockOnlinePayment: "শুধু পেমেন্ট না হওয়া ক্যাশ অন ডেলিভারি অর্ডারের প্রোডাক্ট বদলানো যায়। নতুন অর্ডার তৈরি করুন।",
    lockDiscount: "এই অর্ডারে ডিসকাউন্ট ব্যবহার হয়েছে, তাই প্রোডাক্ট বদলানো যাবে না।",
    lockHistory: "রিফান্ড, ফেরত বা ইনভয়েসের পরে প্রোডাক্ট বদলানো যায় না। নতুন অর্ডার তৈরি করুন।",
    lockInventory: "এই অর্ডারের স্টক আগেই কেটে নেওয়া হয়েছে, তাই প্রোডাক্ট বদলানো যাবে না।",
    lockArchived: "অর্ডারটি আর্কাইভ করা আছে। প্রোডাক্ট বদলাতে আগে আনআর্কাইভ করুন।",
    lockBusy: "কুরিয়ার বুকিং চলছে। এক মিনিট পরে আবার চেষ্টা করুন।",
    lockUnavailable: "এই অর্ডারের একটি প্রোডাক্ট আর বিক্রি হয় না, তাই প্রোডাক্ট বদলানো যাবে না।",
    lockUnknown: "এই অর্ডারের প্রোডাক্ট এখন বদলানো যাবে না।",
  },
});

export type OrderEditLockMessageKey = keyof typeof orderEditLockMessages.en;

const LOCK_MESSAGE: Record<string, OrderEditLockMessageKey> = {
  shipped: "lockShipped",
  part_sent: "lockPartSent",
  closed: "lockClosed",
  paid: "lockPaid",
  online_payment: "lockOnlinePayment",
  discount: "lockDiscount",
  history: "lockHistory",
  inventory: "lockInventory",
  archived: "lockArchived",
  busy: "lockBusy",
  unavailable: "lockUnavailable",
};

/** The plain sentence for a server edit-lock reason code. */
export function editLockMessageKey(reason: string | null): OrderEditLockMessageKey {
  return (reason && LOCK_MESSAGE[reason]) || "lockUnknown";
}
