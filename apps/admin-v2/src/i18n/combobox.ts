import { defineMessages } from "./index";

/** The shared searchable select (combobox): defaults every picker can override. */
export const comboboxMessages = defineMessages({
  en: {
    placeholder: "Select an option",
    search: "Search…",
    options: "Options",
    empty: "No matches.",
    loading: "Loading…",
    loadFailed: "Couldn't load the list.",
    retry: "Try again",
    loadMore: "Load more",
    clear: "Clear {name}",
    clearSelection: "Clear selection",
    showing: "Showing {shown} of {total}. Search to narrow results.",
  },
  bn: {
    placeholder: "একটি বেছে নিন",
    search: "খুঁজুন…",
    options: "অপশন",
    empty: "কিছু পাওয়া যায়নি।",
    loading: "লোড হচ্ছে…",
    loadFailed: "তালিকা লোড করা যায়নি।",
    retry: "আবার চেষ্টা করুন",
    loadMore: "আরও দেখুন",
    clear: "{name} মুছুন",
    clearSelection: "বাছাই মুছুন",
    showing: "{total}টির মধ্যে {shown}টি দেখানো হচ্ছে। খুঁজে তালিকা ছোট করুন।",
  },
});
