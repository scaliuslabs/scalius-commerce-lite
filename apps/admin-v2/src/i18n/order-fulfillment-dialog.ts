import { defineMessages } from "./index";
import { orderDetailMessages } from "./order-detail";

/**
 * The manual hand-over dialog's own copy (mark as sent, picked up or done): it
 * loads when first opened, so its words do too.
 */
const fulfillmentDialogCopy = defineMessages({
  en: {
    "fulfill.title": "Send with your own courier",
    "fulfill.help": "Choose how many of each item your rider is taking.",
    "fulfill.items": "Items",
    "fulfill.alreadySent": "Sent",
    "fulfill.trackingUrl": "Tracking link",
    "fulfill.amount": "Delivery cost",
    "fulfill.note": "Note",
    "fulfill.selectItem": "Send at least 1 item.",
    "fulfill.amountInvalid": "The delivery cost can't be negative.",
    "fulfill.amountHelp": "What the courier charges you.",
    "fulfill.trackingUrlInvalid": "Enter a full link, starting with https://",
    "fulfill.left": "{count} left to send",
    "fulfill.quantity": "Quantity to send for {name}",
    "fulfill.sending": "{count} of {total}",
    "pickup.title": "Mark as picked up",
    "pickup.help": "Choose how many of each item the customer collected.",
    "pickup.alreadyCollected": "Picked up",
    "pickup.left": "{count} to collect",
    "pickup.quantity": "Quantity picked up for {name}",
    "service.title": "Mark as done",
    "service.help": "Choose how much of each service you performed.",
    "service.alreadyDone": "Done",
    "service.left": "{count} to do",
    "service.quantity": "Quantity done for {name}",
    "handover.cashReceived": "Cash received {amount}",
    "handover.cashHelp": "Records the whole balance as paid.",
    "handover.cashLaterHelp": "Record the cash later in Payment.",
  },
  bn: {
    "fulfill.title": "নিজস্ব কুরিয়ারে পাঠান",
    "fulfill.help": "রাইডার প্রতিটি প্রোডাক্ট কতটি নিচ্ছেন লিখুন।",
    "fulfill.items": "প্রোডাক্ট",
    "fulfill.alreadySent": "পাঠানো হয়েছে",
    "fulfill.trackingUrl": "ট্র্যাকিং লিংক",
    "fulfill.amount": "ডেলিভারি খরচ",
    "fulfill.note": "নোট",
    "fulfill.selectItem": "অন্তত ১টি প্রোডাক্ট পাঠান।",
    "fulfill.amountInvalid": "ডেলিভারি খরচ মাইনাস হতে পারে না।",
    "fulfill.amountHelp": "কুরিয়ার আপনার কাছ থেকে যা নেয়।",
    "fulfill.trackingUrlInvalid": "https:// দিয়ে শুরু পূর্ণ লিংক দিন",
    "fulfill.left": "{count}টি পাঠানো বাকি",
    "fulfill.quantity": "{name} কতটি পাঠাবেন",
    "fulfill.sending": "{total}টির মধ্যে {count}টি",
    "pickup.title": "কাস্টমার নিয়ে গেছেন",
    "pickup.help": "কাস্টমার প্রতিটি প্রোডাক্ট কতটি নিয়েছেন লিখুন।",
    "pickup.alreadyCollected": "নিয়ে গেছেন",
    "pickup.left": "{count}টি নেওয়া বাকি",
    "pickup.quantity": "{name} কতটি নিয়েছেন",
    "service.title": "সম্পন্ন হয়েছে",
    "service.help": "প্রতিটি সার্ভিস কতটি করেছেন লিখুন।",
    "service.alreadyDone": "সম্পন্ন",
    "service.left": "{count}টি বাকি",
    "service.quantity": "{name} কতটি সম্পন্ন",
    "handover.cashReceived": "নগদ পাওয়া গেছে {amount}",
    "handover.cashHelp": "পুরো বাকি টাকা পরিশোধিত হিসেবে রেকর্ড হবে।",
    "handover.cashLaterHelp": "নগদ টাকা পরে পেমেন্টে রেকর্ড করুন।",
  },
});

/** The order page catalog plus the hand-over dialog's own copy, for that dialog. */
export const orderFulfillmentDialogMessages = defineMessages({
  en: { ...orderDetailMessages.en, ...fulfillmentDialogCopy.en },
  bn: { ...orderDetailMessages.bn, ...fulfillmentDialogCopy.bn },
});
