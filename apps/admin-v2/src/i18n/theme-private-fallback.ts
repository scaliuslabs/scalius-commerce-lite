import { defineMessages } from "./index";

/**
 * The live theme's private pages the store's own checks refused after an
 * update: which page shows the store's own design, why, and how to fix it.
 */
export const themePrivateFallbackMessages = defineMessages({
  en: {
    title: "Part of your live theme shows your store's own design",
    help: "Since a store update, these pages no longer pass the store's checks. Shoppers see your store's own design there; the rest of your theme is unchanged.",
    page_cart: "Cart page",
    page_cartDrawer: "Cart drawer",
    page_checkout: "Payment step",
    page_receipt: "Order confirmation",
    page_account: "Account pages",
    line: "{page}: {why}.",
    why_readability: "some words or buttons no longer read clearly on their colours",
    why_prominence: "the total or the main button no longer stands out enough",
    why_style: "one of its style settings is no longer accepted",
    why_layout: "its layout leaves out or misplaces something shoppers need",
    why_words: "some of its words are no longer accepted",
    why_files: "it uses an image from another app",
    why_unavailable: "it uses something a theme cannot set on this page yet",
    why_size: "its look is larger than the store allows",
    why_other: "it no longer passes the store's checks",
    detail: "The store's check: {message}",
    fix: "To fix it, open Customize and publish the theme: the store names each setting to change. If the design came from an app, an update of that app may fix it.",
  },
  bn: {
    title: "আপনার লাইভ থিমের একটি অংশে স্টোরের নিজের ডিজাইন দেখাচ্ছে",
    help: "স্টোর আপডেটের পর এই পেজগুলো আর স্টোরের যাচাই পার হয় না। ক্রেতারা সেখানে আপনার স্টোরের নিজের ডিজাইন দেখছেন; আপনার থিমের বাকি অংশ যেমন ছিল তেমনই আছে।",
    page_cart: "কার্ট পেজ",
    page_cartDrawer: "কার্ট ড্রয়ার",
    page_checkout: "পেমেন্ট ধাপ",
    page_receipt: "অর্ডার নিশ্চিতকরণ",
    page_account: "অ্যাকাউন্ট পেজ",
    line: "{page}: {why}।",
    why_readability: "কিছু লেখা বা বাটন তাদের রঙের ওপর আর স্পষ্ট পড়া যায় না",
    why_prominence: "মোট দাম বা প্রধান বাটন আর যথেষ্ট আলাদা করে চোখে পড়ে না",
    why_style: "এর একটি স্টাইল সেটিং আর গ্রহণযোগ্য নয়",
    why_layout: "এর লেআউটে ক্রেতার দরকারি কিছু বাদ পড়েছে বা ভুল জায়গায় আছে",
    why_words: "এর কিছু লেখা আর গ্রহণযোগ্য নয়",
    why_files: "এটি অন্য একটি অ্যাপের ছবি ব্যবহার করে",
    why_unavailable: "এটি এমন কিছু ব্যবহার করে যা থিম এই পেজে এখনও সেট করতে পারে না",
    why_size: "এর ডিজাইন স্টোরের অনুমোদিত আকারের চেয়ে বড়",
    why_other: "এটি আর স্টোরের যাচাই পার হয় না",
    detail: "স্টোরের যাচাই: {message}",
    fix: "ঠিক করতে কাস্টমাইজ খুলে থিমটি প্রকাশ করুন: কোন সেটিং বদলাতে হবে স্টোর তা জানিয়ে দেবে। ডিজাইনটি কোনো অ্যাপ থেকে এলে সেই অ্যাপের আপডেটেও এটি ঠিক হতে পারে।",
  },
});
