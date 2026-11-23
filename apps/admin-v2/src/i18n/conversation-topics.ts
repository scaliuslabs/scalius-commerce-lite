import { defineMessages } from "./index";

/** Settings → Customer accounts → Message topics. */
export const conversationTopicsMessages = defineMessages({
  en: {
    title: "Message topics",
    description: "Buyers choose one when they write to you, such as Payment or Delivery. Leave it empty to offer none. A language with no name of its own shows the first name.",
    load: "Message topics could not load",
    name: "Name",
    nameIn: "Name in {language}",
    untitled: "New topic",
    add: "Add topic",
    remove: "Remove {name}",
    moveUp: "Move {name} up",
    empty: "No topics. Buyers write without one.",
    nameRequired: "Enter a name of up to {count} characters.",
  },
  bn: {
    title: "মেসেজের বিষয়",
    description: "ক্রেতা আপনাকে লেখার সময় একটি বেছে নেন, যেমন পেমেন্ট বা ডেলিভারি। কোনোটি না দিতে খালি রাখুন। যে ভাষায় আলাদা নাম নেই, সেখানে প্রথম নামটি দেখায়।",
    load: "মেসেজের বিষয় লোড করা যায়নি",
    name: "নাম",
    nameIn: "{language} ভাষায় নাম",
    untitled: "নতুন বিষয়",
    add: "বিষয় যোগ করুন",
    remove: "{name} সরান",
    moveUp: "{name} উপরে নিন",
    empty: "কোনো বিষয় নেই। ক্রেতা বিষয় ছাড়াই লেখেন।",
    nameRequired: "{count} অক্ষরের মধ্যে একটি নাম দিন।",
  },
});
