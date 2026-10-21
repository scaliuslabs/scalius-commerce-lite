import { defineMessages } from "./index";

/**
 * The settings cards of the app provider kinds that add a service beside the
 * built-ins: chat apps, browser notifications, exchange rates, address
 * autocomplete, sign-in with other accounts and search. Each card lists the
 * installed apps' providers of its kind, or says none is installed.
 */
export const appKindsMessages = defineMessages({
  en: {
    browseApps: "Browse apps",

    chatTitle: "Chat apps",
    chatDescription: "Apps that send messages in chat, such as Messenger, Telegram or Viber.",
    chatEmpty: "No chat app is installed.",

    browserTitle: "Browser notifications",
    browserDescription: "Signed-in buyers can allow notifications in their browser. Choose what sends them.",
    sendWith: "Send with",
    browserBuiltIn: "Browser (built in)",
    browserBuiltInHelp: "Browser notifications work without an app.",
    browserEmpty: "An app can send them instead.",
    browserLoadFailed: "Browser notifications",

    ratesTitle: "Exchange rates",
    ratesDescription: "A market that sells in its own currency can take its rate from an app instead of a rate you type.",
    ratesEmpty: "No exchange rate app is installed. Markets use the rates you type.",

    addressTitle: "Address autocomplete",
    addressDescription: "An app suggests addresses while buyers type at checkout.",
    addressEmpty: "No address app is installed. Buyers type the whole address.",

    signInTitle: "Sign-in with other accounts",
    signInDescription: "Let buyers sign in with an account they already have.",
    signInEmpty: "No sign-in app is installed. Buyers sign in with a code.",

    searchTitle: "Search",
    searchDescription: "An app can find products when buyers search your store.",
    searchEmpty: "No search app is installed. Your store uses its built-in search.",
  },
  bn: {
    browseApps: "অ্যাপস দেখুন",

    chatTitle: "চ্যাট অ্যাপ",
    chatDescription: "যেসব অ্যাপ চ্যাটে মেসেজ পাঠায়, যেমন মেসেঞ্জার, টেলিগ্রাম বা ভাইবার।",
    chatEmpty: "কোনো চ্যাট অ্যাপ ইনস্টল করা নেই।",

    browserTitle: "ব্রাউজার নোটিফিকেশন",
    browserDescription: "সাইন-ইন করা ক্রেতারা নিজের ব্রাউজারে নোটিফিকেশন চালু করতে পারেন। কে পাঠাবে তা বাছুন।",
    sendWith: "যেভাবে পাঠাবে",
    browserBuiltInHelp: "অ্যাপ ছাড়াই ব্রাউজার নোটিফিকেশন চলে।",
    browserBuiltIn: "ব্রাউজার (বিল্ট-ইন)",
    browserEmpty: "একটি অ্যাপ এর বদলে পাঠাতে পারে।",
    browserLoadFailed: "ব্রাউজার নোটিফিকেশন",

    ratesTitle: "এক্সচেঞ্জ রেট",
    ratesDescription: "নিজের কারেন্সিতে বিক্রি করা মার্কেট আপনার লেখা রেটের বদলে অ্যাপ থেকে রেট নিতে পারে।",
    ratesEmpty: "কোনো এক্সচেঞ্জ রেট অ্যাপ ইনস্টল করা নেই। মার্কেট আপনার লেখা রেট ব্যবহার করে।",

    addressTitle: "ঠিকানা অটোকমপ্লিট",
    addressDescription: "চেকআউটে ক্রেতা লেখার সময় একটি অ্যাপ ঠিকানার পরামর্শ দেয়।",
    addressEmpty: "কোনো ঠিকানা অ্যাপ ইনস্টল করা নেই। ক্রেতারা পুরো ঠিকানা নিজে লেখেন।",

    signInTitle: "অন্য অ্যাকাউন্ট দিয়ে সাইন-ইন",
    signInDescription: "ক্রেতারা তাদের আগে থেকে থাকা অ্যাকাউন্ট দিয়ে সাইন-ইন করতে পারেন।",
    signInEmpty: "কোনো সাইন-ইন অ্যাপ ইনস্টল করা নেই। ক্রেতারা কোড দিয়ে সাইন-ইন করেন।",

    searchTitle: "সার্চ",
    searchDescription: "ক্রেতা আপনার স্টোরে খুঁজলে একটি অ্যাপ পণ্য খুঁজে দিতে পারে।",
    searchEmpty: "কোনো সার্চ অ্যাপ ইনস্টল করা নেই। আপনার স্টোর বিল্ট-ইন সার্চ ব্যবহার করে।",
  },
});
