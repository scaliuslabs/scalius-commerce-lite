import { defineMessages } from "./index";

/** Settings → Customer accounts → Message topics. */
export const conversationTopicsMessages = defineMessages({
  en: {
    title: "Message topics",
    description: "Buyers choose one when they write to you, such as Payment or Delivery. Leave it empty to offer none. Translate names them in other languages.",
    load: "Message topics could not load",
    name: "Name",
    key: "Key",
    keyHelp: "Kept on messages. Lowercase letters, digits, - and _.",
    add: "Add topic",
    remove: "Remove {name}",
    moveUp: "Move {name} up",
    empty: "No topics. Buyers write without one.",
    nameRequired: "Enter a name of up to {count} characters.",
    keyInvalid: "Use lowercase letters, digits, - and _ (up to {count}).",
    keyTaken: "Each key can be used once.",
  },
  bn: {
    title: "মেসেজের বিষয়",
    description: "ক্রেতা আপনাকে লেখার সময় একটি বেছে নেন, যেমন পেমেন্ট বা ডেলিভারি। কোনোটি না দিতে খালি রাখুন। অনুবাদে অন্য ভাষায় নাম দিন।",
    load: "মেসেজের বিষয় লোড করা যায়নি",
    name: "নাম",
    key: "কী",
    keyHelp: "মেসেজে রাখা হয়। ছোট হাতের অক্ষর, সংখ্যা, - ও _।",
    add: "বিষয় যোগ করুন",
    remove: "{name} সরান",
    moveUp: "{name} উপরে নিন",
    empty: "কোনো বিষয় নেই। ক্রেতা বিষয় ছাড়াই লেখেন।",
    nameRequired: "{count} অক্ষরের মধ্যে একটি নাম দিন।",
    keyInvalid: "ছোট হাতের অক্ষর, সংখ্যা, - ও _ ব্যবহার করুন ({count} পর্যন্ত)।",
    keyTaken: "প্রতিটি কী একবারই ব্যবহার করা যায়।",
  },
});
