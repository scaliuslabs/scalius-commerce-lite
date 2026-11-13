// The words of the buyer's file upload control (an app's `file` line input on
// the product page, or a `file` checkout attribute), in English and Bangla,
// keyed by the page's language like cart-line-copy.ts. Sizes and counts arrive
// already in the page's digits (lib/buyer-uploads/model.ts).
import { storefrontLanguage } from "./storefront-language";
import { pageLanguage } from "./store-time-zone";
import { BUYER_REFUSAL_WORDS } from "./buyer-refusal-words";

export interface BuyerUploadCopy {
  chooseFile: string;
  chooseFiles: string;
  /** "JPG, PNG or PDF": the accepted kinds, already listed (`or` joins the last). */
  or: string;
  /** "JPG or PDF, up to 5 MB" (one file) or "…, up to 3 files". */
  hint: (types: string, size: string, count: string | null) => string;
  uploading: (percent: string) => string;
  uploaded: string;
  remove: string;
  removeFor: (name: string) => string;
  removed: (name: string) => string;
  /** A file the line or the answer already holds, named only by its place (its name stays with the order). */
  keptFile: (position: string) => string;
  typeNotAccepted: (types: string) => string;
  tooLarge: (size: string) => string;
  tooMany: (count: string) => string;
  full: (count: string) => string;
  failed: string;
  rateLimited: string;
  /** 409 `uploads_pending` (`buyer-refusal-words.ts`). */
  uploadsPending: string;
  inputUnknown: string;
  required: (field: string) => string;
  wait: string;
}

const EN: BuyerUploadCopy = {
  chooseFile: "Choose file",
  chooseFiles: "Choose files",
  or: "or",
  hint: (types, size, count) => count ? `${types}, up to ${size} each, up to ${count} files` : `${types}, up to ${size}`,
  uploading: (percent) => `Uploading ${percent}`,
  uploaded: "Uploaded",
  remove: "Remove",
  removeFor: (name) => `Remove ${name}`,
  removed: (name) => `${name} removed`,
  keptFile: (position) => `Uploaded file ${position}`,
  typeNotAccepted: (types) => `This kind of file can't be used. Choose a ${types} file.`,
  tooLarge: (size) => `This file is too large. Choose one up to ${size}.`,
  tooMany: (count) => `You can add up to ${count} files. Remove one to add another.`,
  full: (count) => `You've added ${count} of ${count} files.`,
  failed: "This file couldn't be uploaded. Check your connection and try again.",
  rateLimited: "You're uploading too quickly. Wait a moment and try again.",
  uploadsPending: BUYER_REFUSAL_WORDS.en.uploadsPending,
  inputUnknown: "This field doesn't take files right now. Refresh the page and try again.",
  required: (field) => `Upload a file for ${field}.`,
  wait: "Wait for your file to finish uploading.",
};

const BN: BuyerUploadCopy = {
  chooseFile: "ফাইল বেছে নিন",
  chooseFiles: "ফাইলগুলো বেছে নিন",
  or: "বা",
  hint: (types, size, count) => count ? `${types}, প্রতিটি সর্বোচ্চ ${size}, সর্বোচ্চ ${count}টি ফাইল` : `${types}, সর্বোচ্চ ${size}`,
  uploading: (percent) => `আপলোড হচ্ছে ${percent}`,
  uploaded: "আপলোড হয়েছে",
  remove: "সরান",
  removeFor: (name) => `${name} সরান`,
  removed: (name) => `${name} সরানো হয়েছে`,
  keptFile: (position) => `আপলোড করা ফাইল ${position}`,
  typeNotAccepted: (types) => `এই ধরনের ফাইল নেওয়া যায় না। একটি ${types} ফাইল বেছে নিন।`,
  tooLarge: (size) => `ফাইলটি অনেক বড়। সর্বোচ্চ ${size}-এর একটি ফাইল বেছে নিন।`,
  tooMany: (count) => `সর্বোচ্চ ${count}টি ফাইল যোগ করা যায়। আরেকটি যোগ করতে একটি সরান।`,
  full: (count) => `${count}টির মধ্যে ${count}টি ফাইল যোগ করা হয়েছে।`,
  failed: "ফাইলটি আপলোড করা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
  rateLimited: "খুব দ্রুত আপলোড হচ্ছে। একটু অপেক্ষা করে আবার চেষ্টা করুন।",
  uploadsPending: BUYER_REFUSAL_WORDS.bn.uploadsPending,
  inputUnknown: "এই ঘরে এখন ফাইল নেওয়া যাচ্ছে না। পেজটি রিফ্রেশ করে আবার চেষ্টা করুন।",
  required: (field) => `${field}-এর জন্য একটি ফাইল আপলোড করুন।`,
  wait: "ফাইল আপলোড শেষ হওয়া পর্যন্ত অপেক্ষা করুন।",
};

const COPY = { en: EN, bn: BN } as const;

/** The upload control's words in the page's language (Bangla on a Bangla page). */
export function buyerUploadCopy(language: string = pageLanguage()): BuyerUploadCopy {
  return COPY[storefrontLanguage(language)];
}
