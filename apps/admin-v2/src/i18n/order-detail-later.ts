import { defineMessages } from "./index";
import { orderDetailMessages } from "./order-detail";

/**
 * The order page's words that only its later parts show: the cancel dialog,
 * order holds, buyer requests and their review. Those parts load when first
 * needed, so their words do too.
 */
const laterCopy = defineMessages({
  en: {
    "cancel.title": "Cancel order {name}?",
    "cancel.body": "This can't be undone.",
    "cancel.confirm": "Cancel order",
    "cancel.keep": "Keep order",
    "holds.title": "On hold for review",
    "holds.badge": "Needs review",
    "holds.help": "It can't be shipped, handed over or moved to another status until the hold is released. You can still cancel it.",
    "holds.placedAt": "Held {when}",
    "holds.release": "Release hold",
    "holds.releaseTitle": "Release {app}'s hold?",
    "holds.releaseBody": "The order can then be shipped and moved on. {app} won't hold this order again.",
    "requests.open": "{count} open",
    "requests.review": "Review",
    "requests.note": "Note for your team",
    "requests.returnHelp": "Accepting a return request opens a return. Refunds are separate.",
    "requests.nothingToReturn": "Nothing left to return. Choose another answer.",
    "requests.resolve.under_review": "Mark under review",
    "requests.resolve.approved": "Accept",
    "requests.resolve.rejected": "Reject",
    "requests.resolve.completed": "Mark done",
    "cancel.restock": "Units going back to stock: {count}.",
    "cancel.notifyChoice": "Send the customer a cancellation message",
    "cancel.reason": "Reason (optional)",
    "cancel.reasonPlaceholder": "Choose a reason",
    "requests.acceptCancel": "Accept and cancel order",
    "requests.cancelHelp": "Accepting cancels the order and tells the customer.",
    "requests.chooseAction": "Choose what to do with this request",
  },
  bn: {
    "cancel.title": "অর্ডার {name} বাতিল করবেন?",
    "cancel.body": "এটি আর ফেরানো যাবে না।",
    "cancel.confirm": "অর্ডার বাতিল করুন",
    "cancel.keep": "অর্ডার রাখুন",
    "holds.title": "রিভিউর জন্য আটকে রাখা হয়েছে",
    "holds.badge": "রিভিউ দরকার",
    "holds.help": "হোল্ড ছেড়ে না দেওয়া পর্যন্ত অর্ডারটি পাঠানো, হস্তান্তর বা অন্য স্ট্যাটাসে নেওয়া যাবে না। চাইলে বাতিল করতে পারবেন।",
    "holds.placedAt": "আটকে রাখা হয়েছে {when}",
    "holds.release": "হোল্ড ছেড়ে দিন",
    "holds.releaseTitle": "{app}-এর হোল্ড ছেড়ে দেবেন?",
    "holds.releaseBody": "এরপর অর্ডারটি পাঠানো ও এগিয়ে নেওয়া যাবে। {app} এই অর্ডার আর আটকাবে না।",
    "requests.open": "{count}টি খোলা",
    "requests.review": "দেখুন",
    "requests.note": "টিমের জন্য নোট",
    "requests.returnHelp": "রিটার্ন অনুরোধ মানলে একটি রিটার্ন খুলবে। রিফান্ড আলাদা।",
    "requests.nothingToReturn": "ফেরত দেওয়ার মতো কিছু বাকি নেই। অন্য উত্তর বাছাই করুন।",
    "requests.resolve.under_review": "যাচাই চলছে",
    "requests.resolve.approved": "মেনে নিন",
    "requests.resolve.rejected": "বাতিল করুন",
    "requests.resolve.completed": "সম্পন্ন",
    "cancel.restock": "স্টকে ফেরত যাবে: {count}টি।",
    "cancel.notifyChoice": "কাস্টমারকে বাতিলের মেসেজ পাঠান",
    "cancel.reason": "কারণ (ঐচ্ছিক)",
    "cancel.reasonPlaceholder": "একটি কারণ বাছাই করুন",
    "requests.acceptCancel": "মেনে নিয়ে অর্ডার বাতিল করুন",
    "requests.cancelHelp": "মেনে নিলে অর্ডার বাতিল হবে এবং কাস্টমারকে জানানো হবে।",
    "requests.chooseAction": "এই অনুরোধে কী করবেন বাছাই করুন",
  },
});

/** The order page's words with the later parts' own. */
export const orderLaterMessages = defineMessages({
  en: { ...orderDetailMessages.en, ...laterCopy.en },
  bn: { ...orderDetailMessages.bn, ...laterCopy.bn },
});
