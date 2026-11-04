import { defineMessages } from "./index";
import { giftCardTenderMessages } from "./gift-card-tenders";

/**
 * Gift cards on the order page: the refund dialog's "Refund to" choice, the
 * gift-card tenders in the payment summary, and the cards an order issued.
 * Cards are only ever shown by their last 4 characters.
 */
export const giftCardOrderMessages = defineMessages({
  en: {
    ...giftCardTenderMessages.en,
    // Refund dialog
    "refundTo.label": "Refund to",
    "refundTo.original": "Original payment",
    "refundTo.storeCredit": "Store credit (gift card)",
    "refundTo.storeCreditHelp": "A new gift card for this amount is sent to {contact}. No cash changes hands.",
    "refundTo.issueAmount": "Issue {amount} store credit",
    "refundTo.issue": "Issue store credit",
    "refundTo.description": "The customer gets a gift card for this amount. Items aren't restocked.",
    "refundTo.boughtCards": "This order bought gift cards. A refund takes their unspent value back (a card left empty is disabled), and value already spent can't be refunded.",

    // Payment summary

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
    ...giftCardTenderMessages.bn,
    "refundTo.label": "রিফান্ড যাবে",
    "refundTo.original": "আগের পেমেন্ট মাধ্যমে",
    "refundTo.storeCredit": "স্টোর ক্রেডিট (গিফট কার্ড)",
    "refundTo.storeCreditHelp": "এই টাকার একটি নতুন গিফট কার্ড {contact}-এ পাঠানো হবে। কোনো ক্যাশ লেনদেন হবে না।",
    "refundTo.issueAmount": "{amount} স্টোর ক্রেডিট দিন",
    "refundTo.issue": "স্টোর ক্রেডিট দিন",
    "refundTo.description": "কাস্টমার এই টাকার একটি গিফট কার্ড পাবেন। স্টক ফেরত যাবে না।",
    "refundTo.boughtCards": "এই অর্ডারে গিফট কার্ড কেনা হয়েছে। রিফান্ড করলে কার্ডগুলোর খরচ না হওয়া ব্যালেন্স ফেরত নেওয়া হবে (খালি হয়ে যাওয়া কার্ড বন্ধ হবে), আর যে টাকা খরচ হয়ে গেছে তা রিফান্ড করা যাবে না।",


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
