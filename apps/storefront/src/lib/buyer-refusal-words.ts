// The words of the API's refusals that say what the buyer must do first,
// one home for each language. The API error catalogue (buyer-api-error-copy.ts,
// keyed by code in buyer-api-errors.ts) and the surfaces that word the same
// refusal in their own catalogue (the upload control, the inbox, the warranty
// claim form) read them here, so a refusal reads the same everywhere and this
// small module is all a surface downloads for it.

export interface BuyerRefusalWords {
  /** 409 `attachments_pending`: images were added to a message and never sent. */
  attachmentsPending: string;
  /** 409 `uploads_pending`: the visitor's staged files are at the store's cap. */
  uploadsPending: string;
  /** 400 `answers_too_many`: a cart's buyer answers passed the API's cap. */
  answersTooMany: string;
  /** 409 `warranty_not_active`: the warranty cannot take a claim now. */
  warrantyNotActive: string;
  /** 409 `warranty_claim_open`: the warranty already has an open claim. */
  warrantyClaimOpen: string;
}

export const BUYER_REFUSAL_WORDS: Readonly<Record<"en" | "bn", BuyerRefusalWords>> = {
  en: {
    attachmentsPending: "Send or remove the images you already added first.",
    uploadsPending: "You have added many files. Place your order or remove some files first.",
    answersTooMany: "Your cart has too many personalized details. Remove some items or details, then try again.",
    warrantyNotActive: "This warranty can't take a claim right now. Contact the store if you need help.",
    warrantyClaimOpen: "This item already has an open warranty claim. Follow it from your warranties.",
  },
  bn: {
    attachmentsPending: "আগে যোগ করা ছবিগুলো পাঠান অথবা সরিয়ে দিন।",
    uploadsPending: "আপনি অনেক ফাইল যোগ করেছেন। আগে অর্ডার করুন অথবা কিছু ফাইল সরিয়ে দিন।",
    answersTooMany: "আপনার কার্টে অনেক বেশি ব্যক্তিগত তথ্য দেওয়া আছে। কিছু পণ্য বা তথ্য সরিয়ে আবার চেষ্টা করুন।",
    warrantyNotActive: "এই ওয়ারেন্টিতে এখন দাবি করা যাচ্ছে না। সাহায্যের জন্য স্টোরের সাথে যোগাযোগ করুন।",
    warrantyClaimOpen: "এই পণ্যের একটি ওয়ারেন্টি দাবি এখনো খোলা আছে। আপনার ওয়ারেন্টি থেকে সেটি দেখুন।",
  },
};
