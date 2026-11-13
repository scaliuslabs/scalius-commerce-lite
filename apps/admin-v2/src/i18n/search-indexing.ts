import { defineMessages } from "./index";

// The search dialog's note while D1 search is still filling an index after an
// upgrade (the scheduled FTS5 fill): only the lazy search dialog reads it.
export const searchIndexingMessages = defineMessages({
  en: {
    orders: "Search is still indexing older orders: {percent}% done. Name search may miss older orders until it finishes.",
    pages: "Search is still indexing older pages: {percent}% done. Title search may miss older pages until it finishes.",
  },
  bn: {
    orders: "সার্চ এখনও পুরোনো অর্ডারগুলো ইনডেক্স করছে: {percent}% শেষ। শেষ না হওয়া পর্যন্ত নাম দিয়ে খুঁজলে পুরোনো অর্ডার বাদ পড়তে পারে।",
    pages: "সার্চ এখনও পুরোনো পেজগুলো ইনডেক্স করছে: {percent}% শেষ। শেষ না হওয়া পর্যন্ত শিরোনাম দিয়ে খুঁজলে পুরোনো পেজ বাদ পড়তে পারে।",
  },
});
