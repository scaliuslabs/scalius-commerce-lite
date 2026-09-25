import { defineMessages } from "./index";

/**
 * Gift cards on the order page: the refund dialog's "Refund to" choice, the
 * gift-card tenders in the payment summary, and the cards an order issued.
 * Cards are only ever shown by their last 4 characters.
 */
export const giftCardOrderMessages = defineMessages({
  en: {
    // Refund dialog
    "refundTo.label": "Refund to",
    "refundTo.original": "Original payment",
    "refundTo.storeCredit": "Store credit (gift card)",
    "refundTo.storeCreditHelp": "A new gift card for this amount is sent to {contact}. No cash changes hands.",
    "refundTo.issueAmount": "Issue {amount} store credit",
    "refundTo.issue": "Issue store credit",
    "refundTo.description": "The customer gets a gift card for this amount. Items aren't restocked.",

    // Payment summary
    "tender.label": "Gift card •••• {last4}",
    "tender.released": "{amount} · Released",
    "tender.refunded": "{amount} · Refunded",
    "tender.partlyRefunded": "{amount} · {refunded} refunded",
    "storeCredit.label": "Store credit •••• {last4}",

    // Issued cards
    "lines.title": "Gift cards",
    "lines.card": "•••• {last4}",
    "lines.sentTo": "Sent to {contact}",
    "lines.sentToBuyer": "Sent to the customer",
    "lines.resend": "Resend",
    "lines.resendLabel": "Resend gift card •••• {last4}",
    "lines.resent": "Gift card resent",
    "lines.resendFailed": "Couldn't resend the gift card. Try again.",
  },
  bn: {
    "refundTo.label": "রিফান্ড যাবে",
    "refundTo.original": "আগের পেমেন্ট মাধ্যমে",
    "refundTo.storeCredit": "স্টোর ক্রেডিট (গিফট কার্ড)",
    "refundTo.storeCreditHelp": "এই টাকার একটি নতুন গিফট কার্ড {contact}-এ পাঠানো হবে। কোনো ক্যাশ লেনদেন হবে না।",
    "refundTo.issueAmount": "{amount} স্টোর ক্রেডিট দিন",
    "refundTo.issue": "স্টোর ক্রেডিট দিন",
    "refundTo.description": "কাস্টমার এই টাকার একটি গিফট কার্ড পাবেন। স্টক ফেরত যাবে না।",

    "tender.label": "গিফট কার্ড •••• {last4}",
    "tender.released": "{amount} · ফেরত গেছে",
    "tender.refunded": "{amount} · রিফান্ড হয়েছে",
    "tender.partlyRefunded": "{amount} · {refunded} রিফান্ড হয়েছে",
    "storeCredit.label": "স্টোর ক্রেডিট •••• {last4}",

    "lines.title": "গিফট কার্ড",
    "lines.card": "•••• {last4}",
    "lines.sentTo": "{contact}-এ পাঠানো হয়েছে",
    "lines.sentToBuyer": "কাস্টমারকে পাঠানো হয়েছে",
    "lines.resend": "আবার পাঠান",
    "lines.resendLabel": "গিফট কার্ড •••• {last4} আবার পাঠান",
    "lines.resent": "গিফট কার্ড আবার পাঠানো হয়েছে",
    "lines.resendFailed": "গিফট কার্ড আবার পাঠানো যায়নি। আবার চেষ্টা করুন।",
  },
});
