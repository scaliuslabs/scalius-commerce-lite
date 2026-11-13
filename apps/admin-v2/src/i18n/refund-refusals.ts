import { defineMessages } from "./index";

/**
 * Why a refund was refused, worded from its machine reason: only the refund
 * dialog (loaded when first opened) reads these, so no screen's first render
 * carries them.
 */
export const refundRefusalMessages = defineMessages({
  en: {
    giftCardSpent: "{spent} of the gift cards this order sold was already spent, so up to {max} can be refunded.",
    giftCardUnissued: "{unissued} in gift cards from this order is still to be issued: name those units in the lines below to cancel them. Up to {max} can be refunded now.",
    giftCardLimit: "Up to {max}: part of the gift cards this order sold was already spent.",
    paymentLostToDispute: "The bank took this money back in a dispute: the store no longer holds it, so it cannot be refunded. Up to {max} can be refunded.",
    paymentDisputed: "A dispute is open on this order's payment. Answer the dispute instead of refunding; once the bank decides, refund what the store still holds.",
  },
  bn: {
    giftCardSpent: "এই অর্ডারে বিক্রি হওয়া গিফট কার্ডের {spent} ইতিমধ্যে খরচ হয়ে গেছে, তাই সর্বোচ্চ {max} ফেরত দেওয়া যাবে।",
    giftCardUnissued: "এই অর্ডারের {unissued} মূল্যের গিফট কার্ড এখনো ইস্যু হয়নি: বাতিল করতে নিচের লাইনে সেই ইউনিটগুলো বেছে নিন। এখন সর্বোচ্চ {max} ফেরত দেওয়া যাবে।",
    giftCardLimit: "সর্বোচ্চ {max}: এই অর্ডারে বিক্রি হওয়া গিফট কার্ডের কিছু অংশ ইতিমধ্যে খরচ হয়ে গেছে।",
    paymentLostToDispute: "ব্যাংক এই টাকা বিরোধে ফেরত নিয়ে গেছে: স্টোরের কাছে এটি আর নেই, তাই রিফান্ড করা যাবে না। সর্বোচ্চ {max} রিফান্ড করা যাবে।",
    paymentDisputed: "এই অর্ডারের পেমেন্ট নিয়ে একটি বিরোধ চলছে। রিফান্ড না করে বিরোধের জবাব দিন; ব্যাংক সিদ্ধান্ত নেওয়ার পর স্টোরের কাছে যা আছে তা রিফান্ড করুন।",
  },
});
