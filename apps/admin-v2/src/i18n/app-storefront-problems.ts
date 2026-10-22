import { defineMessages } from "./index";

/**
 * An app's storefront part the store drew without (a section, a block or a
 * design): shown on the app's page and beside the part in the theme editor.
 * The store never fails a page for it; it shows the theme's own instead.
 */
export const appStorefrontProblemMessages = defineMessages({
  en: {
    title: "Your store couldn't show part of this app",
    titleSkin: "Your store couldn't show this design",
    titleSection: "Your store couldn't show this section",
    titleBlock: "Your store couldn't show this block",
    when: "Last seen {time}.",
    reason_unavailable: "This version of the app can't run on your store right now.",
    reason_late: "The app took too long to answer.",
    reason_error: "The app's code ran into an error.",
    reason_refused: "What the app drew was too large or broke the storefront's rules.",
    reason_missing: "The app answered without it.",
    reason_unknown: "The app didn't answer as expected.",
    insteadSkin: "Shoppers saw your theme's own design instead.",
    insteadPart: "Shoppers saw the page without it.",
    whatToDo: "Check the app's activity for details, or ask its developer. It shows again once the app answers.",
    openApp: "View app activity",
  },
  bn: {
    title: "আপনার স্টোর এই অ্যাপের একটি অংশ দেখাতে পারেনি",
    titleSkin: "আপনার স্টোর এই ডিজাইনটি দেখাতে পারেনি",
    titleSection: "আপনার স্টোর এই সেকশনটি দেখাতে পারেনি",
    titleBlock: "আপনার স্টোর এই ব্লকটি দেখাতে পারেনি",
    when: "শেষবার দেখা গেছে {time}।",
    reason_unavailable: "অ্যাপের এই ভার্সনটি এখন আপনার স্টোরে চলতে পারছে না।",
    reason_late: "অ্যাপটি উত্তর দিতে অনেক সময় নিয়েছে।",
    reason_error: "অ্যাপের কোডে একটি সমস্যা হয়েছে।",
    reason_refused: "অ্যাপ যা দেখাতে চেয়েছে তা খুব বড় ছিল বা স্টোরফ্রন্টের নিয়ম ভেঙেছে।",
    reason_missing: "অ্যাপটি এটি ছাড়াই উত্তর দিয়েছে।",
    reason_unknown: "অ্যাপটি প্রত্যাশিতভাবে উত্তর দেয়নি।",
    insteadSkin: "ক্রেতারা এর বদলে আপনার থিমের নিজস্ব ডিজাইন দেখেছেন।",
    insteadPart: "ক্রেতারা এটি ছাড়াই পেজটি দেখেছেন।",
    whatToDo: "বিস্তারিত জানতে অ্যাপের কার্যকলাপ দেখুন, বা এর ডেভেলপারকে জিজ্ঞেস করুন। অ্যাপটি উত্তর দিলে এটি আবার দেখা যাবে।",
    openApp: "অ্যাপের কার্যকলাপ দেখুন",
  },
});
